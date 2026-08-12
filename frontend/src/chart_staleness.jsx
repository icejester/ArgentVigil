import { useState } from "react";
import { timeAgo } from "./data_panel";
import { useHealthRows } from "./health_context";
import { SOURCE_DEFINITIONS } from "./source_definitions";

// Three-tier status specific to this glyph — deliberately NOT the same
// ok/stale/error computeStatus already ships for the Data tab/HeaderHealthDot
// (that rule stays untouched; this is a per-user-request variant for the
// per-chart glyph only). "Stale" (age > 2x expected_interval_s, same
// threshold/reasoning as computeStatus) is split into two readings using a
// signal computeStatus doesn't: whether the most recent fetch ATTEMPT was a
// clean "skipped" (the source's own gate — e.g. cot_pipeline's 7-day CFTC
// gate, census_trade's 25-day gate — decided there was nothing new to fetch
// yet) versus an error or an overdue success. A skip means the staleness is
// fully explained by the source's own real-world cadence (CoT on a Monday,
// no new report since Friday) — not a real problem. An error or an
// overdue-with-no-skip-recorded state means something's actually wrong.
//   - "fine": fresh (age <= 2x expected_interval_s), or no cadence number
//     to judge against (manual_only sources with no interval/min_gap).
//   - "explained-stale": stale AND last_attempt_status === "skipped".
//   - "unexplained-stale": stale AND last_attempt_status is "error", or
//     "success" but still overdue (no skip was ever recorded to explain it).
function chartStatus(row, expectedIntervalS) {
  if (!row) return "unknown";
  if (!row.last_success_at) {
    return row.last_attempt_status === "skipped" ? "unknown" : "unexplained-stale";
  }
  if (expectedIntervalS == null) return "fine";
  const ageS = (Date.now() - new Date(row.last_success_at).getTime()) / 1000;
  if (ageS <= 2 * expectedIntervalS) return "fine";
  return row.last_attempt_status === "skipped" ? "explained-stale" : "unexplained-stale";
}

// Per-sub-panel freshness indicator — a small circled-info glyph, colored
// gray/yellow/red by chartStatus above, that expands into a popover on
// hover/focus showing the real last-success time and a "Refresh now"
// button. Deliberately hover-triggered rather than click-to-reveal
// (UI_STANDARDS.md's legend convention disallows hover for THAT use case
// specifically, citing unreliable native title= attributes over SVG/chart
// content) — this is a different shape of element (a compact
// always-visible glyph in a <summary> row, not a legend swatch+label row),
// and this is a real <div>-based popover, not a native title= tooltip, so
// the reliability problem UI_STANDARDS.md flagged doesn't apply the same
// way. :focus-within keeps the popover reachable via keyboard, not
// hover-only.
//
// Renders as the <summary> row's own left-side collapse marker — replaces
// the plain ▸ arrow every other collapsible-pane-title has (CSS hides that
// arrow via a :has() selector whenever a .chart-staleness--marker glyph is
// present in the same row, and `order: -1` puts the glyph first regardless
// of where it sits in the JSX). The arrow's own open/closed rotation isn't
// carried over to the glyph — a circular glyph with a centered "ⓘ"
// character rotating 90° reads as a rendering glitch, not a meaningful
// direction change, unlike an arrow — so open/closed state here is
// whatever the collapsible-pane-body's own visibility already shows.
export default function ChartStaleness({ sourceKey, label, detail }) {
  const { rows, bySourceKey, refresh } = useHealthRows(sourceKey);
  const [refreshing, setRefreshing] = useState(false);

  if (rows.length === 0) return null;

  const keys = Array.isArray(sourceKey) ? sourceKey : [sourceKey];

  // Worst-of-N across a multi-source badge, ranked unexplained-stale >
  // explained-stale > unknown > fine — same "show the thing that most
  // needs attention" reasoning the Data tab's own worst-of-tier rollup uses.
  // Per-source rows (definition + this source's own last-sync time) are
  // rendered separately below so a multi-source badge doesn't collapse
  // each source's real identity/timestamp into one blended line.
  const RANK = { "unexplained-stale": 3, "explained-stale": 2, unknown: 1, fine: 0 };
  let worstStatus = "fine";
  let anyError = null;
  const perSource = keys.map((key) => {
    const row = bySourceKey[key];
    const status = chartStatus(row, row?.expected_interval_s);
    if (RANK[status] > RANK[worstStatus]) worstStatus = status;
    if (status === "unexplained-stale" && row?.last_attempt_status === "error") {
      anyError = row.last_error ?? anyError;
    }
    return { key, row, status };
  });

  function handleRefresh(e) {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    Promise.all(keys.map((k) => fetch(`/api/health/refresh/${k}`, { method: "POST" })))
      .then(refresh)
      .finally(() => setRefreshing(false));
  }

  return (
    <span className="chart-staleness chart-staleness--marker" onClick={(e) => e.stopPropagation()}>
      <span
        className={`chart-staleness-glyph chart-staleness-glyph--${worstStatus}`}
        tabIndex={0}
      >
        ⓘ
      </span>
      <span className="chart-staleness-popover">
        {label && <div className="chart-staleness-popover-label">{label}</div>}
        {perSource.map(({ key, row }) => {
          const def = SOURCE_DEFINITIONS[key];
          return (
            <div className="chart-staleness-popover-source" key={key}>
              <div className="chart-staleness-popover-source-name">{def?.label ?? key}</div>
              {def?.definition && <div className="chart-staleness-popover-row">{def.definition}</div>}
              <div className="chart-staleness-popover-row">
                {row?.last_success_at ? `Last synced ${timeAgo(row.last_success_at)}` : "No successful fetch yet"}
              </div>
            </div>
          );
        })}
        {worstStatus === "explained-stale" && (
          <div className="chart-staleness-popover-row">No new data yet — expected, per this source's own cadence.</div>
        )}
        {anyError && <div className="chart-staleness-popover-row chart-staleness-popover-error">{anyError}</div>}
        {detail &&
          (Array.isArray(detail) ? detail : [detail]).map((line, i) => (
            <div className="chart-staleness-popover-row" key={i}>{line}</div>
          ))}
        <button
          type="button"
          className="data-refresh-btn chart-staleness-refresh"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </span>
    </span>
  );
}
