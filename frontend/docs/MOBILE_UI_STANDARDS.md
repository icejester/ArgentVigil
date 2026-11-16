# Mobile UI Standards

Companion to `UI_STANDARDS.md` (desktop). Governs the mobile view specified in `specs/mobile-spec.md`. Where this doc is silent, `UI_STANDARDS.md` applies. Where they conflict, this doc wins on mobile only.

**This is a living doc.** Every UI decision made while building mobile is recorded here in the same change that makes it, with the reason. A decision that exists only in a component is a decision the next session can't see. Each entry carries the date and, where it came from the user, says so.

Status key: **Decided** (user or spec made the call), **Default** (Claude's choice, awaiting review in use), **Open** (not yet decided).

---

## 1. View selection and shell

- **Decided (2026-11-15)** — Mobile opens automatically under about 720px wide. A "Desktop site" link switches to desktop, and "Mobile site" switches back. The choice is remembered per device (spec G3).
- **Decided** — The mobile shell is separate from desktop. It is not the desktop layout in a narrower column (spec Section 1).
- **Decided** — A persistent header shows silver and gold spot on every screen, plus the pinned-date chip when a date is pinned (spec G1, G5).
- **Default (2026-11-15, built)** — Navigation is a fixed bottom bar with four labeled buttons (Trading, Inventory, Money, Stack), 56px tall, safe-area aware. The active panel has a top accent and `aria-current`. A panel is mounted on first visit, then kept hidden, so its drill screen and window choice survive switching panels.
- **Default** — The header is sticky: brand, Ag/Au spot with 24h change (60s refresh), and the pin chip on its own line when a date is pinned.
- **Default** — The "Desktop site" link sits in the mobile footer; "Mobile site" sits in the desktop header subtitle. Each view is its own lazy bundle.

## 2. Information structure

- **Decided** — Glance, then drill. A panel's first screen is a short list of rows. Detail is one tap away, never on the first screen.
- **Decided** — One series per chart. Multi-axis desktop charts become one row and one drill chart per series.
- **Decided** — Every value carries its as-of date.
- **Decided** — Standing caveats travel with the data (TIC custodial bias, Operational Flow gap, bank charter district, correlation-only).
- **Decided** — Default windows: long-range series since 2000, near-term series 45 days. The 45-day figure is arbitrary and will be tuned after use.

## 3. Charts

- **Decided (2026-11-15, user)** — No Recharts on mobile. Charts are small purpose-built SVG components (spec G4).
- **Decided** — Sparklines in glance rows are plain inline SVG with no interaction. Drill charts load only when a row is opened.
- **Decided** — Supported marks: line, bar, step; shaded bands; annotation markers; touch crosshair with value and date readout.
- **Decided** — Missing values are gaps, never drawn zeros.
- **Decided** — Each panel keeps its existing window button set. Mobile adds `45D` only where a story names 45 days.
- **Default (built)** — Every tappable control is at least 44px tall (segment buttons also 44px wide, glance rows 64px, back button 44px). Drill charts fill the width, 220px tall. Confirm on a real phone.
- **Default (built)** — Charts use a true time X axis, four evenly spaced X labels (year labels when the span exceeds ~400 days, otherwise YY-MM) and about four nice Y ticks. Y values use compact units (T, B, M, K).
- **Default (built)** — Several series on one chart only where the spec names it (Fed vs. M2, purchasing power, SOMA vs. derived net, bank assets vs. SOMA). Those charts get a legend row of swatch plus name above the chart, and one readout line per series. The second SOMA line is dashed, so color is not the only distinction.
- **Default (built)** — Amber is used for the shaded divergence bands, annotation markers and flagged delivery days. Pinned-date markers are blue and dashed. Both are described in text near the chart.

## 4. Interaction

- **Decided (2026-11-15, user)** — Mobile supports the global pinned date. Touch a point, then tap "Pin this date" in the readout. Tapping the pinned date again clears it. The header chip also clears it (spec G5).
- **Decided** — Drill charts mark the pinned date using the existing pin-snap rule. Glance rows stay on the latest value.
- **Decided** — The vault breakdown keeps the exact-match rule: no snapshot for the pinned date shows a message, not a nearby date.
- **Decided** — Hover has no meaning on touch. Tooltip content that desktop shows on hover is shown in the readout under the chart, using the same content function.
- **Decided (built)** — Single-series charts have no legend: the screen title names the series and the readout repeats it.
- **Default (built)** — The readout sits under the chart, always visible when a date is touched or pinned, using one function for both. Touch and drag scrub the date; the chart only claims horizontal gestures, so vertical scroll still works. "Pin this date" and "Close" are 44px buttons in the readout.
- **Default (built)** — Windows are a horizontally scrollable segmented row. Money uses preset years plus a typed "Since" date, with "Since 2000" selected on load.
- **Default (built)** — A long-range series that starts after the chosen date begins at its first real date and says so ("Data for this series begins ...").

## 5. Color

- **Decided** — Green means favorable and red unfavorable, as on desktop, except where noted.
- **Decided (2026-11-15)** — Stack's average-cost change is neutral (arrow and number, no green or red). Desktop's DCA strip inverts green and red on purpose. Mobile does not carry that over, so one color never has two meanings. Only "this purchase today" is colored.
- **Decided** — Color is never the only signal. A sign, arrow or word accompanies every colored value.
- **Default** — Use the existing palette. Chart line colors reuse hues already in the app (`#7b9fff`, `#e0c14c`, `#5aa9e6`, `#e05252`, `#4caf76`, `#919bb0`). **Not yet validated** against `#141820` with the dataviz validator; do that before adding a new hue or a chart with more than four series.
- **Decided (built)** — Gains and losses use `#4caf76` / `#e05252` with a sign (+/−, ▲/▼) beside every colored number, so color is never the only signal.

## 6. Copy

- **Decided** — AV Voice Rules apply unchanged: descriptive only, no prediction, no "alarming" or "critical" framing, no targets.
- **Decided** — Percentile lines are descriptive, for example "82nd percentile, 1Y".
- **Decided** — Nulls show "—". A partial sum is never shown as a total (Stack shows "—" for a purchase date where any row has no price).
- **Decided (built)** — Negative numbers use a true minus sign (−). Money shown compactly uses $T, $B, $M; per-ounce and per-share figures keep cents.
- **Decided (built)** — Mechanism card 2 no longer states a fixed "1.9x"; the SOMA screen computes the ratio from the current data instead.
- **Decided (built)** — Every glance row shows "as of" with the series' own latest date. Panel headers add "synced N ago" from the shared health poll. ChartStaleness' hover popover is not used (no hover on touch).

## 7. Decision log

Append one line per decision. Format: date, area, decision, who, reason.

| Date | Area | Decision | Source | Reason |
|---|---|---|---|---|
| 2026-11-15 | Shell | Auto narrow-viewport switch with a per-device override | User | Tablets may want desktop |
| 2026-11-15 | Charts | Custom SVG, no Recharts | User | Recharts is heavy on desktop already |
| 2026-11-15 | Pin | Global pinned date supported on mobile | User | Shared with desktop |
| 2026-11-15 | Stack | Average-cost change shown neutral | Claude, spec v2.3 | Avoids a second meaning for green and red |
| 2026-11-15 | Nav | Fixed bottom bar, four buttons, panels stay mounted | Claude (default) | Thumb reach; keeps drill state |
| 2026-11-15 | Touch | 44px minimum targets, 220px drill charts | Claude (default) | Platform guidance; unverified on device |
| 2026-11-15 | Charts | Multi-line only where the spec asks; legend row plus dashed second line | Claude (default) | Color is never the only distinction |
| 2026-11-15 | Pin | Header chip clears; vault snapshot keeps exact-match | User (G5), Claude (details) | Matches desktop rule |
| 2026-11-15 | Money | "Since 2000" is a Custom range selected on load, plus 2Y/5Y/10Y/20Y presets | Spec Appendix B | Longer than the 20Y button |
| 2026-11-15 | Money | Divergence bands = quarters where Fed and M2 moved in opposite directions | Claude (default) | Descriptive, not a signal |
| 2026-11-15 | Copy | Mechanism card 2 drops the fixed 1.9x | Claude | The ratio changes; the app computes it |
| 2026-11-15 | Perf | gzip for JSON in nginx; SOMA read with a future `since` | Claude | 2 MB and 4 MB payloads on a phone |
| 2026-11-16 | Header | Ag/Au cells show price, change over the last 6H from real ticks, and a sparkline; tap opens a tick chart with 6H/24H/7D | User, Claude (details) | Match desktop HeaderTicker; spot 24h% was less useful than recent movement |
| 2026-11-16 | Trading | Lead with a current-session high/low range bar and a session tick chart; leverage, curve spread, volume and daily range move into a collapsed card | User | The positioning rows were low value on a phone |
| 2026-11-16 | Trading | Session = since the 22:00 UTC Globex reopen; on a closure the last real session is shown and labeled | Claude (default) | Same boundary as the spot persist-skip rule |
| 2026-11-16 | Inventory | Vault rows replaced by a pie of share by vault (Total/Registered/Eligible) plus a movement list over a chosen window | User | Day-over-day vault deltas were nearly all zero |
| 2026-11-16 | Inventory | Pie names the top 7 vaults, the rest fold into one gray Other; legend carries share, oz and change | Claude (default) | Validated 8-hue palette, color never the only channel |
| 2026-11-16 | Windows | Inventory and Delivery behavior add 1W, 2W and 30D to 45D/3M/6M/All; vault movement defaults to 30D | User | Shorter looks at delivery behavior |

