import { useState, useEffect, useMemo } from "react";
import {
  ComposedChart, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import ChartStaleness from "./chart_staleness";
import { apiFetch } from "./api_client";
import { nearestRowDate, xTicks, windowToSinceUntil, inDateRange } from "./date_utils";

// soma-bank-growth-spec.md — Money Management's 6th sub-panel. A read-time
// correlation view of two real, independently-measured quarterly
// aggregates: total U.S. bank assets (bank_financials) and Fed SOMA
// holdings (fed_soma_holdings). No new upstream source, no composite score.
// EXPLICITLY NOT a causal claim — no data exists anywhere that discloses
// which banks received Fed-created reserves (see the spec's own §1); this
// panel shows two lines together for comparison and nothing more. Story A
// (this pass) is the system-wide chart; Story B (top-10-cohort growth
// share) is a later addition to this same sub-panel.

const MUTED = "#8a94a6";
const PIN_LINE_COLOR = "#e8ecf4";
const BANK_ASSETS_COLOR = "#4caf76";
const SOMA_COLOR = "#4ac6ff";
const SHARE_COLOR = "#e8b04a";
const SHARE_NEGATIVE_COLOR = "#e05252";
const SOMA_QOQ_COLOR = "#4ac6ff";

function fmtPct(v, digits = 0) {
  return v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function fmtUsdCompact(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function BankGrowthTooltip({ active, label, rows }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.quarter === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {row.total_bank_assets != null && (
        <div style={{ color: BANK_ASSETS_COLOR }}>Total U.S. bank assets: {fmtUsdCompact(row.total_bank_assets)}</div>
      )}
      {row.soma_holdings != null && (
        <div style={{ color: SOMA_COLOR }}>SOMA holdings: {fmtUsdCompact(row.soma_holdings)}</div>
      )}
    </div>
  );
}

function BankGrowthVsSomaChart({ rows, pinnedDate, onPin }) {
  const [clickedKey, setClickedKey] = useState(null);
  // xTicks/nearestRowDate both key off a `date` field; this chart's own
  // x-axis dataKey is `quarter` (repdte, an ISO quarter-end string) — alias
  // it rather than renaming the chart's own field, since the tooltip/legend
  // below read `quarter` directly off the raw API rows.
  const merged = useMemo(() => rows.map((r) => ({ ...r, date: r.quarter })), [rows]);
  const ticks = useMemo(() => xTicks(merged, 8), [merged]);
  const pinnedSnap = pinnedDate ? nearestRowDate(merged, pinnedDate) : null;

  if (merged.length === 0) {
    return <div className="comex-empty">No data persisted yet.</div>;
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart
          data={merged}
          margin={{ top: 4, right: 48, left: 12, bottom: 4 }}
          onClick={(state) => state?.activeLabel && onPin(state.activeLabel)}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="quarter" ticks={ticks} tick={{ fill: MUTED, fontSize: 11 }} />
          <YAxis
            yAxisId="bank"
            domain={["auto", "auto"]}
            tickFormatter={(v) => fmtUsdCompact(v)}
            tick={{ fill: BANK_ASSETS_COLOR, fontSize: 11 }}
            width={70}
          />
          <YAxis
            yAxisId="soma"
            orientation="right"
            domain={["auto", "auto"]}
            tickFormatter={(v) => fmtUsdCompact(v)}
            tick={{ fill: SOMA_COLOR, fontSize: 11 }}
            width={70}
          />
          <Tooltip content={<BankGrowthTooltip rows={merged} />} />
          {pinnedSnap && <ReferenceLine yAxisId="bank" x={pinnedSnap} stroke={PIN_LINE_COLOR} strokeDasharray="3 3" />}
          <Line
            yAxisId="bank"
            type="monotone"
            dataKey="total_bank_assets"
            stroke={BANK_ASSETS_COLOR}
            dot={false}
            strokeWidth={clickedKey === "total_bank_assets" ? 3 : 2}
            strokeOpacity={clickedKey && clickedKey !== "total_bank_assets" ? 0.3 : 1}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            yAxisId="soma"
            type="monotone"
            dataKey="soma_holdings"
            stroke={SOMA_COLOR}
            dot={false}
            strokeWidth={clickedKey === "soma_holdings" ? 3 : 2}
            strokeOpacity={clickedKey && clickedKey !== "soma_holdings" ? 0.3 : 1}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {pinnedSnap && (
        <div style={{ marginTop: 4 }}>
          <BankGrowthTooltip active label={pinnedSnap} rows={merged} />
        </div>
      )}
      <div className="comex-legend-list comex-legend-list--horizontal">
        <button
          className={`comex-legend-item legend-btn-row${clickedKey === "total_bank_assets" ? " legend-btn-row--baseline" : ""}`}
          onClick={() => setClickedKey((k) => (k === "total_bank_assets" ? null : "total_bank_assets"))}
        >
          <span className="comex-legend-swatch" style={{ background: BANK_ASSETS_COLOR }} />
          <span><strong>Total U.S. bank assets</strong> — every real Call Report filing that quarter, summed (left axis).</span>
        </button>
        <button
          className={`comex-legend-item legend-btn-row${clickedKey === "soma_holdings" ? " legend-btn-row--baseline" : ""}`}
          onClick={() => setClickedKey((k) => (k === "soma_holdings" ? null : "soma_holdings"))}
        >
          <span className="comex-legend-swatch" style={{ background: SOMA_COLOR }} />
          <span><strong>Fed SOMA holdings</strong> — the real, NY Fed-published total, resampled to quarter-end (right axis, a different scale — bank assets run ~4x larger).</span>
        </button>
      </div>
      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        Two real, independently-measured totals, shown together for comparison — never a claim that
        one caused the other. No source discloses which banks, if any, received Fed-created reserves;
        the only thing either series can support is "these two system-wide numbers moved like this at
        the same time," not "because of." Historical description only.
      </div>
    </div>
  );
}

// Story B: does a fixed cohort of the largest banks (by current size,
// tracked consistently across quarters — the cohort composition itself
// doesn't change quarter to quarter, only how much each member grew)
// capture a disproportionate share of the system's own net quarterly
// growth? Share is against NET SYSTEM-WIDE growth (Story A's own delta) —
// it can legitimately run above 100% or go negative in an odd quarter
// (the rest of the system shrank while the cohort grew, or vice versa).
// That's real information, never clamped or hidden, same treatment this
// app already gives Money Supply's own unclamped assetsLiabilitiesRatio.
function BankGrowthDistributionTooltip({ active, label, rows }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.quarter === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {row.top_n_growth_share != null && (
        <div style={{ color: row.top_n_growth_share >= 0 ? SHARE_COLOR : SHARE_NEGATIVE_COLOR }}>
          Cohort's share of net system growth: {fmtPct(row.top_n_growth_share)}
        </div>
      )}
      {row.soma_qoq_change != null && (
        <div style={{ color: SOMA_QOQ_COLOR }}>SOMA quarterly change: {fmtUsdCompact(row.soma_qoq_change)}</div>
      )}
    </div>
  );
}

function BankGrowthDistributionChart({ cohort, series, pinnedDate, onPin }) {
  const [clickedKey, setClickedKey] = useState(null);
  const [showCohort, setShowCohort] = useState(false);
  const merged = useMemo(() => series.map((r) => ({ ...r, date: r.quarter })), [series]);
  const ticks = useMemo(() => xTicks(merged, 8), [merged]);
  const pinnedSnap = pinnedDate ? nearestRowDate(merged, pinnedDate) : null;

  if (merged.length === 0) {
    return <div className="comex-empty">No data persisted yet.</div>;
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div className="comex-panel-header" style={{ fontSize: 13 }}>
        Top {cohort.length} banks' share of net system growth
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart
          data={merged}
          margin={{ top: 4, right: 48, left: 12, bottom: 4 }}
          onClick={(state) => state?.activeLabel && onPin(state.activeLabel)}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="quarter" ticks={ticks} tick={{ fill: MUTED, fontSize: 11 }} />
          <YAxis
            yAxisId="share"
            domain={["auto", "auto"]}
            tickFormatter={(v) => fmtPct(v)}
            tick={{ fill: SHARE_COLOR, fontSize: 11 }}
            width={55}
          />
          <YAxis
            yAxisId="soma"
            orientation="right"
            domain={["auto", "auto"]}
            tickFormatter={(v) => fmtUsdCompact(v)}
            tick={{ fill: SOMA_QOQ_COLOR, fontSize: 11 }}
            width={70}
          />
          <Tooltip content={<BankGrowthDistributionTooltip rows={merged} />} />
          <ReferenceLine yAxisId="share" y={0} stroke="#5a6278" strokeDasharray="2 4" />
          {pinnedSnap && <ReferenceLine yAxisId="share" x={pinnedSnap} stroke={PIN_LINE_COLOR} strokeDasharray="3 3" />}
          <Bar
            yAxisId="share"
            dataKey="top_n_growth_share"
            barSize={10}
            isAnimationActive={false}
            fillOpacity={clickedKey && clickedKey !== "top_n_growth_share" ? 0.2 : 0.85}
          >
            {merged.map((row) => (
              <Cell key={row.quarter} fill={row.top_n_growth_share >= 0 ? SHARE_COLOR : SHARE_NEGATIVE_COLOR} />
            ))}
          </Bar>
          <Line
            yAxisId="soma"
            type="monotone"
            dataKey="soma_qoq_change"
            stroke={SOMA_QOQ_COLOR}
            dot={false}
            strokeWidth={clickedKey === "soma_qoq_change" ? 3 : 1.5}
            strokeOpacity={clickedKey && clickedKey !== "soma_qoq_change" ? 0.25 : 1}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {pinnedSnap && (
        <div style={{ marginTop: 4 }}>
          <BankGrowthDistributionTooltip active label={pinnedSnap} rows={merged} />
        </div>
      )}
      <div className="comex-legend-list comex-legend-list--horizontal">
        <button
          className={`comex-legend-item legend-btn-row${clickedKey === "top_n_growth_share" ? " legend-btn-row--baseline" : ""}`}
          onClick={() => setClickedKey((k) => (k === "top_n_growth_share" ? null : "top_n_growth_share"))}
        >
          <span className="comex-legend-swatch" style={{ background: `linear-gradient(90deg, ${SHARE_COLOR} 50%, ${SHARE_NEGATIVE_COLOR} 50%)` }} />
          <span><strong>Top-{cohort.length} cohort's share of net system growth</strong> — left axis. Can run above 100% or go negative; that's a real reading of an odd quarter, not an error.</span>
        </button>
        <button
          className={`comex-legend-item legend-btn-row${clickedKey === "soma_qoq_change" ? " legend-btn-row--baseline" : ""}`}
          onClick={() => setClickedKey((k) => (k === "soma_qoq_change" ? null : "soma_qoq_change"))}
        >
          <span className="comex-legend-swatch" style={{ background: SOMA_QOQ_COLOR }} />
          <span><strong>SOMA quarterly change</strong> — right axis, from Story A above.</span>
        </button>
      </div>
      <button
        type="button"
        className="comex-legend-item legend-btn-row"
        onClick={() => setShowCohort((v) => !v)}
        style={{ marginTop: 8 }}
      >
        <span>{showCohort ? "▾" : "▸"} Which {cohort.length} banks are in this cohort?</span>
      </button>
      {showCohort && (
        <div className="comex-panel-note comex-panel-note--eli5">
          Fixed by CURRENT size, tracked the same across every quarter shown (not re-ranked each
          quarter) — a bank's own contribution can be small or negative in an earlier quarter even
          though it's one of today's largest: {cohort.map((c) => c.name).join(", ")}.
        </div>
      )}
      <div className="comex-panel-note" style={{ marginTop: 8 }}>
        This is not "who received Fed money" — no source discloses that, at any resolution finer than
        the whole banking system (see the note above). It only shows whether the system's growth is
        concentrated in its largest banks in a given quarter, alongside Fed SOMA activity that same
        quarter. A high or low share, and any resemblance (or lack of one) to the SOMA line, is
        described here as an observation, not a mechanism.
      </div>
    </div>
  );
}

export default function FedBankGrowthPanel({ window_, customStart, customEnd, pinnedDate, onPin }) {
  const [rows, setRows] = useState(null);
  const [distribution, setDistribution] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiFetch("/api/fed-money-creation-vs-bank-growth/db")
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) throw new Error(j.detail || "Failed to load bank growth data");
        setRows(j.data);
        setError(null);
      })
      .catch((e) => setError(e.message));
    apiFetch("/api/fed-bank-growth-distribution/db?n=10")
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) throw new Error(j.detail || "Failed to load bank growth distribution");
        setDistribution(j.data);
      })
      .catch((e) => setError((prev) => prev ?? e.message));
  }, []);

  // Respects Money Management's panel-wide 2Y/5Y/10Y/20Y/Custom window
  // selector — client-side, same as TransmissionPanel/OperationalFlowPanel
  // (this route has no window param; it's a small, already-fully-fetched
  // quarterly series, not FRED's many-series pull).
  const { since, until, incomplete } = useMemo(
    () => windowToSinceUntil(window_, customStart, customEnd),
    [window_, customStart, customEnd]
  );
  const windowedRows = useMemo(
    () => (incomplete ? [] : (rows ?? []).filter((r) => inDateRange(r.quarter, since, until))),
    [rows, since, until, incomplete]
  );
  const windowedSeries = useMemo(
    () => (incomplete ? [] : (distribution?.series ?? []).filter((r) => inDateRange(r.quarter, since, until))),
    [distribution, since, until, incomplete]
  );

  return (
    <details className="collapsible-pane">
      <summary className="collapsible-pane-title">
        <ChartStaleness sourceKey={["bank_financials", "fed_operational_flow"]} />
        <span>Fed Purchases vs. Bank Growth</span>
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-panel-note">
          Is bank-system growth correlated with Fed SOMA purchases, at a quarterly resolution? This is
          a correlation view of two real, independently-sourced totals — not proof that any specific
          bank received Fed-created reserves. No source publishes daily or per-bank balance sheets, so
          that finer-grained question is unanswerable with any data this app (or anyone else) has.
        </div>
        {error && <div className="error-box">{error}</div>}
        {incomplete && <div className="comex-panel-note">Set both a From and To date to see Custom range data.</div>}
        {rows == null && !error ? (
          <div className="comex-panel-note">Loading...</div>
        ) : (
          <BankGrowthVsSomaChart rows={windowedRows} pinnedDate={pinnedDate} onPin={onPin} />
        )}
        {distribution && (
          <BankGrowthDistributionChart
            cohort={distribution.cohort}
            series={windowedSeries}
            pinnedDate={pinnedDate}
            onPin={onPin}
          />
        )}
      </div>
    </details>
  );
}
