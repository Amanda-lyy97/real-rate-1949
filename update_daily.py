#!/usr/bin/env python3
"""Fetch daily gold + WTI close and write daily_market.json."""
import csv, json, sys, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'daily_market.json'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'

def get(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json,text/csv,*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')

def gold():
    raw = get('https://api.gold-api.com/price/XAU')
    d = json.loads(raw)
    if not isinstance(d.get('price'), (int, float)):
        raise ValueError('gold price missing')
    return float(d['price']), d.get('updatedAt') or datetime.now(timezone.utc).isoformat()

def wti_fred():
    raw = get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO')
    rows = list(csv.reader(raw.splitlines()))
    for row in reversed(rows):
        if len(row) >= 2:
            try:
                v = float(row[1])
                return v, row[0]
            except Exception:
                continue
    raise ValueError('FRED WTI empty')

def wti_yahoo():
    raw = get('https://query1.finance.yahoo.com/v8/finance/chart/CL=F?range=7d&interval=1d')
    d = json.loads(raw)
    res = d['chart']['result'][0]
    closes = res['indicators']['quote'][0]['close']
    ts = res['timestamp']
    for i in range(len(closes) - 1, -1, -1):
        if isinstance(closes[i], (int, float)):
            return float(closes[i]), datetime.fromtimestamp(ts[i], timezone.utc).date().isoformat()
    raise ValueError('Yahoo WTI empty')

def main():
    try:
        g, gat = gold()
    except Exception as e:
        print('gold failed:', e); return 1
    oil = None; od = None
    for fn, name in [(wti_fred, 'FRED'), (wti_yahoo, 'Yahoo')]:
        try:
            oil, od = fn()
            print('WTI source:', name, oil, od)
            break
        except Exception as e:
            print('WTI', name, 'failed:', e)
    if not oil or oil <= 0:
        print('No WTI price; keep existing daily_market.json'); return 1
    payload = {
        'asOf': od or gat[:10],
        'goldUsd': round(g, 2),
        'oilUsd': round(oil, 2),
        'ratio': round(g / oil, 2),
        'live': True,
        'source': 'Gold API + FRED/Yahoo WTI',
        'goldAt': gat,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(payload, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    sys.exit(main())
