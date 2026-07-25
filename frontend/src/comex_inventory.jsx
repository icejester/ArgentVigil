import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import MarketBalancePanel, { DemandCompositionPanel } from "./market_balance";
import DeliveryBehaviorPanel from "./delivery_behavior_panel";
import TradeFlowPanel from "./trade_flow_panel";
import { VAULT_COLORS } from "./palette";
import { FORCE_REFRESH_EVENT } from "./refresh_controls";
import { nearestRowDate } from "./date_utils";

const REFRESH_MS = (parseInt(import.meta.env.VITE_AV_REFRESH_INTERVAL, 10) || 60) * 1000;

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

// Stock & Flow's own shared selector (1M/3M/6M/1Y/ALL/Custom) — drives every
// chart in this section. An earlier per-chart RangeSelector/filterByRange
// pair (1M/3M/1Y/5Y/ALL, no Custom) was removed 2026-07-24 once its last
// caller (RegEligiblePanel) was removed — this is the only selector left.
const SF_WINDOWS = ["1M", "3M", "6M", "1Y", "ALL"];

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

function xTicks(data) {
  if (!data || data.length === 0) return [];
  const n = Math.min(data.length, 8);
  const step = Math.floor(data.length / n);
  return data.filter((_, i) => i % step === 0).map((r) => r.date);
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

// Shows real oz AND % share together (not stacked-% alone) — a stacked-area
// chart was tried first and dropped at the user's request: a vault's stacked
// band can visually shrink even while its real oz rose, if other vaults grew
// faster, which misrepresents what actually happened at that vault. Real oz
// is now the primary series (plotted as lines); % share is still available
// here, computed from the same day's real numbers, not baked into geometry.
// Shows real oz AND % share together. A stacked-area chart was tried first
// and dropped (a vault's stacked band can visually shrink even while its
// real oz rose, if other vaults grew faster — misleading). A per-vault line
// chart was tried next and also dropped — with no vault selected, the
// tooltip listed all 11 vaults stacked vertically and rendered taller than
// the 300px chart itself, covering the chart and blocking clicks entirely.
// Fixed here by keeping the default (no vault clicked) tooltip capped to
// the day's total + top 3 vaults, never all 11 — the full per-vault
// breakdown is available by clicking a legend row first, which also caps
// shownKeys to just that one vault.
function VaultTooltipContent({ active, label, rows, vaultKeys, vaultColor, clickedVault }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.date === label);
  if (!row) return null;
  const dayTotal = vaultKeys.reduce((sum, v) => sum + (row[v]?.oz ?? 0), 0);
  const ranked = vaultKeys.filter((v) => row[v]?.oz != null).sort((a, b) => row[b].oz - row[a].oz);
  const shownKeys = clickedVault ? [clickedVault] : ranked.slice(0, 3);
  const hiddenCount = clickedVault ? 0 : ranked.length - shownKeys.length;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "#8a94a6", marginBottom: 4 }}>Total: {fmt_oz(dayTotal)}</div>
      {shownKeys.map((v) => (
        <div key={v} style={{ color: vaultColor(v) }}>
          {shortName(v)}: {fmt_oz(row[v].oz)}
          {dayTotal > 0 && ` (${((row[v].oz / dayTotal) * 100).toFixed(1)}%)`}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div style={{ color: "#5a6278", marginTop: 2 }}>
          +{hiddenCount} more — click a legend row for detail
        </div>
      )}
    </div>
  );
}

