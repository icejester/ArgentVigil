import { useEffect, useMemo, useRef, useState } from "react";
import { toMs, fmtNum, DASH } from "./stats";

// Lightweight SVG charts for the mobile view (mobile-spec.md G4). No Recharts.
// Rows are {date:'YYYY-MM-DD', value:number|null}. Nulls are gaps, never
// zeros. X is a true time scale so series on different cadences line up.

const GREEN = "#4caf76";
const RED = "#e05252";
const AXIS = "#919bb0";
const GRID = "#2e3547";

export function niceTicks(min, max, n = 4) {
  if (!(max > min)) return [min];
  const raw = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function downsample(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

// Inline sparkline for glance rows. No interaction, no axes.
export function Sparkline({ rows, color = "#7b9fff", width = 96, height = 28 }) {
  const pts = (rows || []).filter((r) => r.value != null);
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const ds = downsample(pts, 60);
  const t0 = toMs(ds[0].date), t1 = toMs(ds[ds.length - 1].date);
  let lo = Infinity, hi = -Infinity;
  for (const p of ds) { if (p.value < lo) lo = p.value; if (p.value > hi) hi = p.value; }
  const span = hi - lo || 1;
  const d = ds
    .map((p, i) => {
      const x = t1 === t0 ? 0 : ((toMs(p.date) - t0) / (t1 - t0)) * (width - 2) + 1;
      const y = height - 2 - ((p.value - lo) / span) * (height - 4);
      return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    })
    .join("");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    setW(el.clientWidth || 320);
    const ro = new ResizeObserver(() => setW(el.clientWidth || 320));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Value of `rows` as-of (on or before) `date`; null if none.
function valueAsOf(rows, date) {
  let best = null;
  for (const r of rows) {
    if (r.date <= date) { if (r.value != null) best = r; } else break;
  }
  return best;
}

// Pin-snap (CLAUDE.md nearest-date convention 2): on/before; after only if
// the pin predates the whole series.
function pinSnap(rows, pinned) {
  if (!pinned || rows.length === 0) return null;
  let best = null;
  for (const r of rows) if (r.date <= pinned) best = r.date;
  return best ?? rows[0].date;
}

/**
 * lines: [{ key, name, color, rows, kind: 'line'|'bar'|'step', dash? }]  (first = primary)
 * bands: [{from,to}] shaded ranges      annotations: [{date,label,onTap}]
 * barColor(row) => color for a bar row   detail(date) => [{label,value}] extra readout lines
 * format(v) => string for the readout     axisFormat(v) => string for Y ticks
 */
export function DrillChart({
  lines,
  bands = [],
  annotations = [],
  pinnedDate,
  onPin,
  format = (v) => fmtNum(v),
  axisFormat,
  barColor,
  detail,
  height = 220,
  zeroLine = false,
  unit = "",
}) {
  const [ref, width] = useWidth();
  const [touch, setTouch] = useState(null); // touched date string
  const padL = 46, padR = 8, padT = 10, padB = 22;
  const primary = lines[0];

  const geo = useMemo(() => {
    const all = lines.flatMap((l) => l.rows.filter((r) => r.value != null));
    if (all.length === 0) return null;
    const t0 = Math.min(...all.map((r) => toMs(r.date)));
    const t1 = Math.max(...all.map((r) => toMs(r.date)));
    let lo = Math.min(...all.map((r) => r.value));
    let hi = Math.max(...all.map((r) => r.value));
    if (lines.some((l) => l.kind === "bar") || zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
    if (!lines.some((l) => l.kind === "bar")) { lo -= pad; hi += pad; } else { hi += pad; if (lo < 0) lo -= pad; }
    return { t0, t1, lo, hi };
  }, [lines, zeroLine]);

  if (!geo) return <div className="m-empty">No data in this window.</div>;

  const W = width, H = height;
  const x = (date) => (geo.t1 === geo.t0 ? padL : padL + ((toMs(date) - geo.t0) / (geo.t1 - geo.t0)) * (W - padL - padR));
  const y = (v) => padT + (1 - (v - geo.lo) / (geo.hi - geo.lo)) * (H - padT - padB);
  const yTicks = niceTicks(geo.lo, geo.hi, 4);
  const xTicks = [0, 1, 2, 3].map((i) => new Date(geo.t0 + ((geo.t1 - geo.t0) * i) / 3).toISOString().slice(0, 10));

  function pathFor(l) {
    let d = "", pen = false, prevY = null;
    for (const r of l.rows) {
      if (r.value == null) { pen = false; continue; }
      const px = x(r.date).toFixed(1), py = y(r.value).toFixed(1);
      if (l.kind === "step" && pen && prevY != null) d += `L${px} ${prevY}`;
      d += (pen ? "L" : "M") + px + " " + py;
      pen = true; prevY = py;
    }
    return d;
  }

  const primaryRows = primary.rows.filter((r) => r.value != null);
  function nearestDate(clientX) {
    const rect = ref.current.getBoundingClientRect();
    const px = Math.min(Math.max(clientX - rect.left, padL), W - padR);
    const t = geo.t0 + ((px - padL) / (W - padL - padR)) * (geo.t1 - geo.t0);
    let best = primaryRows[0], bd = Infinity;
    for (const r of primaryRows) {
      const dd = Math.abs(toMs(r.date) - t);
      if (dd < bd) { bd = dd; best = r; }
    }
    return best?.date ?? null;
  }
  const onPointer = (e) => setTouch(nearestDate(e.clientX));

  const pinnedSnapped = pinSnap(primaryRows, pinnedDate);
  const shown = touch ?? pinnedSnapped;
  const isPinnedShown = !touch && !!pinnedSnapped;
  const barW = Math.max(1, Math.min(8, ((W - padL - padR) / Math.max(primaryRows.length, 1)) * 0.7));
  const fmtAxis = axisFormat || ((v) => fmtNum(v, Math.abs(v) >= 100 ? 0 : 2));

  return (
    <div className="m-chart">
      <div ref={ref} className="m-chart-box">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${primary.name} chart`}
          style={{ touchAction: "pan-y" }}
          onPointerDown={onPointer}
          onPointerMove={(e) => e.buttons || e.pointerType === "touch" ? onPointer(e) : null}
        >
          {bands.map((b, i) => {
            const x0 = Math.max(padL, x(b.from)), x1 = Math.min(W - padR, x(b.to));
            return x1 > x0 ? <rect key={i} x={x0} y={padT} width={x1 - x0} height={H - padT - padB} fill="#d9a441" opacity="0.16" /> : null;
          })}
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
              <text x={padL - 6} y={y(t) + 4} fill={AXIS} fontSize="10" textAnchor="end">{fmtAxis(t)}</text>
            </g>
          ))}
          {(zeroLine || lines.some((l) => l.kind === "bar")) && geo.lo < 0 && geo.hi > 0 && (
            <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke={AXIS} strokeWidth="1" />
          )}
          {xTicks.map((t, i) => (
            <text key={i} x={Math.min(Math.max(x(t), padL), W - padR)} y={H - 6} fill={AXIS} fontSize="10" textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}>
              {geo.t1 - geo.t0 > 400 * 86400000 ? t.slice(0, 4) : t.slice(2, 7)}
            </text>
          ))}
          {lines.map((l) =>
            l.kind === "bar" ? (
              <g key={l.key}>
                {l.rows.filter((r) => r.value != null).map((r) => (
                  <rect
                    key={r.date}
                    x={x(r.date) - barW / 2}
                    y={Math.min(y(r.value), y(0))}
                    width={barW}
                    height={Math.max(1, Math.abs(y(r.value) - y(0)))}
                    fill={barColor ? barColor(r) : r.value >= 0 ? GREEN : RED}
                  />
                ))}
              </g>
            ) : (
              <path key={l.key} d={pathFor(l)} fill="none" stroke={l.color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={l.dash} />
            )
          )}
          {annotations.map((a, i) => (
            <g key={i} onClick={a.onTap} style={{ cursor: a.onTap ? "pointer" : "default" }}>
              <line x1={x(a.date)} x2={x(a.date)} y1={padT} y2={H - padB} stroke="#d9a441" strokeWidth="1" strokeDasharray="2 3" />
              <circle cx={x(a.date)} cy={padT + 6} r="9" fill="#141820" stroke="#d9a441" />
              <text x={x(a.date)} y={padT + 10} fontSize="11" fill="#d9a441" textAnchor="middle">{a.mark ?? "i"}</text>
            </g>
          ))}
          {pinnedSnapped && (
            <line x1={x(pinnedSnapped)} x2={x(pinnedSnapped)} y1={padT} y2={H - padB} stroke="#7b9fff" strokeWidth="1.5" strokeDasharray="4 3" />
          )}
          {touch && <line x1={x(touch)} x2={x(touch)} y1={padT} y2={H - padB} stroke="#c8d0de" strokeWidth="1" />}
        </svg>
      </div>
      <div className="m-readout" aria-live="polite">
        {shown ? (
          <>
            <div className="m-readout-head">
              <strong>{shown}</strong>
              {isPinnedShown && <span className="m-tag">pinned</span>}
            </div>
            {lines.map((l) => {
              const hit = valueAsOf(l.rows, shown);
              return (
                <div key={l.key} className="m-readout-line">
                  <span className="m-swatch" style={{ background: l.color }} aria-hidden="true" />
                  <span>{l.name}</span>
                  <span className="m-readout-val">{hit ? format(hit.value, l) + unit : DASH}</span>
                </div>
              );
            })}
            {detail && detail(shown).map((d) => (
              <div key={d.label} className="m-readout-line"><span /><span>{d.label}</span><span className="m-readout-val">{d.value}</span></div>
            ))}
            {onPin && (
              <div className="m-readout-actions">
                {touch && (
                  <button type="button" className="m-btn" onClick={() => onPin(pinnedDate && pinnedSnapped === touch ? null : touch)}>
                    {pinnedDate && pinnedSnapped === touch ? "Unpin this date" : "Pin this date"}
                  </button>
                )}
                {touch && <button type="button" className="m-btn m-btn--quiet" onClick={() => setTouch(null)}>Close</button>}
              </div>
            )}
          </>
        ) : (
          <div className="m-hint">Touch the chart to read a date{onPin ? " and pin it" : ""}.</div>
        )}
      </div>
    </div>
  );
}


// Pie (inventory composition). slices: [{key,label,value,color}]. Slices are
// separated by a surface-colored ring; the legend beside it carries names,
// shares and values, so color is never the only identity channel.
export function PieChart({ slices, size = 180, onSlice, ariaLabel }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!(total > 0)) return null;
  const r = size / 2 - 2, c = size / 2;
  let a0 = -Math.PI / 2;
  const paths = slices.map((sl) => {
    const frac = sl.value / total;
    const a1 = a0 + frac * 2 * Math.PI;
    let d;
    if (frac >= 0.9999) {
      d = `M${c} ${c - r}A${r} ${r} 0 1 1 ${c - 0.01} ${c - r}Z`;
    } else {
      const x0 = c + r * Math.cos(a0), y0 = c + r * Math.sin(a0);
      const x1 = c + r * Math.cos(a1), y1 = c + r * Math.sin(a1);
      d = `M${c} ${c}L${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}Z`;
    }
    a0 = a1;
    return { ...sl, d };
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
      {paths.map((p) => (
        <path key={p.key} d={p.d} fill={p.color} stroke="#141820" strokeWidth="2" onClick={onSlice && p.onTap !== false ? () => onSlice(p) : undefined} style={onSlice ? { cursor: "pointer" } : undefined} />
      ))}
    </svg>
  );
}

// Tick chart: rows [{t: ms, price}] on a true time axis, optional dashed
// high/low reference lines. Touch/drag scrubs a readout (vertical scroll
// still works: touch-action pan-y).
export function TickChart({ rows, color = "#5aa9e6", height = 150, hi, lo, fmt = (v) => v.toFixed(2) }) {
  const [ref, w] = useWidth();
  const [idx, setIdx] = useState(null);
  const pts = rows || [];
  if (pts.length < 2) return <div className="m-empty">Not enough ticks yet for this window.</div>;
  const padL = 6, padR = 52, padT = 10, padB = 20;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let min = Math.min(...pts.map((p) => p.price)), max = Math.max(...pts.map((p) => p.price));
  if (hi != null) max = Math.max(max, hi);
  if (lo != null) min = Math.min(min, lo);
  const span = max - min || 1;
  min -= span * 0.06; max += span * 0.06;
  const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / (max - min)) * (height - padT - padB);
  const ds = downsample(pts, 240);
  const path = ds.map((p, i) => (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.price).toFixed(1)).join("");
  const ticks = niceTicks(min, max, 3);
  const multiDay = t1 - t0 > 36 * 3600 * 1000;
  const lab = (t) => new Date(t).toLocaleString([], multiDay ? { month: "short", day: "numeric" } : { hour: "numeric", minute: "2-digit" });
  const at = (clientX) => {
    const rect = ref.current.getBoundingClientRect();
    const t = t0 + ((clientX - rect.left - padL) / (w - padL - padR)) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    setIdx(best);
  };
  const sel = idx != null ? pts[idx] : null;
  return (
    <div>
      <div ref={ref} className="m-chart-box" style={{ touchAction: "pan-y" }}
        onPointerDown={(e) => at(e.clientX)} onPointerMove={(e) => (e.buttons || e.pointerType === "touch") && at(e.clientX)}>
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Price ticks">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={w - padR} y1={Y(v)} y2={Y(v)} stroke={GRID} strokeWidth="0.5" />
              <text x={w - padR + 4} y={Y(v) + 4} fontSize="11" fill={AXIS}>{fmt(v)}</text>
            </g>
          ))}
          {hi != null && <line x1={padL} x2={w - padR} y1={Y(hi)} y2={Y(hi)} stroke={AXIS} strokeDasharray="4 3" />}
          {lo != null && <line x1={padL} x2={w - padR} y1={Y(lo)} y2={Y(lo)} stroke={AXIS} strokeDasharray="4 3" />}
          <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
          <text x={padL} y={height - 5} fontSize="11" fill={AXIS}>{lab(t0)}</text>
          <text x={w - padR} y={height - 5} fontSize="11" fill={AXIS} textAnchor="end">{lab(t1)}</text>
          {sel && (
            <g>
              <line x1={X(sel.t)} x2={X(sel.t)} y1={padT} y2={height - padB} stroke={AXIS} />
              <circle cx={X(sel.t)} cy={Y(sel.price)} r="4" fill={color} stroke="#141820" strokeWidth="2" />
            </g>
          )}
        </svg>
      </div>
      <div className="m-readout">
        {sel ? <><b>{fmt(sel.price)}</b> <span className="m-hint">{new Date(sel.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></> : <span className="m-hint">Touch the chart for a price and time.</span>}
      </div>
    </div>
  );
}
