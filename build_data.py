#!/usr/bin/env python3
# Build the embedded dataset for the real-interest-rate dashboard.
import json, csv, math, statistics
from pathlib import Path
from datetime import datetime
import pandas as pd
import numpy as np

ROOT = Path(__file__).parent
DATA = ROOT / 'data'
OUT = ROOT / 'data.js'

# ---------- helpers ----------
def read_json(name):
    with open(DATA / name) as f:
        obj = json.load(f)
    if isinstance(obj, dict) and 'result' in obj:
        return obj['result'].get('data') or []
    return obj

def wb_series(name):
    obj = read_json(name)
    return {int(r['date']): r['value'] for r in obj[1] if r['value'] is not None}

def month_key(y, m):
    return f'{y:04d}-{m:02d}'

def safe_div(a, b):
    return None if a is None or b is None or b == 0 else a / b

def rnd(v, n=2):
    return None if v is None else round(float(v), n)

# ---------- annual official / historical inputs ----------
# CPI year-on-year, percent. 1951-1985 from NBS historical series as commonly
# reproduced in statistical yearbooks; 1986+ from GMD / World Bank / NBS.
cpi_yoy_manual = {
    1951: 12.2, 1952: 2.7, 1953: 5.1, 1954: 1.4, 1955: 0.3,
    1956: -0.1, 1957: 2.6, 1958: 0.2, 1959: 0.9, 1960: 2.8,
    1961: 16.1, 1962: 3.8, 1963: 5.9, 1964: -3.7, 1965: 0.7,
    1966: -0.2, 1967: -0.1, 1968: 0.1, 1969: 1.1, 1970: 0.0,
    1971: -0.1, 1972: 0.2, 1973: 0.1, 1974: 0.3, 1975: 0.3,
    1976: 0.4, 1977: 2.0, 1978: 0.7, 1979: 2.0, 1980: 6.0,
    1981: 2.4, 1982: 1.9, 1983: 1.5, 1984: 2.8, 1985: 9.3,
    1986: 6.5,
}
# 1-year household deposit benchmark / major-bank posted rate, year-end, percent.
deposit_annual = {}
for y in range(1949, 2027):
    if y == 1949: v = 252.0
    elif y == 1950: v = 156.0
    elif y == 1951: v = 31.2
    elif y <= 1954: v = 14.4
    elif y <= 1958: v = 7.92
    elif y <= 1964: v = 5.4
    elif y <= 1970: v = 3.24
    elif y <= 1978: v = 2.7
    elif y == 1979: v = 3.96
    elif y <= 1981: v = 5.4
    elif y <= 1984: v = 5.76
    elif y <= 1987: v = 7.2
    elif y == 1988: v = 8.64
    elif y == 1989: v = 11.34
    elif y == 1990: v = 8.64
    elif y <= 1992: v = 7.56
    elif y <= 1995: v = 10.98
    elif y == 1996: v = 7.47
    elif y == 1997: v = 5.67
    elif y == 1998: v = 3.78
    elif y <= 2001: v = 2.25
    elif y <= 2003: v = 1.98
    elif y <= 2005: v = 2.25
    elif y == 2006: v = 2.52
    elif y == 2007: v = 3.87
    elif y <= 2009: v = 2.25
    elif y == 2010: v = 2.75
    elif y == 2011: v = 3.5
    elif y <= 2013: v = 3.0
    elif y == 2014: v = 2.75
    elif y <= 2024: v = 1.5
    else: v = 0.95
    deposit_annual[y] = v

gdp_manual = {
    1950: 9.3, 1951: 15.0, 1952: 18.0, 1953: 15.6, 1954: 4.2,
    1955: 6.8, 1956: 15.0, 1957: 5.1, 1958: 21.3, 1959: 8.8, 1960: -0.3,
}

# Average commercial housing price YoY, percent. 1987-2010 approximations from
# NBS average selling prices; 2011+ computed from 70-city median (official).
house_manual = {
    1988: 23.3, 1989: 13.9, 1990: 22.7, 1991: 11.8,
    1992: 26.6, 1993: 29.7, 1994: 9.1, 1995: 12.7, 1996: 13.7,
    1997: 10.6, 1998: 3.3, 1999: -0.5, 2000: 2.9, 2001: 2.7,
    2002: 3.7, 2003: 4.8, 2004: 17.8, 2005: 14.0, 2006: 6.0,
    2007: 7.0, 2008: -1.0, 2009: 1.0, 2010: 7.0,
}

