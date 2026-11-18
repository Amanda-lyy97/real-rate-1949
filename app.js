/* =========================================================
   实质负利率观察站 — app logic
   Vanilla JS, no dependencies.
   ========================================================= */
(function () {
  'use strict';

  const APP = window.APP_DATA;
  if (!APP) { document.body.innerHTML = '<p style="padding:40px">数据文件加载失败。</p>'; return; }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const LS_KEY = 'real_rate_monitor_v1';

  /* ---------- safe storage ---------- */
  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        overrides: state.overrides,
        liveGold: state.liveGold,
        remote: state.remote,
      }));
    } catch (e) { /* file:// private mode etc. */ }
  }
  const saved = loadLocal();

  const state = {
    overrides: (saved.overrides && typeof saved.overrides === 'object') ? saved.overrides : {},
    liveGold: (saved.liveGold && isNum(saved.liveGold.usd)) ? saved.liveGold : null,
    remote: (saved.remote && saved.remote.monthly) ? saved.remote : null,
    calcDirty: false,
    calcLens: 'doubleReal',
    autoState: 'unknown',
    lens: 'doubleReal',
    annualStart: 2000,
    monthlyMonths: 60,
    annualFilter: 'all',
    monthlyFilter: '24',
    goldMode: 'cny',
    goldLog: true,
  };

  const LENS = {
    cpiReal: { label: '实质利率 · CPI 口径', short: 'CPI 口径' },
    moneyReal: { label: '实质利率 · 货币扩张', short: '货币扩张' },
    doubleReal: { label: '实质利率 · 通论口径', short: '通论口径' },
  };

  /* ---------- derive ---------- */
  function derive(row) {
    const cpi = isNum(row.cpi) ? row.cpi : null;
    const dep = isNum(row.dep) ? row.dep : null;
    const house = isNum(row.house) ? row.house : null;
    const m2 = isNum(row.m2) ? row.m2 : null;
    const gdp = isNum(row.gdp) ? row.gdp : null;
    const cpiReal = (dep == null || cpi == null) ? null : dep - cpi;
    const moneyReal = (dep == null || m2 == null || gdp == null) ? null : dep - (m2 - gdp);
    const doubleReal = (dep == null || cpi == null || m2 == null || gdp == null) ? null : dep - cpi - (m2 - gdp);
    return Object.assign({}, row, { cpiReal, moneyReal, doubleReal });
  }

  function buildData() {
    let annual = APP.annual.map(r => Object.assign({}, r));
    // Official auto-update payload (from the local update service).
    if (state.remote && state.remote.annual) {
      const ar = annual.find(a => a.year === Number(state.remote.annual.year));
      if (ar) {
        ['cpi', 'house', 'm2', 'gdp', 'dep'].forEach(k => {
          if (isNum(state.remote.annual[k])) ar[k] = state.remote.annual[k];
        });
        if (state.remote.annual.cpiSrc) ar.cpiSrc = state.remote.annual.cpiSrc;
        if (state.remote.annual.houseSrc) ar.houseSrc = state.remote.annual.houseSrc;
        ar.auto = true;
      }
    }
    annual = annual.map(derive);

    let monthly = APP.monthly.map(r => Object.assign({}, r));
    if (state.remote && state.remote.monthly) {
      const rm = state.remote.monthly;
      let row = monthly.find(r => r.ym === rm.ym);
      if (!row) {
        const [y, m] = rm.ym.split('-').map(Number);
        row = { ym: rm.ym, y, m, cpiSrc: 'NBS 官方', houseSrc: '70城官方', m2Src: 'PBOC 官方' };
        monthly.push(row);
      }
      ['cpi', 'house', 'm2', 'gdp', 'dep', 'goldUsd', 'fx'].forEach(k => {
        if (isNum(rm[k])) row[k] = rm[k];
      });
      row.gdpPeriod = rm.gdpPeriod || row.gdpPeriod;
      row.auto = true;
      row.cpiSrc = 'NBS 官方';
      row.houseSrc = '70城官方';
      row.m2Src = 'PBOC 官方';
      if (isNum(rm.goldUsd) && isNum(rm.fx)) row.goldCnyG = rm.goldUsd / 31.1034768 * rm.fx;
    }
    Object.keys(state.overrides).forEach(ym => {
      const ov = state.overrides[ym] || {};
      let row = monthly.find(r => r.ym === ym);
      if (!row) {
        const [y, m] = ym.split('-').map(Number);
        row = { ym, y, m, gdpPeriod: '用户录入', cpiSrc: '用户录入', houseSrc: '用户录入', m2Src: '用户录入' };
        monthly.push(row);
      }
      ['cpi', 'dep', 'house', 'm2', 'gdp', 'goldUsd', 'fx'].forEach(k => {
        if (isNum(ov[k])) row[k] = ov[k];
        else if (ov[k] === null) row[k] = null;
      });
      if (isNum(ov.goldUsd) && isNum(ov.fx)) row.goldCnyG = ov.goldUsd / 31.1034768 * ov.fx;
      row.isOverride = true;
    });
    monthly = monthly.map(derive).sort((a, b) => a.ym.localeCompare(b.ym));
    return { annual, monthly };
  }

  let DATA = buildData();
  let annual = DATA.annual;
  let monthly = DATA.monthly;

  function rebuild() {
    DATA = buildData();
    annual = DATA.annual;
    monthly = DATA.monthly;
  }

  /* ---------- formatting ---------- */
  function fmt(v, d = 1, suffix = '') {
    if (!isNum(v)) return '—';
    return v.toFixed(d) + suffix;
  }
  function fmtSigned(v, d = 2, suffix = '%') {
    if (!isNum(v)) return '—';
    const sign = v > 0.0001 ? '+' : (v < -0.0001 ? '−' : '');
    return sign + Math.abs(v).toFixed(d) + suffix;
  }
  function fmtUnsigned(v, d = 2, suffix = '%') {
    if (!isNum(v)) return '—';
    return Math.abs(v).toFixed(d) + suffix;
  }
  function signClass(v) {
    if (!isNum(v)) return '';
    return v < -0.0001 ? 'neg' : (v > 0.0001 ? 'pos' : '');
  }
  function ymLabel(ym) {
    if (!ym) return '—';
    return ym.slice(0, 4) + '.' + ym.slice(5, 7);
  }
  function goldTime(iso) {
    if (!iso) return '尚未获取';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- chart engine ---------- */
  function niceBounds(min, max, target = 5) {
    if (!isNum(min) || !isNum(max)) { min = 0; max = 1; }
    if (min > 0) min = 0;
    if (max < 0) max = 0;
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const raw = span / target;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / pow;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    step *= pow;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    return { min: lo, max: hi, step };
  }
  function axisFmt(v, step) {
    if (Math.abs(v) < 1e-9) return '0';
    const d = step < 1 ? 1 : 0;
    return (v > 0 ? '' : '−') + Math.abs(v).toFixed(d);
  }
  function linePath(pts) {
    return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
  }
  function areaPath(pts, baseY) {
    if (!pts.length) return '';
    return 'M' + pts[0][0].toFixed(2) + ' ' + baseY.toFixed(2) +
      pts.map(p => 'L' + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ') +
      'L' + pts[pts.length - 1][0].toFixed(2) + ' ' + baseY.toFixed(2) + ' Z';
  }

  let chartUid = 0;
  function drawChart(el, cfg) {
    if (!el) return;
    const width = Math.max(300, Math.round(el.clientWidth || 680));
    const compact = width < 560;
    const height = cfg.height || (compact ? 276 : 344);
    const m = {
      top: compact ? 28 : 34,
      right: compact ? 12 : 18,
      bottom: compact ? 27 : 32,
      left: compact ? 36 : 44,
    };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;
    const rows = cfg.rows || [];
    if (!rows.length) {
      el.innerHTML = '<div style="padding:50px 10px;text-align:center;color:var(--muted);font-size:12px">当前筛选无数据</div>';
      return;
    }
    const n = rows.length;
    const series = (cfg.series || []).filter(s => rows.some(r => isNum(r[s.key])));
    if (!series.length) {
      el.innerHTML = '<div style="padding:50px 10px;text-align:center;color:var(--muted);font-size:12px">当前口径无数据</div>';
      return;
    }

    const x = i => m.left + (n === 1 ? 0.5 : i / (n - 1)) * iw;

    let yMin, yMax, yStep;
    if (cfg.log) {
      const vals = [];
      series.forEach(s => rows.forEach(r => { if (isNum(r[s.key]) && r[s.key] > 0) vals.push(r[s.key]); }));
      const lo = Math.pow(10, Math.floor(Math.log10(Math.min.apply(null, vals))));
      const hi = Math.pow(10, Math.ceil(Math.log10(Math.max.apply(null, vals))));
      yMin = lo; yMax = hi;
      yStep = null;
    } else if (isNum(cfg.yMin) && isNum(cfg.yMax)) {
      yMin = cfg.yMin; yMax = cfg.yMax; yStep = cfg.yStep || null;
    } else {
      const vals = [];
      series.forEach(s => rows.forEach(r => { if (isNum(r[s.key])) vals.push(r[s.key]); }));
      const b = niceBounds(Math.min.apply(null, vals), Math.max.apply(null, vals), compact ? 4 : 5);
      yMin = b.min; yMax = b.max; yStep = b.step;
    }
    if (!(yMax > yMin)) { yMax = yMin + 1; }

    const y = v => {
      if (cfg.log) {
        const lv = Math.log10(Math.max(v, yMin));
        return m.top + (Math.log10(yMax) - lv) / (Math.log10(yMax) - Math.log10(yMin)) * ih;
      }
      return m.top + (yMax - v) / (yMax - yMin) * ih;
    };
    const baseY = y(clamp(0, yMin, yMax));
    const zeroIn = 0 >= yMin && 0 <= yMax;

    // y ticks
    let yTicks = [];
    if (cfg.log) {
      const a = Math.round(Math.log10(yMin)), b = Math.round(Math.log10(yMax));
      for (let k = a; k <= b; k++) yTicks.push(Math.pow(10, k));
    } else if (isNum(yStep) && yStep > 0) {
      for (let v = yMin; v <= yMax + yStep * 0.001; v += yStep) yTicks.push(Math.round(v * 1e6) / 1e6);
    } else {
      yTicks = [yMin, yMin + (yMax - yMin) / 2, yMax];
    }

    // x ticks
    const xTicks = [];
    if (cfg.xType === 'month') {
      const yearStep = cfg.xStep || (n > 120 ? 5 : (n > 60 ? 2 : 1));
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        if (r.m === 1 && r.y % yearStep === 0) xTicks.push(i);
      }
      const lastIdx = n - 1;
      const prevIdx = xTicks.length ? xTicks[xTicks.length - 1] : -1;
      if (prevIdx !== lastIdx) {
        const gap = prevIdx < 0 ? 99 : (rows[lastIdx].y * 12 + rows[lastIdx].m) - (rows[prevIdx].y * 12 + rows[prevIdx].m);
        if (gap >= 18) xTicks.push(lastIdx);
      }
    } else {
      const yearStep = cfg.xStep || (n > 40 ? 10 : 5);
      for (let i = 0; i < n; i++) {
        if (rows[i].year % yearStep === 0) xTicks.push(i);
      }
      if (!xTicks.length) xTicks.push(0);
      const lastIdx = n - 1;
      const prevIdx = xTicks.length ? xTicks[xTicks.length - 1] : -1;
      if (prevIdx !== lastIdx) {
        const gap = prevIdx < 0 ? 99 : rows[lastIdx].year - rows[prevIdx].year;
        const minGap = rows.length > 50 ? 12 : 4;
        if (gap >= minGap) xTicks.push(lastIdx);
      }
    }

    const id = 'c' + (++chartUid);
    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" role="group" aria-label="' + escapeHTML(cfg.ariaLabel || '数据图表') + '">';
    svg += '<defs>';
    svg += '<clipPath id="above' + id + '"><rect x="' + m.left + '" y="' + m.top + '" width="' + iw + '" height="' + Math.max(0, baseY - m.top) + '"/></clipPath>';
    svg += '<clipPath id="below' + id + '"><rect x="' + m.left + '" y="' + baseY + '" width="' + iw + '" height="' + Math.max(0, m.top + ih - baseY) + '"/></clipPath>';
    if (cfg.area) {
      const areaColor = cfg.areaColor || '#1d6b5f';
      svg += '<linearGradient id="pos' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + areaColor + '" stop-opacity=".24"/><stop offset="1" stop-color="' + areaColor + '" stop-opacity=".02"/></linearGradient>';
      svg += '<linearGradient id="neg' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b23b2e" stop-opacity=".04"/><stop offset="1" stop-color="#b23b2e" stop-opacity=".26"/></linearGradient>';
    }
    svg += '</defs>';

    // negative shaded periods
    if (cfg.shadeNegative) {
      let start = null;
      for (let i = 0; i < n; i++) {
        const v = rows[i][cfg.shadeKey || cfg.series[0].key];
        const neg = isNum(v) && v < 0;
        if (neg && start === null) start = i;
        if ((!neg || i === n - 1) && start !== null) {
          const end = neg ? i : i - 1;
          const x1 = Math.max(m.left, x(start) - (n > 1 ? (iw / (n - 1)) * .45 : 0));
          const x2 = Math.min(m.left + iw, x(end) + (n > 1 ? (iw / (n - 1)) * .45 : 0));
          svg += '<rect x="' + x1.toFixed(2) + '" y="' + m.top + '" width="' + Math.max(0, x2 - x1).toFixed(2) + '" height="' + ih + '" fill="#b23b2e" opacity=".035"/>';
          start = null;
        }
      }
    }

    // grid
    yTicks.forEach(v => {
      const yy = y(v);
      if (yy < m.top - .5 || yy > m.top + ih + .5) return;
      svg += '<line x1="' + m.left + '" x2="' + (m.left + iw) + '" y1="' + yy.toFixed(2) + '" y2="' + yy.toFixed(2) + '" stroke="' + (Math.abs(v) < 1e-9 && zeroIn ? 'rgba(24,24,21,.28)' : 'rgba(24,24,21,.075)') + '" stroke-width="1"/>';
      svg += '<text x="' + (m.left - 7) + '" y="' + (yy + 3.5).toFixed(2) + '" text-anchor="end" font-family="SF Mono,Menlo,monospace" font-size="' + (compact ? 8 : 9) + '" fill="#8a8276">' + axisFmt(v, cfg.log && v < 1 ? 0.1 : (yStep || 1)) + '</text>';
    });
    xTicks.forEach(i => {
      const xx = x(i);
      if (xx > m.left + iw + 1) return;
      svg += '<line x1="' + xx.toFixed(2) + '" x2="' + xx.toFixed(2) + '" y1="' + (m.top + ih) + '" y2="' + (m.top + ih + 4) + '" stroke="rgba(24,24,21,.25)" stroke-width="1"/>';
      const label = cfg.xType === 'month' ? String(rows[i].y) : String(rows[i].year);
      svg += '<text x="' + xx.toFixed(2) + '" y="' + (height - 8) + '" text-anchor="middle" font-family="SF Mono,Menlo,monospace" font-size="' + (compact ? 8 : 9) + '" fill="#8a8276">' + label + '</text>';
    });

    // policy band (e.g. Tonglun's -2% ~ +2% comfort range)
    if (Array.isArray(cfg.band) && cfg.band.length === 2) {
      const lo = Math.min(cfg.band[0], cfg.band[1]);
      const hi = Math.max(cfg.band[0], cfg.band[1]);
      if (hi >= yMin && lo <= yMax) {
        const yTop = y(Math.min(hi, yMax));
        const yBot = y(Math.max(lo, yMin));
        svg += '<rect x="' + m.left + '" y="' + yTop.toFixed(2) + '" width="' + iw + '" height="' + Math.max(0, yBot - yTop).toFixed(2) + '" fill="#1d6b5f" opacity=".055"/>';
        svg += '<line x1="' + m.left + '" x2="' + (m.left + iw) + '" y1="' + yTop.toFixed(2) + '" y2="' + yTop.toFixed(2) + '" stroke="#1d6b5f" stroke-width="1" stroke-dasharray="3 4" opacity=".35"/>';
        svg += '<line x1="' + m.left + '" x2="' + (m.left + iw) + '" y1="' + yBot.toFixed(2) + '" y2="' + yBot.toFixed(2) + '" stroke="#1d6b5f" stroke-width="1" stroke-dasharray="3 4" opacity=".35"/>';
        if (cfg.bandLabel) svg += '<text x="' + (m.left + iw - 2) + '" y="' + (yTop - 4).toFixed(2) + '" text-anchor="end" font-size="7.5" fill="#1d6b5f" font-family="PingFang SC,Noto Sans SC,sans-serif" opacity=".75">' + escapeHTML(cfg.bandLabel) + '</text>';
      }
    }

    // events
    if (cfg.events && cfg.events.length) {
      const compactYears = cfg.compactEvents || [1988, 2008, 2022];
      const evs = compact ? cfg.events.filter(e => compactYears.indexOf(e.year) >= 0) : cfg.events;
      evs.forEach((ev, ei) => {
        let idx = -1;
        if (cfg.xType === 'month') idx = rows.findIndex(r => r.y === ev.year && r.m === 1);
        else idx = rows.findIndex(r => r.year === ev.year);
        if (idx < 0) return;
        const xx = x(idx);
        if (xx < m.left || xx > m.left + iw) return;
        svg += '<line x1="' + xx.toFixed(2) + '" x2="' + xx.toFixed(2) + '" y1="' + m.top + '" y2="' + (m.top + ih) + '" stroke="rgba(24,24,21,.16)" stroke-width="1" stroke-dasharray="2 4"/>';
        const labelY = m.top - 9 - (cfg.eventStagger ? (ei % 2) * 12 : 0);
        svg += '<text x="' + xx.toFixed(2) + '" y="' + labelY + '" text-anchor="middle" font-size="' + (compact ? 7.5 : 8.5) + '" fill="#8a8276" font-family="PingFang SC,Noto Sans SC,sans-serif">' + escapeHTML(ev.label) + '</text>';
      });
    }

    // areas & lines
    series.forEach((s, si) => {
      const pts = [];
      rows.forEach((r, i) => { if (isNum(r[s.key])) pts.push([x(i), y(r[s.key])]); });
      if (!pts.length) return;
      if (s.area && cfg.area) {
        const ap = areaPath(pts, baseY);
        svg += '<path d="' + ap + '" fill="url(#pos' + id + ')" clip-path="url(#above' + id + ')"/>';
        svg += '<path d="' + ap + '" fill="url(#neg' + id + ')" clip-path="url(#below' + id + ')"/>';
      }
      const dash = s.dash ? ' stroke-dasharray="5 4"' : '';
      const widthLine = s.width || (s.dash ? 1.25 : 1.9);
      svg += '<path d="' + linePath(pts) + '" fill="none" stroke="' + (s.color || '#181815') + '" stroke-width="' + widthLine + '" stroke-linejoin="round" stroke-linecap="round"' + dash + ' opacity="' + (s.opacity || 1) + '"/>';
      // last point
      const last = pts[pts.length - 1];
      svg += '<circle cx="' + last[0].toFixed(2) + '" cy="' + last[1].toFixed(2) + '" r="3.2" fill="' + (s.dash ? '#fbf8f2' : '#181815') + '" stroke="' + (s.color || '#181815') + '" stroke-width="1.4"/>';
    });

    if (zeroIn && !cfg.log) {
      svg += '<line x1="' + m.left + '" x2="' + (m.left + iw) + '" y1="' + baseY.toFixed(2) + '" y2="' + baseY.toFixed(2) + '" stroke="rgba(24,24,21,.55)" stroke-width="1"/>';
      svg += '<text x="' + (m.left + iw - 2) + '" y="' + (baseY - 5).toFixed(2) + '" text-anchor="end" font-family="SF Mono,Menlo,monospace" font-size="8" fill="#8a8276">0</text>';
    }
    if (isNum(cfg.hLine)) {
      const hy = y(cfg.hLine);
      if (hy >= m.top - .5 && hy <= m.top + ih + .5) {
        svg += '<line x1="' + m.left + '" x2="' + (m.left + iw) + '" y1="' + hy.toFixed(2) + '" y2="' + hy.toFixed(2) + '" stroke="#a97a24" stroke-width="1" stroke-dasharray="4 4" opacity=".65"/>';
        svg += '<text x="' + (m.left + 4) + '" y="' + (hy - 5).toFixed(2) + '" font-family="SF Mono,Menlo,monospace" font-size="8" fill="#a97a24">' + escapeHTML(cfg.hLineLabel || '均值') + '</text>';
      }
    }

    // hover layer
    svg += '<line class="hover-line" x1="0" x2="0" y1="' + m.top + '" y2="' + (m.top + ih) + '" stroke="rgba(24,24,21,.45)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>';
    series.forEach((s, si) => {
      svg += '<circle class="hover-dot" data-si="' + si + '" cx="0" cy="0" r="4" fill="#fbf8f2" stroke="' + (s.color || '#181815') + '" stroke-width="1.6" opacity="0"/>';
    });
    svg += '<rect class="hover-layer" x="' + m.left + '" y="' + m.top + '" width="' + iw + '" height="' + ih + '" fill="transparent" style="cursor:crosshair"/>';
    svg += '</svg>';
    el.innerHTML = svg + '<div class="chart-tip" aria-hidden="true"></div>';

    const svgEl = el.querySelector('svg');
    const tip = el.querySelector('.chart-tip');
    const hoverLine = el.querySelector('.hover-line');
    const hoverDots = $$('.hover-dot', el);
    const layer = el.querySelector('.hover-layer');

    function showAt(clientX) {
      const rect = svgEl.getBoundingClientRect();
      const px = (clientX - rect.left) * (width / rect.width);
      let i = Math.round((px - m.left) / (iw || 1) * (n - 1));
      i = clamp(i, 0, n - 1);
      const xx = x(i);
      const row = rows[i];
      hoverLine.setAttribute('x1', xx);
      hoverLine.setAttribute('x2', xx);
      hoverLine.setAttribute('opacity', '1');
      series.forEach((s, si) => {
        const dot = hoverDots[si];
        if (!dot) return;
        if (isNum(row[s.key])) {
          dot.setAttribute('cx', xx);
          dot.setAttribute('cy', y(row[s.key]));
          dot.setAttribute('opacity', '1');
        } else dot.setAttribute('opacity', '0');
      });
      if (cfg.tooltip) tip.innerHTML = cfg.tooltip(row, i, series);
      tip.classList.add('show');
      const tw = 176;
      let left = xx + 12;
      if (left + tw > width - 8) left = xx - tw - 12;
      tip.style.left = clamp(left, 8, width - tw - 8) + 'px';
      tip.style.top = (m.top + 4) + 'px';
    }
    function hide() {
      tip.classList.remove('show');
      hoverLine.setAttribute('opacity', '0');
      hoverDots.forEach(d => d.setAttribute('opacity', '0'));
    }
    layer.addEventListener('pointermove', e => { e.preventDefault(); showAt(e.clientX); });
    layer.addEventListener('pointerdown', e => { showAt(e.clientX); });
    layer.addEventListener('pointerleave', hide);
    layer.addEventListener('pointercancel', hide);
    el._chart = { showAt, hide };
  }

  function sparkline(values, color) {
    const vals = values.filter(isNum);
    if (vals.length < 2) return '';
    const w = 64, h = 22;
    const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    const span = (max - min) || 1;
    const pts = vals.map((v, i) => [i / (vals.length - 1) * w, h - 2 - (v - min) / span * (h - 4)]);
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="' + linePath(pts) + '" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  /* ---------- hero / metrics ---------- */
  function latestMonth() { return monthly[monthly.length - 1]; }
  function annualRow(year) { return annual.find(r => r.year === year); }

  function renderHero() {
    const m = latestMonth();
    if (!m) return;
    const v = m[state.lens];
    $('#heroRate').textContent = isNum(v) ? Math.abs(v).toFixed(2) : '—';
    $('#heroSign').textContent = isNum(v) ? (v < 0 ? '−' : '+') : '';
    $('#heroSign').className = 'pulse-sign ' + (isNum(v) && v < 0 ? 'neg' : '');
    $('#heroLabel').textContent = LENS[state.lens].label;
    $('#pulseMonth').textContent = m.ym;
    $('#pulseCpi').textContent = fmtSigned(m.cpi, 1);
    $('#pulseCpi').className = signClass(m.cpi);
    $('#pulseDep').textContent = fmtUnsigned(m.dep, 2);
    $('#pulseHouse').textContent = fmtSigned(m.house, 2);
    $('#pulseHouse').className = signClass(m.house);
    $('#pulseMoney').textContent = fmtSigned(m.moneyReal, 2);
    $('#pulseMoney').className = signClass(m.moneyReal);
    $('#pulseCpiReal').textContent = fmtSigned(m.cpiReal, 2);
    $('#pulseCpiReal').className = signClass(m.cpiReal);
    const mr = monthlyRows();
    if (mr.length) $('#monthlyRangeLabel').textContent = mr[0].ym + ' 至 ' + mr[mr.length - 1].ym;
    const synced = !!(state.remote && state.remote.monthly && state.remote.latestMonth === m.ym);
    $('#statusText').textContent = synced ? '官方已同步 · ' + m.ym : '数据截至 ' + m.ym;
    $('#footerDate').textContent = m.ym;
    if ($('#formulaAsOf')) $('#formulaAsOf').textContent = (synced ? '官方自动同步 · ' : '数据截至 ') + m.ym;

    let text;
    if (isNum(m.doubleReal) && m.doubleReal < 0) {
      text = m.ym + '：通论口径（CPI + 货币扩张）为 ' + fmtSigned(m.doubleReal, 2) + '，货币扩张口径为 ' + fmtSigned(m.moneyReal, 2) + '。按《通论》公式，现金正在被 CPI 与货币扩张同时挤压。';
    } else {
      text = m.ym + '：通论口径为 ' + fmtSigned(m.doubleReal, 2) + '，CPI 口径为 ' + fmtSigned(m.cpiReal, 2) + '。';
    }
    $('#calloutText').textContent = text;
  }

  function renderMetrics() {
    const m = latestMonth();
    const last24 = monthly.slice(-24);
    const cards = [
      { label: 'CPI 同比', value: m.cpi, d: 1, sub: '官方 · ' + m.ym, color: '#a97a24', key: 'cpi', signed: true },
      { label: '一年期定存', value: m.dep, d: 2, sub: '大行挂牌 / 基准', color: '#181815', key: 'dep', signed: false },
      { label: '70 城新房同比', value: m.house, d: 2, sub: '70 城中位数', color: '#b23b2e', key: 'house', signed: true },
      { label: 'M2 同比', value: m.m2, d: 1, sub: '同比 · 月末 ' + m.ym, color: '#3d5f84', key: 'm2', signed: true },
    ];
    $('#metricStrip').innerHTML = cards.map(c => {
      const suffix = '%';
      const cls = signClass(c.value);
      const v = isNum(c.value) ? (c.signed ? (c.value < 0 ? '−' : (c.value > 0 ? '+' : '')) : '') + Math.abs(c.value).toFixed(c.d) : '—';
      return '<div class="metric">' +
        '<div class="metric-top"><span>' + c.label + '</span><span class="dot" style="background:' + c.color + '"></span></div>' +
        '<div class="metric-value ' + cls + '">' + v + '<small>' + suffix + '</small></div>' +
        '<div class="metric-sub"><span>' + c.sub + '</span>' + sparkline(last24.map(r => r[c.key]), c.color) + '</div>' +
      '</div>';
    }).join('');
  }

  /* ---------- annual ---------- */
  function annualRows() {
    let rows = annual.filter(r => r.year >= state.annualStart && isNum(r[state.lens]));
    return rows;
  }

  function renderAnnualChart() {
    const el = $('#annualChart');
    if (!el) return;
    const rows = annualRows();
    const main = state.lens;
    const series = [{
      key: main,
      label: LENS[main].label,
      color: '#181815',
      area: true,
      width: 2,
    }];
    $('#annualMainLabel').textContent = LENS[main].label;
    drawChart(el, {
      rows,
      series,
      area: true,
      shadeNegative: main !== 'moneyReal',
      shadeKey: main,
      xType: 'year',
      xStep: rows.length > 60 ? 10 : (rows.length > 25 ? 5 : 2),
      events: APP.events,
      band: main === 'doubleReal' ? [-2, 2] : null,
      bandLabel: '通论合理区间 −2%~+2%',
      ariaLabel: '中国实质利率年度曲线',
      tooltip: (r) => {
        const lines = [
          ['实质利率', fmtSigned(r.doubleReal, 2)],
          ['CPI 口径', fmtSigned(r.cpiReal, 2)],
          ['货币口径', fmtSigned(r.moneyReal, 2)],
          ['CPI / 定存', fmt(r.cpi, 1) + '% / ' + fmt(r.dep, 2) + '%'],
          ['房价 / M2', fmt(r.house, 1) + '% / ' + fmt(r.m2, 1) + '%'],
        ];
        return '<b>' + r.year + ' 年</b>' + lines.map(([k, v]) =>
          '<div class="tip-row"><span>' + k + '</span><em class="' + (String(v).indexOf('−') === 0 ? 'neg' : '') + '">' + v + '</em></div>'
        ).join('');
      }
    });
  }

  function computeStats(start) {
    const key = state.lens;
    const rows = annual.filter(r => r.year >= start && isNum(r[key]));
    const neg = rows.filter(r => r[key] < 0);
    let cur = [], runs = [];
    rows.forEach(r => {
      if (r[key] < 0) cur.push(r.year);
      else { if (cur.length) runs.push(cur); cur = []; }
    });
    if (cur.length) runs.push(cur);
    const longest = runs.sort((a, b) => b.length - a.length)[0] || [];
    const deepest = rows.reduce((a, b) => (b[key] < a[key] ? b : a), rows[0] || {});
    return { n: rows.length, neg: neg.length, share: rows.length ? neg.length / rows.length * 100 : null, longest, deepest, key };
  }

  function renderAnnualStats() {
    const start = state.lens === 'doubleReal' ? 2016 : 1978;
    const s = computeStats(start);
    const m = latestMonth();
    $('#annualStats').innerHTML =
      '<div class="stat"><span>' + start + ' 年以来负利率年份</span><b>' + (s.share == null ? '—' : s.share.toFixed(0)) + '<small>%</small></b><p>' + s.neg + ' / ' + s.n + ' 年</p></div>' +
      '<div class="stat"><span>最长连续负利率</span><b>' + s.longest.length + '<small>年</small></b><p>' + (s.longest.length ? s.longest[0] + '—' + s.longest[s.longest.length - 1] : '—') + '</p></div>' +
      '<div class="stat"><span>最深负利率</span><b class="neg">' + fmtSigned(s.deepest[s.key], 1) + '</b><p>' + (s.deepest.year || '—') + ' 年 · ' + LENS[s.key].short + '</p></div>' +
      '<div class="stat"><span>当前 · ' + m.ym + '</span><b class="' + signClass(m[s.key]) + '">' + fmtSigned(m[s.key], 2) + '</b><p>一年期定存 ' + fmt(m.dep, 2) + '%</p></div>';
  }

  function cell(v, decimals, opts) {
    opts = opts || {};
    if (!isNum(v)) return '<td>' + (opts.zero || '—') + '</td>';
    const cls = opts.colored ? signClass(v) : '';
    const strong = opts.strong ? ' strong' : '';
    const nearZero = Math.abs(v) < 0.05 && decimals === 1;
    const txt = nearZero ? '0.0' : (opts.signed ? fmtSigned(v, decimals) : (v < 0 ? '−' : '') + Math.abs(v).toFixed(decimals));
    const inner = opts.est
      ? '<span class="est" title="' + escapeHTML(opts.est) + '">' + txt + '</span>'
      : txt;
    return '<td class="' + (cls + strong).trim() + '">' + inner + '</td>';
  }

  function renderAnnualTable() {
    const wrap = $('#annualTableWrap');
    if (!wrap) return;
    let rows = annual.slice().sort((a, b) => b.year - a.year);
    if (state.annualFilter === '1978') rows = rows.filter(r => r.year >= 1978);
    if (state.annualFilter === '2000') rows = rows.filter(r => r.year >= 2000);
    if (state.annualFilter === 'negative') rows = rows.filter(r => isNum(r.doubleReal) && r.doubleReal < 0);
    const nbs = 'https://www.stats.gov.cn/sj/ndsj/';
    const cpiUrl = 'https://www.stats.gov.cn/sj/zxfb/202611/t20261109_1965795.html';
    const nbsM = 'https://www.stats.gov.cn/sj/zxfb/';
    const pbcM2 = 'http://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html';
    const pbcRate = 'http://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125440/125838/125888/index.html';
    const goldSrc = 'https://www.gold.org/goldhub/data/gold-prices';
    const src = (label, url, title) => '<th>' + label + ' <a class="th-src" href="' + url + '"' + (url.charAt(0) === '#' ? '' : ' target="_blank" rel="noopener noreferrer"') + ' title="来源：' + title + '">↗</a></th>';
    let html = '<table><thead><tr>' +
      '<th>年份</th>' + src('CPI', cpiUrl, '国家统计局 2026-10 CPI') + src('定存', pbcRate, '中国人民银行') + src('实质利率', '#sources', '计算值；公式见《通论》p294/p338') +
      src('CPI 口径', '#sources', '计算值') + src('货币口径', '#sources', '计算值') + src('GDP', nbs, '国家统计局 / World Bank') +
      src('M2', pbcM2, '中国人民银行') + src('房价', nbsM, '国家统计局 70 城') + src('100元购买力', '#sources', '由 CPI 计算') + src('黄金 ¥/g', goldSrc, 'Gold.org / LBMA') +
      '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="11" class="table-empty">当前筛选没有数据</td></tr>';
    rows.forEach(r => {
      const cur = r.year === APP.meta.latestAnnual;
      const cpiEst = r.year <= 1985 ? '1985 年前为历史估算' : (r.year === 2026 ? '2026 为 1—10 月均值' : '');
      const houseEst = r.year === 1987 ? '1987 为房价基年，无同比' : ((r.year >= 1988 && r.year <= 2010) ? '1988—2010 为年度估算' : (r.year === 2026 ? '70 城 1—10 月' : ''));
      const gdpEst = r.year <= 1960 ? '1950—1960 为估算' : (r.year === 2026 ? '前三季度' : '');
      html += '<tr class="' + (cur ? 'is-current' : '') + '">' +
        '<td>' + r.year + (cur ? ' <span style="color:var(--gold);font-size:8px">年内</span>' : '') + '</td>' +
        cell(r.cpi, 1, { signed: true, est: cpiEst }) +
        cell(r.dep, 2, {}) +
        cell(r.doubleReal, 1, { signed: true, colored: true, strong: true }) +
        cell(r.cpiReal, 1, { signed: true, colored: true }) +
        cell(r.moneyReal, 1, { signed: true, colored: true }) +
        cell(r.gdp, 1, { est: gdpEst }) +
        cell(r.m2, 1, {}) +
        cell(r.house, 1, { signed: true, colored: true, est: houseEst, zero: r.year === 1987 ? '基年' : '—' }) +
        cell(r.pp100, 1, {}) +
        cell(r.goldCnyG, 0, {}) +
      '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  /* ---------- monthly ---------- */
  function monthlyRows() {
    const n = state.monthlyMonths;
    const rows = n > 0 ? monthly.slice(-n) : monthly.slice();
    return rows.filter(r => isNum(r.doubleReal));
  }

  function renderMonthlyChart() {
    const el = $('#monthlyChart');
    if (!el) return;
    const rows = monthlyRows();
    if (rows.length) $('#monthlyRangeLabel').textContent = rows[0].ym + ' 至 ' + rows[rows.length - 1].ym;
    drawChart(el, {
      rows,
      series: [
        { key: 'doubleReal', label: '通论口径', color: '#181815', area: true, width: 1.8 },
      ],
      area: true,
      shadeNegative: true,
      shadeKey: 'doubleReal',
      xType: 'month',
      xStep: rows.length > 120 ? 5 : (rows.length > 60 ? 2 : 1),
      events: APP.events,
      ariaLabel: '中国月度实质利率曲线',
      tooltip: (r) => {
        return '<b>' + r.ym + '</b>' +
          '<div class="tip-row"><span>实质利率</span><em class="' + signClass(r.doubleReal) + '">' + fmtSigned(r.doubleReal, 2) + '</em></div>' +
          '<div class="tip-row"><span>CPI 口径</span><em class="' + signClass(r.cpiReal) + '">' + fmtSigned(r.cpiReal, 2) + '</em></div>' +
          '<div class="tip-row"><span>货币口径</span><em class="' + signClass(r.moneyReal) + '">' + fmtSigned(r.moneyReal, 2) + '</em></div>' +
          '<div class="tip-row"><span>CPI / 房价</span><em>' + fmt(r.cpi, 1) + '% / ' + fmt(r.house, 1) + '%</em></div>' +
          '<div class="tip-row"><span>定存 / M2</span><em>' + fmt(r.dep, 2) + '% / ' + fmt(r.m2, 1) + '%</em></div>' +
          (r.isOverride ? '<div class="tip-row"><span style="color:#f0a89c">本地修订</span><em>✓</em></div>' : '');
      }
    });
  }

  function renderMonthlyStats() {
    const last = monthly.slice(-12).filter(r => isNum(r.doubleReal));
    const avg = mean(last.map(r => r.doubleReal));
    const neg = last.filter(r => r.doubleReal < 0).length;
    const m = latestMonth();
    $('#monthlyStats').innerHTML =
      '<div class="stat"><span>当前 · 通论口径</span><b class="' + signClass(m.doubleReal) + '">' + fmtSigned(m.doubleReal, 2) + '</b><p>' + m.ym + ' · 定存 ' + fmt(m.dep, 2) + '%</p></div>' +
      '<div class="stat"><span>近 12 个月均值</span><b class="' + signClass(avg) + '">' + fmtSigned(avg, 2) + '</b><p>' + (last.length ? last[0].ym + ' — ' + last[last.length - 1].ym : '—') + '</p></div>' +
      '<div class="stat"><span>近 12 个月负利率月份</span><b>' + neg + '<small> / ' + last.length + '</small></b><p>按通论口径</p></div>' +
      '<div class="stat"><span>70 城房价同比</span><b class="' + signClass(m.house) + '">' + fmtSigned(m.house, 2) + '</b><p>中位数 · ' + m.ym + '</p></div>';
  }

  function renderHouseChart() {
    const el = $('#houseChart');
    if (!el) return;
    const rows = monthly.filter(r => r.ym >= '2011-01');
    drawChart(el, {
      rows,
      series: [
        { key: 'house', label: '70 城房价', color: '#b23b2e', width: 1.8 },
        { key: 'cpi', label: 'CPI', color: '#1d6b5f', width: 1.4 },
      ],
      area: false,
      shadeNegative: false,
      xType: 'month',
      xStep: 5,
      ariaLabel: '70城房价同比与CPI同比',
      tooltip: (r) => '<b>' + r.ym + '</b>' +
        '<div class="tip-row"><span>70 城房价</span><em class="' + signClass(r.house) + '">' + fmtSigned(r.house, 2) + '</em></div>' +
        '<div class="tip-row"><span>CPI</span><em class="' + signClass(r.cpi) + '">' + fmtSigned(r.cpi, 2) + '</em></div>' +
        '<div class="tip-row"><span>定存</span><em>' + fmt(r.dep, 2) + '%</em></div>'
    });
  }

  function renderMonthlyTable() {
    const wrap = $('#monthlyTableWrap');
    if (!wrap) return;
    let rows = monthly.slice().reverse();
    if (state.monthlyFilter === '24') rows = rows.slice(0, 24);
    if (state.monthlyFilter === '180') rows = rows.filter(r => r.ym >= '2011-01');
    if (state.monthlyFilter === 'negative') rows = rows.filter(r => isNum(r.doubleReal) && r.doubleReal < 0);
    const nbsM = 'https://www.stats.gov.cn/sj/zxfb/';
    const cpiUrl = 'https://www.stats.gov.cn/sj/zxfb/202611/t20261109_1965795.html';
    const pbcM2 = 'http://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html';
    const pbcRate = 'http://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125440/125838/125888/index.html';
    const goldSrc = 'https://www.gold.org/goldhub/data/gold-prices';
    const src = (label, url, title) => '<th>' + label + ' <a class="th-src" href="' + url + '"' + (url.charAt(0) === '#' ? '' : ' target="_blank" rel="noopener noreferrer"') + ' title="来源：' + title + '">↗</a></th>';
    let html = '<table><thead><tr>' +
      '<th>月份</th>' + src('CPI', cpiUrl, '国家统计局 2026-10 CPI') + src('定存', pbcRate, '中国人民银行') + src('实质利率', '#sources', '计算值；公式见《通论》p294/p338') +
      src('CPI 口径', '#sources', '计算值') + src('货币口径', '#sources', '计算值') + src('房价同比', nbsM, '国家统计局 70 城') +
      src('M2', pbcM2, '中国人民银行') + src('GDP', nbsM, '国家统计局') + src('黄金 ¥/g', goldSrc, 'Gold.org') +
      '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="10" class="table-empty">当前筛选没有数据</td></tr>';
    rows.forEach(r => {
      const cur = r.ym === latestMonth().ym;
      const cpiEst = '';
      const houseEst = r.ym < '2011-01' ? '2011 年前为年度估算' : '';
      const m2Est = r.ym < '2008-01' ? '2008 年前为年度估算' : '';
      const gdpTxt = isNum(r.gdp) ? fmt(r.gdp, 1) : '—';
      html += '<tr class="' + (cur ? 'is-current' : '') + '">' +
        '<td>' + r.ym + (r.isOverride ? ' <span style="color:var(--gold);font-size:8px">修订</span>' : '') + '</td>' +
        cell(r.cpi, 1, { signed: true, est: cpiEst }) +
        cell(r.dep, 2, {}) +
        cell(r.doubleReal, 2, { signed: true, colored: true, strong: true }) +
        cell(r.cpiReal, 2, { signed: true, colored: true }) +
        cell(r.moneyReal, 2, { signed: true, colored: true }) +
        cell(r.house, 1, { signed: true, colored: true, est: houseEst }) +
        cell(r.m2, 1, { est: m2Est }) +
        '<td title="' + escapeHTML(r.gdpPeriod || '') + '">' + gdpTxt + (isNum(r.gdp) ? '<span style="font-size:7px;color:var(--muted-2)"> 累计</span>' : '') + '</td>' +
        cell(r.goldCnyG, 0, {}) +
      '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  /* ---------- prices + video 20x ---------- */
  function livingRows() { return (APP.living || []).slice(); }

  function renderPurchase() {
    const living = livingRows();
    if (!living.length) return;
    const first = living[0], cur = living[living.length - 1];
    const comma = n => Math.round(n).toLocaleString('zh-CN');
    const mult = (a, b) => (b / a).toFixed(a < 1 ? 0 : 1);

    $('#priceStats').innerHTML =
      '<div class="stat"><span>大米 · 1950→2026</span><b>' + fmt(first.rice, 2) + ' → ' + fmt(cur.rice, 2) + '<small>元/斤</small></b><p>约 ' + mult(first.rice, cur.rice) + ' 倍</p></div>' +
      '<div class="stat"><span>猪肉 · 1950→2026</span><b>' + fmt(first.pork, 2) + ' → ' + fmt(cur.pork, 2) + '<small>元/斤</small></b><p>约 ' + mult(first.pork, cur.pork) + ' 倍</p></div>' +
      '<div class="stat"><span>居民用电 · 1950→2026</span><b>' + fmt(first.power, 2) + ' → ' + fmt(cur.power, 2) + '<small>元/度</small></b><p>约 ' + mult(first.power, cur.power) + ' 倍</p></div>' +
      '<div class="stat"><span>2026 · 年平均工资（估算）</span><b>' + fmt(cur.wage, 0) + '<small>元</small></b><p>2025 官方 129,441 · 月均 ' + fmt(cur.wage / 12, 0) + '</p></div>';

    const showYears = [1950, 1978, 1990, 2000, 2010, 2020, 2026];
    const nbsYear = 'https://www.stats.gov.cn/sj/ndsj/';
    const nbsWage = 'https://www.stats.gov.cn/sj/zxfb/202605/t20260515_1963707.html';
    const src = (label, url, title) => '<th>' + label + ' <a class="th-src" href="' + url + '" target="_blank" rel="noopener noreferrer" title="来源：' + title + '">↗</a></th>';
    let html = '<table><thead><tr><th>年份</th>' + src('大米<br><span style="font-weight:400">元/斤</span>', nbsYear, '国家统计局历年统计年鉴') +
      src('猪肉<br><span style="font-weight:400">元/斤</span>', nbsYear, '国家统计局历年统计年鉴') +
      src('居民用电<br><span style="font-weight:400">元/度</span>', nbsYear, '国家统计局历年统计年鉴') +
      src('年平均工资<br><span style="font-weight:400">元</span>', nbsWage, '国家统计局年度数据') +
      src('月平均工资<br><span style="font-weight:400">元</span>', nbsWage, '国家统计局年度数据') + '</tr></thead><tbody>';
    showYears.forEach(y => {
      const r = living.find(x => x.year === y);
      if (!r) return;
      html += '<tr class="' + (y === cur.year ? 'is-current' : '') + '">' +
        '<td>' + y + (y === cur.year ? ' <span style="color:var(--gold);font-size:8px">估算</span>' : '') + '</td>' +
        '<td>' + fmt(r.rice, 2) + '</td><td>' + fmt(r.pork, 2) + '</td><td>' + fmt(r.power, 2) + '</td><td>' + fmt(r.wage, 0) + '</td><td>' + fmt(r.wage / 12, 0) + '</td></tr>';
    });
    html += '</tbody></table>';
    $('#livingTableWrap').innerHTML = html;

    $('#livingMobile').innerHTML = showYears.map(y => {
      const r = living.find(x => x.year === y);
      if (!r) return '';
      return '<div class="living-mobile-card">' +
        '<div class="lm-head"><b>' + y + (y === cur.year ? ' · 估算' : '') + '</b><span></span></div>' +
        '<div class="lm-row">大米 <b>' + fmt(r.rice, 2) + '</b> 元/斤</div>' +
        '<div class="lm-row">猪肉 <b>' + fmt(r.pork, 2) + '</b> 元/斤 · 电 <b>' + fmt(r.power, 2) + '</b> 元/度</div>' +
        '<div class="lm-row">年平均工资 <b>¥' + fmt(r.wage, 0) + '</b> · 月均 ¥' + fmt(r.wage / 12, 0) + '</div>' +
      '</div>';
    }).join('');

    // gold card (price history, not part of the purchasing basket)
    const m = latestMonth();
    const goldCny = m.goldCnyG;
    const grams = isNum(goldCny) && goldCny > 0 ? 100 / goldCny : null;
    const grams1950 = 100 / 2.7;
    $('#goldNow').textContent = state.goldMode === 'cny' ? (isNum(goldCny) ? Math.round(goldCny) : '—') : (isNum(m.goldUsd) ? Math.round(m.goldUsd) : '—');
    $('#goldUnitLabel').textContent = state.goldMode === 'cny' ? '元/克 · 2026-10 月均' : '$/盎司 · 2026-10 月均';
    $('#goldCopy').textContent = '100 元今天大约只能买到 ' + (grams ? grams.toFixed(2) : '—') + ' 克黄金；1950 年，同样的钱可以买到约 ' + grams1950.toFixed(0) + ' 克。';
  }

  function renderPriceChart() {
    const el = $('#priceChart');
    if (!el) return;
    const rows = livingRows();
    drawChart(el, {
      rows,
      series: [
        { key: 'rice', label: '大米 元/斤', color: '#a97a24', width: 1.7 },
        { key: 'pork', label: '猪肉 元/斤', color: '#b23b2e', width: 1.7 },
        { key: 'power', label: '电 元/度', color: '#1d6b5f', width: 1.7 },
      ],
      area: false,
      log: true,
      yMin: 0.05,
      yMax: 50,
      shadeNegative: false,
      xType: 'year',
      xStep: 10,
      events: [
        { year: 1978, label: '改革开放' },
        { year: 2000, label: '加入 WTO' },
        { year: 2026, label: '2026' },
      ],
      compactEvents: [1978, 2000, 2026],
      ariaLabel: '1950年以来大米、猪肉、居民用电价格',
      tooltip: (r) => '<b>' + r.year + ' 年</b>' +
        '<div class="tip-row"><span>大米</span><em>' + fmt(r.rice, 2) + ' 元/斤</em></div>' +
        '<div class="tip-row"><span>猪肉</span><em>' + fmt(r.pork, 2) + ' 元/斤</em></div>' +
        '<div class="tip-row"><span>居民用电</span><em>' + fmt(r.power, 2) + ' 元/度</em></div>' +
        '<div class="tip-row"><span>年平均工资</span><em>¥' + fmt(r.wage, 0) + '</em></div>'
    });
  }

  function renderGoldOilStats() {
    const rows = (APP.goldOil || []).slice();
    if (!rows.length) return;
    const cur = rows[rows.length - 1], first = rows[0];
    const avg = mean(rows.filter(r => r.year <= 2025).map(r => r.ratio));
    const peak = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a), rows[0]);
    $('#goldOilStats').innerHTML =
      '<div class="stat"><span>2026 · 金油比</span><b class="gold">' + fmt(cur.ratio, 1) + '</b><p>1 盎司黄金 ≈ ' + fmt(cur.ratio, 0) + ' 桶 WTI</p></div>' +
      '<div class="stat"><span>1949 · 起点</span><b>' + fmt(first.ratio, 1) + '</b><p>黄金官价 $' + fmt(first.goldUsd, 0) + ' / 油 $' + fmt(first.oilUsd, 2) + '</p></div>' +
      '<div class="stat"><span>1949—2025 均值</span><b>' + fmt(avg, 1) + '</b><p>长期相对价格中枢</p></div>' +
      '<div class="stat"><span>区间最高</span><b>' + fmt(peak.ratio, 1) + '</b><p>' + peak.year + ' 年 · 油 $' + fmt(peak.oilUsd, 0) + '</p></div>';
  }

  function renderGoldOilChart() {
    const el = $('#goldOilChart');
    if (!el) return;
    const rows = (APP.goldOil || []).slice();
    const avg = mean(rows.filter(r => r.year <= 2025).map(r => r.ratio));
    drawChart(el, {
      rows,
      series: [{ key: 'ratio', label: '金油比', color: '#a97a24', area: true, width: 1.8 }],
      area: true,
      areaColor: '#a97a24',
      shadeNegative: false,
      xType: 'year',
      xStep: 10,
      hLine: avg,
      hLineLabel: '1949—2025 均值 ' + fmt(avg, 1),
      events: [
        { year: 1973, label: '石油危机' },
        { year: 1980, label: '二次石油危机' },
        { year: 2008, label: '金融危机' },
        { year: 2020, label: '疫情' },
        { year: 2022, label: '俄乌冲突' },
      ],
      eventStagger: true,
      compactEvents: [1973, 1980, 2020],
      ariaLabel: '1949年以来金油比年度趋势',
      tooltip: (r) => '<b>' + r.year + ' 年</b>' +
        '<div class="tip-row"><span>金油比</span><em class="gold">' + fmt(r.ratio, 1) + '</em></div>' +
        '<div class="tip-row"><span>黄金</span><em>$' + fmt(r.goldUsd, 0) + '/oz</em></div>' +
        '<div class="tip-row"><span>WTI 原油</span><em>$' + fmt(r.oilUsd, 2) + '/桶</em></div>'
    });
  }

  function renderGoldChart() {
    const el = $('#goldChart');
    if (!el) return;
    const key = state.goldMode === 'cny' ? 'goldCnyG' : 'goldUsd';
    const rows = annual.filter(r => r.year >= 1950 && isNum(r[key]) && r[key] > 0);
    drawChart(el, {
      rows,
      series: [{ key, label: state.goldMode === 'cny' ? '黄金 ¥/克' : '黄金 $/盎司', color: '#a97a24', area: true, width: 1.7 }],
      area: true,
      log: state.goldLog,
      shadeNegative: false,
      xType: 'year',
      xStep: 10,
      areaColor: '#a97a24',
      ariaLabel: '黄金价格历史',
      tooltip: (r) => '<b>' + r.year + ' 年</b>' +
        '<div class="tip-row"><span>人民币/克</span><em>' + fmt(r.goldCnyG, 0) + '</em></div>' +
        '<div class="tip-row"><span>美元/盎司</span><em>' + fmt(r.goldUsd, 0) + '</em></div>' +
        '<div class="tip-row"><span>100 元买金</span><em>' + (isNum(r.goldCnyG) && r.goldCnyG > 0 ? (100 / r.goldCnyG).toFixed(2) : '—') + ' g</em></div>'
    });
  }

  function renderGoldLive() {
    const g = state.liveGold || APP.meta.goldSpot;
    if (!g) return;
    const fx = latestMonth() ? (latestMonth().fx || 6.684) : 6.684;
    const cny = g.usd / 31.1034768 * fx;
    $('#goldLiveUsd').textContent = '$' + Math.round(g.usd).toLocaleString('en-US') + ' / oz · ¥' + Math.round(cny) + '/g';
    $('#goldLiveTime').textContent = (state.liveGold ? '已更新 · ' : '内置快照 · ') + goldTime(g.at);
    $('#footerGold').textContent = '$' + Math.round(g.usd) + '/oz';
  }

  /* ---------- sources / freshness ---------- */
  function renderSources() {
    const src = [
      ['国家统计局', 'CPI / 70城房价 / GDP', 'https://www.stats.gov.cn/'],
      ['中国人民银行', 'M2 / 存款基准利率', 'http://www.pbc.gov.cn/'],
      ['World Bank', '长期 GDP / CPI / 汇率', 'https://data.worldbank.org/country/china'],
      ['FRED', 'CPI / 汇率 / WTI 原油', 'https://fred.stlouisfed.org/'],
      ['东方财富', '宏观数据月度序列', 'https://data.eastmoney.com/cjsj/'],
      ['Gold Prices', '历史金价数据集', 'https://github.com/datasets/gold-prices'],
      ['Gold API', '国际现货实时价格', 'https://gold-api.com/'],
      ['Global Macro Database', '长周期宏观拼接', 'https://www.globalmacrodata.com/'],
    ];
    $('#sourceList').innerHTML = src.map(([n, d, u]) =>
      '<a href="' + u + '" target="_blank" rel="noopener noreferrer"><span><b>' + n + '</b>' + d + '</span><span>↗</span></a>'
    ).join('');

    const rows = [
      ['CPI 同比', '国家统计局年度/月度数据；1950—1985 部分为 World Bank 与历史估算补齐', [['2026-10 CPI 公告', 'https://www.stats.gov.cn/sj/zxfb/202611/t20261109_1965795.html'], ['World Bank CPI', 'https://data.worldbank.org/indicator/FP.CPI.TOTL?locations=CN']], '1950—2026'],
      ['70 城房价', '国家统计局 70 城新建商品住宅销售价格指数；1987—2010 为年度均价估算', [['NBS 月度数据', 'https://www.stats.gov.cn/sj/zxfb/'], ['NBS 统计年鉴', 'https://www.stats.gov.cn/sj/ndsj/']], '1987—2026'],
      ['M2 同比', '中国人民银行金融统计；2000—2007 月度为年度增速估算；长序列拼接 GMD', [['PBOC 金融统计', 'http://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html'], ['Global Macro Database', 'https://www.globalmacrodata.com/']], '1990—2026'],
      ['GDP 同比', '国家统计局季度/年度核算；长期序列由 World Bank 补齐', [['NBS 年度数据', 'https://www.stats.gov.cn/sj/ndsj/'], ['World Bank GDP', 'https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG?locations=CN']], '1950—2026'],
      ['一年期定存', 'PBOC 基准利率历史；2015 年后取主要银行一年期挂牌利率（当前 0.95%）', [['PBOC 利率历史', 'http://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125440/125838/125888/index.html']], '1950—2026'],
      ['平均工资', '国家统计局城镇非私营单位就业人员年平均工资；2026 为估算', [['2025 年平均工资公告', 'https://www.stats.gov.cn/sj/zxfb/202605/t20260515_1963707.html']], '1950—2026'],
      ['大米 / 猪肉 / 居民用电', '国家统计局历年《中国统计年鉴》及地方价格资料；长周期零售价为整理/估算', [['NBS 统计年鉴', 'https://www.stats.gov.cn/sj/ndsj/']], '1950—2026'],
      ['黄金价格', 'Gold.org / LBMA 历史金价；人民币价格按当年 USD/CNY 折算', [['Gold.org', 'https://www.gold.org/goldhub/data/gold-prices'], ['历史金价数据集', 'https://github.com/datasets/gold-prices']], '1949—2026'],
      ['WTI 原油', 'FRED DCOILWTICO 年度均价', [['FRED WTI', 'https://fred.stlouisfed.org/series/DCOILWTICO']], '1949—2026'],
      ['USD/CNY 汇率', 'FRED DEXCHUS 年度均价；早期为官方汇率', [['FRED 汇率', 'https://fred.stlouisfed.org/series/DEXCHUS']], '1949—2026'],
      ['实质利率', '由定存、CPI、M2、GDP 计算；公式依据《通论》讲课稿 PDF p294、p338', [], '计算值'],
      ['100 元购买力', '由 CPI 定基指数计算，不是独立官方序列', [['2026-10 CPI 公告', 'https://www.stats.gov.cn/sj/zxfb/202611/t20261109_1965795.html']], '计算值'],
    ];
    const html = '<table><thead><tr><th>数据</th><th>来源 / 说明</th><th>查询链接</th><th>覆盖</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td class="links">' +
        (r[2].length ? r[2].map(l => '<a href="' + l[1] + '" target="_blank" rel="noopener noreferrer">' + l[0] + ' ↗</a>').join('') : '<span style="color:var(--muted-2)">计算值</span>') +
        '</td><td>' + r[3] + '</td></tr>').join('') + '</tbody></table>';
    const el = $('#sourceMatrix');
    if (el) el.innerHTML = html;
    const mel = $('#sourceMatrixMobile');
    if (mel) mel.innerHTML = rows.map(r =>
      '<div class="source-mobile-card"><div class="sm-head"><b>' + r[0] + '</b><span>' + r[3] + '</span></div>' +
      '<p>' + r[1] + '</p>' +
      '<div class="sm-links">' + (r[2].length ? r[2].map(l => '<a href="' + l[1] + '" target="_blank" rel="noopener noreferrer">' + l[0] + ' ↗</a>').join('') : '<span>计算值</span>') + '</div></div>'
    ).join('');
  }

  function renderFreshness() {
    const m = latestMonth();
    const items = [
      ['CPI', m.ym, true],
      ['70 城房价', m.ym, true],
      ['M2', m.ym, true],
      ['GDP', '2026 Q3', true],
      ['1 年定存', m.ym, true],
      ['黄金', state.liveGold ? '实时' : '快照', !!state.liveGold],
    ];
    $('#freshness').innerHTML = items.map(([k, v, ok]) =>
      '<div class="fresh"><span>' + k + '</span><span><b>' + v + '</b> <i class="' + (ok ? 'ok' : 'wait') + '" style="display:inline-block;margin-left:5px"></i></span></div>'
    ).join('');
  }

  /* ---------- render all ---------- */
  function renderCharts() {
    renderAnnualChart();
    renderMonthlyChart();
    renderHouseChart();
    renderPriceChart();
    renderGoldChart();
    renderGoldOilChart();
  }
  function renderAll() {
    renderHero();
    renderMetrics();
    renderAnnualStats();
    renderAnnualTable();
    renderAnnualCalc();
    renderMonthlyStats();
    renderMonthlyTable();
    renderPurchase();
    renderGoldOilStats();
    renderFreshness();
    renderGoldLive();
    renderCharts();
  }

  /* ---------- sheet ---------- */
  let lastFocus = null;
  function openSheet() {
    lastFocus = document.activeElement;
    const m = latestMonth();
    const ym = m ? m.ym : '2026-10';
    $('#fMonth').value = state.overrides[ym] ? ym : ym;
    fillSheet(ym);
    $('#sheetOverlay').classList.add('open');
    $('#updateSheet').classList.add('open');
    setTimeout(() => { $('#fMonth').focus(); }, 80);
  }
  function closeSheet() {
    $('#sheetOverlay').classList.remove('open');
    $('#updateSheet').classList.remove('open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function fillSheet(ym) {
    let row = monthly.find(r => r.ym === ym);
    if (!row) {
      const [y, mm] = ym.split('-').map(Number);
      row = { ym, cpi: null, dep: latestMonth() ? latestMonth().dep : 0.95, house: null, m2: null, gdp: null, goldUsd: null, fx: latestMonth() ? latestMonth().fx : 6.684, gdpPeriod: '用户录入' };
    }
    const ov = state.overrides[ym] || {};
    const pick = (k) => isNum(ov[k]) ? ov[k] : row[k];
    $('#fCpi').value = pick('cpi') == null ? '' : pick('cpi');
    $('#fDep').value = pick('dep') == null ? '' : pick('dep');
    $('#fHouse').value = pick('house') == null ? '' : pick('house');
    $('#fM2').value = pick('m2') == null ? '' : pick('m2');
    $('#fGdp').value = pick('gdp') == null ? '' : pick('gdp');
    $('#fGold').value = pick('goldUsd') == null ? '' : pick('goldUsd');
    $('#fFx').value = pick('fx') == null ? '' : pick('fx');
  }
  function numOrNull(id) {
    const v = $(id).value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function saveMonth() {
    const ym = $('#fMonth').value;
    if (!/^\d{4}-\d{2}$/.test(ym)) { toast('请选择月份'); return; }
    const ov = {
      cpi: numOrNull('#fCpi'),
      dep: numOrNull('#fDep'),
      house: numOrNull('#fHouse'),
      m2: numOrNull('#fM2'),
      gdp: numOrNull('#fGdp'),
      goldUsd: numOrNull('#fGold'),
      fx: numOrNull('#fFx'),
    };
    if (ov.cpi == null || ov.dep == null) { toast('至少填写 CPI 与一年期定存'); return; }
    if (ov.fx == null) {
      const row = monthly.find(r => r.ym === ym);
      ov.fx = row && isNum(row.fx) ? row.fx : 6.684;
    }
    state.overrides[ym] = ov;
    saveLocal();
    rebuild();
    renderAll();
    closeSheet();
    toast('已保存 ' + ym + '，图表已重算');
  }
  function clearMonth() {
    const ym = $('#fMonth').value;
    if (state.overrides[ym]) {
      delete state.overrides[ym];
      saveLocal();
      rebuild();
      renderAll();
      closeSheet();
      toast('已清除 ' + ym + ' 的本地修订');
    } else {
      toast('该月没有本地修订');
    }
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ---------- formula calculator ---------- */
  function calcNum(id) {
    const v = $(id).value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function updateCalculator() {
    if (!$('#calcRate')) return;
    const cpi = calcNum('#calcCpi');
    const dep = calcNum('#calcDep');
    const m2 = calcNum('#calcM2');
    const gdp = calcNum('#calcGdp');
    const inf = (cpi == null || m2 == null || gdp == null) ? null : cpi + (m2 - gdp);
    const rate = (dep == null || inf == null) ? null : dep - inf;
    $('#calcInf').textContent = isNum(inf) ? fmtSigned(inf, 2) : '—';
    $('#calcInf').className = signClass(inf);
    $('#calcRate').textContent = isNum(rate) ? fmtSigned(rate, 2) : '—';
    $('#calcRate').className = signClass(rate);
    const v = $('#calcVerdict');
    if (!isNum(rate)) {
      v.textContent = '输入四个数字，立即判断';
      v.className = 'calc-verdict';
    } else if (rate < 0) {
      v.textContent = '实质负利率：实际通胀高于名义利率';
      v.className = 'calc-verdict neg';
    } else {
      v.textContent = '正实质利率：名义利率高于实际通胀';
      v.className = 'calc-verdict pos';
    }
  }
  function fillCalculator(force) {
    if (!force && state.calcDirty) return;
    const m = latestMonth();
    if (!m) return;
    $('#calcCpi').value = isNum(m.cpi) ? +m.cpi.toFixed(2) : '';
    $('#calcDep').value = isNum(m.dep) ? +m.dep.toFixed(2) : '';
    $('#calcM2').value = isNum(m.m2) ? +m.m2.toFixed(2) : '';
    $('#calcGdp').value = isNum(m.gdp) ? +m.gdp.toFixed(2) : '';
    state.calcDirty = false;
    updateCalculator();
  }

  /* ---------- official auto-update ---------- */
  function apiBase() {
    return location.protocol === 'file:' ? 'http://127.0.0.1:8080' : '';
  }
  function isStaticHost() {
    return /\.github\.io$/i.test(location.hostname) || /\.pages\.dev$/i.test(location.hostname);
  }
  function apiTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function renderAutoStatus(remote, mode) {
    const el = $('#autoStatus');
    if (!el) return;
    if (mode === 'static') {
      el.className = 'auto-status synced';
      el.innerHTML = '<span class="auto-dot"></span><div><b>GitHub Pages 静态版</b><span>每日北京时间 09:00 由 GitHub Actions 自动重建，电脑关机也能访问</span><div class="auto-src"><a href="https://github.com/Amanda-lyy97/real-rate-1949/actions" target="_blank" rel="noopener noreferrer">查看更新记录 ↗</a><a href="https://github.com/Amanda-lyy97/real-rate-1949" target="_blank" rel="noopener noreferrer">源码仓库 ↗</a></div></div>';
      return;
    }
    if (mode === 'busy') {
      el.className = 'auto-status';
      el.innerHTML = '<span class="auto-dot"></span><div><b>正在抓取官方数据…</b><span>国家统计局 / 中国人民银行</span></div>';
      return;
    }
    if (mode === 'synced' && remote) {
      const s = remote.sources || {};
      const links = [
        ['CPI', s.cpi], ['房价', s.house], ['M2', s.m2], ['GDP', s.gdp]
      ].filter(x => x[1]);
      el.className = 'auto-status synced';
      el.innerHTML = '<span class="auto-dot"></span><div><b>官方数据已自动同步</b><span>' +
        (remote.latestMonth || '') + ' · 更新于 ' + apiTime(remote.updatedAt) +
        ' · 服务端每 24 小时自动检查一次</span><div class="auto-src">' +
        links.map(([n, u]) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + n + ' 原文 ↗</a>').join('') +
        '</div></div>';
    } else {
      el.className = 'auto-status error';
      el.innerHTML = '<span class="auto-dot"></span><div><b>未连接自动更新服务</b><span>当前使用内置/缓存快照；启动 server.py 后会自动同步官方数据。</span></div>';
    }
  }
  async function loadRemoteLatest(manual) {
    if (isStaticHost()) {
      renderAutoStatus(null, 'static');
      return true;
    }
    try {
      const res = await fetch(apiBase() + '/api/latest?ts=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!j.ok || !j.monthly) throw new Error(j.error || 'no official data');
      const before = state.remote ? JSON.stringify([state.remote.latestMonth, state.remote.monthly, state.remote.annual]) : '';
      const after = JSON.stringify([j.latestMonth, j.monthly, j.annual]);
      state.remote = j;
      saveLocal();
      if (before !== after) {
        rebuild();
        renderAll();
        fillCalculator(true);
      }
      renderAutoStatus(j, 'synced');
      if (manual) toast('已同步 ' + j.latestMonth + ' 官方数据');
      return true;
    } catch (e) {
      renderAutoStatus(null, 'offline');
      if (manual) toast('自动更新服务未连接，继续使用内置快照');
      return false;
    }
  }
  /* ---------- annual calculation appendix ---------- */
  function calcText(v, d = 2) {
    return isNum(v) ? v.toFixed(d) : '—';
  }
  function renderAnnualCalc() {
    const wrap = $('#annualCalcWrap');
    if (!wrap) return;
    const lens = state.calcLens;
    const rows = annual.slice().sort((a, b) => b.year - a.year);
    let html = '<table><thead><tr><th>年份</th><th>定存</th><th>CPI</th><th>补充数据</th><th>计算过程</th><th>结果</th></tr></thead><tbody>';
    rows.forEach(r => {
      let expr = '数据不足';
      let extra = '—';
      let result = null;
      if (lens === 'doubleReal') {
        result = r.doubleReal;
        extra = (isNum(r.m2) ? 'M2 ' + r.m2.toFixed(2) : 'M2 —') + ' / ' + (isNum(r.gdp) ? 'GDP ' + r.gdp.toFixed(2) : 'GDP —');
        if (isNum(r.dep) && isNum(r.cpi) && isNum(r.m2) && isNum(r.gdp)) {
          expr = r.dep.toFixed(2) + ' − ' + r.cpi.toFixed(2) + ' − (' + r.m2.toFixed(2) + ' − ' + r.gdp.toFixed(2) + ')';
        }
      } else if (lens === 'cpiReal') {
        result = r.cpiReal;
        extra = '—';
        if (isNum(r.dep) && isNum(r.cpi)) expr = r.dep.toFixed(2) + ' − ' + r.cpi.toFixed(2);
      } else {
        result = r.moneyReal;
        extra = (isNum(r.m2) ? 'M2 ' + r.m2.toFixed(2) : 'M2 —') + ' / ' + (isNum(r.gdp) ? 'GDP ' + r.gdp.toFixed(2) : 'GDP —');
        if (isNum(r.dep) && isNum(r.m2) && isNum(r.gdp)) expr = r.dep.toFixed(2) + ' − (' + r.m2.toFixed(2) + ' − ' + r.gdp.toFixed(2) + ')';
      }
      const resTxt = isNum(result) ? fmtSigned(result, 2) : '—';
      const cls = signClass(result);
      html += '<tr class="' + (r.year === 2026 ? 'is-current' : '') + '">' +
        '<td>' + r.year + '</td>' +
        '<td>' + calcText(r.dep) + '</td>' +
        '<td>' + calcText(r.cpi) + '</td>' +
        '<td>' + extra + '</td>' +
        '<td class="expr">' + expr + (isNum(result) ? ' = ' + resTxt : '') + '</td>' +
        '<td class="result ' + cls + '">' + resTxt + '</td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    let mobile = '';
    rows.forEach(r => {
      let expr = '数据不足';
      let extra = '—';
      let result = null;
      if (lens === 'doubleReal') {
        result = r.doubleReal;
        extra = (isNum(r.m2) ? 'M2 ' + r.m2.toFixed(2) : 'M2 —') + ' / ' + (isNum(r.gdp) ? 'GDP ' + r.gdp.toFixed(2) : 'GDP —');
        if (isNum(r.dep) && isNum(r.cpi) && isNum(r.m2) && isNum(r.gdp)) expr = r.dep.toFixed(2) + ' − ' + r.cpi.toFixed(2) + ' − (' + r.m2.toFixed(2) + ' − ' + r.gdp.toFixed(2) + ')';
      } else if (lens === 'cpiReal') {
        result = r.cpiReal; extra = '—';
        if (isNum(r.dep) && isNum(r.cpi)) expr = r.dep.toFixed(2) + ' − ' + r.cpi.toFixed(2);
      } else {
        result = r.moneyReal;
        extra = (isNum(r.m2) ? 'M2 ' + r.m2.toFixed(2) : 'M2 —') + ' / ' + (isNum(r.gdp) ? 'GDP ' + r.gdp.toFixed(2) : 'GDP —');
        if (isNum(r.dep) && isNum(r.m2) && isNum(r.gdp)) expr = r.dep.toFixed(2) + ' − (' + r.m2.toFixed(2) + ' − ' + r.gdp.toFixed(2) + ')';
      }
      const resTxt = isNum(result) ? fmtSigned(result, 2) : '—';
      mobile += '<div class="calc-mobile-card">' +
        '<div class="cm-head"><b>' + r.year + '</b><span class="' + signClass(result) + '">' + resTxt + '</span></div>' +
        '<div class="cm-input">定存 ' + calcText(r.dep) + ' · CPI ' + calcText(r.cpi) + ' · ' + extra + '</div>' +
        '<div class="cm-expr">' + expr + (isNum(result) ? ' = ' + resTxt : '') + '</div>' +
      '</div>';
    });
    $('#annualCalcMobile').innerHTML = mobile;
    $$('#calcLensTabs button').forEach(b => {
      const active = b.getAttribute('data-clens') === lens;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  /* ---------- CSV / JSON ---------- */
  function download(name, text, mime, bom) {
    const prefix = bom === false ? '' : '\ufeff';
    const blob = new Blob([prefix + text], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }
  function toCSV(rows, cols) {
    const head = cols.map(c => c[1]).join(',');
    const body = rows.map(r => cols.map(c => {
      const v = r[c[0]];
      return isNum(v) ? v : '';
    }).join(',')).join('\n');
    return head + '\n' + body;
  }
  function exportAnnualCSV() {
    const cols = [['year', '年份'], ['cpi', 'CPI同比%'], ['dep', '一年定存%'], ['doubleReal', '实质利率%'], ['cpiReal', 'CPI口径%'], ['moneyReal', '货币扩张口径%'], ['gdp', 'GDP同比%'], ['m2', 'M2同比%'], ['house', '房价同比%'], ['pp100', '100元购买力'], ['goldUsd', '黄金USD/oz'], ['goldCnyG', '黄金人民币/克']];
    download('中国实质利率_年度_1950-2026.csv', toCSV(annual, cols));
    toast('年度 CSV 已导出');
  }
  function exportMonthlyCSV() {
    const cols = [['ym', '月份'], ['cpi', 'CPI同比%'], ['dep', '一年定存%'], ['house', '70城房价同比%'], ['doubleReal', '实质利率%'], ['cpiReal', 'CPI口径%'], ['moneyReal', '货币扩张口径%'], ['m2', 'M2同比%'], ['gdp', 'GDP累计同比%'], ['goldUsd', '黄金USD/oz'], ['goldCnyG', '黄金人民币/克']];
    download('中国实质利率_月度_2000-2026.csv', toCSV(monthly, cols));
    toast('月度 CSV 已导出');
  }
  function exportJSON() {
    download('实质利率观察站_备份.json', JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(),
      overrides: state.overrides, liveGold: state.liveGold,
    }, null, 2), 'application/json', false);
    toast('备份已导出');
  }
  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result).replace(/^\ufeff/, ''));
        if (obj.overrides && typeof obj.overrides === 'object') state.overrides = obj.overrides;
        if (obj.liveGold && isNum(obj.liveGold.usd)) state.liveGold = obj.liveGold;
        saveLocal(); rebuild();
        renderAll();
        toast('备份已导入，图表已重算');
      } catch (e) { toast('文件格式无法识别'); }
    };
    reader.readAsText(file);
  }

  /* ---------- live gold ---------- */
  let goldBusy = false;
  async function fetchGold(manual) {
    if (goldBusy) return;
    goldBusy = true;
    const btn = $('#refreshGold');
    if (btn) btn.style.opacity = '.45';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch('https://api.gold-api.com/price/XAU', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (isNum(j.price)) {
        state.liveGold = { usd: j.price, at: j.updatedAt || new Date().toISOString() };
        saveLocal();
        renderGoldLive();
        renderFreshness();
        if (manual) toast('金价已更新：$' + Math.round(j.price) + '/oz');
      } else throw new Error('no price');
    } catch (e) {
      if (manual) toast('实时金价获取失败，已保留最近快照');
      renderGoldLive();
    } finally {
      goldBusy = false;
      if (btn) btn.style.opacity = '1';
    }
  }

  /* ---------- nav / observer ---------- */
  function setupNav() {
    const links = $$('[data-nav]');
    const sections = ['overview', 'formula', 'annual', 'monthly', 'purchasing', 'goldoil', 'data'].map(id => document.getElementById(id)).filter(Boolean);
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        const id = en.target.id;
        links.forEach(a => a.classList.toggle('active', a.getAttribute('data-nav') === id));
      });
    }, { rootMargin: '-35% 0px -55% 0px', threshold: 0 });
    sections.forEach(s => io.observe(s));

    window.addEventListener('scroll', () => {
      $('#topbar').classList.toggle('scrolled', window.scrollY > 8);
    }, { passive: true });
  }

  /* ---------- events ---------- */
  function bind() {
    $('#openUpdate').addEventListener('click', openSheet);
    $('#openUpdateHero').addEventListener('click', openSheet);
    $('#closeSheet').addEventListener('click', closeSheet);
    $('#sheetOverlay').addEventListener('click', closeSheet);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
    $('#fMonth').addEventListener('change', () => fillSheet($('#fMonth').value));
    $('#saveMonth').addEventListener('click', saveMonth);
    $('#clearMonth').addEventListener('click', clearMonth);

    $$('#lensTabs button').forEach(b => b.addEventListener('click', () => {
      state.lens = b.getAttribute('data-lens');
      $$('#lensTabs button').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
      renderHero();
      renderAnnualChart();
      renderAnnualStats();
    }));
    $$('#annualRangePills button').forEach(b => b.addEventListener('click', () => {
      state.annualStart = Number(b.getAttribute('data-range'));
      $$('#annualRangePills button').forEach(x => x.classList.toggle('active', x === b));
      renderAnnualChart();
    }));
    $$('#annualTablePills button').forEach(b => b.addEventListener('click', () => {
      state.annualFilter = b.getAttribute('data-filter');
      $$('#annualTablePills button').forEach(x => x.classList.toggle('active', x === b));
      renderAnnualTable();
    }));
    $$('#monthlyRangeTabs button').forEach(b => b.addEventListener('click', () => {
      state.monthlyMonths = Number(b.getAttribute('data-months'));
      $$('#monthlyRangeTabs button').forEach(x => x.classList.toggle('active', x === b));
      renderMonthlyChart();
    }));
    $$('#monthlyTablePills button').forEach(b => b.addEventListener('click', () => {
      state.monthlyFilter = b.getAttribute('data-mfilter');
      $$('#monthlyTablePills button').forEach(x => x.classList.toggle('active', x === b));
      renderMonthlyTable();
    }));
    $$('#goldTabs button').forEach(b => b.addEventListener('click', () => {
      state.goldMode = b.getAttribute('data-gold');
      $$('#goldTabs button').forEach(x => x.classList.toggle('active', x === b));
      renderPurchase();
      renderGoldChart();
    }));
    $('#exportAnnual').addEventListener('click', exportAnnualCSV);
    $('#exportMonthly').addEventListener('click', exportMonthlyCSV);
    $('#exportJson').addEventListener('click', exportJSON);
    $('#importJson').addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
    $('#refreshGold').addEventListener('click', () => fetchGold(true));
    $$('#calcLensTabs button').forEach(b => b.addEventListener('click', () => {
      state.calcLens = b.getAttribute('data-clens');
      renderAnnualCalc();
    }));
    ['calcCpi', 'calcDep', 'calcM2', 'calcGdp'].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('input', () => { state.calcDirty = true; updateCalculator(); });
    });

    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { renderCharts(); }, 160);
    });
  }

  /* ---------- boot ---------- */
  function boot() {
    renderSources();
    renderAll();
    fillCalculator(true);
    bind();
    setupNav();
    setTimeout(() => loadRemoteLatest(false), 900);
    setInterval(() => loadRemoteLatest(false), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadRemoteLatest(false);
    });
    // cached live gold is shown immediately; refresh in background if stale or absent
    const stale = !state.liveGold || (Date.now() - new Date(state.liveGold.at).getTime() > 6 * 3600 * 1000);
    if (stale) setTimeout(() => fetchGold(false), 600);
  }

  boot();
})();
