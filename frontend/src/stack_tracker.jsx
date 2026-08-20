import { useState, useEffect, useCallback } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { VAULT_COLORS } from "./palette";

// Stack Tracker (specs/stackTracker-spec.md) — a personal CRUD inventory of
// physical silver/gold holdings, backed entirely by runtime/stack.db +
// runtime/stack_images/, never argentvigil.db. Melt value cross-reads AV's
// live spot price at read time (a read, not a write — persist-on-fetch is
// unaffected). Not a pricing authority for numismatic value — hand-entered
// or null, never estimated.
//
// Deliberately regressed to a minimal surface at the user's request
// ("just a spot to aggregate count and price data") — date/quantity/price
// paid/series is the primary entry shape, building toward "I have 7 2013
// Maples, 6 2014 Maples" via the Grouped by series view. The richer
// backend (photos, reference links, numismatic grading fields, per-item
// silver_weight_oz/gold_weight_oz) is untouched and still fully live —
// just tucked under each item's "Advanced" collapsible instead of being
// front-and-center in the Add flow.

const METALS = ["silver", "gold"];
// bimetallic is a valid backend value but deliberately not offered in the
// simplified Add form's metal picker — only surfaced in the full-page
// item editor, which covers every stack_items column.
const METALS_FULL = ["silver", "gold", "bimetallic"];
const FORMS = ["coin", "bar", "round", "other"];
const SERIES = [
  "American Eagle",
  "Canadian Maple Leaf",
  "Austrian Philharmonic",
  "British Britannia",
  "South African Krugerrand",
  "Australian Kangaroo/Kookaburra",
  "Mexican Libertad",
  "Chinese Silver Panda",
  "Ukraine Archangel Michael",
  "Niue",
  "APMEX",
  "US - Constitutional",
  "Other/Generic",
];
const GRADING_SERVICES = ["PCGS", "NGC", "ANACS", "Ungraded"];
// Mirrors backend/stack.py's UNIT_WEIGHT_QUICK_PICKS — oz per single unit.
// 0.1808 is the standard 90%-silver junk-silver quarter's actual silver
// content, per the user's real holding ("14 quarters, 2.5312 oz").
const UNIT_WEIGHT_QUICK_PICKS = [
  { label: "1 oz", value: "1" },
  { label: "10 oz", value: "10" },
  { label: "90% silver quarter (0.1808 oz)", value: "0.1808" },
  { label: "Custom", value: "custom" },
];

async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.detail || `request to ${url} failed`);
  return data.data;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.detail || `request to ${url} failed`);
  return data.data;
}

async function putJSON(url, body) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.detail || `request to ${url} failed`);
  return data.data;
}

async function deleteJSON(url) {
  const res = await fetch(url, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.detail || `request to ${url} failed`);
  return data.data;
}