# ---------- load sources ----------
cpi_wb = wb_series('FP.CPI.TOTL.json')       # index 2010=100, 1986-2025
gdp_wb = wb_series('NY.GDP.MKTP.KD.ZG.json') # real growth, 1961-2025
fx_wb = wb_series('PA.NUS.FCRF.json')        # LCU per USD, 1960-2025
m2_wb_pct = wb_series('FM.LBL.BMNY.GD.ZS.json')
m2_gmd = {int(r['year']): r for r in pd.read_stata(DATA / 'chainlinked_M2.dta', convert_categoricals=False).query("ISO3 == 'CHN'").to_dict('records')}

# gold annual and monthly
gold_annual = {}
with open(DATA / 'gold_annual.csv') as f:
    for row in csv.DictReader(f):
        try:
            y = int(row['Date'])
        except Exception:
            continue
        gold_annual[y] = float(row['Price'])
gold_monthly = {}
with open(DATA / 'gold_monthly.csv') as f:
    for row in csv.DictReader(f):
        try:
            gold_monthly[row['Date']] = float(row['Price'])
        except Exception:
            pass
gold_2026_avg = statistics.fmean([v for k, v in gold_monthly.items() if k.startswith('2026-')])
gold_annual[2026] = gold_2026_avg

# monthly CPI: FRED index for 2000-2007, Eastmoney official YoY 2008+
fred = pd.read_csv(DATA / 'cpi_monthly.csv', parse_dates=['observation_date'])
fred['yoy'] = fred['CHNCPIALLMINMEI'].pct_change(12) * 100
fred_map = {f"{d.year:04d}-{d.month:02d}": v for d, v in zip(fred.observation_date, fred.yoy) if pd.notna(v)}

cpi_em_rows = read_json('RPT_ECONOMY_CPI.json')
cpi_em = {}
for r in cpi_em_rows:
    d = pd.to_datetime(r['REPORT_DATE'])
    v = r.get('NATIONAL_SAME')
    if v is not None:
        cpi_em[f'{d.year:04d}-{d.month:02d}'] = float(v)

# monthly house: median YoY of 70 cities, 2011+
house_rows = read_json('RPT_ECONOMY_HOUSE_PRICE.json')
house_df = pd.DataFrame(house_rows)
house_df['date'] = pd.to_datetime(house_df['REPORT_DATE'])
house_df['v'] = pd.to_numeric(house_df['FIRST_COMHOUSE_SAME'], errors='coerce')
house_month = house_df.groupby('date')['v'].median().to_dict()
house_month = {f'{d.year:04d}-{d.month:02d}': v for d, v in house_month.items() if pd.notna(v)}
house_annual_actual = {}
for ym, v in house_month.items():
    house_annual_actual.setdefault(int(ym[:4]), []).append(v)
for y, vals in house_annual_actual.items():
    house_manual[y] = statistics.fmean(vals) - 100.0

# monthly M2: official YoY 2008+
m2_rows = read_json('RPT_ECONOMY_CURRENCY_SUPPLY.json')
m2_month = {}
for r in m2_rows:
    d = pd.to_datetime(r['REPORT_DATE'])
    v = r.get('BASIC_CURRENCY_SAME')
    if v is not None:
        m2_month[f'{d.year:04d}-{d.month:02d}'] = float(v)

# quarterly GDP: use latest cumulative release at/ before each month
gdp_rows = read_json('RPT_ECONOMY_GDP.json')
gdp_q = []
for r in gdp_rows:
    d = pd.to_datetime(r['REPORT_DATE'])
    if r.get('SUM_SAME') is None:
        continue
    gdp_q.append((d, float(r['SUM_SAME']), r.get('TIME', '')))
gdp_q.sort()
# annual growth for 2000-2005 at December
for y in range(2000, 2006):
    if y in gdp_wb:
        gdp_q.append((pd.Timestamp(year=y, month=12, day=1), float(gdp_wb[y]), f'{y}年'))
gdp_q.sort()

