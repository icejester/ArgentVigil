import { useState, useEffect, useCallback } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { FORCE_REFRESH_EVENT } from "./refresh_controls";
import { nearestRowDate } from "./date_utils";

// Same shape/cutoffs as comex_inventory.jsx's own filterBySFWindow — kept as
// a local copy rather than a shared import, matching this codebase's
// established per-file xTicks-style duplication convention (each file that
// needs it keeps its own small copy rather than a cross-file dependency for
// a few lines of logic).
function filterBySFWindow(data, window_, customStart, customEnd) {
  if (!data) return data;
  if (window_ === "custom") {
    if (!customStart || !customEnd || customStart > customEnd) return data;
    return data.filter((r) => r.date >= customStart && r.date <= customEnd);
  }
  if (window_ === "ALL") return data;
  const cutoffs = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 };
  const days = cutoffs[window_];
  if (!days) return data;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return data.filter((r) => r.date >= cutoff);
}

// Per UI_STANDARDS.md's color convention: green = favorable/normal. Neither
// flag type is itself "unfavorable" (both are normal, legal vault-operator
// status changes — CLAUDE.md's AV Voice Rules bar implication-of-wrongdoing
// framing) so they get two distinct non-green colors rather than reusing red
// for both: red for "reclassification" (registered rose without matching
// delivery — looks like eligible stock re-designated registered), amber for
// "deregistration" (registered fell without matching delivery — the mirror
// case, looks like registered stock re-designated back to eligible). Bars are
// diverging (up for a real stack increase, down for a real decrease), driven
// by total_delta so a flagged day and a real physical move are both visually
// legible in the same direction — the point of this chart is the physical
// COMEX stack, not just the registered-only reclassification candidates it
// used to be scoped to.
const NORMAL_COLOR = "#4caf76";
const RECLASSIFICATION_COLOR = "#e05252";
const DEREGISTRATION_COLOR = "#e0a852";
const TOTAL_VOLUME_COLOR = "#4a90d9";

const FLAG_COLORS = {
  reclassification: RECLASSIFICATION_COLOR,
  deregistration: DEREGISTRATION_COLOR,
};

function barColor(flagType) {
  return FLAG_COLORS[flagType] ?? NORMAL_COLOR;
}

// Per UI_STANDARDS.md's Legends section: one array-of-objects source of
// truth for label/color/detail text, click-to-toggle (not hover) behavior.
const RECLASSIFICATION_LEGEND = [
  {
    key: "normal",
    legendLabel: "Normal move",
    color: NORMAL_COLOR,
    eli5: "A day's registered-inventory change where either delivery-notice volume covers at least 10% of the move, or the move is small/flat enough not to trigger a check. Most days.",
  },
  {
    key: "reclassification",
    legendLabel: "Flagged — reclassification",
    color: RECLASSIFICATION_COLOR,
    eli5: "Registered inventory rose, but that day's real delivery-notice volume covered less than 10% of the increase — consistent with existing eligible stock being re-designated registered rather than fresh metal physically arriving. A structural fact about how the increase looks, not an implication of wrongdoing.",
  },
  {
    key: "deregistration",
    legendLabel: "Flagged — deregistration",
    color: DEREGISTRATION_COLOR,
    eli5: "The mirror case: registered inventory fell, but that day's real delivery-notice volume covered less than 10% of the drop — consistent with registered stock being re-designated back to eligible (still in the vault, never left) rather than metal actually being withdrawn from COMEX custody.",
  },
  {
    key: "total_volume",
    legendLabel: "Total vault volume",
    color: TOTAL_VOLUME_COLOR,
    eli5: "Total COMEX silver holdings (registered + eligible) each day — the physical stack itself, plotted on its own right-hand axis since its scale (hundreds of millions of oz) is far larger than the day-to-day change the bars show.",
  },
];

function fmt_oz(v) {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " oz";
}

// Drops the day-of-month from an ISO date (2026-06-16 -> 2026-06) for the
// x-axis — MM-DD (no year) still read as too cluttered on a dense axis
// spanning many months; YYYY-MM keeps the year (needed once the window can
// span multiple years, e.g. "1y"/"All") while dropping the highest-frequency
// component.
function fmt_year_month(isoDate) {
  return isoDate.slice(0, 7);
}

// Caps the x-axis to a fixed number of rendered ticks regardless of how many
// rows are in the current window (100ish for "checked" up to 1,600+ for
// "All") — same pattern as money_supply.jsx's own xTicks(data, maxTicks).
// The exact date is already surfaced on hover via the tooltip, so the axis
// itself only needs to orient roughly in time, not label every point.
function xTicks(rows, maxTicks = 12) {
  if (!rows || rows.length === 0) return [];
  const n = Math.min(rows.length, maxTicks);
  const step = Math.floor(rows.length / n) || 1;
  return rows.filter((_, i) => i % step === 0).map((r) => r.date);
}

