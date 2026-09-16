// Shared date helpers for cross-chart pin behavior.

// The canonical "pin-snap" variant of AV's nearest-date conventions (see
// CLAUDE.md's Cross-cutting data conventions section): nearest real row
// date on/before pinnedDate, falling back to the nearest row after it if
// the pin predates that chart's own data. Needed because Recharts'
// category-axis ReferenceLine only renders when its x= value exists
// verbatim in that chart's own dataset — each chart snaps a shared
// pinnedDate onto its own date grid before drawing the line, so a pin set
// by clicking one chart still appears on charts with different date grids
// (weekly vs. daily vs. monthly-resampled) at the closest date each one
// actually has, rather than not at all.
export function nearestRowDate(rows, pinnedDate) {
  if (!rows || rows.length === 0 || !pinnedDate) return null;
  let best = null;
  for (const row of rows) {
    if (row.date <= pinnedDate) best = row.date;
  }
  if (best != null) return best;
  return rows[0]?.date ?? null;
}

// Evenly-spaced subset of a series' `date` values for a Recharts category
// X-axis, capped at maxTicks — the exact date is already on the tooltip,
// so a chart never needs a tick per row. The `|| 1` guards a series
// shorter than maxTicks (where Math.floor(len/n) would be 0 → i % 0 is
// NaN → zero ticks rendered). Was independently defined three times
// (comex_inventory.jsx, money_supply_shared.js, an inline copy in
// silver_cot_tracker.jsx's CombinedChart) before this consolidation.
export function xTicks(data, maxTicks = 8) {
  if (!data || data.length === 0) return [];
  const n = Math.min(data.length, maxTicks);
  const step = Math.floor(data.length / n) || 1;
  return data.filter((_, i) => i % step === 0).map((r) => r.date);
}