# daily USD/CNY -> monthly average
fx_daily = pd.read_csv(DATA / 'usdcny_daily.csv', parse_dates=['observation_date'])
fx_daily['v'] = pd.to_numeric(fx_daily['DEXCHUS'], errors='coerce')
fx_daily = fx_daily.dropna(subset=['v'])
fx_daily['ym'] = fx_daily.observation_date.dt.strftime('%Y-%m')
fx_month = fx_daily.groupby('ym')['v'].mean().to_dict()

# ---------- monthly grid 2000-01 .. 2026-10 ----------
months = []
y, m = 2000, 1
while (y, m) <= (2026, 10):
    months.append(f'{y:04d}-{m:02d}')
    m += 1
    if m == 13:
        m = 1; y += 1

# deposit policy path
dep_changes = {
    '2000-01': 2.25, '2002-02': 1.98, '2004-10': 2.25, '2006-08': 2.52,
    '2007-03': 2.79, '2007-05': 3.06, '2007-07': 3.33, '2007-08': 3.60,
    '2007-09': 3.87, '2008-10': 3.60, '2008-11': 2.52, '2008-12': 2.25,
    '2010-10': 2.50, '2010-12': 2.75, '2011-02': 3.00, '2011-04': 3.25,
    '2011-07': 3.50, '2012-06': 3.25, '2012-07': 3.00, '2014-11': 2.75,
    '2015-03': 2.50, '2015-05': 2.25, '2015-06': 2.00, '2015-08': 1.75,
    '2015-10': 1.50, '2025-05': 0.95,
}

monthly = []
dep = None
last_gdp = None
gdp_i = 0
for ym in months:
    if ym in dep_changes:
        dep = dep_changes[ym]
    yy, mm = int(ym[:4]), int(ym[5:])
    # CPI
    cpi = cpi_em.get(ym)
    cpi_src = 'NBS/Eastmoney'
    if cpi is None:
        cpi = fred_map.get(ym)
        cpi_src = 'FRED/NBS'
    # house
    house = house_month.get(ym)
    if house is not None:
        house = house - 100.0
    house_src = '70城新房同比中位数'
    if house is None:
        house = house_manual.get(yy)
        house_src = '年度估算'
    # m2
    m2 = m2_month.get(ym)
    m2_src = 'PBOC/Eastmoney'
    if m2 is None:
        m2 = m2_gmd.get(yy, {}).get('M2')
        if m2 is not None:
            # annual level -> growth
            prev = m2_gmd.get(yy - 1, {}).get('M2')
            m2 = (m2 / prev - 1) * 100 if prev else None
        m2_src = '年度估算'
    # gdp: latest release at or before month
    while gdp_i + 1 < len(gdp_q) and gdp_q[gdp_i + 1][0] <= pd.Timestamp(year=yy, month=mm, day=28):
        gdp_i += 1
    if gdp_i < len(gdp_q) and gdp_q[gdp_i][0].year <= yy:
        last_gdp = gdp_q[gdp_i]
    gdp = last_gdp[1] if last_gdp else None
    gdp_period = last_gdp[2] if last_gdp else None
    # gold
    gusd = gold_monthly.get(ym)
    fx = fx_month.get(ym)
    if fx is None:
        fx = fx_wb.get(yy) or (6.67 if yy >= 2025 else None)
    gcny = (gusd / 31.1034768 * fx) if (gusd and fx) else None
    real_inf = (0.75 * cpi + 0.25 * house) if (cpi is not None and house is not None) else cpi
    real_rate = (dep - real_inf) if (dep is not None and real_inf is not None) else None
    cpi_real = (dep - cpi) if (dep is not None and cpi is not None) else None
    money_real = (dep - (m2 - gdp)) if (dep is not None and m2 is not None and gdp is not None) else None
    vals = [x for x in (cpi_real, real_rate, money_real) if x is not None]
    composite = statistics.fmean(vals) if vals else None
    monthly.append({
        'ym': ym, 'y': yy, 'm': mm,
        'cpi': rnd(cpi), 'dep': rnd(dep), 'house': rnd(house),
        'm2': rnd(m2), 'gdp': rnd(gdp), 'gdpPeriod': gdp_period,
        'goldUsd': rnd(gusd), 'goldCnyG': rnd(gcny), 'fx': rnd(fx, 3),
        'realInf': rnd(real_inf), 'realRate': rnd(real_rate),
        'cpiReal': rnd(cpi_real), 'moneyReal': rnd(money_real),
        'composite': rnd(composite),
        'cpiSrc': cpi_src, 'houseSrc': house_src, 'm2Src': m2_src,
        'est': bool(house_src == '年度估算' or m2_src == '年度估算'),
    })

