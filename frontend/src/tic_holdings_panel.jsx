import { useState, useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  ReferenceLine,
} from "recharts";
import { VAULT_COLORS } from "./palette";
import { nearestRowDate } from "./date_utils";
import ChartStaleness from "./chart_staleness";
import { usePinnedDate } from "./pinned_date_context";
import { xTicks, fmtTrillions, RATIO_COLOR } from "./money_supply_shared";

// Extracted from money_supply.jsx (cleanup-spec.md Stage 3.5). Foreign
// Holdings of U.S. Treasuries (TIC) — a 14-country stacked-area chart plus
// a companion "who's biggest now" pie. Its data (tic_countries /
// tic_grand_total) comes back inside the tab's shared
// /api/fred/money-supply/db response, so it's passed in as props rather
// than fetched here — the panel-wide window selector still governs it.

// TIC_COUNTRY_ORDER fixes a stable ranking (largest real 2026-05 holders
// first) so a country's assigned color/legend position doesn't reshuffle
// as values change month to month — same "fixed ranking, not re-ranked per
// period" reasoning as topAgenciesByLatestMonth. Grand Total is NOT one of
// these countries (its own tic_grand_total field, excluded here).
const TIC_COUNTRY_ORDER = [
  "Japan", "China", "United Kingdom", "Belgium", "Cayman Islands", "Luxembourg",
  "Canada", "Total Caribbean", "Taiwan", "Ireland", "Switzerland", "Hong Kong",
  "India", "Turkey",
];
const TIC_COUNTRY_COLOR = Object.fromEntries(
  TIC_COUNTRY_ORDER.map((country, i) => [country, VAULT_COLORS[i % VAULT_COLORS.length]])
);
const TIC_GRAND_TOTAL_COLOR = "#e8ecf4";

// data.tic_countries is { country: [{date, value_trillions}] };
// data.tic_grand_total is the same shape as one more series. Merged into
// one flat per-date row (same date-key merge as mergeYields) so all
// countries + grand total share one chart's x-axis.
function mergeTicHoldings(ticCountries, ticGrandTotal) {
  const byDate = {};
  for (const country of TIC_COUNTRY_ORDER) {
    for (const r of ticCountries?.[country] || []) {
      byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, [country]: r.value_trillions };
    }
  }
  for (const r of ticGrandTotal || []) {
    byDate[r.date] = { ...(byDate[r.date] || {}), date: r.date, grand_total: r.value_trillions };
  }
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Hover tooltip — only currently-visible countries plus grand total,
// sorted largest-first at that date so the ranking reads at a glance
// rather than being fixed by TIC_COUNTRY_ORDER's latest-month ranking
// (which can differ from a hovered historical date's real ranking).
function TicHoldingsTooltipContent({ active, label, ticMerged, hiddenCountries, soloCountry }) {
  if (!active || !label) return null;
  const row = ticMerged.find((r) => r.date === label);
  if (!row) return null;
  const countryRows = (soloCountry ? [soloCountry] : TIC_COUNTRY_ORDER)
    .filter((c) => (soloCountry || !hiddenCountries.has(c)) && row[c] != null)
    .map((c) => ({ name: c, value: row[c], color: TIC_COUNTRY_COLOR[c] }))
    .sort((a, b) => b.value - a.value);
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {row.grand_total != null && (
        <div style={{ color: TIC_GRAND_TOTAL_COLOR, fontWeight: 600, marginBottom: 2 }}>
          Grand Total (LT only): {fmtTrillions(row.grand_total)}
        </div>
      )}
      {countryRows.map((c) => (
        <div key={c.name} style={{ color: c.color }}>
          {c.name}: {fmtTrillions(c.value)}
        </div>
      ))}
    </div>
  );
}

