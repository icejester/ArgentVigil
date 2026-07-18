# ArgentVigil UI Standards

Cross-cutting interaction/visual conventions for interactive elements (legends, tooltips,
clickable chart series, etc.) — distinct from `CLAUDE.md`, which documents *what exists
per tab*, not *how interactive elements should generally behave*. New interactive UI should
be checked against this doc; deviations are fine when there's a real reason, but should be
a deliberate choice, not an accident of not knowing the standard existed.

Established by observing/generalizing the concrete decisions made building the Money Supply
tab's Composition and M2/WALCL chart legends — see `CLAUDE.md`'s Tab: Money Supply section
for the full blow-by-blow of how each decision below was arrived at (including the bugs that
motivated some of them).

---

## 1. Legends

**Shape**: horizontal, compact swatch + label rows. Not a vertical stack of full-sentence
prose. Classes: `comex-legend-list comex-legend-list--horizontal`, `comex-legend-item`,
`legend-btn-row` (see `index.css`).

**Interaction is click, not hover.**
- Native HTML `title=` attributes are **disallowed** for legend detail text — confirmed
  unreliable in practice (long hover delay, easy to miss the trigger area, doesn't work well
  layered over SVG/chart content).
- Clicking a legend row toggles a detail panel (below the legend, not floating) showing that
  item's full explanation. Clicking the same row again closes it.
- Only one item's detail is open at a time (single piece of "clicked key" state per legend,
  not a per-row boolean map).

**Clicking a legend row must do two things together, not just one:**
1. Open/close that item's detail panel.
2. Highlight that item **on the chart** — dim the other series/slices, and make the clicked
   one visually prominent (thicker stroke, fuller fill opacity, or a light outline on a pie
   slice). A legend that only opens a text panel without any chart-side feedback is
   incomplete.

**Data shape**: each legend entry is an object carrying at minimum `key`, a short
`legendLabel` (no jargon/acronyms — acronyms belong in the chart's own tooltip/axis, not the
legend, unless the acronym IS the label people know it by) and a full explanation field
(`eli5` in current code) for the click-revealed detail. Keep this as a single array-of-objects
per chart (e.g. `COMPOSITION_SERIES`, `M2_LEGEND_SERIES`) rather than scattering the same
labels/colors across multiple JSX blocks — one source of truth for label text, color, and
detail copy.

**Always show every relevant item**, not just whichever currently has a nonzero/visible
value. A legend that silently drops an item because its current value happens to be ~0 reads
as a bug, not a feature (confirmed: this exact thing happened and was reported as one).

## 2. Tooltips (hover + pinned)

**One tooltip-content function, two triggers.** Extract tooltip content into a standalone
function component (e.g. `XyzTooltipContent({ active, label, ...data })`) called from both:
- The live Recharts `<Tooltip content={...}>` (hover-driven), and
- A "pinned" box rendered below the chart when a date is pinned/clicked elsewhere in the
  panel (same component, `active` forced `true`, `label` set to the pinned/snapped date).

Never duplicate the same tooltip markup once for hover and again for pinned display — if the
content needs to change, it should change in exactly one place.

**Detail level**: prefer showing the full breakdown, not just a rolled-up total, when a
tooltip is describing a composite/grouped figure. If a chart has a "total assets" and "total
liabilities" style rollup, the tooltip should also list the individual line items that sum to
each rollup, not just the two totals with no further breakdown.

**Long text**: if tooltip/detail copy uses `\n\n` for paragraph breaks, the container needs
`white-space: pre-wrap` (not the default, not `pre-line` — see `.comex-panel-note--eli5` in
`index.css`) or the breaks silently collapse.

## 3. Color convention

- **Green (`WIN_COLOR`, `#4caf76`)** = assets / positive / favorable — growth, "win" side of
  a ratio, the side of a balance sheet the entity owns.
- **Red (`LOSS_COLOR`, `#e05252`)** = liabilities / negative / unfavorable — contraction,
  "loss" side of a ratio, the side of a balance sheet the entity owes.

Apply this **consistently across every representation of the same data** — a summary badge,
a detailed tooltip breakdown, and a chart legend should all use the same color for "this is
the assets side" rather than each picking an arbitrary distinct color per series. Individual
series within a group may still get their own distinct *shade* for visual distinction (e.g.
`WRESBAL_COLOR`/`RRPONTSYD_COLOR` are both reddish but different exact hues), but the
group-level color/badge/ratio-threshold coloring should not drift from green=assets/
red=liabilities once established for a given chart.

**Threshold-based coloring** (e.g. a ratio crossing some meaningful value): pick one clear
threshold, document why that number, and apply green/red consistently above/below it rather
than a gradient or multiple bands unless there's a real reason for more granularity.

## 4. Sizing / layout

- Don't let a fixed-aspect-ratio element (a circle, a square icon) sit inside a
  `width="100%"` responsive container sized for a different kind of chart (a wide line/area
  chart) — it leaves dead space. Give fixed-shape elements their own capped container size.
- When two elements are conceptually paired (e.g. a line chart and the pie summarizing the
  same data), prefer a side-by-side flex layout over stacking them in separate full-width
  rows, if there's room — this uses the width both elements actually need instead of two
  mostly-empty full-width rows.
- Chart x-axis tick counts should scale down when a chart's available width shrinks (e.g.
  because it now shares a row with another element) — a fixed tick count tuned for full width
  will overlap/bleed once the container narrows. `xTicks(data, maxTicks)` in
  `money_supply.jsx` takes an explicit override for this.

## 5. Removing dead UI

When a toggle/mode is removed from the UI (not just hidden), remove its entire code path —
state, the branches that only existed to serve it, any props threaded through solely for its
benefit — rather than leaving it unreachable-but-present. Confirmed via `grep` that the
relevant state/prop name has zero remaining references before considering the removal done.