# ---------- annual grid 1949-2026 ----------
annual = []
cpi_index = 100.0  # 1950 = 100
for yy in range(1949, 2027):
    cpi = cpi_yoy_manual.get(yy)
    cpi_src = '估算/历史'
    if cpi is None and yy >= 1986:
        # derive from World Bank index
        idx = cpi_wb.get(yy); prev = cpi_wb.get(yy - 1)
        if idx is not None and prev:
            cpi = (idx / prev - 1) * 100
            cpi_src = 'World Bank/NBS'
    if yy == 2024: cpi, cpi_src = 0.2, 'NBS'
    if yy == 2025: cpi, cpi_src = 0.0, 'NBS'
    if yy == 2026: cpi, cpi_src = 0.9, 'NBS 1-10月均值'
    if yy > 1950 and cpi is not None:
        cpi_index *= (1 + cpi / 100)
    dep = deposit_annual.get(yy)
    gdp = gdp_wb.get(yy) if yy >= 1961 else gdp_manual.get(yy)
    gdp_src = 'World Bank/NBS' if yy >= 1961 else ('估算' if gdp is not None else '缺失')
    if yy == 2026: gdp, gdp_src = 4.6, 'NBS 前三季度'
    m2 = None; m2_src = '缺失'
    if yy >= 1953 and yy <= 2023:
        rec = m2_gmd.get(yy); prev = m2_gmd.get(yy - 1)
        if rec and prev and rec.get('M2') and prev.get('M2'):
            m2 = (rec['M2'] / prev['M2'] - 1) * 100; m2_src = 'PBOC/IMF'
    if yy == 2024: m2, m2_src = 7.3, 'PBOC'
    if yy == 2025: m2, m2_src = 8.5, 'PBOC'
    if yy == 2026: m2, m2_src = 7.1, 'PBOC 10月末'
    house = house_manual.get(yy)
    house_src = '70城新房同比' if yy >= 2011 else ('估算' if house is not None else '无市场')
    if yy == 1987: house_src = '基年无同比'
    if yy == 2026: house_src = '70城 1-10月'
    real_inf = (0.75 * cpi + 0.25 * house) if (cpi is not None and house is not None) else cpi
    real_rate = (dep - real_inf) if (dep is not None and real_inf is not None) else None
    cpi_real = (dep - cpi) if (dep is not None and cpi is not None) else None
    money_real = (dep - (m2 - gdp)) if (dep is not None and m2 is not None and gdp is not None) else None
    vals = [x for x in (cpi_real, real_rate, money_real) if x is not None]
    composite = statistics.fmean(vals) if vals else None
    fx = fx_wb.get(yy) or (2.4618 if yy < 1960 else (6.67 if yy >= 2026 else None))
    gusd = gold_annual.get(yy)
    gcny = (gusd / 31.1034768 * fx) if (gusd and fx) else None
    pp100 = (10000.0 / cpi_index) if yy >= 1950 else None
    annual.append({
        'year': yy, 'cpi': rnd(cpi), 'dep': rnd(dep), 'gdp': rnd(gdp), 'm2': rnd(m2),
        'house': rnd(house), 'realInf': rnd(real_inf), 'realRate': rnd(real_rate),
        'cpiReal': rnd(cpi_real), 'moneyReal': rnd(money_real), 'composite': rnd(composite),
        'pp100': rnd(pp100, 1), 'goldUsd': rnd(gusd, 1), 'goldCnyG': rnd(gcny, 1),
        'cpiIndex': rnd(cpi_index, 1),
        'cpiSrc': cpi_src, 'depSrc': 'PBOC/历史', 'gdpSrc': gdp_src,
        'm2Src': m2_src, 'houseSrc': house_src,
    })

