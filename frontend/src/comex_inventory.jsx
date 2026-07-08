import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import MarketBalancePanel, { DemandCompositionPanel } from "./market_balance";
import DeliveryBehaviorPanel from "./delivery_behavior_panel";
import { VAULT_COLORS } from "./palette";
import { FORCE_REFRESH_EVENT } from "./refresh_controls";

const REFRESH_MS = (parseInt(import.meta.env.VITE_AV_REFRESH_INTERVAL, 10) || 60) * 1000;
const STALE_MS = 5 * 60 * 1000;

function fmt_moz(v) {
  if (v == null) return "—";
  return (v / 1_000_000).toFixed(2) + "M oz";
}

function fmt_oz(v) {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " oz";
}

function delta_class(val) {
  if (val == null || val === 0) return "comex-delta-flat";
  return val > 0 ? "comex-delta-pos" : "comex-delta-neg";
}

function delta_str(val) {
  if (val == null) return "—";
  if (val === 0) return "—";
  const sign = val > 0 ? "+" : "";
  return sign + fmt_oz(val);
}

// ── Range selector ──────────────────────────────────────────────────────────

const RANGES = ["1M", "3M", "1Y", "5Y", "ALL"];

function RangeSelector({ value, onChange }) {
  return (
    <div className="comex-range-selector">
      {RANGES.map((r) => (
        <button
          key={r}
          className={`comex-range-btn${value === r ? " comex-range-btn--active" : ""}`}
          onClick={() => onChange(r)}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

// ── Filtered history by range ───────────────────────────────────────────────

function filterByRange(data, range) {
  if (!data || range === "ALL") return data;
  const now = new Date();
  const cutoffs = { "1M": 30, "3M": 90, "1Y": 365, "5Y": 1825 };
  const days = cutoffs[range];
  if (!days) return data;
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  return data.filter((r) => r.date >= cutoff);
}

function xTicks(data) {
  if (!data || data.length === 0) return [];
  const n = Math.min(data.length, 8);
  const step = Math.floor(data.length / n);
  return data.filter((_, i) => i % step === 0).map((r) => r.date);
}

// ── Panel 2: Registered vs Eligible ────────────────────────────────────────

function RegEligiblePanel({ history }) {
  const [range, setRange] = useState("1Y");
  const filtered = (filterByRange(history, range) ?? []).map((r) => {
    const total = (r.registered ?? 0) + (r.eligible ?? 0);
    return {
      ...r,
      pct_available: r.registered != null && total > 0 ? (r.registered / total) * 100 : null,
    };
  });
  const ticks = xTicks(filtered);

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        Registered vs Eligible Silver — % Available for Delivery
        <RangeSelector value={range} onChange={setRange} />
      </div>
      <div className="comex-panel-note">
        Registered = deliverable (warranted). Eligible = stored, not warranted.
        Sharp registered drop = delivery pressure signal. % available spike up =
        more of total COMEX silver warranted for delivery (bullish physical demand signal).
      </div>
      {filtered && filtered.length > 0 ? (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={filtered} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
            <YAxis
              yAxisId="oz"
              tickFormatter={(v) => `${(v / 1e6).toFixed(0)}M`}
              tick={{ fill: "#8a94a6", fontSize: 11 }}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              tickFormatter={(v) => `${v.toFixed(0)}%`}
              tick={{ fill: "#e8ecf4", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
              labelStyle={{ color: "#c8d0de" }}
              formatter={(v, name) => {
                if (name === "pct_available") return [v != null ? v.toFixed(1) + "%" : "—", "% available for delivery — right axis"];
                return [fmt_moz(v), name === "registered" ? "Registered — left axis" : "Eligible — left axis"];
              }}
            />
            <Line
              yAxisId="oz"
              type="monotone"
              dataKey="registered"
              stroke="#4caf76"
              dot={false}
              strokeWidth={1.8}
              connectNulls={false}
            />
            <Line
              yAxisId="oz"
              type="monotone"
              dataKey="eligible"
              stroke="#e05252"
              dot={false}
              strokeWidth={1.8}
              connectNulls={false}
            />
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="pct_available"
              stroke="#e8ecf4"
              dot={false}
              strokeWidth={1.8}
              strokeDasharray="4 3"
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="comex-empty">No data</div>
      )}
      <div className="comex-legend-list">
        <div className="comex-legend-item">
          <span className="comex-legend-swatch" style={{ background: "#4caf76" }} />
          <span><strong>Registered</strong> — deliverable (warranted) COMEX silver, left axis.</span>
        </div>
        <div className="comex-legend-item">
          <span className="comex-legend-swatch" style={{ background: "#e05252" }} />
          <span><strong>Eligible</strong> — stored at COMEX vaults but not warranted for delivery, left axis.</span>
        </div>
        <div className="comex-legend-item">
          <span className="comex-legend-swatch comex-legend-swatch--dashed" style={{ borderColor: "#e8ecf4" }} />
          <span><strong>% available for delivery</strong> — registered ÷ (registered + eligible), right axis. Higher = more of COMEX inventory is deliverable, not delivered.</span>
        </div>
      </div>
    </div>
  );
}

// ── Panel 4: Paper leverage ratio ──────────────────────────────────────────
// The volume-oi endpoint returns today's snapshot only (no historical series),
// so this renders as a stat card rather than a chart.

// ── Vault pie chart colors ──────────────────────────────────────────────────

function shortName(name) {
  return name
    .replace(/\bBank\b.*/, "Bank")
    .replace(/\bInternational\b/, "Intl")
    .replace(/\bDepository\b/, "Dep.")
    .replace(/\bPrecious Metals\b/, "PM")
    .replace(/, (Inc|LLC|NA)\b\.?/i, "")
    .replace(/\(US\)/i, "")
    .trim();
}

// ── Panel 5: Per-vault snapshot table + pie chart ──────────────────────────

function VaultSnapshotPanel({ depositories, pinnedDate, pinnedDepositories, pinnedLoading }) {
  const [pieMetric, setPieMetric] = useState("total");

  const headerLabel = pinnedDate ? `Per-Vault Snapshot — ${pinnedDate}` : "Per-Vault Snapshot — Today";

  // While a pinned-date fetch is in flight, keep showing today's rows in the
  // background rather than swapping them out — this component always renders
  // the exact same tree (header/note/pie-slot/table-slot never disappear),
  // with only an overlay message toggled inside those fixed-height slots when
  // there's nothing to show for the pinned date. Any branch that removes the
  // ResponsiveContainer/table from the tree entirely forces Recharts to
  // remount and briefly measure 0×0, which visibly collapses the pie — and
  // the resulting reflow shifts the Delivery Behavior table below it, which
  // knocks the mouse off the very row being hovered and fires a spurious
  // mouseleave that cancels the pin.
  const showingPinned = pinnedDate && !pinnedLoading;
  const pinnedHasData = (pinnedDepositories?.data?.length ?? 0) > 0;
  const effectiveDepositories = showingPinned && pinnedHasData ? pinnedDepositories : depositories;
  const overlayMessage = showingPinned && !pinnedHasData
    ? `No per-vault snapshot persisted for ${pinnedDate} yet — history only goes back to whenever this data first started being recorded.`
    : !effectiveDepositories
    ? "Loading…"
    : null;

  const rows = [...(effectiveDepositories?.data || [])].sort(
    (a, b) => (b.total ?? 0) - (a.total ?? 0)
  );

  const pieData = rows
    .filter((r) => (r[pieMetric] ?? 0) > 0)
    .map((r, i) => ({
      name: shortName(r.depository),
      fullName: r.depository,
      value: r[pieMetric],
      color: VAULT_COLORS[i % VAULT_COLORS.length],
    }));

  const METRIC_LABELS = { total: "Total", registered: "Registered", eligible: "Eligible" };

  return (
    <div className="comex-panel comex-panel--vault-snapshot">
      <div className="comex-panel-header">{headerLabel}</div>
      <div className="comex-panel-note">
        Sorted by total descending. Δ columns vs previous day. Green = increase, red = decrease.
        {pinnedDate && " Pinned from a hovered Delivery Behavior date — hover away to return to today."}
      </div>

      <div className="comex-vault-snapshot-body">
        {overlayMessage && (
          <div className="comex-vault-snapshot-overlay">
            <div className="comex-empty">{overlayMessage}</div>
          </div>
        )}

        {/* Pie chart */}
        <div className="comex-vault-pie-row">
          <div className="comex-pie-metric-selector">
            {Object.entries(METRIC_LABELS).map(([k, label]) => (
              <button
                key={k}
                className={`comex-range-btn${pieMetric === k ? " comex-range-btn--active" : ""}`}
                onClick={() => setPieMetric(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={110}
                innerRadius={54}
                paddingAngle={1}
              >
                {pieData.map((entry) => (
                  <Cell key={entry.fullName} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                formatter={(v, _, props) => [fmt_oz(v), props.payload.fullName]}
              />
              <Legend
                formatter={(_, entry) => (
                  <span style={{ color: "#8a94a6", fontSize: 11 }}>{entry.payload.name}</span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Table */}
        <div className="comex-table-wrap">
          <table className="comex-table">
            <thead>
              <tr>
                <th>Depository</th>
                <th className="right">Registered</th>
                <th className="right">Eligible</th>
                <th className="right">Total</th>
                <th className="right">Δ Registered</th>
                <th className="right">Δ Eligible</th>
                <th className="right">Δ Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const dReg = r.registered != null && r.prevRegistered != null
                  ? r.registered - r.prevRegistered : null;
                const dElig = r.eligible != null && r.prevEligible != null
                  ? r.eligible - r.prevEligible : null;
                const dTotal = r.total != null && r.prevTotal != null
                  ? r.total - r.prevTotal : null;
                return (
                  <tr key={r.depository}>
                    <td className="comex-vault-name">{r.depository}</td>
                    <td className="right">{fmt_oz(r.registered)}</td>
                    <td className="right">{fmt_oz(r.eligible)}</td>
                    <td className="right comex-total-col">{fmt_oz(r.total)}</td>
                    <td className={`right ${delta_class(dReg)}`}>{delta_str(dReg)}</td>
                    <td className={`right ${delta_class(dElig)}`}>{delta_str(dElig)}</td>
                    <td className={`right ${delta_class(dTotal)}`}>{delta_str(dTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Panel 6: Delivery notices MTD ──────────────────────────────────────────

function DeliveryNoticesPanel({ delivery }) {
  if (!delivery) return <div className="comex-empty">Loading…</div>;

  const data = delivery.data;
  const isArray = Array.isArray(data);

  // MTD summary — may be a number, object, or array depending on response shape
  let summary = null;
  if (!isArray && data != null) {
    summary = data;
  } else if (isArray) {
    summary = data;
  }

  function renderValue(v) {
    if (v == null) return <span className="comex-empty">—</span>;
    if (typeof v === "number") return <strong>{v.toLocaleString()}</strong>;
    if (typeof v === "string") return <span>{v}</span>;
    if (typeof v === "object") {
      return (
        <table className="comex-delivery-table">
          <tbody>
            {Object.entries(v).map(([k, val]) => (
              <tr key={k}>
                <td className="comex-delivery-key">{k}</td>
                <td className="comex-delivery-val">
                  {typeof val === "number" ? val.toLocaleString() : String(val)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return String(v);
  }

  if (!isArray) return renderValue(summary);
  if (summary.length === 0) return <div className="comex-empty">No MTD notices yet</div>;

  // mtdCumulative/ytdCumulative are always 0 in metalcharts' response —
  // an unpopulated upstream field, not real zero-activity — so they're
  // dropped rather than shown as misleading data.
  const HIDDEN_COLUMNS = new Set(["mtdCumulative", "ytdCumulative"]);
  const rows = summary.slice(0, 20);
  const isTabular = rows.every((item) => item != null && typeof item === "object");
  const columns = isTabular
    ? Object.keys(rows[0]).filter((k) => !HIDDEN_COLUMNS.has(k))
    : [];

  return isTabular ? (
    <div className="comex-table-wrap">
      <table className="comex-table">
        <thead>
          <tr>
            {columns.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((item, i) => (
            <tr key={i}>
              {columns.map((k) => (
                <td key={k}>
                  {typeof item[k] === "number" ? item[k].toLocaleString() : String(item[k] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="comex-delivery-list">
      {rows.map((item, i) => <div key={i} className="comex-delivery-item">{String(item)}</div>)}
    </div>
  );
}

// ── Cross-exchange overlay chart ────────────────────────────────────────────
// Aligns COMEX (oz) and SHFE (oz converted from kg) on a shared date axis.
// SHFE only has ~8 months of history from metalcharts so the overlap window
// determines how far back the combined view goes.

function CrossExchangePanel({ comexHistory, shfeHistory, pslv }) {
  const [range, setRange] = useState("1Y");

  if (!comexHistory && !shfeHistory) return (
    <div className="comex-panel">
      <div className="comex-panel-header">COMEX vs SHFE — Combined Inventory</div>
      <div className="comex-empty">Loading…</div>
    </div>
  );

  const shfeByDate = {};
  for (const r of (shfeHistory || [])) shfeByDate[r.date] = r.total_oz;

  const pslvOz = pslv?.total_oz ?? null;

  const raw = (comexHistory || []).map((r) => ({
    date: r.date,
    comex: r.total,
    shfe: shfeByDate[r.date] ?? null,
    // PSLV is a point-in-time snapshot, not a series — show as constant line
    pslv: pslvOz,
  }));

  const filtered = filterByRange(raw, range);
  const ticks = xTicks(filtered);

  const hasData = filtered.some((r) => r.comex != null || r.shfe != null);

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        COMEX vs SHFE — Physical Exchange Inventories
        <RangeSelector value={range} onChange={setRange} />
      </div>
      <div className="comex-panel-note">
        Both in troy oz. SHFE converted from kg (÷1000 × 32.1507). SHFE history
        available from Nov 2025 via metalcharts. LME requires a paid subscription
        and is not shown.
      </div>
      {hasData ? (
        <>
          {(() => {
            const comexOz = filtered.filter(r=>r.comex).at(-1)?.comex ?? 0;
            const shfeOz  = filtered.filter(r=>r.shfe).at(-1)?.shfe  ?? 0;
            const barMax  = comexOz;
            const bars = [
              { label:"COMEX",        oz: comexOz,  color:"#7b9fff", note:"USA — New York vaults" },
              { label:"PSLV (Sprott)",oz: pslvOz,   color:"#4caf76", note:"Canada — Royal Canadian Mint, Ottawa" },
              { label:"SHFE",         oz: shfeOz,   color:"#f87171", note:"China — Shanghai warehouses" },
            ].filter(b => b.oz > 0);
            return (
              <div className="comex-exchange-size-bar">
                {bars.map(({ label, oz, color, note }) => (
                  <div key={label} className="comex-exchange-size-row">
                    <span className="comex-exchange-size-label" style={{color}}>{label}</span>
                    <div className="comex-exchange-size-track">
                      <div className="comex-exchange-size-fill" style={{
                        width: `${Math.min(oz / barMax * 100, 100).toFixed(1)}%`,
                        background: color,
                      }} />
                    </div>
                    <span className="comex-exchange-size-val">
                      {fmt_moz(oz)}
                      {oz < comexOz && (
                        <span className="comex-exchange-size-pct">
                          {" "}({(oz / comexOz * 100).toFixed(1)}% of COMEX)
                        </span>
                      )}
                    </span>
                    <span className="comex-exchange-size-note">{note}</span>
                  </div>
                ))}
              </div>
            );
          })()}
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={filtered} margin={{ top: 4, right: 56, left: 12, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
              <YAxis
                yAxisId="comex"
                tickFormatter={(v) => `${(v / 1e6).toFixed(0)}M`}
                tick={{ fill: "#7b9fff", fontSize: 11 }}
                width={52}
              />
              <YAxis
                yAxisId="shfe"
                orientation="right"
                tickFormatter={(v) => `${(v / 1e6).toFixed(1)}M`}
                tick={{ fill: "#f87171", fontSize: 11 }}
                width={52}
              />
              <Tooltip
                contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                labelStyle={{ color: "#c8d0de" }}
                formatter={(v, name) => [
                  fmt_moz(v),
                  name === "comex"
                    ? "COMEX (USA) — left axis"
                    : name === "pslv"
                    ? "PSLV/Sprott (Canada) — left axis, today's snapshot"
                    : "SHFE (China) — right axis",
                ]}
              />
              <Line yAxisId="comex" type="monotone" dataKey="comex" stroke="#7b9fff"
                dot={false} strokeWidth={1.8} connectNulls={false} />
              <Line yAxisId="shfe" type="monotone" dataKey="shfe" stroke="#f87171"
                dot={false} strokeWidth={1.8} connectNulls={false} />
              {pslvOz && (
                <Line yAxisId="comex" type="monotone" dataKey="pslv" stroke="#4caf76"
                  dot={false} strokeWidth={1.4} strokeDasharray="6 3" connectNulls={true} />
              )}
            </LineChart>
          </ResponsiveContainer>
          <div className="comex-legend-list">
            <div className="comex-legend-item">
              <span className="comex-legend-swatch" style={{ background: "#7b9fff" }} />
              <span><strong>COMEX (USA)</strong> — left axis, physical silver held in New York COMEX-approved vaults.</span>
            </div>
            <div className="comex-legend-item">
              <span className="comex-legend-swatch" style={{ background: "#f87171" }} />
              <span><strong>SHFE (China)</strong> — right axis (independent scale), physical silver in Shanghai Futures Exchange warehouses.</span>
            </div>
            <div className="comex-legend-item">
              <span className="comex-legend-swatch comex-legend-swatch--dashed" style={{ borderColor: "#4caf76" }} />
              <span><strong>PSLV/Sprott (Canada)</strong> — left axis, today's snapshot only (not a historical series), Sprott Physical Silver Trust holdings.</span>
            </div>
          </div>
          <div className="comex-dual-axis-note">
            Dual independent axes — each line uses its own scale to show trend movement.
            COMEX is genuinely ~12× larger than SHFE in absolute terms (see bars above).
          </div>
        </>
      ) : (
        <div className="comex-empty">No overlapping data in this range</div>
      )}
    </div>
  );
}

// ── SHFE history panel ──────────────────────────────────────────────────────

function ShfeHistoryPanel({ shfeHistory }) {
  const [range, setRange] = useState("1Y");
  const filtered = filterByRange(shfeHistory, range);
  const ticks = xTicks(filtered);

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        SHFE Silver Inventory (Shanghai)
        <RangeSelector value={range} onChange={setRange} />
      </div>
      <div className="comex-panel-note">
        Shanghai Futures Exchange warranted silver, in troy oz (converted from kg).
        SHFE silver is measured in kg; 1 lot = 15 kg.
      </div>
      {filtered && filtered.length > 0 ? (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={filtered} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
            <YAxis
              tickFormatter={(v) => `${(v / 1e6).toFixed(1)}M`}
              tick={{ fill: "#8a94a6", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
              labelStyle={{ color: "#c8d0de" }}
              formatter={(v) => [fmt_moz(v), "SHFE Total"]}
            />
            <Line type="monotone" dataKey="total_oz" stroke="#f87171" dot={false}
              strokeWidth={1.8} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="comex-empty">No data</div>
      )}
    </div>
  );
}

// ── SHFE warehouse snapshot table ───────────────────────────────────────────

function ShfeWarehousePanel({ shfeWarehouses }) {
  if (!shfeWarehouses) return (
    <div className="comex-panel">
      <div className="comex-panel-header">SHFE Warehouse Snapshot</div>
      <div className="comex-empty">Loading…</div>
    </div>
  );

  const rows = [...(shfeWarehouses.data || [])].sort(
    (a, b) => (b.warrant ?? 0) - (a.warrant ?? 0)
  );

  const totalOz = rows.reduce((s, r) => s + (r.warrant_oz ?? 0), 0);
  const date = rows[0]?.date ?? "—";

  const pieData = rows
    .filter((r) => (r.warrant_oz ?? 0) > 0)
    .map((r, i) => ({
      name: r.warehouse,
      value: r.warrant_oz,
      color: VAULT_COLORS[i % VAULT_COLORS.length],
    }));

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">SHFE Warehouse Snapshot — {date}</div>
      <div className="comex-panel-note">
        Warranted silver by approved SHFE warehouse. Δ = change from prior day.
        Values in troy oz (converted from kg).
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={pieData} dataKey="value" nameKey="name"
            cx="50%" cy="50%" outerRadius={100} innerRadius={48} paddingAngle={2}>
            {pieData.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
            formatter={(v, _, props) => [fmt_oz(v), props.payload.name]}
          />
          <Legend
            formatter={(_, entry) => (
              <span style={{ color: "#8a94a6", fontSize: 11 }}>{entry.payload.name}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>

      <div className="comex-table-wrap">
        <table className="comex-table">
          <thead>
            <tr>
              <th>Warehouse</th>
              <th className="right">Warrants (oz)</th>
              <th className="right">Δ (oz)</th>
              <th className="right">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const share = totalOz > 0 ? ((r.warrant_oz ?? 0) / totalOz * 100).toFixed(1) : "—";
              const dClass = delta_class(r.warrant_change_oz);
              return (
                <tr key={r.warehouse}>
                  <td className="comex-vault-name">{r.warehouse}</td>
                  <td className="right">{fmt_oz(r.warrant_oz)}</td>
                  <td className={`right ${dClass}`}>{delta_str(r.warrant_change_oz)}</td>
                  <td className="right" style={{ color: "#6b778d" }}>{share}%</td>
                </tr>
              );
            })}
            <tr className="comex-table-total">
              <td><strong>Total</strong></td>
              <td className="right"><strong>{fmt_oz(totalOz)}</strong></td>
              <td className="right" />
              <td className="right" style={{ color: "#6b778d" }}>100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Global silver context panel ─────────────────────────────────────────────
// Figures: Silver Institute World Silver Survey 2024, USGS Mineral Commodity
// Summary 2024, CPM Group Silver Yearbook. All estimates ± 20%.

const ABOVE_GROUND_OZ = 41_152_896_000; // ~1,280,000 tonnes × 32,150.7 oz/t
const SURVEY_YEAR = 2024;
const SURVEY_PUBLISHED = new Date(SURVEY_YEAR + 1, 3, 1); // typically published April of following year
const SURVEY_STALE_MONTHS = 18;

const GLOBAL_CATEGORIES = [
  { label: "Jewelry & Silverware",          oz: 22_505_490_000, note: "privately held, partially recoverable" },
  { label: "Investment (coins & bars)",     oz: 10_448_977_500, note: "public holdings, outside vaults" },
  { label: "Industrial (in products)",      oz:  6_430_140_000, note: "largely unrecoverable — electronics, solar, etc." },
  { label: "ETF & Exchange Vaults",         oz:  1_446_781_500, note: "tracked, allocated — the part markets can see" },
  { label: "Central Bank / Govt Reserves",  oz:    321_507_000, note: "US Treasury ~7,000 t at West Point; most CBs divested" },
];

function GlobalSilverPanel({ comexHistory, shfeHistory, pslv }) {
  const [stackOz, setStackOz] = useState("500");
  const stack = parseFloat(stackOz) || 0;

  const comexLatest = comexHistory?.filter(r => r.total).at(-1)?.total ?? null;
  const shfeLatest  = shfeHistory?.filter(r => r.total_oz).at(-1)?.total_oz ?? null;
  const pslvLatest  = pslv?.total_oz ?? null;
  const trackedOz   = (comexLatest ?? 0) + (shfeLatest ?? 0) + (pslvLatest ?? 0);

  function pctOfBase(p) {
    if (p < 0.0001) return p.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") + "%";
    return p.toFixed(6) + "%";
  }

  function pctOf(oz) {
    if (!oz || !ABOVE_GROUND_OZ) return "—";
    return pctOfBase(oz / ABOVE_GROUND_OZ * 100);
  }

  const barMax = GLOBAL_CATEGORIES[0].oz;
  const monthsStale = Math.floor((Date.now() - SURVEY_PUBLISHED) / (1000 * 60 * 60 * 24 * 30.44));
  const surveyStale = monthsStale > SURVEY_STALE_MONTHS;

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        Global Silver — Estimated Above-Ground Stock (Survey {SURVEY_YEAR})
        {surveyStale && (
          <span className="comex-freshness comex-freshness--stale">
            ⚠ Stale — survey {SURVEY_YEAR} data is over {SURVEY_STALE_MONTHS} months old
          </span>
        )}
      </div>
      <div className="comex-panel-note">
        Sources: Silver Institute World Silver Survey {SURVEY_YEAR}, USGS Mineral Commodity
        Summary {SURVEY_YEAR}, CPM Group. All figures are estimates ±20% — no single
        authoritative audit exists. ~1,280,000 tonnes total above-ground = ~41.2 billion troy oz.
      </div>

      {/* Category breakdown bars */}
      <div className="global-silver-bars">
        {GLOBAL_CATEGORIES.map(({ label, oz, note }) => (
          <div key={label} className="global-silver-row">
            <div className="global-silver-label">{label}</div>
            <div className="global-silver-track">
              <div className="global-silver-fill"
                style={{ width: `${(oz / barMax * 100).toFixed(1)}%` }} />
            </div>
            <div className="global-silver-amt">{(oz / 1e9).toFixed(2)}B oz</div>
            <div className="global-silver-note">{note}</div>
          </div>
        ))}

        {/* Live tracked exchange line */}
        {trackedOz > 0 && (
          <div className="global-silver-row global-silver-row--tracked">
            <div className="global-silver-label" style={{color:"#4caf76"}}>
              COMEX + SHFE + PSLV (live)
            </div>
            <div className="global-silver-track">
              <div className="global-silver-fill"
                style={{ width: `${(trackedOz / barMax * 100).toFixed(2)}%`, background:"#4caf76" }} />
            </div>
            <div className="global-silver-amt" style={{color:"#4caf76"}}>
              {(trackedOz / 1e6).toFixed(0)}M oz
            </div>
            <div className="global-silver-note">
              {pctOf(trackedOz)} of estimated above-ground stock
            </div>
          </div>
        )}
      </div>

      <div className="flow-legend-note">
        AV tracks COMEX + SHFE + PSLV live — a subset of the Silver Institute's "ETF &amp;
        Exchange Vaults" category above ({(GLOBAL_CATEGORIES[3].oz / 1e9).toFixed(2)}B oz),
        which also includes other global ETFs (iShares SLV, Aberdeen, etc.) that AV does not
        fetch. The live figure will therefore always read lower than the full category — that
        gap is expected, not a data error, and reflects the limits of what's publicly trackable.
      </div>

      {/* Stack calculator */}
      <div className="global-stack-calc">
        <div className="global-stack-header">Stack Calculator</div>
        <div className="global-stack-row">
          <input
            className="global-stack-input"
            type="number"
            min="0"
            value={stackOz}
            onChange={(e) => setStackOz(e.target.value)}
          />
          <span className="global-stack-unit">troy oz</span>
          <span className="global-stack-eq">
            = <strong>{pctOf(stack)}</strong> of estimated above-ground silver
          </span>
        </div>
        {stack > 0 && (
          <div className="global-stack-context">
            <span>vs. COMEX registered: <strong>{comexLatest ? pctOfBase(stack / comexLatest * 100) : "—"}</strong></span>
            <span>vs. all exchange vaults (COMEX+SHFE): <strong>{trackedOz > 0 ? pctOfBase(stack / trackedOz * 100) : "—"}</strong></span>
          </div>
        )}
        <div className="global-stack-note">
          In-ground reserves (USGS 2024): ~310,000 t economically mineable (~12 years at current
          mining rates). Identified resources: ~610,000 t. Most silver is a byproduct of
          copper/lead/zinc mining — primary silver mines are a minority of supply.
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function ComexInventoryDashboard() {
  const [history, setHistory] = useState(null);
  const [depositories, setDepositories] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [shfeHistory, setShfeHistory] = useState(null);
  const [shfeWarehouses, setShfeWarehouses] = useState(null);
  const [pslv, setPslv] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const timerRef = useRef(null);

  // Hovering a Delivery Behavior reclassification row pins VaultSnapshotPanel
  // to that date's per-depository snapshot instead of today's. Separate from
  // `depositories` (today's data, polled) so returning to "today" doesn't
  // require a re-fetch.
  const [pinnedDate, setPinnedDate] = useState(null);
  const [pinnedDepositories, setPinnedDepositories] = useState(null);
  const [pinnedLoading, setPinnedLoading] = useState(false);
  const pinnedRequestRef = useRef(0);

  const handleHoverDate = useCallback((date) => {
    setPinnedDate(date);
    if (!date) {
      setPinnedLoading(false);
      return;
    }
    const requestId = ++pinnedRequestRef.current;
    setPinnedLoading(true);
    fetch(`/api/silver/db/depositories?date=${date}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        if (pinnedRequestRef.current === requestId) {
          setPinnedDepositories(json);
          setPinnedLoading(false);
        }
      })
      .catch(() => {
        if (pinnedRequestRef.current === requestId) {
          setPinnedDepositories({ data: [] });
          setPinnedLoading(false);
        }
      });
  }, []);

  const fetchAll = useCallback(async () => {
    setFetchError(null);

    async function get(url, setter, transform) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        setter(transform ? transform(json) : json);
      } catch (e) {
        // individual endpoint failures are silent — panel shows its own empty state
      }
    }

    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    // Stagger requests by 300ms each so panels fill in progressively.
    // All reads are local DB reads now — upstream refresh is handled
    // server-side by the tiered background refresh (see RefreshControls).
    await get("/api/silver/db/history",           setHistory,       (j) => j.data ?? null);
    await delay(300);
    await get("/api/silver/db/depositories",      setDepositories,  null);
    await delay(300);
    await get("/api/silver/db/delivery?type=mtd", setDelivery,      null);
    await delay(300);
    await get("/api/shfe/db/history",             setShfeHistory,   (j) => j.data ?? null);
    await delay(300);
    await get("/api/shfe/db/warehouses",          setShfeWarehouses, null);
    await delay(300);
    await get("/api/pslv/db",                     setPslv,           null);

    setLastFetch(Date.now());
  }, []);

  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, REFRESH_MS);
    window.addEventListener(FORCE_REFRESH_EVENT, fetchAll);
    return () => {
      clearInterval(timerRef.current);
      window.removeEventListener(FORCE_REFRESH_EVENT, fetchAll);
    };
  }, [fetchAll]);

  const stale = lastFetch && Date.now() - lastFetch > STALE_MS;

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        Stock &amp; Flow
        <span className="stock-flow-title-source"></span>
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-shell">
          <div className="comex-header">
            <div className="comex-title">Silver Inventory — Exchange Reserves</div>
            <div className="comex-subtitle">
              COMEX (USA) · SHFE (China) · reads from AV's own database, refreshed{" "}
              from metalcharts.org/Sprott on a server-side schedule
            </div>
            {lastFetch && (
              <div className={`comex-freshness${stale ? " comex-freshness--stale" : ""}`}>
                {stale ? "⚠ Stale — " : ""}Last updated:{" "}
                {new Date(lastFetch).toLocaleTimeString()}
              </div>
            )}
            {fetchError && (
              <div className="comex-error">
                Error fetching data: {fetchError}. Is the FastAPI proxy running?{" "}
                <code>uvicorn main:app --reload</code>
              </div>
            )}
          </div>

          <CrossExchangePanel comexHistory={history} shfeHistory={shfeHistory} pslv={pslv} />

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">COMEX — New York</summary>
            <div className="collapsible-pane-body">
              <VaultSnapshotPanel
                depositories={depositories}
                pinnedDate={pinnedDate}
                pinnedDepositories={pinnedDepositories}
                pinnedLoading={pinnedLoading}
              />
              <details className="collapsible-pane">
                <summary className="collapsible-pane-title">Delivery Behavior</summary>
                <div className="collapsible-pane-body">
                  <DeliveryBehaviorPanel onHoverDate={handleHoverDate} />
                </div>
              </details>
              <details className="collapsible-pane">
                <summary className="collapsible-pane-title">Registered vs Eligible Silver — % Available for Delivery</summary>
                <div className="collapsible-pane-body">
                  <RegEligiblePanel history={history} />
                </div>
              </details>
              <details className="collapsible-pane">
                <summary className="collapsible-pane-title">Delivery Notices — Month to Date</summary>
                <div className="collapsible-pane-body">
                  <DeliveryNoticesPanel delivery={delivery} />
                </div>
              </details>
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">SHFE — Shanghai</summary>
            <div className="collapsible-pane-body">
              <ShfeWarehousePanel shfeWarehouses={shfeWarehouses} />
              <details className="collapsible-pane">
                <summary className="collapsible-pane-title">SHFE Silver Inventory (Shanghai)</summary>
                <div className="collapsible-pane-body">
                  <ShfeHistoryPanel shfeHistory={shfeHistory} />
                </div>
              </details>
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">Market Demand</summary>
            <div className="collapsible-pane-body">
              <MarketBalancePanel />
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">Demand Composition Over Time</summary>
            <div className="collapsible-pane-body">
              <DemandCompositionPanel />
            </div>
          </details>

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">Global Context</summary>
            <div className="collapsible-pane-body">
              <GlobalSilverPanel comexHistory={history} shfeHistory={shfeHistory} pslv={pslv} />
            </div>
          </details>

          <div className="comex-footer">
            COMEX data: metalcharts.org proxy (CME Group). SHFE data: metalcharts.org
            proxy (Shanghai Futures Exchange, converted from kg). LME (London) requires
            a paid API subscription and is not shown. SQLite persistence in argentvigil.db.
          </div>
        </div>
      </div>
    </details>
  );
}