function VaultSnapshotPanel({ metal, depositoriesHistory, sfWindow, sfCustomStart, sfCustomEnd, pinnedDate, onPin }) {
  const [pieMetric, setPieMetric] = useState("total");
  const [clickedVault, setClickedVault] = useState(null);

  // A vault clicked under one metal's legend has no meaning under the
  // other's (different vault sets/names) — clear it on metal switch rather
  // than leaving a highlighted selection that no longer corresponds to
  // anything in the new dataset.
  useEffect(() => {
    setClickedVault(null);
  }, [metal]);

  const metalLabel = metal === "XAU" ? "Gold" : "Silver";

  // Stable vault -> color assignment (alphabetical by full depository name,
  // not by whatever order a given day's data happens to sort into) so a
  // vault keeps the same color across the bar chart, its legend, and the
  // pie, rather than being re-indexed every render based on that day's
  // total-descending sort order.
  const allVaultNames = Array.from(
    new Set((depositoriesHistory || []).map((r) => r.depository))
  ).sort();
  const vaultColor = (name) => VAULT_COLORS[allVaultNames.indexOf(name) % VAULT_COLORS.length];

  // Pivot depositoriesHistory (one row per date+depository) into one row per
  // date, each vault keyed to its own {oz} object (not a flat % field) —
  // real oz is the thing actually plotted (as bars, one per vault); %
  // share is derived from these same real numbers on read (in the tooltip),
  // never baked into stacking geometry the way a stacked-area chart would.
  const byDate = {};
  for (const r of depositoriesHistory || []) {
    if (r.total == null) continue;
    if (!byDate[r.date]) byDate[r.date] = { date: r.date };
    byDate[r.date][r.depository] = { oz: r.total, registered: r.registered, eligible: r.eligible };
  }
  const allHistoryRows = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  const historyRows = filterBySFWindow(allHistoryRows, sfWindow, sfCustomStart, sfCustomEnd);
  // Exact match only, per the user's 2026-07-24 request — unlike every other
  // Stock & Flow chart (which snap a pin to their own nearest real row via
  // nearestRowDate, since their date grids can legitimately differ), this
  // panel blanks out instead of guessing at a nearby date when the shared
  // pinnedDate doesn't exist in its own (short, accumulates-forward-only)
  // per-vault history.
  const pinnedDateSnapped = pinnedDate && historyRows.some((r) => r.date === pinnedDate) ? pinnedDate : null;

  const headerLabel = pinnedDateSnapped
    ? `${metalLabel} Per-Vault Snapshot — ${pinnedDateSnapped}`
    : `${metalLabel} Per-Vault Snapshot — Today`;

  // The pie/legend snapshot is client-side now (2026-07-24, replacing the
  // earlier fetch-on-pin design) — computed straight from depositoriesHistory
  // rather than a separate /api/{silver,gold}/db/depositories?date= call, since
  // that full per-vault series is already loaded for the bar chart above.
  // `rows` is whichever date is pinned, or the true latest date if nothing's
  // pinned ANYWHERE (pinnedDate itself is null) — but if something IS pinned
  // and it just doesn't exist in this panel's own data (pinnedDateSnapped
  // came back null above), snapshotDate stays null too rather than silently
  // falling back to "today," per the user's explicit "blank it out" request.
  // `prevRows` is the same vaults' most recent EARLIER date in the full
  // (unwindowed) history, used for delta — sourced from allHistoryRows, not
  // the windowed historyRows, so a pin near the start of a narrow window
  // (e.g. "1M") can still diff against real data just before the window's
  // own left edge instead of finding no prior day at all.
  const snapshotDate = pinnedDate ? pinnedDateSnapped : allHistoryRows.at(-1)?.date ?? null;
  const snapshotIndex = snapshotDate ? allHistoryRows.findIndex((r) => r.date === snapshotDate) : -1;
  const snapshotRow = snapshotIndex >= 0 ? allHistoryRows[snapshotIndex] : null;
  const prevRow = snapshotIndex > 0 ? allHistoryRows[snapshotIndex - 1] : null;

  const overlayMessage = !snapshotRow
    ? pinnedDate
      ? `No per-vault snapshot for ${pinnedDate} in this panel's data.`
      : "Loading…"
    : null;

  const rows = allVaultNames
    .map((name) => {
      const cur = snapshotRow?.[name];
      const prev = prevRow?.[name];
      return {
        depository: name,
        total: cur?.oz ?? null,
        registered: cur?.registered ?? null,
        eligible: cur?.eligible ?? null,
        prev_total: prev?.oz ?? null,
        prev_registered: prev?.registered ?? null,
        prev_eligible: prev?.eligible ?? null,
      };
    })
    .filter((r) => r.total != null)
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  // Per-vault day-over-day delta, keyed by full depository name — used by
  // the legend to dim vaults with no real change on the currently pinned
  // date, for whichever metric the pie is currently showing.
  function vaultDelta(name) {
    const r = rows.find((row) => row.depository === name);
    const prevKey = `prev_${pieMetric}`;
    if (!r || r[pieMetric] == null || r[prevKey] == null) return null;
    return r[pieMetric] - r[prevKey];
  }

  const pieData = rows
    .filter((r) => (r[pieMetric] ?? 0) > 0)
    .map((r) => {
      const prevKey = `prev_${pieMetric}`;
      const delta = r[pieMetric] != null && r[prevKey] != null ? r[pieMetric] - r[prevKey] : null;
      return {
        name: shortName(r.depository),
        fullName: r.depository,
        value: r[pieMetric],
        delta,
        color: vaultColor(r.depository),
      };
    });

  // Total day-over-day change across every vault — lets a real total_delta
  // on a pinned date (e.g. from Reclassification vs. Real Inflow) show up
  // here too, not just in that other chart.
  const totalDelta = pieData.reduce((sum, d) => (d.delta != null ? sum + d.delta : sum), 0);
  const totalDeltaKnown = pieData.some((d) => d.delta != null);

  // When a vault's legend row is clicked, the summary above the pie switches
  // from the aggregate total/change to that specific vault's own total/
  // change, so clicking a vault surfaces its number directly rather than
  // only via the pie's hover tooltip.
  const clickedVaultData = clickedVault ? pieData.find((d) => d.fullName === clickedVault) : null;

  const METRIC_LABELS = { total: "Total", registered: "Registered", eligible: "Eligible" };

  return (
    <div className="comex-panel comex-panel--vault-snapshot">
      <div className="comex-panel-header">{headerLabel}</div>
      <div className="comex-panel-note">
        Each vault's real ounces held, day by day — click a bar to pin that date across the
        Stock & Flow charts below, or click a legend row to highlight one vault's segment (oz and
        % of COMEX total together in the tooltip). Real history only goes back to whenever this
        data first started being recorded (no upstream backfill), so this may be a short window.
      </div>

      <div className="comex-vault-snapshot-body">
        {overlayMessage && (
          <div className="comex-vault-snapshot-overlay">
            <div className="comex-empty">{overlayMessage}</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* Stacked bar of each vault's real oz per day — discrete bars per
              date, not a continuous filled area, so a vault's segment height
              directly reflects that day's real oz with no interpolation
              implying a trend between real data points. Clicking a legend
              row dims the other vaults' segments rather than removing them,
              so the whole stack (and total bar height) stays visible for
              context — a line chart with 11 overlapping lines was tried and
              dropped (unreadable, and its default all-vaults tooltip
              rendered taller than the chart, blocking clicks entirely). */}
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            {historyRows.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={historyRows}
                  margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
                  onClick={(state) => {
                    if (state?.activeLabel && onPin) onPin(state.activeLabel);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d) => `${d.slice(5, 7)}/${d.slice(8, 10)}`}
                    tick={{ fill: "#8a94a6", fontSize: 11 }}
                  />
                  <YAxis
                    tickFormatter={(v) => `${(v / 1e6).toFixed(0)}M`}
                    tick={{ fill: "#8a94a6", fontSize: 11 }}
                  />
                  <Tooltip
                    content={
                      <VaultTooltipContent
                        rows={historyRows}
                        vaultKeys={allVaultNames}
                        vaultColor={vaultColor}
                        clickedVault={clickedVault}
                      />
                    }
                  />
                  {pinnedDateSnapped && (
                    <ReferenceLine x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
                  )}
                  {/* Recharts stacks Bars in render order — first-rendered
                      sits at the bottom of the stack. Moving the clicked
                      vault to the front of this list puts its segment flush
                      against the x-axis, where its own shape/height is
                      easiest to read (same move CategoryCompositionChart's
                      stackOrder already makes for its stacked-area bands). */}
                  {(clickedVault
                    ? [clickedVault, ...allVaultNames.filter((v) => v !== clickedVault)]
                    : allVaultNames
                  ).map((v) => (
                    <Bar
                      key={v}
                      dataKey={`${v}.oz`}
                      name={v}
                      stackId="vaults"
                      fill={vaultColor(v)}
                      fillOpacity={clickedVault && clickedVault !== v ? 0.2 : 0.85}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="comex-empty">Loading…</div>
            )}
          </div>

          {/* Pie chart */}
          <div className="comex-vault-pie-row" style={{ flex: "0 0 260px" }}>
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
            {clickedVaultData ? (
              <div style={{ fontSize: 12, textAlign: "center" }}>
                <div style={{ color: vaultColor(clickedVault), fontWeight: 600 }}>
                  {shortName(clickedVault)}
                </div>
                {fmt_oz(clickedVaultData.value)}
                {clickedVaultData.delta != null && (
                  <>
                    {" · "}
                    <span className={delta_class(clickedVaultData.delta)}>
                      {delta_str(clickedVaultData.delta)}
                    </span>
                  </>
                )}
              </div>
            ) : (
              totalDeltaKnown && (
                <div style={{ fontSize: 12, textAlign: "center" }}>
                  Total change:{" "}
                  <span className={delta_class(totalDelta)}>{delta_str(totalDelta)}</span>
                </div>
              )
            )}
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  innerRadius={50}
                  paddingAngle={1}
                >
                  {pieData.map((entry) => (
                    <Cell
                      key={entry.fullName}
                      fill={entry.color}
                      fillOpacity={clickedVault && clickedVault !== entry.fullName ? 0.35 : 1}
                      stroke={clickedVault === entry.fullName ? "#e8ecf4" : undefined}
                      strokeWidth={clickedVault === entry.fullName ? 2 : undefined}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "6px 10px" }}>
                        <div style={{ color: "#c8d0de", fontWeight: 600 }}>{d.fullName}</div>
                        <div style={{ color: "#8a94a6" }}>{fmt_oz(d.value)}</div>
                        {d.delta != null && (
                          <div className={delta_class(d.delta)}>{delta_str(d.delta)} vs. prior day</div>
                        )}
                      </div>
                    );
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            {snapshotDate && (
              <div style={{ fontSize: 11, color: "#8a94a6", textAlign: "center" }}>
                {pinnedDateSnapped ? `As of ${snapshotDate}` : `Latest — ${snapshotDate}`}
              </div>
            )}
          </div>
        </div>

        <div className="comex-legend-list comex-legend-list--horizontal">
          {allVaultNames.map((v) => {
            const delta = pinnedDateSnapped ? vaultDelta(v) : null;
            const noChange = pinnedDateSnapped && (delta == null || delta === 0);
            return (
            <button
              key={v}
              className={`comex-legend-item legend-btn-row${clickedVault === v ? " legend-btn-row--baseline" : ""}`}
              style={{ "--legend-color": vaultColor(v), opacity: noChange ? 0.4 : 1 }}
              onClick={() => setClickedVault((prev) => (prev === v ? null : v))}
            >
              <span className="comex-legend-swatch" style={{ background: vaultColor(v) }} />
              <span>
                {shortName(v)}
                {pinnedDateSnapped && delta != null && delta !== 0 && (
                  <span className={delta_class(delta)} style={{ marginLeft: 4 }}>
                    {delta_str(delta)}
                  </span>
                )}
              </span>
            </button>
            );
          })}
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

function CrossExchangeTooltipContent({ active, label, rows }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.date === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {row.comex != null && <div style={{ color: "#7b9fff" }}>COMEX (USA): {fmt_moz(row.comex)}</div>}
      {row.shfe != null && <div style={{ color: "#f87171" }}>SHFE (China): {fmt_moz(row.shfe)}</div>}
      {row.pslv != null && (
        <div style={{ color: "#4caf76" }}>PSLV/Sprott (Canada): {fmt_moz(row.pslv)} (today's snapshot)</div>
      )}
    </div>
  );
}

function CrossExchangePanel({ comexHistory, shfeHistory, pslv, sfWindow, sfCustomStart, sfCustomEnd, pinnedDate, onPin }) {
  if (!comexHistory && !shfeHistory) return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">Silver Inventory — Exchange Reserves</summary>
      <div className="collapsible-pane-body">
        <div className="comex-panel">
          <div className="comex-empty">Loading…</div>
        </div>
      </div>
    </details>
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

  const filtered = filterBySFWindow(raw, sfWindow, sfCustomStart, sfCustomEnd);
  const ticks = xTicks(filtered);

  const hasData = filtered.some((r) => r.comex != null || r.shfe != null);
  const pinnedDateSnapped = nearestRowDate(filtered, pinnedDate);

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">Silver Inventory — Exchange Reserves</summary>
      <div className="collapsible-pane-body">
        <div className="comex-panel">
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
            <LineChart
              data={filtered}
              margin={{ top: 4, right: 56, left: 12, bottom: 4 }}
              onClick={(state) => {
                if (state?.activeLabel && onPin) onPin(state.activeLabel);
              }}
            >
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
              <Tooltip content={<CrossExchangeTooltipContent rows={filtered} />} />
              {pinnedDateSnapped && (
                <ReferenceLine yAxisId="comex" x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
              )}
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
          {pinnedDateSnapped && (
            <div style={{ marginTop: 4 }}>
              <CrossExchangeTooltipContent active label={pinnedDateSnapped} rows={filtered} />
            </div>
          )}
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
        </>
      ) : (
        <div className="comex-empty">No overlapping data in this range</div>
      )}
        </div>
      </div>
    </details>
  );
}

// ── SHFE history panel ──────────────────────────────────────────────────────

function ShfeHistoryTooltipContent({ active, label, rows }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.date === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "#f87171" }}>SHFE Total: {fmt_moz(row.total_oz)}</div>
    </div>
  );
}