# ---------- stats ----------
def stats_for(start_year):
    rows = [r for r in annual if r['year'] >= start_year and r['realRate'] is not None]
    neg = [r for r in rows if r['realRate'] < 0]
    streak = []; cur = []
    for r in rows:
        if r['realRate'] < 0:
            cur.append(r)
        else:
            if cur: streak.append(cur); cur = []
    if cur: streak.append(cur)
    longest = max(streak, key=len) if streak else []
    deepest = min(rows, key=lambda r: r['realRate']) if rows else None
    return {
        'start': start_year, 'n': len(rows), 'neg': len(neg),
        'negShare': round(len(neg) / len(rows) * 100, 1) if rows else None,
        'longest': {'years': [r['year'] for r in longest], 'n': len(longest)} if longest else None,
        'deepest': {'year': deepest['year'], 'value': deepest['realRate']} if deepest else None,
    }

stats = {'all': stats_for(1951), 'reform': stats_for(1978), 'market': stats_for(2000)}

# negative periods for timeline
periods = []
cur = []
for r in annual:
    if r['realRate'] is not None and r['realRate'] < 0:
        cur.append(r['year'])
    else:
        if cur: periods.append([cur[0], cur[-1]]); cur = []
if cur: periods.append([cur[0], cur[-1]])


# ---------- living basket & gold-oil ratio ----------
# Reference retail prices in current RMB (1950-1954 converted to the post-1955
# new yuan at 10,000:1). These are long-run reference prices, not a monthly
# statistical release; they are rounded and documented as estimates.
rice_pts = {1950:0.10, 1952:0.12, 1957:0.14, 1965:0.15, 1970:0.16, 1978:0.18,
            1985:0.25, 1990:0.45, 1995:1.00, 2000:1.10, 2005:1.50, 2010:2.20,
            2015:2.60, 2020:2.80, 2025:3.00, 2026:3.10}
pork_pts = {1950:0.45, 1952:0.50, 1957:0.65, 1965:0.75, 1970:0.80, 1978:0.90,
            1985:1.50, 1990:2.50, 1995:5.00, 2000:5.50, 2005:7.50, 2010:10.00,
            2015:13.00, 2020:28.00, 2022:17.00, 2024:17.00, 2026:16.00}
oil_pts = {1950:0.60, 1952:0.65, 1957:0.80, 1965:0.90, 1970:1.00, 1978:1.10,
           1985:1.80, 1990:3.00, 1995:5.50, 2000:5.00, 2005:6.50, 2010:9.00,
           2015:9.00, 2020:10.00, 2025:10.50, 2026:11.00}
power_pts = {1950:0.20, 1952:0.20, 1957:0.20, 1965:0.20, 1970:0.20, 1978:0.20,
             1985:0.22, 1990:0.30, 1995:0.40, 2000:0.50, 2005:0.52, 2010:0.53,
             2015:0.56, 2020:0.57, 2025:0.58, 2026:0.59}
wage_pts = {1950:420, 1952:445, 1957:520, 1965:590, 1970:600, 1978:615,
            1985:1148, 1990:2140, 1995:5500, 2000:9371, 2005:18200,
            2010:36539, 2015:62029, 2020:97379, 2025:129441, 2026:135000}

def interp_pts(pts, y):
    xs = sorted(pts)
    return float(np.interp(y, xs, [pts[x] for x in xs]))

living = []
for y in range(1950, 2027):
    rice = interp_pts(rice_pts, y)
    pork = interp_pts(pork_pts, y)
    oil = interp_pts(oil_pts, y)
    power = interp_pts(power_pts, y)
    wage = interp_pts(wage_pts, y)
    basket = rice * 20 + pork * 4 + oil * 5 + power * 100  # 10kg rice, 2kg pork, 5L oil, 100kWh
    hourly = wage / 2000.0
    living.append({
        'year': y, 'rice': rnd(rice, 2), 'pork': rnd(pork, 2), 'oil': rnd(oil, 2),
        'power': rnd(power, 2), 'wage': rnd(wage, 0), 'basket': rnd(basket, 1),
        'hours': rnd(basket / hourly, 1), 'baskets': rnd(wage / basket, 1),
        'riceHour': rnd(hourly / rice, 2), 'porkHour': rnd(hourly / pork, 2),
        'oilHour': rnd(hourly / oil, 2), 'powerHour': rnd(hourly / power, 0),
    })