async function postForm(url, formData) {
  const res = await fetch(url, { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.detail || `request to ${url} failed`);
  return data.data;
}

function fmtUsd(v) {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function fmtOz(v) {
  if (v === null || v === undefined) return "—";
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 4 })} oz`;
}

// Bare number, no "oz" suffix — for table cells that already sit under a
// "Total oz" column header, where repeating the unit on every row is
// redundant (per the user's own call).
function fmtOzBare(v) {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtPct(v) {
  if (v === null || v === undefined) return "";
  return ` (${v >= 0 ? "+" : ""}${v.toFixed(1)}%)`;
}

const SERIES_CUSTOM_SENTINEL = "__custom__";

// Series is freehand text server-side (per the user's "this DB is mine"
// call — a casino chip's series is just as valid as "Canadian Maple
// Leaf"), but the SERIES list stays as one-click quick-picks for the
// common cases. Shared across the Add/Edit/Bulk-update forms so all three
// offer the same picker rather than drifting into three slightly
// different inputs. `blankLabel` differs per call site ("No series" vs.
// "Series — leave unchanged" for bulk update).
function SeriesInput({ value, onChange, blankLabel }) {
  const isCustom = value !== "" && !SERIES.includes(value);
  const [customMode, setCustomMode] = useState(isCustom);

  function handleSelectChange(e) {
    if (e.target.value === SERIES_CUSTOM_SENTINEL) {
      setCustomMode(true);
      onChange("");
    } else {
      setCustomMode(false);
      onChange(e.target.value);
    }
  }

  return (
    <>
      <select value={customMode ? SERIES_CUSTOM_SENTINEL : value} onChange={handleSelectChange}>
        <option value="">{blankLabel}</option>
        {SERIES.map((s) => <option key={s} value={s}>{s}</option>)}
        <option value={SERIES_CUSTOM_SENTINEL}>Custom…</option>
      </select>
      {customMode && (
        <input
          className="research-input"
          placeholder="Type a series, e.g. 'Luxor'"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  );
}

// Grouped by date is the default per the user's request — "I only want to
// see the aggregate when I first open the tab." Flat and Grouped by series
// stay available as alternate modes via the same toggle row.
const GROUP_MODES = [
  { key: "date", label: "Grouped by date" },
  { key: "series", label: "Grouped by series" },
  { key: "flat", label: "Flat list" },
];

export default function StackTracker() {
  const [mode, setMode] = useState("series"); // "date" | "series" | "flat"
  const [view, setView] = useState("list"); // "list" | "detail" | "add"
  const [metalFilter, setMetalFilter] = useState("all"); // "all" | "silver" | "gold"
  // Lifted out of StackCharts so DcaStrip can also react to a pie-legend
  // click, per the user's request that clicking a series filters every
  // panel below the list, not just the two charts.
  const [clickedSeries, setClickedSeries] = useState(null);
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [seriesGroups, setSeriesGroups] = useState([]);
  const [dateGroups, setDateGroups] = useState([]);
  const [timeseries, setTimeseries] = useState([]);
  const [listError, setListError] = useState(null);
  const [activeItemId, setActiveItemId] = useState(null);
  const [activeGroupIds, setActiveGroupIds] = useState(null); // item ids of the drilled-into group, or null

  const refresh = useCallback(() => {
    getJSON("/api/stack/items/db").then(setItems).catch((err) => setListError(err.message));
    getJSON("/api/stack/summary/db").then(setSummary).catch(() => {});
    getJSON("/api/stack/series-summary/db").then(setSeriesGroups).catch(() => {});
    getJSON("/api/stack/date-summary/db").then(setDateGroups).catch(() => {});
    getJSON("/api/stack/timeseries/db").then(setTimeseries).catch(() => {});
  }, []);

  useEffect(() => {
    if (view === "list") refresh();
  }, [view, refresh]);

  function openItem(id) {
    setActiveItemId(id);
    setView("detail");
  }

  function backToList() {
    setActiveItemId(null);
    setView("list");
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setActiveGroupIds(null);
  }

  // Metal filter applies to whichever mode is active — items directly for
  // Flat, and both the item set AND the group summaries (each group's
  // item_ids filtered down, empty groups dropped, AND every numeric
  // total genuinely recomputed from the filtered member items — a group
  // that mixes metals, e.g. "Canadian Maple Leaf" spanning both silver
  // and gold coins, was previously keeping its unfiltered combined oz
  // total even after filtering to one metal, a real bug confirmed live)
  // for the grouped modes.
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const filteredItems = metalFilter === "all" ? items : items.filter((i) => i.metal === metalFilter);
  const filteredItemIds = new Set(filteredItems.map((i) => i.id));
  function filterGroups(groups) {
    if (metalFilter === "all") return groups;
    return groups
      .map((g) => {
        const memberIds = g.item_ids.filter((id) => filteredItemIds.has(id));
        const members = memberIds.map((id) => itemsById.get(id)).filter(Boolean);
        let totalCount = 0, totalOz = null, totalMelt = null, totalSpent = null;
        for (const m of members) {
          totalCount += m.count || 1;
          if (m.total_weight_oz !== null && m.total_weight_oz !== undefined) totalOz = (totalOz || 0) + m.total_weight_oz;
          if (m.melt_value !== null && m.melt_value !== undefined) totalMelt = (totalMelt || 0) + m.melt_value;
          if (m.purchase_price !== null && m.purchase_price !== undefined) totalSpent = (totalSpent || 0) + m.purchase_price;
        }
        return {
          ...g,
          item_ids: memberIds,
          item_count: members.length,
          total_count: totalCount,
          total_weight_oz: totalOz,
          total_melt_value: totalMelt,
          total_spent: totalSpent,
        };
      })
      .filter((g) => g.item_ids.length > 0);
  }

  return (
    <div className="app-shell">
      <details className="collapsible-pane" open>
        <summary className="collapsible-pane-title">
          <span>Stack</span>
        </summary>
        <div className="collapsible-pane-body">
          {view === "list" && (
            <div>
              <SummaryStrip summary={summary} />
              <div className="research-input-row" style={{ margin: "12px 0" }}>
                <button type="button" onClick={() => setView("add")}>+ Add</button>
                {GROUP_MODES.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => switchMode(m.key)}
                    disabled={mode === m.key && !activeGroupIds}
                  >
                    {m.label}
                  </button>
                ))}
                <select value={metalFilter} onChange={(e) => setMetalFilter(e.target.value)}>
                  <option value="all">All metals</option>
                  <option value="silver">Silver</option>
                  <option value="gold">Gold</option>
                </select>
              </div>

              {mode === "flat" && (
                <ItemList items={filteredItems} error={listError} onOpen={openItem} onBulkUpdated={refresh} />
              )}

              {mode !== "flat" && !activeGroupIds && (
                <GroupList
                  groups={filterGroups(mode === "date" ? dateGroups : seriesGroups)}
                  error={listError}
                  onOpenGroup={setActiveGroupIds}
                />
              )}
              {mode !== "flat" && activeGroupIds && (
                <div>
                  <button type="button" onClick={() => setActiveGroupIds(null)}>
                    ← Back to {mode === "date" ? "dates" : "series"}
                  </button>
                  <ItemList
                    items={filteredItems.filter((i) => activeGroupIds.includes(i.id))}
                    error={listError}
                    onOpen={openItem}
                    onBulkUpdated={refresh}
                  />
                </div>
              )}

              <DcaStrip summary={summary} items={items} clickedSeries={clickedSeries} />
              <StackCharts
                seriesGroups={seriesGroups}
                timeseries={timeseries}
                items={items}
                clickedSeries={clickedSeries}
                setClickedSeries={setClickedSeries}
              />
            </div>
          )}
          {view === "detail" && <ItemDetail itemId={activeItemId} onBack={backToList} />}
          {view === "add" && <AddForm onDone={backToList} onCancel={backToList} />}
        </div>
      </details>
    </div>
  );
}

// --- List view -------------------------------------------------------

function SummaryStrip({ summary }) {
  if (!summary) return null;
  return (
    <div className="comex-panel-header">
      <div>
        <div className="comex-panel-note">Total spent</div>
        <div>{fmtUsd(summary.total_spent)}</div>
      </div>
      <div>
        <div className="comex-panel-note">Unrealized gain/loss</div>
        <div>
          {fmtUsd(summary.total_unrealized_gain)}
          {summary.total_unrealized_gain_pct !== null && summary.total_unrealized_gain_pct !== undefined
            ? ` (${summary.total_unrealized_gain_pct.toFixed(1)}%)`
            : ""}
        </div>
      </div>
      <div>
        <div className="comex-panel-note">Current value</div>
        <div>{fmtUsd(summary.total_current_value)}</div>
      </div>
      <div>
        <div className="comex-panel-note">Held</div>
        <div>
          {fmtOz(summary.total_silver_oz)} Ag{fmtPct(summary.silver_gain_pct)} /{" "}
          {fmtOz(summary.total_gold_oz)} Au{fmtPct(summary.gold_gain_pct)}
        </div>
      </div>
    </div>
  );
}

// DCA (dollar-cost-average) per metal — avg cost/oz actually paid, colored
// against live spot: green when spot is higher (your average buy-in is
// cheaper than today's price, a favorable position — matches this app's
// standing green=favorable/red=unfavorable convention) and red when spot
// is lower. Deliberately shows only the colored DCA figure, no spot price
// or % alongside it, per the user's explicit call.
// Green = you're underwater vs. spot (DCA > spot) = a buying opportunity,
// the actionable/favorable read for someone still accumulating. Red = your
// stack is already cheaper than spot (DCA < spot). This is deliberately
// the OPPOSITE of the gain/loss coloring elsewhere in this panel (green =
// currently profitable there) — DCA's color answers "should I buy more,"
// not "am I up or down," per the user's explicit correction.
function DcaLine({ label, dca, spot }) {
  if (dca === null || dca === undefined) return null;
  const color = spot === null || spot === undefined ? "#8a94a6" : dca > spot ? "#4caf76" : "#e05252";
  return (
    <span style={{ fontSize: 22, fontWeight: 700, whiteSpace: "nowrap" }}>
      <span style={{ color: "#5a6278", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label} DCA{" "}
      </span>
      <span style={{ color }}>{fmtUsd(dca)}/oz</span>
      {spot !== null && spot !== undefined && (
        <span className="comex-panel-note" style={{ fontSize: 13, fontWeight: 400 }}> (spot {fmtUsd(spot)}/oz)</span>
      )}
    </span>
  );
}

// DCA for one metal within an arbitrary item subset — spend/oz both
// accumulated from real per-item data, mirroring backend/stack.py's
// portfolio_summary silver_dca/gold_dca math (spend / oz, NULL if either
// side has no real data), so a filtered DCA is computed the same way the
// portfolio-wide one is, just over fewer rows.
function dcaForMetal(items, metal) {
  const metalItems = items.filter((i) => i.metal === metal);
  let spend = 0;
  let anySpend = false;
  let oz = 0;
  for (const item of metalItems) {
    if (item.purchase_price !== null && item.purchase_price !== undefined) {
      spend += item.purchase_price;
      anySpend = true;
    }
    oz += item.total_weight_oz || 0;
  }
  return anySpend && oz ? spend / oz : null;
}

function DcaStrip({ summary, items, clickedSeries }) {
  if (!summary) return null;

  let silverDca = summary.silver_dca;
  let goldDca = summary.gold_dca;
  if (clickedSeries) {
    const seriesItems = items.filter((i) => (i.series || i.description) === clickedSeries);
    silverDca = dcaForMetal(seriesItems, "silver");
    goldDca = dcaForMetal(seriesItems, "gold");
  }
  if (silverDca === null && goldDca === null) return null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 16 }}>
      {silverDca !== null && (
        <div className="comex-panel" style={{ padding: "16px 20px" }}>
          <DcaLine label={clickedSeries ? `Silver (${clickedSeries})` : "Silver"} dca={silverDca} spot={summary.spot_silver} />
        </div>
      )}
      {goldDca !== null && (
        <div className="comex-panel" style={{ padding: "16px 20px", marginLeft: silverDca === null ? "auto" : undefined }}>
          <DcaLine label={clickedSeries ? `Gold (${clickedSeries})` : "Gold"} dca={goldDca} spot={summary.spot_gold} />
        </div>
      )}
    </div>
  );
}

// Custom label — direct % labels on pie slices (per the dataviz skill's
// requirement that a CVD-adjacent-pair color pair only ships with a
// secondary encoding; this app's shared VAULT_COLORS palette is reused
// here for consistency with every other pie in AV, so direct labels carry
// the identity that color-alone can't guarantee).
function pieSliceLabel({ percent }) {
  return percent >= 0.04 ? `${(percent * 100).toFixed(0)}%` : "";
}

function SeriesPieTooltip({ active, payload, clickedSeries }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  if (clickedSeries && d.name !== clickedSeries) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "6px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600 }}>{d.name}</div>
      <div style={{ color: "#8a94a6" }}>{fmtOz(d.value)}</div>
    </div>
  );
}

function GapTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const gap = payload[0].value;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "6px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600 }}>{label}</div>
      <div style={{ color: gap >= 0 ? "#4caf76" : "#e05252" }}>
        {gap >= 0 ? "+" : ""}{fmtUsd(gap)} vs. cost basis
      </div>
    </div>
  );
}

function OzGrowthTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "6px 10px" }}>
      <div style={{ color: "#c8d0de", fontWeight: 600 }}>{label} (click to pin)</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {fmtOzBare(p.value)}
        </div>
      ))}
    </div>
  );
}

// Pie by series (oz-weighted — "what's my stack made of, by oz") plus an
// area chart of the gap between cumulative spend and what the running oz
// total is worth at TODAY's live spot — "am I up or down, and by how
// much," shaded green above zero / red below, rather than making the
// reader compare two crossing lines (the original two-line design the
// user disliked).
// As-of-date series composition, computed client-side from the full item
// list (items already carry series/total_weight_oz/purchase_date — no
// need for a dedicated backend route just to filter+regroup data the
// frontend already has in full). Mirrors backend/stack.py's series_summary
// grouping rule (fall back to description for un-seriesed items) so the
// pinned-date pie and the live one group identically.
function seriesCompositionAsOf(items, asOfDate) {
  const filtered = asOfDate ? items.filter((i) => i.purchase_date && i.purchase_date <= asOfDate) : items;
  const totals = new Map();
  for (const item of filtered) {
    if (!item.total_weight_oz) continue;
    const key = item.series || item.description;
    totals.set(key, (totals.get(key) || 0) + item.total_weight_oz);
  }
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Client-side twin of backend/stack.py's stack.timeseries(), scoped to an
// arbitrary item subset (e.g. one series' items after a pie-legend click)
// rather than the whole portfolio — mirrors that function's shape
// (day_spend/cumulative_spend/cumulative_*_oz/cumulative_melt_value) so
// the oz-growth and gap charts can render identically whether they're
// fed the portfolio-wide /timeseries/db response or a filtered subset.
// Reuses each item's own melt_value/total_weight_oz (already computed
// server-side at today's live spot by list_items_with_valuation) rather
// than re-deriving from spot prices, which the frontend doesn't have
// direct access to outside of what /items/db already returned.
function timeseriesFromItems(items) {
  const dated = items.filter((i) => i.purchase_date);
  const byDate = new Map();
  for (const item of dated) {
    if (!byDate.has(item.purchase_date)) byDate.set(item.purchase_date, []);
    byDate.get(item.purchase_date).push(item);
  }
  let cumulativeSpend = 0;
  let cumulativeSilverOz = 0;
  let cumulativeGoldOz = 0;
  let cumulativeMeltValue = 0;
  let anyMeltValue = false;
  const rows = [];
  for (const date of [...byDate.keys()].sort()) {
    const dayItems = byDate.get(date);
    const daySpend = dayItems.reduce((sum, i) => sum + (i.purchase_price || 0), 0);
    cumulativeSpend += daySpend;
    for (const item of dayItems) {
      if (item.metal === "silver") cumulativeSilverOz += item.total_weight_oz || 0;
      else if (item.metal === "gold") cumulativeGoldOz += item.total_weight_oz || 0;
      if (item.melt_value !== null && item.melt_value !== undefined) {
        cumulativeMeltValue += item.melt_value;
        anyMeltValue = true;
      }
    }
    rows.push({
      date,
      day_spend: daySpend,
      cumulative_spend: cumulativeSpend,
      cumulative_silver_oz: cumulativeSilverOz,
      cumulative_gold_oz: cumulativeGoldOz,
      cumulative_melt_value: anyMeltValue ? cumulativeMeltValue : null,
    });
  }
  return rows;
}

// Cumulative oz over time, stacked by series — a client-side computation
// (no backend route; items already carry series/total_weight_oz/
// purchase_date in full) since this is a genuinely different shape from
// stack.timeseries()'s per-metal cumulative rows: one running total per
// series-key rather than one per metal. Returns { rows, seriesKeys } —
// rows is one object per real purchase_date with every series-key's
// running cumulative oz as of that date (present on every row, even 0,
// so Recharts' stacked Area always has a value to stack), seriesKeys is
// the stable list of series names found, sorted by CURRENT total (largest
// band first) so the stack order stays meaningful rather than
// alphabetical or insertion-order.
function ozGrowthBySeries(items) {
  const dated = items.filter((i) => i.purchase_date && i.total_weight_oz);
  const byDate = new Map();
  for (const item of dated) {
    if (!byDate.has(item.purchase_date)) byDate.set(item.purchase_date, []);
    byDate.get(item.purchase_date).push(item);
  }
  const dates = [...byDate.keys()].sort();
  const cumulative = new Map(); // series key -> running oz
  const rows = [];
  for (const date of dates) {
    for (const item of byDate.get(date)) {
      const key = item.series || item.description;
      cumulative.set(key, (cumulative.get(key) || 0) + item.total_weight_oz);
    }
    const row = { date };
    for (const [key, value] of cumulative) row[key] = value;
    rows.push(row);
  }
  // Backfill 0 for any series-key that didn't exist yet as of an earlier
  // row — a stacked Area needs every key present on every row, not just
  // from the date it first appears.
  const seriesKeys = [...cumulative.keys()].sort((a, b) => (cumulative.get(b) || 0) - (cumulative.get(a) || 0));
  for (const row of rows) {
    for (const key of seriesKeys) if (!(key in row)) row[key] = 0;
  }
  return { rows, seriesKeys };
}

function StackCharts({ seriesGroups, timeseries, items, clickedSeries, setClickedSeries }) {
  const [pinnedDate, setPinnedDate] = useState(null);
  const [hiddenOzSeries, setHiddenOzSeries] = useState(() => new Set());

  const livePieData = seriesGroups
    .filter((g) => g.total_weight_oz)
    .map((g) => ({ name: g.label, value: g.total_weight_oz }));
  const pieSource = pinnedDate ? seriesCompositionAsOf(items, pinnedDate) : livePieData;
  // Color assignment keys off the LIVE series list, not the pinned
  // subset, so a given series keeps the same color whether or not it's
  // pinned — a pinned date with fewer series present shouldn't cause the
  // remaining slices to repaint into different colors than their live view.
  const colorByName = new Map(livePieData.map((g, i) => [g.name, VAULT_COLORS[i % VAULT_COLORS.length]]));
  const pieData = pieSource.map((g) => ({ ...g, color: colorByName.get(g.name) || "#94a3b8" }));

  // Selecting a series in the pie's legend re-scopes the two charts below
  // to that series' own items — per the user's explicit "I'd see the
  // graphs below change as if they were focused only on the rows with
  // series American Eagle" request.
  const activeTimeseries = clickedSeries
    ? timeseriesFromItems(items.filter((i) => (i.series || i.description) === clickedSeries))
    : timeseries;
  const activeItems = clickedSeries
    ? items.filter((i) => (i.series || i.description) === clickedSeries)
    : items;

  // Own stacked-by-series growth chart — separate from the pie's
  // clickedSeries "solo one series" filter above. hiddenOzSeries is a
  // checkbox-style multi-select (toggle any number of bands off/on),
  // deliberately a different interaction than the pie legend's
  // single-select highlight, per the user's explicit call.
  const { rows: ozGrowthData, seriesKeys: ozSeriesKeys } = ozGrowthBySeries(activeItems);
  const visibleOzSeriesKeys = ozSeriesKeys.filter((k) => !hiddenOzSeries.has(k));
  const ozColorByKey = new Map(ozSeriesKeys.map((k, i) => [k, VAULT_COLORS[i % VAULT_COLORS.length]]));
  // "Timeline should be min/max acquisition date": a category axis's
  // domain is inherently the exact set of x-values present in its data
  // (Recharts has no separate "domain" concept to override for
  // type="category" the way a numeric/time axis does), and ozGrowthData
  // is already sorted ascending by real purchase_date with no synthetic
  // padding rows — so the axis already spans exactly [earliest purchase,
  // latest purchase] by construction, with nothing further to set.

  function toggleOzSeries(key) {
    setHiddenOzSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleOzChartClick(state) {
    const label = state?.activeLabel;
    if (!label) return;
    setPinnedDate((prev) => (prev === label ? null : label));
  }

  const gapData = activeTimeseries.map((r) => ({
    date: r.date,
    gap: r.cumulative_melt_value === null ? null : r.cumulative_melt_value - r.cumulative_spend,
  }));
  const gapValues = gapData.map((r) => r.gap).filter((v) => v !== null);
  const gapMax = gapValues.length ? Math.max(...gapValues) : 0;
  const gapMin = gapValues.length ? Math.min(...gapValues) : 0;
  // Split-gradient offset: where zero falls in the [max, min] domain (SVG
  // gradients paint top-to-bottom, so gapMax is offset 0%). All-positive
  // or all-negative data clamps to a single solid color across the whole
  // fill rather than a degenerate 0%/100% split.
  const zeroOffset = gapMax === gapMin ? 0.5 : Math.max(0, Math.min(1, gapMax / (gapMax - gapMin)));

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">Charts</summary>
      <div className="collapsible-pane-body" style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          {pinnedDate && (
            <div className="comex-panel-note" style={{ textAlign: "center" }}>
              As of {pinnedDate} —{" "}
              <button type="button" onClick={() => setPinnedDate(null)} style={{ fontSize: 11 }}>
                clear
              </button>
            </div>
          )}
          {pieData.length === 0 ? (
            <div className="comex-empty">No weighed items yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
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
                  stroke="#141820"
                  strokeWidth={2}
                  label={pieSliceLabel}
                  labelLine={false}
                >
                  {pieData.map((entry) => (
                    <Cell
                      key={entry.name}
                      fill={entry.color}
                      fillOpacity={clickedSeries && clickedSeries !== entry.name ? 0.35 : 1}
                      stroke={clickedSeries === entry.name ? "#e8ecf4" : "#141820"}
                      strokeWidth={clickedSeries === entry.name ? 3 : 2}
                    />
                  ))}
                </Pie>
                <Tooltip content={<SeriesPieTooltip clickedSeries={clickedSeries} />} />
              </PieChart>
            </ResponsiveContainer>
          )}
          {pieData.length > 0 && (
            <div className="comex-legend-list comex-legend-list--horizontal">
              {pieData.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className={`comex-legend-item legend-btn-row${clickedSeries === entry.name ? " legend-btn-row--baseline" : ""}`}
                  style={{ "--legend-color": entry.color }}
                  onClick={() => setClickedSeries((prev) => (prev === entry.name ? null : entry.name))}
                >
                  <span className="comex-legend-swatch" style={{ background: entry.color }} />
                  <span>{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          {ozGrowthData.length === 0 ? (
            <div className="comex-empty">No dated purchases yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart
                data={ozGrowthData}
                margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                onClick={handleOzChartClick}
                style={{ cursor: "pointer" }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2333" />
                <XAxis dataKey="date" stroke="#5a6278" fontSize={11} minTickGap={40} />
                <YAxis stroke="#5a6278" fontSize={11} width={60} />
                <Tooltip content={<OzGrowthTooltip />} />
                {pinnedDate && <ReferenceLine x={pinnedDate} stroke="#8a94a6" strokeDasharray="3 3" />}
                {visibleOzSeriesKeys.map((key) => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key}
                    stackId="oz"
                    stroke={ozColorByKey.get(key)}
                    fill={ozColorByKey.get(key)}
                    fillOpacity={0.55}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          )}
          <div className="comex-legend-list comex-legend-list--horizontal">
            {ozSeriesKeys.map((key) => (
              <button
                key={key}
                type="button"
                className={`comex-legend-item legend-btn-row${hiddenOzSeries.has(key) ? " legend-btn--off" : ""}`}
                style={{ "--legend-color": ozColorByKey.get(key) }}
                onClick={() => toggleOzSeries(key)}
              >
                <span className="comex-legend-swatch" style={{ background: ozColorByKey.get(key) }} />
                <span>{key}</span>
              </button>
            ))}
          </div>
          <div className="comex-panel-note">
            Cumulative oz held as of each purchase date, stacked by series — click a legend entry to
            show/hide that series' band. Click anywhere on the chart to pin that date — the pie chart
            recomputes to show your series composition as it stood then, not the current total.
          </div>
        </div>

        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          {gapData.length === 0 ? (
            <div className="comex-empty">No dated purchases yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={gapData} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                <defs>
                  {/* Single split gradient — SVG paints top (offset 0%) to
                      bottom (offset 100%), and the y-axis here runs high
                      value at top, so zeroOffset is exactly where the
                      real gap value 0 falls in the [gapMax, gapMin]
                      domain. Green above the line, red below — a single
                      Area/fill can't switch color at a data-driven
                      crossing point any other way in Recharts. */}
                  <linearGradient id="stackGapFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={0} stopColor="#4caf76" stopOpacity={0.4} />
                    <stop offset={zeroOffset} stopColor="#4caf76" stopOpacity={0.08} />
                    <stop offset={zeroOffset} stopColor="#e05252" stopOpacity={0.08} />
                    <stop offset={1} stopColor="#e05252" stopOpacity={0.4} />
                  </linearGradient>
                  <linearGradient id="stackGapStroke" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={0} stopColor="#4caf76" />
                    <stop offset={zeroOffset} stopColor="#4caf76" />
                    <stop offset={zeroOffset} stopColor="#e05252" />
                    <stop offset={1} stopColor="#e05252" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2333" />
                <XAxis dataKey="date" stroke="#5a6278" fontSize={11} minTickGap={40} />
                <YAxis stroke="#5a6278" fontSize={11} tickFormatter={(v) => `$${v.toLocaleString()}`} width={70} />
                <Tooltip content={<GapTooltip />} />
                <ReferenceLine y={0} stroke="#5a6278" strokeWidth={1} />
                <Area
                  type="monotone" dataKey="gap"
                  stroke="url(#stackGapStroke)" strokeWidth={2}
                  fill="url(#stackGapFill)"
                  isAnimationActive={false}
                  dot={false}
                  baseValue={0}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
          <div className="comex-panel-note">
            Cumulative melt value (at today's live spot) minus cumulative spend, as of each purchase date —
            above zero means the running total is worth more than was paid, below zero means less.
          </div>
        </div>
      </div>
    </details>
  );
}

// Sortable-column support, shared by GroupList and ItemList — click a
// header to sort by that field, click the same header again to reverse
// direction. `null`/`undefined` values always sort last regardless of
// direction, so an unknown/missing figure never jumps to the top of a
// descending sort just because it compares as falsy.
function useSort(defaultKey, defaultDir = "desc") {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sorted(rows, accessor) {
    const withIndex = rows.map((r, i) => [r, i]);
    withIndex.sort(([a, ai], [b, bi]) => {
      const av = accessor(a, sortKey);
      const bv = accessor(b, sortKey);
      if (av === null || av === undefined) return bv === null || bv === undefined ? ai - bi : 1;
      if (bv === null || bv === undefined) return -1;
      let cmp;
      if (typeof av === "string") cmp = av.localeCompare(bv);
      else cmp = av - bv;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return withIndex.map(([r]) => r);
  }

  return { sortKey, sortDir, toggleSort, sorted };
}

function SortTh({ label, sortKeyName, currentKey, currentDir, onSort, className }) {
  const active = currentKey === sortKeyName;
  return (
    <th className={className} onClick={() => onSort(sortKeyName)} style={{ cursor: "pointer", userSelect: "none" }}>
      {label}{active ? (currentDir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
}

// Shared table for both Grouped by date and Grouped by series — each row
// shows only the aggregate (count/oz/value) until clicked, per the user's
// "I only want to see the aggregate when I first open the tab."
function GroupList({ groups, error, onOpenGroup }) {
  const { sortKey, sortDir, toggleSort, sorted } = useSort("label", "asc");
  const rows = sorted(groups, (g, key) => g[key]);

  return (
    <div>
      {error && <div className="comex-panel-note">{error}</div>}
      {groups.length === 0 ? (
        <div className="comex-empty">No items yet — add one to get started.</div>
      ) : (
        <div className="comex-table-wrap comex-table-wrap--capped">
          <table className="comex-table comex-table--zebra">
            <thead>
              <tr>
                <SortTh label="Group" sortKeyName="label" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                <SortTh label="Total oz" sortKeyName="total_weight_oz" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} className="right" />
                <SortTh label="Melt value" sortKeyName="total_melt_value" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} className="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.label} onClick={() => onOpenGroup(g.item_ids)} style={{ cursor: "pointer" }}>
                  <td>{g.label}</td>
                  <td className="right">{fmtOzBare(g.total_weight_oz)}</td>
                  <td className="right">{fmtUsd(g.total_melt_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Group update — select rows here (works in both the flat list and a
// group's drilldown, since both render through this same component), then
// apply a focused field subset (series/mint_year/etc, per
// BULK_UPDATE_FIELDS) to every selected row at once. e.g. select the 12
// rows from the 1/29 order, set series="Canadian Maple Leaf" + mint_year
// once, apply to all 12 — date/price/count stay per-row, untouched.
function ItemList({ items, error, onOpen, onBulkUpdated }) {
  const [selected, setSelected] = useState(() => new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const { sortKey, sortDir, toggleSort, sorted } = useSort("purchase_date", "desc");

  const itemAccessor = (item, key) => (key === "series" ? item.series || item.description : item[key]);
  const rows = sorted(items, itemAccessor);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  function toggleOne(e, id) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)));
  }

  function handleBulkUpdated() {
    setBulkEditing(false);
    setSelected(new Set());
    onBulkUpdated?.();
  }

  return (
    <div>
      {error && <div className="comex-panel-note">{error}</div>}
      {items.length === 0 ? (
        <div className="comex-empty">No items yet — add one to get started.</div>
      ) : (
        <div>
          {selected.size > 0 && (
            <div className="research-input-row" style={{ margin: "8px 0" }}>
              <span className="comex-panel-note">{selected.size} selected</span>
              <button type="button" onClick={() => setBulkEditing(true)}>Bulk update</button>
              <button type="button" onClick={() => setSelected(new Set())}>Clear selection</button>
            </div>
          )}
          {bulkEditing && (
            <BulkUpdateForm
              itemIds={[...selected]}
              onDone={handleBulkUpdated}
              onCancel={() => setBulkEditing(false)}
            />
          )}
          <div className="comex-table-wrap comex-table-wrap--capped">
            <table className="comex-table comex-table--zebra">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <SortTh label="Date" sortKeyName="purchase_date" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                  <SortTh label="Series / description" sortKeyName="series" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
                  <SortTh label="Total oz" sortKeyName="total_weight_oz" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} className="right" />
                  <SortTh label="Price paid" sortKeyName="purchase_price" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} className="right" />
                  <SortTh label="Melt value" sortKeyName="melt_value" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} className="right" />
                  <SortTh label="Gain/loss" sortKeyName="unrealized_gain" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} className="right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id} onClick={() => onOpen(item.id)} style={{ cursor: "pointer" }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onClick={(e) => toggleOne(e, item.id)}
                        onChange={() => {}}
                      />
                    </td>
                    <td>{item.purchase_date || "—"}</td>
                    <td>{item.series || item.description}</td>
                    <td className="right">{fmtOzBare(item.total_weight_oz)}</td>
                    <td className="right">{fmtUsd(item.purchase_price)}</td>
                    <td className="right">{fmtUsd(item.melt_value)}</td>
                    <td className="right">
                      {fmtUsd(item.unrealized_gain)}
                      {item.unrealized_gain_pct !== null && item.unrealized_gain_pct !== undefined
                        ? ` (${item.unrealized_gain_pct.toFixed(1)}%)`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Blank form — only fields actually filled in get applied, per the user's
// choice: leaving a field blank means "don't touch this on any selected
// row," so a bulk update can't accidentally blank out data on rows that
// already had something different set.
// Blank form covering the full BULK_UPDATE_FIELDS set (every stack_items
// column except count/lot_id — see backend/stack.py) — expanded from an
// original narrower field set at the user's explicit "I should be able
// to bulk update any one (or all) of the nested fields of the coin"
// request. Every field starts blank; only fields actually filled in get
// sent, so an untouched field is never overwritten with an empty value.
function BulkUpdateForm({ itemIds, onDone, onCancel }) {
  const [series, setSeries] = useState("");
  const [description, setDescription] = useState("");
  const [metal, setMetal] = useState("");
  const [form, setForm] = useState("");
  const [unitWeight, setUnitWeight] = useState("");
  const [silverWeight, setSilverWeight] = useState("");
  const [goldWeight, setGoldWeight] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [premiumPaid, setPremiumPaid] = useState("");
  const [mintYear, setMintYear] = useState("");
  const [mintMark, setMintMark] = useState("");
  const [mintage, setMintage] = useState("");
  const [gradingService, setGradingService] = useState("");
  const [grade, setGrade] = useState("");
  const [certNumber, setCertNumber] = useState("");
  const [numismaticValue, setNumismaticValue] = useState("");
  const [numismaticValueAsOf, setNumismaticValueAsOf] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fields = {};
    if (series) fields.series = series;
    if (description) fields.description = description;
    if (metal) fields.metal = metal;
    if (form) fields.form = form;
    if (unitWeight) fields.unit_weight_oz = parseFloat(unitWeight);
    if (silverWeight) fields.silver_weight_oz = parseFloat(silverWeight);
    if (goldWeight) fields.gold_weight_oz = parseFloat(goldWeight);
    if (purchaseDate) fields.purchase_date = purchaseDate;
    if (purchasePrice) fields.purchase_price = parseFloat(purchasePrice);
    if (premiumPaid) fields.premium_paid = parseFloat(premiumPaid);
    if (mintYear) fields.mint_year = parseInt(mintYear, 10);
    if (mintMark) fields.mint_mark = mintMark;
    if (mintage) fields.mintage = parseInt(mintage, 10);
    if (gradingService) fields.grading_service = gradingService;
    if (grade) fields.grade = grade;
    if (certNumber) fields.certification_number = certNumber;
    if (numismaticValue) fields.numismatic_value = parseFloat(numismaticValue);
    if (numismaticValueAsOf) fields.numismatic_value_as_of = numismaticValueAsOf;
    if (notes) fields.numismatic_notes = notes;
    try {
      await postJSON("/api/stack/items/bulk-update", { item_ids: itemIds, fields });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="comex-panel">
      <div className="comex-panel-header"><span>Bulk update {itemIds.length} item{itemIds.length === 1 ? "" : "s"}</span></div>
      <div className="comex-panel-note">
        Only fields you fill in below get applied — leave a field blank to leave it untouched on every
        selected row. Quantity isn't editable here since it's determined by how the rows were created.
      </div>

      <div className="research-input-row">
        <SeriesInput value={series} onChange={setSeries} blankLabel="Series — leave unchanged" />
        <input
          className="research-input" placeholder="Description — leave blank to skip"
          value={description} onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="research-input-row">
        <select value={metal} onChange={(e) => setMetal(e.target.value)}>
          <option value="">Metal — leave unchanged</option>
          {METALS_FULL.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={form} onChange={(e) => setForm(e.target.value)}>
          <option value="">Form — leave unchanged</option>
          {FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>
      <div className="research-input-row">
        <input
          className="research-input" type="number" step="0.0001" placeholder="oz per unit — leave blank to skip"
          value={unitWeight} onChange={(e) => setUnitWeight(e.target.value)}
        />
        <input
          className="research-input" type="number" step="0.0001" placeholder="Silver oz (explicit) — leave blank to skip"
          value={silverWeight} onChange={(e) => setSilverWeight(e.target.value)}
        />
        <input
          className="research-input" type="number" step="0.0001" placeholder="Gold oz (explicit) — leave blank to skip"
          value={goldWeight} onChange={(e) => setGoldWeight(e.target.value)}
        />
      </div>
      <div className="research-input-row">
        <input
          className="research-input" type="date" placeholder="Purchase date — leave blank to skip"
          value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)}
        />
        <input
          className="research-input" type="number" step="0.01" placeholder="Price paid ($) — leave blank to skip"
          value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)}
        />
        <input
          className="research-input" type="number" step="0.01" placeholder="Premium paid ($) — leave blank to skip"
          value={premiumPaid} onChange={(e) => setPremiumPaid(e.target.value)}
        />
      </div>

      <div className="comex-panel-note" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", margin: "8px 0 4px" }}>
        Numismatic
      </div>
      <div className="research-input-row">
        <input
          className="research-input" type="number" placeholder="Mint year — leave blank to skip"
          value={mintYear} onChange={(e) => setMintYear(e.target.value)}
        />
        <input
          className="research-input" placeholder="Mint mark — leave blank to skip"
          value={mintMark} onChange={(e) => setMintMark(e.target.value)}
        />
        <input
          className="research-input" type="number" placeholder="Mintage — leave blank to skip"
          value={mintage} onChange={(e) => setMintage(e.target.value)}
        />
      </div>
      <div className="research-input-row">
        <select value={gradingService} onChange={(e) => setGradingService(e.target.value)}>
          <option value="">Grading service — leave unchanged</option>
          {GRADING_SERVICES.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input
          className="research-input" placeholder="Grade — leave blank to skip"
          value={grade} onChange={(e) => setGrade(e.target.value)}
        />
        <input
          className="research-input" placeholder="Cert # — leave blank to skip"
          value={certNumber} onChange={(e) => setCertNumber(e.target.value)}
        />
      </div>
      <div className="research-input-row">
        <input
          className="research-input" type="number" step="0.01"
          placeholder="Numismatic value ($) — leave blank to skip"
          value={numismaticValue} onChange={(e) => setNumismaticValue(e.target.value)}
        />
        <input
          className="research-input" type="date" placeholder="Value as of — leave blank to skip"
          value={numismaticValueAsOf} onChange={(e) => setNumismaticValueAsOf(e.target.value)}
        />
      </div>
      <div className="research-input-row">
        <input
          className="research-input" placeholder="Notes — leave blank to skip (replaces existing notes on each row)"
          value={notes} onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {error && <div className="comex-panel-note">{error}</div>}
      <div className="research-input-row">
        <button type="submit" disabled={saving}>{saving ? "Applying…" : `Apply to ${itemIds.length} item${itemIds.length === 1 ? "" : "s"}`}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// --- Shared minimal-fields form ----------------------------------------

const EMPTY_STATE = {
  description: "", series: "", metal: "silver",
  unitWeightPick: "1", unitWeightCustom: "",
  quantity: "1", purchase_date: "", purchase_price: "",
};

function unitWeightOzFromState(state) {
  const raw = state.unitWeightPick === "custom" ? state.unitWeightCustom : state.unitWeightPick;
  return raw ? parseFloat(raw) : null;
}

function MinimalFieldsInputs({ state, setField }) {
  return (
    <div>
      <div className="research-input-row">
        <SeriesInput
          value={state.series}
          onChange={(v) => setField("series", v)}
          blankLabel="No series (bar / generic round) — type a description below"
        />
      </div>
      <div className="research-input-row">
        <input
          className="research-input"
          placeholder="Description (used if no series selected, e.g. '10oz generic bar')"
          value={state.description}
          onChange={(e) => setField("description", e.target.value)}
        />
      </div>
      <div className="research-input-row">
        <select value={state.metal} onChange={(e) => setField("metal", e.target.value)}>
          {METALS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={state.unitWeightPick} onChange={(e) => setField("unitWeightPick", e.target.value)}>
          {UNIT_WEIGHT_QUICK_PICKS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        {state.unitWeightPick === "custom" && (
          <input
            className="research-input" type="number" step="0.0001" placeholder="oz per unit"
            value={state.unitWeightCustom} onChange={(e) => setField("unitWeightCustom", e.target.value)}
          />
        )}
      </div>
      <div className="research-input-row">
        <input
          className="research-input" type="number" min="1" placeholder="Quantity"
          value={state.quantity} onChange={(e) => setField("quantity", e.target.value)}
        />
        <input
          className="research-input" type="date" placeholder="Date"
          value={state.purchase_date} onChange={(e) => setField("purchase_date", e.target.value)}
        />
        <input
          className="research-input" type="number" step="0.01" placeholder="Price paid ($, total for this entry)"
          value={state.purchase_price} onChange={(e) => setField("purchase_price", e.target.value)}
        />
      </div>
    </div>
  );
}

function AddForm({ onDone, onCancel }) {
  const [state, setState] = useState(EMPTY_STATE);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  function setField(key, value) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const quantity = parseInt(state.quantity, 10) || 1;
      const shared = {
        description: state.description || state.series || "Unlabeled item",
        series: state.series || null,
        metal: state.metal,
        form: "coin",
        unit_weight_oz: unitWeightOzFromState(state),
        purchase_date: state.purchase_date || null,
      };
      if (quantity <= 1) {
        await postJSON("/api/stack/items", { ...shared, count: 1, purchase_price: state.purchase_price ? parseFloat(state.purchase_price) : null });
      } else {
        // Bulk-entry path — N independent rows, per-unit price
        // (purchase_price entered above is the TOTAL for this entry, so
        // divide down to the per-unit price create_bulk expects).
        const totalPrice = state.purchase_price ? parseFloat(state.purchase_price) : null;
        await postJSON("/api/stack/items/bulk", {
          ...shared,
          quantity,
          unit_price: totalPrice !== null ? totalPrice / quantity : null,
        });
      }
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="comex-panel-header"><span>Add</span></div>
      <div className="comex-panel-note">
        Quantity &gt; 1 creates that many independent entries (own edit/delete later), not one row with a
        count — e.g. "7, 2013 Canadian Maple Leaf" becomes 7 separate rows you can track individually.
      </div>
      <MinimalFieldsInputs state={state} setField={setField} />
      {error && <div className="comex-panel-note">{error}</div>}
      <div className="research-input-row">
        <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// --- Detail / edit view ------------------------------------------------

// Full-page item editor — one comprehensive form covering every
// stack_items column (replaces the earlier split of a minimal main form
// + a separate "Advanced" numismatic sub-form, per the user's explicit
// "I want to be able to see and edit all the fields used" request).
// Organized into labeled sections for readability, not a single flat
// wall of inputs — Basics / Weight & Value / Numismatic — but it's all
// one <form onSubmit={handleSave}>, one Save action. Photos and
// Reference Links keep their own independent-action sub-forms as
// siblings (HTML forbids nesting <form> elements, and each already has
// its own upload/add-link action distinct from the main Save).
function FormField({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#5a6278" }}>
      {label}
      {children}
    </label>
  );
}

function ItemDetail({ itemId, onBack }) {
  const [item, setItem] = useState(null);
  const [description, setDescription] = useState("");
  const [series, setSeries] = useState("");
  const [metal, setMetal] = useState("silver");
  const [form, setForm] = useState("coin");
  const [unitWeight, setUnitWeight] = useState("");
  const [silverWeight, setSilverWeight] = useState("");
  const [goldWeight, setGoldWeight] = useState("");
  const [count, setCount] = useState("1");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [premiumPaid, setPremiumPaid] = useState("");
  const [mintYear, setMintYear] = useState("");
  const [mintMark, setMintMark] = useState("");
  const [mintage, setMintage] = useState("");
  const [gradingService, setGradingService] = useState("");
  const [grade, setGrade] = useState("");
  const [certNumber, setCertNumber] = useState("");
  const [numismaticValue, setNumismaticValue] = useState("");
  const [numismaticValueAsOf, setNumismaticValueAsOf] = useState("");
  const [numismaticNotes, setNumismaticNotes] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [lightbox, setLightbox] = useState(null);

  const refresh = useCallback(() => {
    getJSON(`/api/stack/items/${itemId}/db`)
      .then((data) => {
        setItem(data);
        setDescription(data.description || "");
        setSeries(data.series || "");
        setMetal(data.metal || "silver");
        setForm(data.form || "coin");
        setUnitWeight(data.unit_weight_oz !== null && data.unit_weight_oz !== undefined ? String(data.unit_weight_oz) : "");
        setSilverWeight(data.silver_weight_oz !== null && data.silver_weight_oz !== undefined ? String(data.silver_weight_oz) : "");
        setGoldWeight(data.gold_weight_oz !== null && data.gold_weight_oz !== undefined ? String(data.gold_weight_oz) : "");
        setCount(String(data.count ?? 1));
        setPurchaseDate(data.purchase_date || "");
        setPurchasePrice(data.purchase_price !== null && data.purchase_price !== undefined ? String(data.purchase_price) : "");
        setPremiumPaid(data.premium_paid !== null && data.premium_paid !== undefined ? String(data.premium_paid) : "");
        setMintYear(data.mint_year !== null && data.mint_year !== undefined ? String(data.mint_year) : "");
        setMintMark(data.mint_mark || "");
        setMintage(data.mintage !== null && data.mintage !== undefined ? String(data.mintage) : "");
        setGradingService(data.grading_service || "");
        setGrade(data.grade || "");
        setCertNumber(data.certification_number || "");
        setNumismaticValue(data.numismatic_value !== null && data.numismatic_value !== undefined ? String(data.numismatic_value) : "");
        setNumismaticValueAsOf(data.numismatic_value_as_of || "");
        setNumismaticNotes(data.numismatic_notes || "");
      })
      .catch((err) => setError(err.message));
  }, [itemId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await putJSON(`/api/stack/items/${itemId}`, {
        description: description || series || "Unlabeled item",
        series: series || null,
        metal,
        form,
        unit_weight_oz: unitWeight ? parseFloat(unitWeight) : null,
        silver_weight_oz: silverWeight ? parseFloat(silverWeight) : null,
        gold_weight_oz: goldWeight ? parseFloat(goldWeight) : null,
        count: count ? parseInt(count, 10) : 1,
        purchase_date: purchaseDate || null,
        purchase_price: purchasePrice ? parseFloat(purchasePrice) : null,
        premium_paid: premiumPaid ? parseFloat(premiumPaid) : null,
        mint_year: mintYear ? parseInt(mintYear, 10) : null,
        mint_mark: mintMark || null,
        mintage: mintage ? parseInt(mintage, 10) : null,
        grading_service: gradingService || null,
        grade: grade || null,
        certification_number: certNumber || null,
        numismatic_value: numismaticValue ? parseFloat(numismaticValue) : null,
        numismatic_value_as_of: numismaticValueAsOf || null,
        numismatic_notes: numismaticNotes || null,
      });
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${item.series || item.description}"?`)) return;
    try {
      await deleteJSON(`/api/stack/items/${itemId}`);
      onBack();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleAddLink(e) {
    e.preventDefault();
    if (!linkUrl.trim()) return;
    try {
      await postJSON(`/api/stack/items/${itemId}/links`, { url: linkUrl.trim(), label: linkLabel.trim() || null });
      setLinkUrl("");
      setLinkLabel("");
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeleteLink(linkId) {
    try {
      await deleteJSON(`/api/stack/links/${linkId}`);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePhotoUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setError(null);
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        await postForm(`/api/stack/items/${itemId}/photos`, formData);
      } catch (err) {
        setError(err.message);
        break;
      }
    }
    e.target.value = "";
    refresh();
  }

  async function handleDeletePhoto(photoId) {
    try {
      await deleteJSON(`/api/stack/photos/${photoId}`);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!item) return <div className="comex-empty">Loading…</div>;

  return (
    <div>
      <div className="research-input-row">
        <button type="button" onClick={onBack}>← Back</button>
        <button type="button" onClick={handleDelete}>Delete</button>
      </div>

      {item.lot_id && (
        <div className="comex-panel-note">
          Part of a group added together — independently editable/deletable from the others.
        </div>
      )}

      <div className="comex-panel-header">
        <div>
          <div className="comex-panel-note">Total oz</div>
          <div>{fmtOz(item.total_weight_oz)}</div>
        </div>
        <div>
          <div className="comex-panel-note">Melt value</div>
          <div>{fmtUsd(item.melt_value)}</div>
        </div>
        {item.numismatic_value !== null && item.numismatic_value !== undefined && (
          <>
            <div>
              <div className="comex-panel-note">Numismatic value</div>
              <div>{fmtUsd(item.numismatic_value)}</div>
            </div>
            <div>
              <div className="comex-panel-note">Numismatic premium</div>
              <div>{fmtUsd(item.numismatic_premium)}</div>
            </div>
          </>
        )}
        <div>
          <div className="comex-panel-note">Gain/loss</div>
          <div>
            {fmtUsd(item.unrealized_gain)}
            {item.unrealized_gain_pct !== null && item.unrealized_gain_pct !== undefined
              ? ` (${item.unrealized_gain_pct.toFixed(1)}%)`
              : ""}
          </div>
        </div>
      </div>

      <form onSubmit={handleSave}>
        <div className="comex-panel-note" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", margin: "12px 0 4px" }}>
          Basics
        </div>
        <div className="research-input-row">
          <SeriesInput value={series} onChange={setSeries} blankLabel="No series" />
        </div>
        <div className="research-input-row">
          <FormField label="Description">
            <input className="research-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
        </div>
        <div className="research-input-row">
          <FormField label="Metal">
            <select value={metal} onChange={(e) => setMetal(e.target.value)}>
              {METALS_FULL.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </FormField>
          <FormField label="Form">
            <select value={form} onChange={(e) => setForm(e.target.value)}>
              {FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </FormField>
          <FormField label="Quantity">
            <input className="research-input" type="number" min="1" value={count} onChange={(e) => setCount(e.target.value)} />
          </FormField>
        </div>
        <div className="research-input-row">
          <FormField label="Purchase date">
            <input className="research-input" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
          </FormField>
          <FormField label="Price paid ($, total for this row)">
            <input className="research-input" type="number" step="0.01" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
          </FormField>
          <FormField label="Premium paid ($)">
            <input className="research-input" type="number" step="0.01" value={premiumPaid} onChange={(e) => setPremiumPaid(e.target.value)} />
          </FormField>
        </div>

        <div className="comex-panel-note" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", margin: "16px 0 4px" }}>
          Weight
        </div>
        <div className="research-input-row">
          <FormField label="oz per unit (primary weight model)">
            <input className="research-input" type="number" step="0.0001" value={unitWeight} onChange={(e) => setUnitWeight(e.target.value)} />
          </FormField>
          <FormField label="Silver oz (explicit per-item, overrides oz/unit if set)">
            <input className="research-input" type="number" step="0.0001" value={silverWeight} onChange={(e) => setSilverWeight(e.target.value)} />
          </FormField>
          <FormField label="Gold oz (explicit per-item, overrides oz/unit if set)">
            <input className="research-input" type="number" step="0.0001" value={goldWeight} onChange={(e) => setGoldWeight(e.target.value)} />
          </FormField>
        </div>

        <div className="comex-panel-note" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", margin: "16px 0 4px" }}>
          Numismatic
        </div>
        <div className="research-input-row">
          <FormField label="Mint year">
            <input className="research-input" type="number" value={mintYear} onChange={(e) => setMintYear(e.target.value)} />
          </FormField>
          <FormField label="Mint mark">
            <input className="research-input" value={mintMark} onChange={(e) => setMintMark(e.target.value)} />
          </FormField>
          <FormField label="Mintage">
            <input className="research-input" type="number" value={mintage} onChange={(e) => setMintage(e.target.value)} />
          </FormField>
        </div>
        <div className="research-input-row">
          <FormField label="Grading service">
            <select value={gradingService} onChange={(e) => setGradingService(e.target.value)}>
              <option value="">No grading service</option>
              {GRADING_SERVICES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </FormField>
          <FormField label="Grade, e.g. MS70">
            <input className="research-input" value={grade} onChange={(e) => setGrade(e.target.value)} />
          </FormField>
          <FormField label="Certification number">
            <input className="research-input" value={certNumber} onChange={(e) => setCertNumber(e.target.value)} />
          </FormField>
        </div>
        <div className="research-input-row">
          <FormField label="Numismatic value ($) — hand-entered, never estimated by AV">
            <input className="research-input" type="number" step="0.01" value={numismaticValue} onChange={(e) => setNumismaticValue(e.target.value)} />
          </FormField>
          <FormField label="Value as of">
            <input className="research-input" type="date" value={numismaticValueAsOf} onChange={(e) => setNumismaticValueAsOf(e.target.value)} />
          </FormField>
        </div>
        <div className="research-input-row">
          <FormField label="Notes">
            <input className="research-input" value={numismaticNotes} onChange={(e) => setNumismaticNotes(e.target.value)} />
          </FormField>
        </div>

        {error && <div className="comex-panel-note">{error}</div>}
        <div className="research-input-row" style={{ margin: "16px 0" }}>
          <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </form>

      <details className="collapsible-pane" open>
        <summary className="collapsible-pane-title">Photos ({item.images.length}/5)</summary>
        <div className="collapsible-pane-body">
          <div className="research-input-row">
            <input type="file" accept="image/*" multiple onChange={handlePhotoUpload} disabled={item.images.length >= 5} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {item.images.map((img) => (
              <div key={img.id} style={{ position: "relative" }}>
                <img
                  src={`/stack_images/${img.file_path}`}
                  alt={img.caption || "stack item photo"}
                  style={{ width: 96, height: 96, objectFit: "cover", cursor: "pointer" }}
                  onClick={() => setLightbox(img)}
                />
                <button type="button" onClick={() => handleDeletePhoto(img.id)} style={{ position: "absolute", top: 0, right: 0 }}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </details>

      <details className="collapsible-pane">
        <summary className="collapsible-pane-title">Reference links ({item.reference_links.length})</summary>
        <div className="collapsible-pane-body">
          <ul>
            {item.reference_links.map((link) => (
              <li key={link.id}>
                <a href={link.url} target="_blank" rel="noreferrer">{link.label || link.url}</a>{" "}
                <button type="button" onClick={() => handleDeleteLink(link.id)}>Remove</button>
              </li>
            ))}
          </ul>
          <form onSubmit={handleAddLink} className="research-input-row">
            <input
              className="research-input" placeholder="URL (Numista listing, PCGS pop report, ...)"
              value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)}
            />
            <input
              className="research-input" placeholder="Label"
              value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)}
            />
            <button type="submit">Add link</button>
          </form>
        </div>
      </details>

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, cursor: "pointer",
          }}
        >
          <img src={`/stack_images/${lightbox.file_path}`} alt={lightbox.caption || ""} style={{ maxWidth: "90%", maxHeight: "90%" }} />
        </div>
      )}
    </div>
  );
}