// Computes a y-axis domain + 5 evenly-spaced ticks from the REAL values in
// the current window, rounded outward to a clean step — gold and silver
// have wildly different real magnitudes (silver's total_oz sits ~300-360M,
// gold's ~23-33M; silver's daily total_delta swings ~±3M, gold's ~±4M) so a
// domain hardcoded from one metal's numbers silently mis-scales the other
// (confirmed live: silver's fixed [300M,400M]/[-4M,4M] domains rendered
// gold's real ~23-33M line as a flat garbage line pinned near the bottom of
// an axis it was never sized for). `values` should already exclude nulls.
function niceAxis(values, { includeZero = false } = {}) {
  if (!values.length) return { domain: [0, 1], ticks: [0, 1] };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const range = max - min || 1;
  // Round the step to a "nice" magnitude (1/2/5 × a power of 10) so ticks
  // land on round numbers instead of jagged real-data fractions.
  const rawStep = range / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v));
  return { domain: [niceMin, niceMax], ticks };
}

const FLAG_LABELS = {
  reclassification: "Flagged — reclassification (registered rose, low delivery coverage)",
  deregistration: "Flagged — deregistration (registered fell, low delivery coverage)",
};

function ReclassificationTooltipContent({ active, label, rows }) {
  if (!active || !label) return null;
  const d = rows.find((r) => r.date === label);
  if (!d) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600, marginBottom: 4 }}>{d.date}</div>
      <div style={{ color: barColor(d.flag_type) }}>
        {d.flag_type
          ? FLAG_LABELS[d.flag_type]
          : d.registered_delta > 0
          ? "Normal — delivery activity covers the increase"
          : d.registered_delta < 0
          ? "Normal — delivery activity covers the decrease"
          : "No registered change"}
      </div>
      <div style={{ color: "#8a94a6", marginTop: 4 }}>
        Registered change: {fmt_oz(d.registered_delta)}
      </div>
      <div
        style={{
          color:
            d.total_delta > 0 ? NORMAL_COLOR : d.total_delta < 0 ? RECLASSIFICATION_COLOR : TOTAL_VOLUME_COLOR,
        }}
      >
        Total vault change: {fmt_oz(d.total_delta)}
      </div>
      <div style={{ color: "#8a94a6" }}>Delivery volume: {fmt_oz(d.delivery_volume_oz)}</div>
      <div style={{ color: "#8a94a6" }}>Total in vault: {fmt_oz(d.total_oz)}</div>
    </div>
  );
}