# Annual cost of the fixed living basket. The 1949 point is an estimate for
# the founding year; 1950+ uses the annualised monthly basket above.
annual_cost = []
_b49 = {'rice': 0.09, 'pork': 0.42, 'oil': 0.55, 'power': 0.20}
_b49_basket = _b49['rice'] * 20 + _b49['pork'] * 4 + _b49['oil'] * 5 + _b49['power'] * 100
annual_cost.append({'year': 1949, 'monthly': rnd(_b49_basket, 1), 'annual': rnd(_b49_basket * 12, 1), 'wage': None, 'share': None, 'est': True})
for r in living:
    annual_val = r['basket'] * 12
    annual_cost.append({
        'year': r['year'], 'monthly': rnd(r['basket'], 1), 'annual': rnd(annual_val, 1),
        'wage': r['wage'], 'share': rnd(annual_val / r['wage'] * 100, 1) if r['wage'] else None,
        'est': r['year'] == 2026,
    })

# WTI annual average (USD/barrel), 1949-2026; 2026 is Jan-Oct.
oil_df = pd.read_csv(DATA / 'wti_monthly.csv', parse_dates=['observation_date'])
oil_df['year'] = oil_df.observation_date.dt.year
oil_annual = {int(y): float(v) for y, v in oil_df.groupby('year')['WTISPLC'].mean().items()}
gold_oil = []
for y in range(1949, 2027):
    g = gold_annual.get(y); o = oil_annual.get(y)
    if g and o:
        gold_oil.append({'year': y, 'goldUsd': rnd(g, 1), 'oilUsd': rnd(o, 2), 'ratio': rnd(g / o, 1)})

meta = {
    'builtAt': '2026-11-18',
    'latestMonth': '2026-10',
    'latestAnnual': 2026,
    'goldSpot': {'usd': 3755.5, 'at': '2026-11-18T20:43+08:00', 'fx': 6.67},
    'weights': {'cpi': 0.75, 'house': 0.25},
    'gold2026Avg': round(gold_2026_avg, 1),
}

payload = {'meta': meta, 'annual': annual, 'monthly': monthly, 'living': living, 'annualCost': annual_cost, 'goldOil': gold_oil, 'basketItems': [
    {'key': 'rice', 'name': '大米', 'qty': 10, 'unit': 'kg', 'unitPrice': '元/斤'},
    {'key': 'pork', 'name': '猪肉', 'qty': 2, 'unit': 'kg', 'unitPrice': '元/斤'},
    {'key': 'oil', 'name': '食用油', 'qty': 5, 'unit': 'L', 'unitPrice': '元/L'},
    {'key': 'power', 'name': '居民用电', 'qty': 100, 'unit': 'kWh', 'unitPrice': '元/度'},
], 'livingMeta': {'wageNote': '城镇非私营单位就业人员年平均工资；2026 为估算', 'hoursPerYear': 2000, 'priceNote': '参考零售价，1950—1954 已折算为第二套人民币'}, 'stats': stats, 'periods': periods, 'events': [
    {'year': 1961, 'label': '困难时期'},
    {'year': 1978, 'label': '改革开放'},
    {'year': 1988, 'label': '价格闯关'},
    {'year': 1994, 'label': '高通胀'},
    {'year': 2008, 'label': '四万亿'},
    {'year': 2015, 'label': '棚改货币化'},
    {'year': 2022, 'label': '楼市拐点'},
]}

with open(OUT, 'w') as f:
    f.write('window.APP_DATA = ')
    json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')

# also write CSV copies for inspection / download
with open(ROOT / 'annual.csv', 'w', newline='') as f:
    fields = ['year','cpi','dep','gdp','m2','house','realInf','realRate','cpiReal','moneyReal','composite','pp100','goldUsd','goldCnyG']
    w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); w.writeheader(); w.writerows(annual)
with open(ROOT / 'monthly.csv', 'w', newline='') as f:
    fields = ['ym','cpi','dep','house','m2','gdp','realInf','realRate','cpiReal','moneyReal','composite','goldUsd','goldCnyG']
    w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); w.writeheader(); w.writerows(monthly)

print('built', OUT, OUT.stat().st_size, 'bytes')
print('annual rows', len(annual), 'monthly rows', len(monthly))
for k in stats: print(k, stats[k])
print('periods', periods[:20])
print('latest', annual[-1])
print('latest month', monthly[-1])
print('gold 2026 avg', gold_2026_avg)
