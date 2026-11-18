#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fetch the latest official China CPI / 70-city house price / M2 / GDP data,
merge it into data.js, and write official_latest.json for the live server.

Primary sources:
  - National Bureau of Statistics (NBS) release listing and detail pages
  - People's Bank of China (PBOC) financial statistics reports
  - Gold monthly history (datasets/gold-prices) as a fallback for the month
"""
from __future__ import annotations
import csv
import json
import math
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

from lxml import html

ROOT = Path(__file__).resolve().parent
DATA_JSON = ROOT / "official_latest.json"
LOG = ROOT / "update.log"
NBS_LIST = "https://www.stats.gov.cn/sj/zxfb/"
PBOC_LIST = "http://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html"
GOLD_CSV = "https://raw.githubusercontent.com/datasets/gold-prices/main/data/monthly.csv"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
DEPOSIT_MARKET = 0.95       # major-bank 1-year posted rate; policy variable, not monthly NBS data
DEPOSIT_OFFICIAL = 1.50     # PBOC 1-year benchmark, unchanged since 2015-10-24
WEIGHT_HOUSE = 0.25


def log(msg: str) -> None:
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def fetch(url: str, timeout: int = 35) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    for enc in ("utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "ignore")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def doc_text(url: str) -> tuple[html.HtmlElement, str]:
    s = fetch(url)
    doc = html.fromstring(s)
    text = norm(" ".join(doc.text_content().split()))
    return doc, text


def page_links(url: str) -> list[tuple[str, str]]:
    s = fetch(url)
    doc = html.fromstring(s)
    out = []
    for a in doc.xpath("//a"):
        t = norm(a.text_content())
        h = a.get("href") or ""
        if not t or not h or h.startswith("javascript:"):
            continue
        out.append((t, urljoin(url, h)))
    return out


def nbs_links() -> list[tuple[str, str]]:
    out = []
    for suffix in ("", "index_1.html", "index_2.html"):
        url = NBS_LIST if not suffix else urljoin(NBS_LIST, suffix)
        try:
            out.extend(page_links(url))
        except Exception as e:
            log(f"NBS listing {url} failed: {e}")
    return out


def pick_latest(links: list[tuple[str, str]], pattern: str) -> tuple[str, str, re.Match] | None:
    best = None
    seen = set()
    for text, href in links:
        if href in seen:
            continue
        seen.add(href)
        m = re.search(pattern, text)
        if not m:
            continue
        # Order by year/month when available; otherwise by URL date.
        y = int(m.group(1)) if m.lastindex and m.lastindex >= 1 else 0
        mo = int(m.group(2)) if m.lastindex and m.lastindex >= 2 and str(m.group(2)).isdigit() else 0
        key = (y, mo, href)
        if best is None or key > best[0]:
            best = (key, text, href, m)
    return (best[1], best[2], best[3]) if best else None


def parse_num(s: str) -> float | None:
    try:
        return float(s.replace(",", "").strip())
    except Exception:
        return None


def signed_value(kind: str, value: float | None) -> float:
    if kind == "下降":
        return -(value or 0)
    if kind == "持平":
        return 0.0
    return value or 0.0


def find_cpi(links):
    picked = pick_latest(links, r"(\d{4})年(\d{1,2})月份居民消费价格")
    if not picked:
        raise RuntimeError("NBS listing: CPI link not found")
    title, href, m = picked
    _, text = doc_text(href)
    title_match = re.search(r"(\d{4})年(\d{1,2})月份居民消费价格", title) or m
    year, month = int(title_match.group(1)), int(title_match.group(2))
    mm = re.search(r"(\d{4})年(\d{1,2})月份，全国居民消费价格同比(上涨|下降|持平)\s*([\d.]+)?%", text)
    if not mm:
        mm = re.search(r"全国居民消费价格同比(上涨|下降|持平)\s*([\d.]+)?%", text)
        if not mm:
            raise RuntimeError("CPI page: YoY sentence not found")
        cpi = signed_value(mm.group(1), parse_num(mm.group(2) or "0"))
    else:
        cpi = signed_value(mm.group(3), parse_num(mm.group(4) or "0"))
    ytd = None
    ym = re.search(r"1\s*[—\-]\s*(\d{1,2})月平均，全国居民消费价格比上年同期(上涨|下降|持平)\s*([\d.]+)?%", text)
    if ym:
        ytd = signed_value(ym.group(2), parse_num(ym.group(3) or "0"))
    return {"ym": f"{year:04d}-{month:02d}", "cpi": cpi, "cpiYtd": ytd, "url": href, "title": title}


def find_house(links):
    picked = pick_latest(links, r"(\d{4})年(\d{1,2})月份70个大中城市商品住宅销售价格变动情况")
    if not picked:
        raise RuntimeError("NBS listing: 70-city house price link not found")
    title, href, m = picked
    doc, text = doc_text(href)
    title_match = re.search(r"(\d{4})年(\d{1,2})月份70个大中城市", title) or m
    year, month = int(title_match.group(1)), int(title_match.group(2))
    yoy_vals, ytd_vals = [], []
    # The page repeats the main table for print/desktop/mobile. Use the first
    # whole-market table only (skip the 90m2 / 90-144m2 / 144m2 breakdowns).
    main_tables = []
    for table in doc.xpath("//table"):
        head = norm(" ".join(table.text_content().split()))[:160]
        if "城市" in head and "同比" in head and "90m2" not in head:
            main_tables.append(table)
    if not main_tables:
        raise RuntimeError("House page: main city table not found")
    for tr in main_tables[0].xpath(".//tr"):
        cells = [norm(" ".join(td.itertext())) for td in tr.xpath("./td|./th")]
        if len(cells) < 8:
            continue
        for idx, bucket in ((2, yoy_vals), (6, yoy_vals), (3, ytd_vals), (7, ytd_vals)):
            v = parse_num(cells[idx])
            if v is not None and 50 <= v <= 200:
                bucket.append(v)
    if len(yoy_vals) < 40:
        raise RuntimeError(f"House page: only {len(yoy_vals)} city YoY values parsed")
    yoy = statistics_median(yoy_vals) - 100
    ytd = (statistics_median(ytd_vals) - 100) if len(ytd_vals) >= 40 else None
    return {"ym": f"{year:04d}-{month:02d}", "house": yoy, "houseYtd": ytd, "url": href, "title": title}


def find_pboc(links):
    picked = pick_latest(links, r"(\d{4})年(\d{1,2})月金融统计数据报告")
    if not picked:
        raise RuntimeError("PBOC listing: financial statistics report not found")
    title, href, m = picked
    _, text = doc_text(href)
    title_match = re.search(r"(\d{4})年(\d{1,2})月金融统计数据报告", title) or m
    year, month = int(title_match.group(1)), int(title_match.group(2))
    mm = re.search(r"广义货币\s*[（(]M2[）)]\s*余额\s*([\d.]+)\s*万亿元，同比增长\s*([\d.]+)%", text)
    if not mm:
        mm = re.search(r"广义货币\s*[（(]M2[）)]\s*余额\s*([\d.]+)\s*万亿元[^。]{0,40}?同比增长\s*([\d.]+)%", text)
    if not mm:
        raise RuntimeError("PBOC page: M2 sentence not found")
    return {
        "ym": f"{year:04d}-{month:02d}",
        "m2": float(mm.group(2)),
        "m2Level": float(mm.group(1)),
        "url": href,
        "title": title,
    }


def find_gdp(links):
    picked = pick_latest(links, r"(\d{4})年(一季度|二季度|三季度|前三季度|上半年|全年).*?国内生产总值初步核算结果")
    if not picked:
        raise RuntimeError("NBS listing: GDP link not found")
    title, href, m = picked
    doc, text = doc_text(href)
    gdp = None
    # Table 1: the GDP row contains absolute values followed by YoY values.
    for table in doc.xpath("//table"):
        for tr in table.xpath(".//tr"):
            cells = [norm(" ".join(td.itertext())) for td in tr.xpath("./td|./th")]
            if len(cells) >= 4 and cells[0] in ("GDP", "国内生产总值"):
                vals = [parse_num(x) for x in cells[1:]]
                vals = [v for v in vals if v is not None]
                if vals:
                    gdp = vals[-1]
                    break
        if gdp is not None:
            break
    if gdp is None:
        mm = re.search(r"国内生产总值[^。]{0,120}?同比增长\s*([\d.]+)%", text)
        if mm:
            gdp = float(mm.group(1))
    if gdp is None:
        raise RuntimeError("GDP page: growth value not found")
    ym_match = re.search(r"(\d{4})年(一季度|二季度|三季度|前三季度|上半年|全年)", title)
    period = f"{ym_match.group(1)}年{ym_match.group(2)}" if ym_match else title
    return {"gdp": gdp, "gdpPeriod": period, "url": href, "title": title}


def find_gold():
    try:
        s = fetch(GOLD_CSV, timeout=25)
        rows = list(csv.DictReader(s.splitlines()))
        last = rows[-1]
        return {"ym": last["Date"], "goldUsd": float(last["Price"]), "url": GOLD_CSV}
    except Exception as e:
        log(f"gold remote fetch failed: {e}")
        try:
            with open(ROOT / "data" / "gold_monthly.csv", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            last = rows[-1]
            return {"ym": last["Date"], "goldUsd": float(last["Price"]), "url": "local gold_monthly.csv"}
        except Exception as e2:
            log(f"gold local fallback failed: {e2}")
            return None


def statistics_median(vals):
    vals = sorted(vals)
    n = len(vals)
    if n % 2:
        return vals[n // 2]
    return (vals[n // 2 - 1] + vals[n // 2]) / 2


def derive(row, weight=WEIGHT_HOUSE):
    cpi = row.get("cpi")
    dep = row.get("dep")
    house = row.get("house")
    m2 = row.get("m2")
    gdp = row.get("gdp")
    real_inf = None
    if cpi is not None:
        real_inf = cpi if house is None else cpi * (1 - weight) + house * weight
    real_rate = None if (dep is None or real_inf is None) else dep - real_inf
    cpi_real = None if (dep is None or cpi is None) else dep - cpi
    money_real = None if (dep is None or m2 is None or gdp is None) else dep - (m2 - gdp)
    vals = [x for x in (cpi_real, real_rate, money_real) if x is not None]
    composite = sum(vals) / len(vals) if vals else None
    return {
        "realInf": round(real_inf, 2) if real_inf is not None else None,
        "realRate": round(real_rate, 2) if real_rate is not None else None,
        "cpiReal": round(cpi_real, 2) if cpi_real is not None else None,
        "moneyReal": round(money_real, 2) if money_real is not None else None,
        "composite": round(composite, 2) if composite is not None else None,
    }


def merge_into_data(payload):
    """Update data.js + rebuild index.html so the offline snapshot also advances."""
    raw = (ROOT / "data.js").read_text(encoding="utf-8").strip()
    prefix = "window.APP_DATA = "
    if not raw.startswith(prefix):
        raise RuntimeError("data.js: unexpected format")
    obj = json.loads(raw[len(prefix):].rstrip(";\n"))
    monthly = obj["monthly"]
    row = payload["monthly"]
    target = next((r for r in monthly if r["ym"] == row["ym"]), None)
    if target is None:
        target = {"ym": row["ym"], "y": int(row["ym"][:4]), "m": int(row["ym"][5:])}
        monthly.append(target)
    for k in ("cpi", "house", "m2", "gdp", "dep", "goldUsd", "fx"):
        if row.get(k) is not None:
            target[k] = row[k]
    target["gdpPeriod"] = row.get("gdpPeriod") or target.get("gdpPeriod")
    target["cpiSrc"] = "NBS 官方"
    target["houseSrc"] = "70城官方"
    target["m2Src"] = "PBOC 官方"
    if target.get("goldUsd") and target.get("fx"):
        target["goldCnyG"] = round(target["goldUsd"] / 31.1034768 * target["fx"], 2)
    target.update(derive(target))
    monthly.sort(key=lambda r: r["ym"])

    annual = obj["annual"]
    ar = next((r for r in annual if r["year"] == int(payload["year"])), None)
    if ar is not None:
        for k in ("cpi", "house", "m2", "gdp", "dep"):
            if payload["annual"].get(k) is not None:
                ar[k] = payload["annual"][k]
        ar["cpiSrc"] = payload["annual"].get("cpiSrc", "NBS 年内")
        ar["houseSrc"] = payload["annual"].get("houseSrc", "70城 年内")
        ar["m2Src"] = "PBOC 最新"
        ar["gdpSrc"] = "NBS 最新"
        ar.update(derive(ar))

    (ROOT / "data.js").write_text(prefix + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")

    # Keep the CSV copies in step with the embedded snapshot.
    try:
        with open(ROOT / "annual.csv", "w", newline="", encoding="utf-8") as f:
            fields = ["year", "cpi", "dep", "gdp", "m2", "house", "realInf", "realRate", "cpiReal", "moneyReal", "composite", "pp100", "goldUsd", "goldCnyG"]
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows([{k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items()} for r in obj["annual"]])
        with open(ROOT / "monthly.csv", "w", newline="", encoding="utf-8") as f:
            fields = ["ym", "cpi", "dep", "house", "m2", "gdp", "realInf", "realRate", "cpiReal", "moneyReal", "composite", "goldUsd", "goldCnyG"]
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows([{k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items()} for r in obj["monthly"]])
    except Exception as e:
        log(f"CSV refresh failed: {e}")

    try:
        subprocess.run([sys.executable, str(ROOT / "build.py")], check=True, capture_output=True, timeout=30)
        log("rebuilt index.html from data.js")
    except Exception as e:
        log(f"build.py failed: {e}")


def main():
    t0 = time.time()
    errors = []
    links = nbs_links()
    pboc_links = page_links(PBOC_LIST)
    cpi = house = m2 = gdp = gold = None
    try:
        cpi = find_cpi(links)
    except Exception as e:
        errors.append(f"CPI: {e}")
    try:
        house = find_house(links)
    except Exception as e:
        errors.append(f"house: {e}")
    try:
        m2 = find_pboc(pboc_links)
    except Exception as e:
        errors.append(f"M2: {e}")
    try:
        gdp = find_gdp(links)
    except Exception as e:
        errors.append(f"GDP: {e}")
    gold = find_gold()

    if not cpi or not house or not m2 or not gdp:
        raise RuntimeError("; ".join(errors) or "official sources incomplete")

    # Only publish a month when CPI, 70-city house price and M2 are aligned.
    # NBS CPI usually arrives around the 9th, 70-city around the 15th, PBOC
    # M2 around the 10th-15th; waiting avoids mixing two months in one row.
    months = [cpi["ym"], house["ym"], m2["ym"]]
    if len(set(months)) != 1:
        raise RuntimeError(f"official releases are not aligned yet: CPI {cpi['ym']}, house {house['ym']}, M2 {m2['ym']}")
    ym = months[0]
    row = {
        "ym": ym,
        "cpi": cpi["cpi"],
        "house": house["house"],
        "m2": m2["m2"],
        "m2Level": m2["m2Level"],
        "gdp": gdp["gdp"],
        "gdpPeriod": gdp["gdpPeriod"],
        "dep": DEPOSIT_MARKET,
        "officialDep": DEPOSIT_OFFICIAL,
    }
    if gold and gold["ym"] == ym:
        row["goldUsd"] = gold["goldUsd"]

    # Latest annual YTD row: CPI/house 1-N month averages, latest M2/GDP.
    year = ym[:4]
    annual = {
        "year": int(year),
        "cpi": cpi.get("cpiYtd"),
        "house": house.get("houseYtd"),
        "m2": m2["m2"],
        "gdp": gdp["gdp"],
        "dep": DEPOSIT_MARKET,
        "cpiSrc": "NBS 年内均值",
        "houseSrc": "70城 年内均值",
    }

    payload = {
        "version": 1,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "latestMonth": ym,
        "year": int(year),
        "monthly": row,
        "annual": annual,
        "sources": {
            "cpi": cpi["url"],
            "house": house["url"],
            "m2": m2["url"],
            "gdp": gdp["url"],
            "gold": (gold or {}).get("url"),
        },
        "notes": {
            "deposit": "0.95% 为主要银行一年期挂牌；PBOC 一年期基准为 1.50%。",
            "cpiYtd": cpi.get("cpiYtd"),
            "houseYtd": house.get("houseYtd"),
        },
        "errors": errors,
        "elapsed": round(time.time() - t0, 1),
        "status": "ok",
    }
    # Keep a local FX for gold CNY conversion if the month has gold.
    try:
        old = json.loads(DATA_JSON.read_text(encoding="utf-8"))
        old_row = old.get("monthly", {})
        if row.get("goldUsd") and not row.get("fx"):
            row["fx"] = old_row.get("fx") or 6.684
        payload["monthly"] = row
    except Exception:
        row["fx"] = row.get("fx") or 6.684
        payload["monthly"] = row

    DATA_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    merge_into_data(payload)
    log(f"updated {ym}: CPI {row['cpi']}%, house {row['house']}%, M2 {row['m2']}%, GDP {row['gdp']}%")
    if errors:
        log("partial: " + "; ".join(errors))
    print(json.dumps({"ok": True, "latestMonth": ym, "updatedAt": payload["updatedAt"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"update failed: {e}")
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        raise SystemExit(1)