function ReclassificationChart({ reclassification, sfWindow, sfCustomStart, sfCustomEnd, pinnedDate, onPin }) {
  const [clickedKey, setClickedKey] = useState(null);

  function toggle(key) {
    setClickedKey((prev) => (prev === key ? null : key));
  }

  if (!reclassification.available) {
    return (
      <div className="comex-empty">
        {reclassification.reason}
      </div>
    );
  }

  const allRows = reclassification.days;
  const coverageStart = reclassification.coverage_start_date;
  // Driven by Stock & Flow's shared window selector (2026-07-24) — this
  // chart's own "Checked period" window control was dropped in favor of the
  // shared one, per the user's explicit call; the underlying pre-coverage-
  // years distinction is still surfaced via coverageNote below.
  const rows = filterBySFWindow(allRows, sfWindow, sfCustomStart, sfCustomEnd);
  const reclassCount = rows.filter((d) => d.flag_type === "reclassification").length;
  const deregCount = rows.filter((d) => d.flag_type === "deregistration").length;
  const deltaAxis = niceAxis(
    rows.map((d) => d.total_delta).filter((v) => v != null),
    { includeZero: true }
  );
  const totalAxis = niceAxis(rows.map((d) => d.total_oz).filter((v) => v != null));
  const coverageNote = coverageStart
    ? `Delivery-notice data only exists from ${coverageStart} onward — days before that can't be checked for a flag, and are not shown as confirmed clean.`
    : `No delivery-notice data persisted yet — no day can currently be checked for a flag.`;

  if (allRows.length === 0) {
    return <div className="flow-panel-note">No inventory history persisted yet. {coverageNote}</div>;
  }

  const pinnedDateSnapped = nearestRowDate(rows, pinnedDate);

  return (
    <>
      <div className="flow-panel-note">
        The COMEX physical silver stack, day by day. Bars show the day's change in registered
        inventory — green for a normal move, red when a registered increase looks like
        reclassification of existing eligible stock rather than fresh metal arriving, amber when a
        registered decrease looks like de-registration back to eligible rather than metal actually
        leaving COMEX custody (both: delivery-notice volume covered less than 10% of the move —
        structural facts, not implications of wrongdoing). The blue line is total vault holdings
        (registered + eligible).{" "}
        {reclassCount} reclassification / {deregCount} deregistration day(s) shown of {rows.length}.{" "}
        {coverageNote}
        {onPin && " Click a bar to pin this date across the Stock & Flow charts below."}
      </div>
      <div className="comex-legend-list comex-legend-list--horizontal">
        {RECLASSIFICATION_LEGEND.map(({ key, legendLabel, color }) => (
          <button
            key={key}
            className={`comex-legend-item legend-btn-row${clickedKey === key ? " legend-btn-row--baseline" : ""}`}
            style={{ "--legend-color": color }}
            onClick={() => toggle(key)}
          >
            <span className="comex-legend-swatch" style={{ background: color }} />
            <span>{legendLabel}</span>
          </button>
        ))}
      </div>
      {clickedKey && (
        <div className="comex-panel-note comex-panel-note--eli5">
          {RECLASSIFICATION_LEGEND.find((d) => d.key === clickedKey)?.eli5}
        </div>
      )}
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart
          data={rows}
          margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
          onClick={(state) => {
            if (state?.activeLabel && onPin) onPin(state.activeLabel);
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis
            dataKey="date"
            tickFormatter={fmt_year_month}
            ticks={xTicks(rows, 10)}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
          />
          <YAxis
            yAxisId="delta"
            // Domain + ticks computed from this window's REAL total_delta
            // values (niceAxis, above) rather than a fixed constant — gold
            // and silver have genuinely different real magnitudes (silver's
            // daily change swings ~±3M oz, gold's ~±4M but off a much
            // smaller total base), so a domain tuned for one metal silently
            // mis-scaled the other (confirmed live: gold rendered as a flat
            // garbage line under silver's hardcoded ±4M/300-400M domains).
            // A prior attempt at a computed domain had a real Recharts
            // signature bug (domain functions are called as two positional
            // args (dataMin, dataMax), not one destructurable array) — fixed
            // here by computing the domain in plain JS before render instead
            // of inside Recharts' own domain-function callback.
            domain={deltaAxis.domain}
            tickFormatter={(v) => `${(v / 1_000_000).toFixed(1)}M`}
            ticks={deltaAxis.ticks}
            tick={{ fill: "#8a94a6", fontSize: 11 }}
            label={{ value: "Δ oz", position: "insideTopLeft", fill: "#5a6278", fontSize: 11 }}
          />
          <YAxis
            yAxisId="total"
            orientation="right"
            // Same real-data-driven domain approach as the "delta" axis
            // above — gold's total vault volume (~23-33M oz) is roughly an
            // order of magnitude smaller than silver's (~300-360M oz).
            domain={totalAxis.domain}
            tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`}
            ticks={totalAxis.ticks}
            tick={{ fill: TOTAL_VOLUME_COLOR, fontSize: 11 }}
            label={{ value: "total oz", angle: 90, position: "insideTopRight", fill: TOTAL_VOLUME_COLOR, fontSize: 11 }}
          />
          <Tooltip content={<ReclassificationTooltipContent rows={rows} />} />
          {pinnedDateSnapped && (
            <ReferenceLine yAxisId="delta" x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
          )}
          <ReferenceLine yAxisId="delta" y={0} stroke="#4a5268" />
          <Bar
            yAxisId="delta"
            dataKey="total_delta"
            isAnimationActive={false}
            fillOpacity={clickedKey === "total_volume" ? 0.25 : 1}
          >
            {rows.map((d) => (
              <Cell key={d.date} fill={barColor(d.flag_type)} />
            ))}
          </Bar>
          <Line
            yAxisId="total"
            type="monotone"
            dataKey="total_oz"
            stroke={TOTAL_VOLUME_COLOR}
            dot={false}
            strokeWidth={clickedKey === "total_volume" ? 3 : 2}
            strokeOpacity={clickedKey && clickedKey !== "total_volume" ? 0.3 : 1}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {pinnedDateSnapped && (
        <div style={{ marginTop: 4 }}>
          <ReclassificationTooltipContent active label={pinnedDateSnapped} rows={rows} />
        </div>
      )}
    </>
  );
}

function useDeliveryBehavior(metal) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/delivery-behavior/db?metal=${metal}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json.data ?? null);
    } catch (e) {
      setError(e.message);
    }
  }, [metal]);

  useEffect(() => {
    fetchAll();
    window.addEventListener(FORCE_REFRESH_EVENT, fetchAll);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, fetchAll);
  }, [fetchAll]);

  return { data, error };
}

export default function DeliveryBehaviorPanel({ metal, sfWindow, sfCustomStart, sfCustomEnd, pinnedDate, onPin }) {
  const { data, error } = useDeliveryBehavior(metal);

  // metal is now a controlled prop (2026-07-24) — the selector moved up to
  // "COMEX — New York"'s own header (its natural home, since it also drives
  // the sibling Per-Vault Snapshot panel), replacing the local <select> this
  // panel used to own. Still clear any existing pin on a metal switch — a
  // pin made while viewing gold has no meaning once switched to silver (or
  // vice versa), since the underlying per-day rows are metal-specific.
  useEffect(() => {
    onPin?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metal]);

  return (
    <>
      <div className="comex-panel">
        <div className="comex-panel-header">
          Reclassification vs. Real Inflow
        </div>

        {data ? (
          <ReclassificationChart
            reclassification={data.reclassification}
            sfWindow={sfWindow}
            sfCustomStart={sfCustomStart}
            sfCustomEnd={sfCustomEnd}
            pinnedDate={pinnedDate}
            onPin={onPin}
          />
        ) : error ? (
          <div className="comex-empty">
            No data available.
            <div className="comex-empty-note">{error}</div>
          </div>
        ) : (
          <div className="comex-empty">Loading…</div>
        )}
      </div>
    </>
  );
}
