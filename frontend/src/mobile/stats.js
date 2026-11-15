// Pure helpers for the mobile view: window slicing, descriptive percentiles,
// indexing, divergence bands, formatting. No React, no I/O, so Node can test
// them directly (frontend/src/mobile/stats.test.mjs).

const DAY_MS = 86400000;

export function toMs(dateStr) {
  return Date.parse(dateStr.length === 10 ? dateStr + "T00:00:00Z" : dateStr);
}

// Rows are {date, value}. A window is {days} (relative to the LAST row's
// date, so a stale series still shows its latest data), {all:true}, or
// {since:'YYYY-MM-DD'}.
export function sliceWindow(rows, win) {
  if (!rows || rows.length === 0) return [];
  if (!win || win.all) return rows;
  if (win.since) return rows.filter((r) => r.date >= win.since);
  const cutoff = toMs(rows[rows.length - 1].date) - win.days * DAY_MS;
  return rows.filter((r) => toMs(r.date) >= cutoff);
}

export function realValues(rows) {
  return rows.filter((r) => r.value != null && Number.isFinite(r.value));
}

export function last(rows) {
  const v = realValues(rows);
  return v.length ? v[v.length - 1] : null;
}

// latest real reading and the one before it
export function lastChange(rows) {
  const v = realValues(rows);
  if (v.length === 0) return null;
  const cur = v[v.length - 1];
  const prev = v.length > 1 ? v[v.length - 2] : null;
  return { date: cur.date, value: cur.value, prevDate: prev?.date ?? null, change: prev ? cur.value - prev.value : null };
}

// Share of the window's real values strictly below the current one, 0-100.
// Descriptive only (a series against its own history). Null when the window
// has too few points to mean anything.
export const MIN_PERCENTILE_POINTS = 5;
export function percentileRank(rows) {
  const v = realValues(rows);
  if (v.length < MIN_PERCENTILE_POINTS) return null;
  const cur = v[v.length - 1].value;
  const below = v.filter((r) => r.value < cur).length;
  return (below / v.length) * 100;
}

export function ordinal(n) {
  const k = Math.round(n);
  const s = ["th", "st", "nd", "rd"];
  const v = k % 100;
  return k + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Index each series to 100 at the first date where ALL series have a value
// on or before it (as-of), so lines on different cadences share one base.
export function asOf(rows, date) {
  let best = null;
  for (const r of rows) {
    if (r.date <= date) {
      if (r.value != null) best = r;
    } else break;
  }
  return best;
}

export function indexTo100(rows, baseDate) {
  const base = asOf(rows, baseDate) ?? realValues(rows).find((r) => r.date >= baseDate);
  if (!base || !base.value) return [];
  return rows.filter((r) => r.date >= baseDate && r.value != null).map((r) => ({ date: r.date, value: (r.value / base.value) * 100 }));
}

export function firstCommonDate(seriesList) {
  const firsts = seriesList.map((s) => realValues(s)[0]?.date).filter(Boolean);
  if (firsts.length !== seriesList.length) return null;
  return firsts.reduce((a, b) => (a > b ? a : b));
}

// Percent change between two as-of readings.
export function pctSince(rows, sinceDate) {
  const v = realValues(rows);
  if (v.length === 0) return null;
  const base = asOf(v, sinceDate) ?? v.find((r) => r.date >= sinceDate);
  const cur = v[v.length - 1];
  if (!base || !base.value) return null;
  return { from: base.date, to: cur.date, pct: (cur.value / base.value - 1) * 100 };
}

// Bands wherever two (already indexed) series move in opposite directions
// over a trailing `lag`-step window on series A's dates. Returns merged
// [{from,to}] ranges. Flat (zero change) counts as no divergence.
export function divergenceBands(a, b, lag = 3) {
  const A = realValues(a);
  const flags = [];
  for (let i = lag; i < A.length; i++) {
    const a0 = A[i - lag], a1 = A[i];
    const b0 = asOf(b, a0.date), b1 = asOf(b, a1.date);
    if (!b0 || !b1) continue;
    const da = a1.value - a0.value, db = b1.value - b0.value;
    flags.push({ from: a0.date, to: a1.date, opposite: da * db < 0 });
  }
  const bands = [];
  for (const f of flags) {
    if (!f.opposite) continue;
    const prev = bands[bands.length - 1];
    if (prev && f.from <= prev.to) prev.to = f.to > prev.to ? f.to : prev.to;
    else bands.push({ from: f.from, to: f.to });
  }
  return bands;
}

// ---- formatting ----
export const DASH = "—";
const isNum = (x) => x != null && Number.isFinite(x);

export function fmtNum(x, d = 2) {
  return isNum(x) ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : DASH;
}
export function fmtSigned(x, d = 2) {
  if (!isNum(x)) return DASH;
  return (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtPct(x, d = 1) {
  return isNum(x) ? fmtNum(x, d) + "%" : DASH;
}
export function fmtSignedPct(x, d = 1) {
  return isNum(x) ? fmtSigned(x, d) + "%" : DASH;
}
export function fmtUsd(x, d = 2) {
  if (!isNum(x)) return DASH;
  return (x < 0 ? "−$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtSignedUsd(x, d = 2) {
  if (!isNum(x)) return DASH;
  return (x > 0 ? "+$" : x < 0 ? "−$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
// Compact magnitude with a unit suffix: 1.2B, 345.6M, 12.3K
export function fmtCompact(x, d = 1) {
  if (!isNum(x)) return DASH;
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  if (a >= 1e12) return s + (a / 1e12).toFixed(d) + "T";
  if (a >= 1e9) return s + (a / 1e9).toFixed(d) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(d) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(d) + "K";
  return s + a.toFixed(d === 0 ? 0 : Math.min(d, 1));
}
export function fmtSignedCompact(x, d = 1) {
  if (!isNum(x)) return DASH;
  return (x > 0 ? "+" : "") + fmtCompact(x, d);
}
export function fmtOz(x, d = 2) {
  return isNum(x) ? fmtNum(x, d) + " oz" : DASH;
}
export function fmtUsdCompact(x, d = 1) {
  if (!isNum(x)) return DASH;
  return (x < 0 ? "−$" : "$") + fmtCompact(Math.abs(x), d);
}
export function sinceLabel(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : DASH;
}
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