function ShfeHistoryPanel({ shfeHistory, sfWindow, sfCustomStart, sfCustomEnd, pinnedDate, onPin }) {
  // Driven by Stock & Flow's shared window selector (2026-07-24), same as
  // Silver Inventory/Per-Vault Snapshot/Delivery Behavior — dropped this
  // chart's own independent RangeSelector.
  const filtered = filterBySFWindow(shfeHistory, sfWindow, sfCustomStart, sfCustomEnd);
  const ticks = xTicks(filtered);
  const pinnedDateSnapped = nearestRowDate(filtered, pinnedDate);

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">SHFE Silver Inventory (Shanghai)</div>
      <div className="comex-panel-note">
        Shanghai Futures Exchange warranted silver, in troy oz (converted from kg).
        SHFE silver is measured in kg; 1 lot = 15 kg. Click the chart to pin a date across the
        Stock &amp; Flow charts.
      </div>
      {filtered && filtered.length > 0 ? (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart
            data={filtered}
            margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
            onClick={(state) => {
              if (state?.activeLabel && onPin) onPin(state.activeLabel);
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
            <YAxis
              tickFormatter={(v) => `${(v / 1e6).toFixed(1)}M`}
              tick={{ fill: "#8a94a6", fontSize: 11 }}
            />
            <Tooltip content={<ShfeHistoryTooltipContent rows={filtered} />} />
            {pinnedDateSnapped && (
              <ReferenceLine x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
            )}
            <Line type="monotone" dataKey="total_oz" stroke="#f87171" dot={false}
              strokeWidth={1.8} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="comex-empty">No data</div>
      )}
      {pinnedDateSnapped && (
        <div style={{ marginTop: 4 }}>
          <ShfeHistoryTooltipContent active label={pinnedDateSnapped} rows={filtered} />
        </div>
      )}
    </div>
  );
}

// ── SHFE warehouse snapshot table ───────────────────────────────────────────

// ── SHFE per-warehouse snapshot + history (bar chart + pie, one panel) ──────
// Merged into a single panel 2026-07-24 to match VaultSnapshotPanel's layout
// (COMEX's stacked bar + pie live side by side in one panel; SHFE's were
// two separate panels — inconsistent, fixed here). No registered/eligible
// split or metric toggle exists here, unlike VaultSnapshotPanel's Total/
// Registered/Eligible buttons — SHFE only ever reports total warrant stock,
// so Total is the only real number this exchange has.

function ShfeVaultTooltipContent({ active, label, rows, warehouseKeys, warehouseColor }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.date === label);
  if (!row) return null;
  const dayTotal = warehouseKeys.reduce((sum, w) => sum + (row[w]?.oz ?? 0), 0);
  const ranked = warehouseKeys.filter((w) => row[w]?.oz != null).sort((a, b) => row[b].oz - row[a].oz);
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "#8a94a6", marginBottom: 4 }}>Total: {fmt_oz(dayTotal)}</div>
      {ranked.slice(0, 3).map((w) => (
        <div key={w} style={{ color: warehouseColor(w) }}>
          {w}: {fmt_oz(row[w].oz)}
          {dayTotal > 0 && ` (${((row[w].oz / dayTotal) * 100).toFixed(1)}%)`}
        </div>
      ))}
      {ranked.length > 3 && (
        <div style={{ color: "#5a6278", marginTop: 2 }}>
          +{ranked.length - 3} more — click a legend row for detail
        </div>
      )}
    </div>
  );
}