export default function TicHoldingsPanel({ ticCountries, ticGrandTotal }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [hiddenTicCountries, setHiddenTicCountries] = useState(() => new Set());
  // soloCountry is a SOLO selector (replaced the old clickedTicKey
  // dim/highlight): clicking a country in the legend (or pie) hides every
  // other country, switches the chart
  // from a 14-band stacked area to a single line for that one country, and
  // lets the Y-axis auto-scale to its real range — so the actual
  // month-to-month variation (invisible at the full stacked scale) becomes
  // legible. Clicking the same row again, or "Show all", restores the
  // stacked view. The per-country checkboxes still do manual multi-select
  // when nothing is soloed. Requested by the user 2026-09: "instead of
  // dimming the others, the other nations should disappear and the scale
  // change to show real variance."
  const [soloCountry, setSoloCountry] = useState(null);
  const { pinnedDate, togglePinnedDate } = usePinnedDate();

  const ticMerged = useMemo(
    () => (ticCountries || ticGrandTotal ? mergeTicHoldings(ticCountries, ticGrandTotal) : []),
    [ticCountries, ticGrandTotal]
  );
  const ticTicks = useMemo(() => xTicks(ticMerged), [ticMerged]);

  return (
    <details className="collapsible-pane" open={panelOpen} onToggle={(e) => setPanelOpen(e.target.open)}>
      <summary className="collapsible-pane-title">
        <ChartStaleness sourceKey="money_supply" />
        <span>Foreign Holdings of U.S. Treasuries</span>
        {ticMerged.length > 0 && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {(() => {
              const row = pinnedDate ? ticMerged.find((r) => r.date === nearestRowDate(ticMerged, pinnedDate)) : ticMerged[ticMerged.length - 1];
              if (!row) return null;
              const top = TIC_COUNTRY_ORDER.filter((c) => row[c] != null).sort((a, b) => row[b] - row[a])[0];
              return (
                <>
                  {row.date}
                  {row.grand_total != null && ` · Grand Total (LT) ${fmtTrillions(row.grand_total)}`}
                  {top && ` · Top: ${top} ${fmtTrillions(row[top])}`}
                </>
              );
            })()}
          </span>
        )}
      </summary>
      {panelOpen && (
        <div className="collapsible-pane-body">
          <div className="comex-panel-note">
            Which countries hold how much U.S. Treasury debt, over time — FRED's own ingestion of
            Treasury's TIC (Treasury International Capital) data. <strong>Long-term Treasuries
            only — excludes T-bills entirely.</strong> Treasury's own separately-published Major
            Foreign Holders total (bills-inclusive) runs meaningfully higher than the grand total
            this data represents; the two are not interchangeable. "Cayman Islands" is a real subset
            of "Total Caribbean," not a duplicate — both are shown, but summing them would
            double-count.
          </div>
          {ticMerged.length > 0 ? (
            <div className="comex-vault-pie-row">
              {soloCountry && (
                <div className="comex-panel-note comex-panel-note--eli5" style={{ marginBottom: 8 }}>
                  Showing <strong>{soloCountry}</strong> only, Y-axis auto-scaled to its own range so
                  month-to-month variation is visible. Click <strong>{soloCountry}</strong> in the legend
                  again, or “Show all”, to return to the full stacked view.
                  <button
                    className="comex-range-btn"
                    style={{ marginLeft: 10 }}
                    onClick={() => setSoloCountry(null)}
                  >
                    Show all
                  </button>
                </div>
              )}
              {(() => {
                const pinnedDateTic = nearestRowDate(ticMerged, pinnedDate);
                // Pin > hover > latest, same priority rule as every other pie in this panel.
                const ticPieDate = pinnedDate ? pinnedDateTic : ticMerged[ticMerged.length - 1]?.date;
                const ticPieRow = ticMerged.find((r) => r.date === ticPieDate) ?? null;
                // In solo mode the pie is a single-slice "this country" view;
                // otherwise the normal visible-countries breakdown.
                const ticPieData = !ticPieRow
                  ? []
                  : soloCountry
                    ? (ticPieRow[soloCountry] != null && ticPieRow[soloCountry] > 0
                        ? [{ key: soloCountry, name: soloCountry, value: ticPieRow[soloCountry], color: TIC_COUNTRY_COLOR[soloCountry] }]
                        : [])
                    : TIC_COUNTRY_ORDER
                        .filter((c) => !hiddenTicCountries.has(c) && ticPieRow[c] != null && ticPieRow[c] > 0)
                        .map((c) => ({ key: c, name: c, value: ticPieRow[c], color: TIC_COUNTRY_COLOR[c] }));
                return (
                  <>
                    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 420px", minWidth: 0 }}>
                        <ResponsiveContainer width="100%" height={280}>
                          <ComposedChart data={ticMerged} margin={{ top: 4, right: 20, left: 12, bottom: 4 }} onClick={(state) => {
                            if (state?.activeLabel) togglePinnedDate(state.activeLabel);
                          }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                            <XAxis dataKey="date" ticks={ticTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
                            <YAxis
                              // Solo mode: auto-scale to the one country's real range
                              // (the whole point of soloing). Full mode: from 0, so
                              // the stacked bands read as absolute magnitudes.
                              domain={soloCountry ? ["auto", "auto"] : [0, "auto"]}
                              tickFormatter={(v) => `$${v.toFixed(soloCountry ? 2 : 1)}T`}
                              tick={{ fill: "#8a94a6", fontSize: 11 }}
                              label={{ value: "Trillions USD", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
                            />
                            <Tooltip content={<TicHoldingsTooltipContent ticMerged={ticMerged} hiddenCountries={hiddenTicCountries} soloCountry={soloCountry} />} />
                            {pinnedDateTic && <ReferenceLine x={pinnedDateTic} stroke={RATIO_COLOR} strokeDasharray="3 3" />}
                            {soloCountry ? (
                              <Line
                                type="monotone"
                                dataKey={soloCountry}
                                name={soloCountry}
                                stroke={TIC_COUNTRY_COLOR[soloCountry]}
                                strokeWidth={2}
                                dot={false}
                                connectNulls
                                isAnimationActive={false}
                              />
                            ) : (
                              /* Stack order highest-to-lowest at the pinned/hovered/latest date.
                                 Recharts tracks each Area's stack position by React key at mount
                                 time, NOT by current JSX child order — so each Area's key is
                                 pinned to a stable SLOT index and the country its dataKey/color
                                 renders is what changes. Hidden countries dropped before ranking. */
                              (() => {
                                const visible = TIC_COUNTRY_ORDER.filter((c) => !hiddenTicCountries.has(c));
                                const ranked = ticPieRow
                                  ? [...visible].sort((a, b) => (ticPieRow[b] ?? 0) - (ticPieRow[a] ?? 0))
                                  : visible;
                                return ranked.map((c, slot) => (
                                  <Area
                                    key={`slot-${slot}`}
                                    type="monotone"
                                    dataKey={c}
                                    name={c}
                                    stackId="tic-holdings"
                                    stroke={TIC_COUNTRY_COLOR[c]}
                                    fill={TIC_COUNTRY_COLOR[c]}
                                    strokeWidth={1}
                                    fillOpacity={0.65}
                                    connectNulls
                                  />
                                ));
                              })()
                            )}
                          </ComposedChart>
                        </ResponsiveContainer>
                        {pinnedDateTic && (
                          <div style={{ marginTop: 4 }}>
                            <TicHoldingsTooltipContent active label={pinnedDateTic} ticMerged={ticMerged} hiddenCountries={hiddenTicCountries} soloCountry={soloCountry} />
                          </div>
                        )}
                      </div>

                      {/* Companion pie — a 14-country line chart alone is illegible with every
                          series drawn at once; the pie makes "who's biggest right now" legible
                          for whatever date is pinned/hovered. */}
                      <div style={{ flex: "0 0 180px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <ResponsiveContainer width={180} height={180}>
                          <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                            <Pie
                              data={ticPieData}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              outerRadius={70}
                              innerRadius={36}
                              paddingAngle={1}
                              onClick={(entry) => setSoloCountry((k) => (k === entry.key ? null : entry.key))}
                              style={{ cursor: "pointer" }}
                            >
                              {ticPieData.map((entry) => (
                                <Cell key={entry.key} fill={entry.color} />
                              ))}
                            </Pie>
                            <Tooltip
                              contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
                              formatter={(v, name) => [fmtTrillions(v), name]}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                        {ticPieRow?.date && (
                          <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                            As of {ticPieRow.date}
                            {ticPieRow.grand_total != null && (
                              <>
                                <br />
                                Grand Total (LT): {fmtTrillions(ticPieRow.grand_total)}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()}
              <div className="comex-legend-list comex-legend-list--horizontal">
                {TIC_COUNTRY_ORDER.map((c) => {
                  const dimmed = soloCountry && soloCountry !== c;
                  return (
                    <div key={c} className="metals-legend-row" style={dimmed ? { opacity: 0.3 } : undefined}>
                      <input
                        type="checkbox"
                        className="metals-legend-checkbox"
                        checked={!hiddenTicCountries.has(c)}
                        disabled={!!soloCountry}
                        onChange={() =>
                          setHiddenTicCountries((prev) => {
                            const next = new Set(prev);
                            if (next.has(c)) next.delete(c);
                            else next.add(c);
                            return next;
                          })
                        }
                        title={
                          soloCountry
                            ? "Checkboxes are disabled while one country is soloed"
                            : hiddenTicCountries.has(c)
                              ? "Show this country"
                              : "Hide this country"
                        }
                      />
                      <button
                        className={`comex-legend-item legend-btn-row${soloCountry === c ? " legend-btn-row--baseline" : ""}`}
                        onClick={() => setSoloCountry((k) => (k === c ? null : c))}
                        title={soloCountry === c ? `Show all countries again` : `Show only ${c}, auto-scaled`}
                      >
                        <span className="comex-legend-swatch" style={{ background: TIC_COUNTRY_COLOR[c] }} />
                        <span>
                          <strong>{c}</strong>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="comex-empty">
              No data available.
              <div className="comex-empty-note">Requires FRED_API_KEY — hit Refresh on the panel above, or run the refresh endpoint once to seed the database.</div>
            </div>
          )}
          <div className="comex-panel-note" style={{ marginTop: 8 }}>
            Source: FRED's own ingestion of U.S. Treasury's TIC (Treasury International Capital)
            data — FORLTTREASPOS* series, monthly, real coverage from 1984-12 for most countries
            (Belgium/Luxembourg/Cayman Islands from ~2001, a real TIC reporting-category change).
            Country codes are TIC's own, looked up from Treasury's published country-code table,
            not derived from ISO codes.
          </div>
        </div>
      )}
    </details>
  );
}