function ShfeWarehousePanel({ metal, shfeWarehousesHistory, sfWindow, sfCustomStart, sfCustomEnd, pinnedDate, onPin }) {
  const [clickedWarehouse, setClickedWarehouse] = useState(null);

  // A warehouse clicked under one metal has no meaning under the other
  // (different warehouse sets) — clear on metal switch, same as COMEX's
  // VaultSnapshotPanel does for clickedVault.
  useEffect(() => {
    setClickedWarehouse(null);
  }, [metal]);

  const allWarehouseNames = Array.from(
    new Set((shfeWarehousesHistory || []).map((r) => r.warehouse))
  ).sort();
  const warehouseColor = (name) => VAULT_COLORS[allWarehouseNames.indexOf(name) % VAULT_COLORS.length];

  // Pivot shfeWarehousesHistory (one row per date+warehouse) into one row
  // per date, each warehouse keyed to its own {oz} object — mirrors
  // VaultSnapshotPanel's exact pattern (COMEX) so the pie/legend/table
  // snapshot is pin-aware here too, not just the bar chart. Previously this
  // panel read a separate "latest" fetch (shfeWarehouses) for the pie/table,
  // which meant the pie never actually moved when a date was pinned — a
  // real functional gap vs. COMEX, fixed by deriving everything from the
  // same history series the bar chart already uses.
  const byDate = {};
  for (const r of shfeWarehousesHistory || []) {
    if (r.warrant_oz == null) continue;
    if (!byDate[r.date]) byDate[r.date] = { date: r.date };
    byDate[r.date][r.warehouse] = { oz: r.warrant_oz };
  }
  const allHistoryRows = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
  const historyRows = filterBySFWindow(allHistoryRows, sfWindow, sfCustomStart, sfCustomEnd);
  // Exact match only, same as VaultSnapshotPanel's own pin — a pinned date
  // that doesn't exist in SHFE's own (independently short) history blanks
  // out rather than guessing at a nearby date.
  const pinnedDateSnapped = pinnedDate && historyRows.some((r) => r.date === pinnedDate) ? pinnedDate : null;

  const headerLabel = pinnedDateSnapped
    ? `SHFE Warehouse Snapshot — ${pinnedDateSnapped}`
    : "SHFE Warehouse Snapshot — Today";

  // Same "pinned date if it exists here, else true latest, but stay blank
  // if something's pinned elsewhere and just doesn't exist in this panel's
  // data" logic as VaultSnapshotPanel.
  const snapshotDate = pinnedDate ? pinnedDateSnapped : allHistoryRows.at(-1)?.date ?? null;
  const snapshotIndex = snapshotDate ? allHistoryRows.findIndex((r) => r.date === snapshotDate) : -1;
  const snapshotRow = snapshotIndex >= 0 ? allHistoryRows[snapshotIndex] : null;
  const prevRow = snapshotIndex > 0 ? allHistoryRows[snapshotIndex - 1] : null;

  const overlayMessage = !snapshotRow
    ? pinnedDate
      ? `No SHFE warehouse snapshot for ${pinnedDate} in this panel's data.`
      : "Loading…"
    : null;

  const snapshotRows = allWarehouseNames
    .map((name) => {
      const cur = snapshotRow?.[name];
      const prev = prevRow?.[name];
      return {
        warehouse: name,
        warrant_oz: cur?.oz ?? null,
        warrant_change_oz: cur?.oz != null && prev?.oz != null ? cur.oz - prev.oz : null,
      };
    })
    .filter((r) => r.warrant_oz != null)
    .sort((a, b) => (b.warrant_oz ?? 0) - (a.warrant_oz ?? 0));
  const totalOz = snapshotRows.reduce((s, r) => s + (r.warrant_oz ?? 0), 0);

  const stackOrder = clickedWarehouse
    ? [clickedWarehouse, ...allWarehouseNames.filter((w) => w !== clickedWarehouse)]
    : allWarehouseNames;

  const pieData = snapshotRows
    .filter((r) => (r.warrant_oz ?? 0) > 0)
    .map((r) => ({
      name: r.warehouse,
      value: r.warrant_oz,
      delta: r.warrant_change_oz,
      color: warehouseColor(r.warehouse),
    }));

  // Total day-over-day change across every warehouse — same summary
  // COMEX's VaultSnapshotPanel shows above its pie.
  const totalDelta = pieData.reduce((sum, d) => (d.delta != null ? sum + d.delta : sum), 0);
  const totalDeltaKnown = pieData.some((d) => d.delta != null);
  const clickedWarehouseData = clickedWarehouse ? pieData.find((d) => d.name === clickedWarehouse) : null;

  return (
    <div className="comex-panel comex-panel--vault-snapshot">
      <div className="comex-panel-header">{headerLabel}</div>
      <div className="comex-panel-note">
        Each warehouse's real warrant ounces held, day by day — click a bar to pin that date
        across the Stock &amp; Flow charts, or click a legend row to highlight one warehouse in
        both the bar chart and the pie. Δ = change from prior day. Real history only goes back
        to whenever this data first started being recorded (no upstream backfill), so this may
        be a short window.
        {metal === "XAU" && allWarehouseNames.length === 0 && (
          <> <strong>metalcharts.org does not report a per-warehouse breakdown for SHFE
          gold</strong> — confirmed live 2026-07-24 (a real 200 response with an empty data
          array), unlike silver, which has full per-warehouse detail. SHFE gold's total is
          still available below.</>
        )}
      </div>

      <div className="comex-vault-snapshot-body">
        {overlayMessage && (
          <div className="comex-vault-snapshot-overlay">
            <div className="comex-empty">{overlayMessage}</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          {historyRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={historyRows}
                margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
                onClick={(state) => {
                  if (state?.activeLabel && onPin) onPin(state.activeLabel);
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d) => `${d.slice(5, 7)}/${d.slice(8, 10)}`}
                  tick={{ fill: "#8a94a6", fontSize: 11 }}
                />
                <YAxis
                  tickFormatter={(v) => `${(v / 1e6).toFixed(1)}M`}
                  tick={{ fill: "#8a94a6", fontSize: 11 }}
                />
                <Tooltip
                  content={
                    <ShfeVaultTooltipContent
                      rows={historyRows}
                      warehouseKeys={allWarehouseNames}
                      warehouseColor={warehouseColor}
                    />
                  }
                />
                {pinnedDateSnapped && (
                  <ReferenceLine x={pinnedDateSnapped} stroke="#e0a84c" strokeDasharray="3 3" />
                )}
                {stackOrder.map((w) => (
                  <Bar
                    key={w}
                    dataKey={`${w}.oz`}
                    name={w}
                    stackId="warehouses"
                    fill={warehouseColor(w)}
                    fillOpacity={clickedWarehouse && clickedWarehouse !== w ? 0.2 : 0.85}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="comex-empty">Loading…</div>
          )}
        </div>

        <div className="comex-vault-pie-row" style={{ flex: "0 0 260px" }}>
          {clickedWarehouseData ? (
            <div style={{ fontSize: 12, textAlign: "center" }}>
              <div style={{ color: warehouseColor(clickedWarehouse), fontWeight: 600 }}>
                {clickedWarehouse}
              </div>
              {fmt_oz(clickedWarehouseData.value)}
              {clickedWarehouseData.delta != null && (
                <>
                  {" · "}
                  <span className={delta_class(clickedWarehouseData.delta)}>
                    {delta_str(clickedWarehouseData.delta)}
                  </span>
                </>
              )}
            </div>
          ) : (
            totalDeltaKnown && (
              <div style={{ fontSize: 12, textAlign: "center" }}>
                Total change:{" "}
                <span className={delta_class(totalDelta)}>{delta_str(totalDelta)}</span>
              </div>
            )
          )}
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name"
                cx="50%" cy="50%" outerRadius={100} innerRadius={50} paddingAngle={1}>
                {pieData.map((entry) => (
                  <Cell
                    key={entry.name}
                    fill={entry.color}
                    fillOpacity={clickedWarehouse && clickedWarehouse !== entry.name ? 0.35 : 1}
                    stroke={clickedWarehouse === entry.name ? "#e8ecf4" : undefined}
                    strokeWidth={clickedWarehouse === entry.name ? 2 : undefined}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "6px 10px" }}>
                      <div style={{ color: "#c8d0de", fontWeight: 600 }}>{d.name}</div>
                      <div style={{ color: "#8a94a6" }}>{fmt_oz(d.value)}</div>
                      {d.delta != null && (
                        <div className={delta_class(d.delta)}>{delta_str(d.delta)} vs. prior day</div>
                      )}
                    </div>
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          {snapshotDate && (
            <div style={{ fontSize: 11, color: "#8a94a6", textAlign: "center" }}>
              {pinnedDateSnapped ? `As of ${snapshotDate}` : `Latest — ${snapshotDate}`}
            </div>
          )}
        </div>
        </div>

        <div className="comex-legend-list comex-legend-list--horizontal">
          {allWarehouseNames.map((w) => (
            <button
              key={w}
              className={`comex-legend-item legend-btn-row${clickedWarehouse === w ? " legend-btn-row--baseline" : ""}`}
              style={{ "--legend-color": warehouseColor(w) }}
              onClick={() => setClickedWarehouse((prev) => (prev === w ? null : w))}
            >
              <span className="comex-legend-swatch" style={{ background: warehouseColor(w) }} />
              <span>{w}</span>
            </button>
          ))}
        </div>
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
  const [depositoriesHistory, setDepositoriesHistory] = useState(null);
  const [goldDepositoriesHistory, setGoldDepositoriesHistory] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [shfeHistory, setShfeHistory] = useState(null);
  const [shfeWarehousesHistory, setShfeWarehousesHistory] = useState(null);
  const [shfeGoldHistory, setShfeGoldHistory] = useState(null);
  const [shfeGoldWarehousesHistory, setShfeGoldWarehousesHistory] = useState(null);
  const [pslv, setPslv] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const timerRef = useRef(null);

  // Stock & Flow's own panel-wide date selector — drives every chart in this
  // section (Silver Inventory, Per-Vault Snapshot, Delivery Behavior/
  // Reclassification vs. Real Inflow), per the user's 2026-07-24 request,
  // same 6-preset-plus-Custom shape as Paper Games/Dollars and Sense's own
  // selectors. Client-side filtering of each chart's already-fetched series,
  // same as those two panels — no per-window refetch.
  const [sfWindow, setSfWindow] = useState("1Y");
  const [sfCustomStart, setSfCustomStart] = useState("");
  const [sfCustomEnd, setSfCustomEnd] = useState("");

  // Cross-chart click-to-pin (2026-07-24, replacing the earlier hover-driven,
  // server-refetching pin) — same convention as Money Supply/Paper Games:
  // one shared pinnedDate string, any chart's onClick can set it, every
  // chart snaps it to its own nearest real row via nearestRowDate and draws
  // its own ReferenceLine. Pure client-side against each chart's own
  // already-fetched data — no fetch-on-pin, unlike the old design (which
  // re-fetched /api/{silver,gold}/db/depositories?date= on every hover).
  const [pinnedDate, setPinnedDate] = useState(null);
  // comexMetal drives both VaultSnapshotPanel and DeliveryBehaviorPanel —
  // owned here (2026-07-24) and rendered as a selector in "COMEX — New
  // York"'s own header, since it's the shared parent of both panels. Used
  // to live as local state inside DeliveryBehaviorPanel, reported upward via
  // a callback; now it's a plain controlled prop passed down to both.
  const [comexMetal, setComexMetal] = useState("XAG");
  // shfeMetal is SHFE's own independent metal toggle (added 2026-07-24 with
  // the SHFE gold build-out) — deliberately separate state from comexMetal,
  // since COMEX and SHFE are different exchanges with no reason to be forced
  // to the same metal at the same time.
  const [shfeMetal, setShfeMetal] = useState("XAG");

  const handlePin = useCallback((date) => {
    setPinnedDate((prev) => (prev === date ? null : date));
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
    await get("/api/silver/db/depositories/history", setDepositoriesHistory, (j) => j.data ?? null);
    await delay(300);
    await get("/api/gold/db/depositories/history", setGoldDepositoriesHistory, (j) => j.data ?? null);
    await delay(300);
    await get("/api/silver/db/delivery?type=mtd", setDelivery,      null);
    await delay(300);
    await get("/api/shfe/db/history",             setShfeHistory,   (j) => j.data ?? null);
    await delay(300);
    await get("/api/shfe/db/warehouses/history",  setShfeWarehousesHistory, (j) => j.data ?? null);
    await delay(300);
    await get("/api/shfe/gold/db/history",        setShfeGoldHistory, (j) => j.data ?? null);
    await delay(300);
    await get("/api/shfe/gold/db/warehouses/history", setShfeGoldWarehousesHistory, (j) => j.data ?? null);
    await delay(300);
    await get("/api/pslv/db",                     setPslv,           null);
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

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        Stock &amp; Flow
        <div className="comex-range-selector">
          {pinnedDate && (
            <button
              className="comex-range-btn"
              onClick={() => setPinnedDate(null)}
              title="Click to remove the pinned date"
            >
              📌 {pinnedDate}
            </button>
          )}
          {SF_WINDOWS.map((w) => (
            <button
              key={w}
              className={`comex-range-btn${sfWindow === w ? " comex-range-btn--active" : ""}`}
              onClick={() => setSfWindow(w)}
            >
              {w}
            </button>
          ))}
          <button
            className={`comex-range-btn${sfWindow === "custom" ? " comex-range-btn--active" : ""}`}
            onClick={() => setSfWindow("custom")}
          >
            Custom
          </button>
        </div>
      </div>
      {sfWindow === "custom" && (
        <div className="comex-range-selector" style={{ marginBottom: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8a94a6" }}>
            From
            <input
              type="date"
              value={sfCustomStart}
              onChange={(e) => setSfCustomStart(e.target.value)}
              max={sfCustomEnd || undefined}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8a94a6" }}>
            To
            <input
              type="date"
              value={sfCustomEnd}
              onChange={(e) => setSfCustomEnd(e.target.value)}
              min={sfCustomStart || undefined}
            />
          </label>
          {sfCustomStart && sfCustomEnd && sfCustomStart > sfCustomEnd && (
            <span style={{ fontSize: 11, color: "#e05252" }}>Start must be before end.</span>
          )}
        </div>
      )}
      <div className="comex-shell">
          {fetchError && (
            <div className="comex-header">
              <div className="comex-error">
                Error fetching data: {fetchError}. Is the FastAPI proxy running?{" "}
                <code>uvicorn main:app --reload</code>
              </div>
            </div>
          )}

          <CrossExchangePanel
            comexHistory={history}
            shfeHistory={shfeHistory}
            pslv={pslv}
            sfWindow={sfWindow}
            sfCustomStart={sfCustomStart}
            sfCustomEnd={sfCustomEnd}
            pinnedDate={pinnedDate}
            onPin={handlePin}
          />

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">
              COMEX — New York
              <select
                value={comexMetal}
                onChange={(e) => setComexMetal(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                style={{ marginLeft: "auto" }}
              >
                <option value="XAG">Silver</option>
                <option value="XAU">Gold</option>
              </select>
            </summary>
            <div className="collapsible-pane-body">
              <VaultSnapshotPanel
                metal={comexMetal}
                depositoriesHistory={comexMetal === "XAU" ? goldDepositoriesHistory : depositoriesHistory}
                sfWindow={sfWindow}
                sfCustomStart={sfCustomStart}
                sfCustomEnd={sfCustomEnd}
                pinnedDate={pinnedDate}
                onPin={handlePin}
              />
              <details className="collapsible-pane">
                <summary className="collapsible-pane-title">Delivery Behavior</summary>
                <div className="collapsible-pane-body">
                  <DeliveryBehaviorPanel
                    metal={comexMetal}
                    sfWindow={sfWindow}
                    sfCustomStart={sfCustomStart}
                    sfCustomEnd={sfCustomEnd}
                    pinnedDate={pinnedDate}
                    onPin={handlePin}
                  />
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
            <summary className="collapsible-pane-title">
              SHFE — Shanghai
              <select
                value={shfeMetal}
                onChange={(e) => setShfeMetal(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                style={{ marginLeft: "auto" }}
              >
                <option value="XAG">Silver</option>
                <option value="XAU">Gold</option>
              </select>
            </summary>
            <div className="collapsible-pane-body">
              <ShfeWarehousePanel
                metal={shfeMetal}
                shfeWarehousesHistory={shfeMetal === "XAU" ? shfeGoldWarehousesHistory : shfeWarehousesHistory}
                sfWindow={sfWindow}
                sfCustomStart={sfCustomStart}
                sfCustomEnd={sfCustomEnd}
                pinnedDate={pinnedDate}
                onPin={handlePin}
              />
              <details className="collapsible-pane">
                <summary className="collapsible-pane-title">
                  {shfeMetal === "XAU" ? "SHFE Gold Inventory (Shanghai)" : "SHFE Silver Inventory (Shanghai)"}
                </summary>
                <div className="collapsible-pane-body">
                  <ShfeHistoryPanel
                    shfeHistory={shfeMetal === "XAU" ? shfeGoldHistory : shfeHistory}
                    sfWindow={sfWindow}
                    sfCustomStart={sfCustomStart}
                    sfCustomEnd={sfCustomEnd}
                    pinnedDate={pinnedDate}
                    onPin={handlePin}
                  />
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

          <details className="collapsible-pane">
            <summary className="collapsible-pane-title">Trade Flow</summary>
            <div className="collapsible-pane-body">
              <TradeFlowPanel />
            </div>
          </details>

          <div className="comex-footer">
            COMEX data: metalcharts.org proxy (CME Group). SHFE data: metalcharts.org
            proxy (Shanghai Futures Exchange, converted from kg). LME (London) requires
            a paid API subscription and is not shown. SQLite persistence in argentvigil.db.
          </div>
      </div>
    </div>
  );
}
