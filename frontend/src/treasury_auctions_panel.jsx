import { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { nearestRowDate } from "./date_utils";
import ChartStaleness from "./chart_staleness";
import { usePinnedDate } from "./pinned_date_context";
import { xTicks, round1, RATIO_COLOR } from "./money_supply_shared";

// Extracted from money_supply.jsx (cleanup-spec.md Stage 3.5). Treasury
// Auctions — bid-to-cover by security type + buyer-category mix per real
// settled auction. Its data comes from its OWN fetch (/api/treasury-auctions/db
// has no window param — a rolling ~120-day trailing window), independent of
// the tab's panel-wide window_ state, which is why it was the cleanest of
// the three panels to pull out.

// Security types get their own distinct colors (the bid-to-cover chart
// plots several on one shared axis); buyer categories get a separate
// palette (the %-stacked mix chart only ever shows one security type at a
// time, so its 4 categories needn't be distinct from the type colors).
const AUCTION_SECURITY_TYPES = ["Bill", "Note", "Bond", "TIPS", "FRN"];
const AUCTION_TYPE_COLOR = {
  Bill: "#7b9fff",
  Note: "#4caf76",
  Bond: "#e0a84c",
  TIPS: "#a78bfa",
  FRN: "#f472b6",
};
// What each security type actually is — shown as click-revealed gray text
// below the bid-to-cover legend (same convention as the CoT / Money Supply
// legends' eli5). Descriptive, per AV Voice Rules — no view on which is a
// "better" instrument.
const AUCTION_TYPE_DEFS = {
  Bill: "Treasury Bill — matures in one year or less (4, 8, 13, 17, 26, or 52 weeks). Sold at a discount to face value and pays no coupon; the return is the difference between the discounted purchase price and the face value paid at maturity.",
  Note: "Treasury Note — 2, 3, 5, 7, or 10-year maturity. Pays a fixed coupon every six months. The 10-year note is the most-watched benchmark for medium-term U.S. borrowing costs.",
  Bond: "Treasury Bond — the longest maturities, 20 or 30 years. Fixed semi-annual coupon. Most sensitive of the fixed-coupon types to changes in long-term rate expectations.",
  TIPS: "Treasury Inflation-Protected Securities — 5, 10, or 30-year. The principal is adjusted with CPI, so the fixed coupon rate is paid on an inflation-adjusted balance; at maturity you receive the greater of the adjusted or original principal. The gap between a TIPS yield and a same-maturity nominal note yield is the market's implied inflation ('breakeven').",
  FRN: "Floating Rate Note — 2-year. The coupon is not fixed: it resets weekly to the most recent 13-week Bill auction rate plus a fixed spread set at the FRN's own auction. The only Treasury security with a coupon that moves with short-term rates.",
};
const AUCTION_BUYER_COLORS = {
  primary_dealer: "#7b9fff",
  indirect_bidder: "#4caf76",
  direct_bidder: "#e0a84c",
  soma: "#e05252",
};
const AUCTION_BUYERS = [
  { key: "primary_dealer", label: "Primary Dealers" },
  { key: "indirect_bidder", label: "Indirect Bidders" },
  { key: "direct_bidder", label: "Direct Bidders" },
  { key: "soma", label: "SOMA (the Fed)" },
];

// One row per real settled auction (bid_to_cover_ratio non-null — an
// announced-but-unsettled row has every result field null, per the standing
// nulls-over-zeros convention). buyer_mix_pct computed here at read time
// (not persisted) as each category's share of total_accepted. Flat
// per-auction list (several rows can share a date — multiple security types
// auction the same day); used by the buyer-mix chart (filtered to one type,
// so no ambiguity) and by AuctionsTooltipContent (which looks up ALL rows
// for a hovered date). NOT used directly as chart `data` for the multi-type
// bid-to-cover chart — see mergeAuctionsByType for why.
function mergeAuctions(rows) {
  return (rows || [])
    .filter((r) => r.bid_to_cover_ratio != null)
    .map((r) => {
      const total = r.total_accepted;
      const pct = (v) => (v != null && total ? round1((v / total) * 100) : null);
      return {
        date: r.auction_date,
        cusip: r.cusip,
        security_type: r.security_type,
        security_term: r.security_term,
        bid_to_cover_ratio: r.bid_to_cover_ratio,
        high_yield: r.high_yield,
        primary_dealer_pct: pct(r.primary_dealer_accepted),
        indirect_bidder_pct: pct(r.indirect_bidder_accepted),
        direct_bidder_pct: pct(r.direct_bidder_accepted),
        soma_pct: pct(r.soma_accepted),
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Pivots the flat per-auction list into one row per real date, each
// security type its own column (bid_to_cover_ratio keyed by type) — the
// same "one row per date, one column per series" shape every other
// multi-line chart uses. Replaces a real bug where each <Line> got its own
// filtered data={auctionsByType[t]} array while the chart shared a
// different data array: Recharts positions a category-axis point by that
// SERIES' own array index/date, not a globally shared position, so two
// types' points landed at mismatched x-positions even on matching real
// dates. Rows with only one type auctioned that day get every other type's
// column as null, which Line's connectNulls handles as a real gap.
function mergeAuctionsByType(auctionRows) {
  const byDate = {};
  for (const r of auctionRows) {
    const row = (byDate[r.date] ??= { date: r.date });
    row[r.security_type] = r.bid_to_cover_ratio;
  }
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Bid-to-cover chart's hover tooltip — more than one real auction can share
// a date (a Bill and a Note auctioned the same day are both real, distinct
// rows), so this looks up ALL rows for the hovered date rather than find()ing one.
function AuctionsTooltipContent({ active, label, auctionsMerged }) {
  if (!active || !label) return null;
  const rows = auctionsMerged.filter((r) => r.date === label);
  if (!rows.length) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>{label}</div>
      {rows.map((r) => (
        <div key={r.cusip} style={{ color: AUCTION_TYPE_COLOR[r.security_type] ?? "#c8d0de", marginBottom: 2 }}>
          {r.security_type} ({r.security_term}): {r.bid_to_cover_ratio.toFixed(2)}x bid-to-cover
          {r.high_yield != null && `, ${r.high_yield.toFixed(2)}% yield`}
        </div>
      ))}
    </div>
  );
}

// Buyer-mix %-stacked chart's tooltip — single security type at a time, so
// a plain find() by date is correct here.
function AuctionMixTooltipContent({ active, label, rows, hiddenBuyers }) {
  if (!active || !label) return null;
  const row = rows.find((r) => r.date === label);
  if (!row) return null;
  return (
    <div style={{ background: "#1a1f2b", border: "1px solid #2e3547", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ color: "#c8d0de", marginBottom: 4 }}>
        {label} ({row.security_term})
      </div>
      {AUCTION_BUYERS.filter((b) => !hiddenBuyers?.has(b.key) && row[`${b.key}_pct`] != null).map((b) => (
        <div key={b.key} style={{ color: AUCTION_BUYER_COLORS[b.key] }}>
          {b.label}: {row[`${b.key}_pct`].toFixed(1)}%
        </div>
      ))}
    </div>
  );
}

export default function TreasuryAuctionsPanel() {
  const [auctionsData, setAuctionsData] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { pinnedDate, togglePinnedDate } = usePinnedDate();

  useEffect(() => {
    fetch("/api/treasury-auctions/db")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => setAuctionsData(json.data ?? null))
      .catch(() => setAuctionsData(null));
  }, []);

  const auctionsMerged = useMemo(() => mergeAuctions(auctionsData), [auctionsData]);
  const [auctionSelectedTypes, setAuctionSelectedTypes] = useState(() => new Set(AUCTION_SECURITY_TYPES));
  const [auctionMixType, setAuctionMixType] = useState("Note");
  const [clickedAuctionTypeKey, setClickedAuctionTypeKey] = useState(null);
  const [clickedAuctionBuyerKey, setClickedAuctionBuyerKey] = useState(null);
  const [hiddenAuctionBuyers, setHiddenAuctionBuyers] = useState(() => new Set());

  const auctionsByType = useMemo(() => {
    const byType = {};
    for (const t of AUCTION_SECURITY_TYPES) byType[t] = [];
    for (const row of auctionsMerged) {
      if (byType[row.security_type]) byType[row.security_type].push(row);
    }
    return byType;
  }, [auctionsMerged]);
  const auctionMixRows = auctionsByType[auctionMixType] || [];
  const auctionsPivoted = useMemo(() => mergeAuctionsByType(auctionsMerged), [auctionsMerged]);
  const auctionsTicks = useMemo(() => xTicks(auctionsPivoted), [auctionsPivoted]);
  const auctionMixTicks = useMemo(() => xTicks(auctionMixRows), [auctionMixRows]);
  const pinnedDateAuctions = nearestRowDate(auctionsPivoted, pinnedDate);
  const pinnedDateAuctionMix = nearestRowDate(auctionMixRows, pinnedDate);

  return (
    <details className="collapsible-pane" open={panelOpen} onToggle={(e) => setPanelOpen(e.target.open)}>
      <summary className="collapsible-pane-title">
        <ChartStaleness sourceKey="treasury_auctions" />
        <span>Treasury Auctions</span>
        {auctionsMerged.length > 0 && (
          <span style={{ fontWeight: "normal", fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            {(() => {
              const latest = auctionsMerged[auctionsMerged.length - 1];
              return `${latest.security_type} (${latest.security_term}) ${latest.date} · ${latest.bid_to_cover_ratio.toFixed(2)}x bid-to-cover`;
            })()}
          </span>
        )}
      </summary>
      {panelOpen && (
        <div className="collapsible-pane-body">
          <div className="comex-panel-note">
            Real Treasury auction results — bid-to-cover ratio (demand strength) and who actually
            bought each auction (primary dealers, indirect bidders — the closest public proxy for
            foreign/other indirect buyers, direct bidders, and the Fed's own SOMA account). Real
            persisted history is a rolling trailing window (see the note below), not multi-year —
            this is about recent auction dynamics, not a long-run series. Descriptive only, per AV
            Voice Rules — no claim about what a given bid-to-cover or buyer mix means for future
            rates or prices.
          </div>
          {auctionsMerged.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart
                  data={auctionsPivoted}
                  margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
                  onClick={(state) => {
                    if (state?.activeLabel) togglePinnedDate(state.activeLabel);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                  <XAxis dataKey="date" ticks={auctionsTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
                  <YAxis
                    domain={["dataMin - 0.2", "dataMax + 0.2"]}
                    tickFormatter={(v) => `${v.toFixed(1)}x`}
                    tick={{ fill: "#8a94a6", fontSize: 11 }}
                    label={{ value: "Bid-to-Cover", angle: -90, position: "insideLeft", fill: "#5a6278", fontSize: 11 }}
                  />
                  <Tooltip content={<AuctionsTooltipContent auctionsMerged={auctionsMerged} />} />
                  {pinnedDateAuctions && (
                    <ReferenceLine x={pinnedDateAuctions} stroke={RATIO_COLOR} strokeDasharray="3 3" />
                  )}
                  {AUCTION_SECURITY_TYPES.filter((t) => auctionSelectedTypes.has(t)).map((t) => (
                    <Line
                      key={t}
                      type="monotone"
                      dataKey={t}
                      name={t}
                      stroke={AUCTION_TYPE_COLOR[t]}
                      dot={{ r: 2 }}
                      strokeWidth={clickedAuctionTypeKey === t ? 3 : 1.5}
                      strokeOpacity={clickedAuctionTypeKey && clickedAuctionTypeKey !== t ? 0.25 : 1}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              {pinnedDateAuctions && (
                <div style={{ marginTop: 4 }}>
                  <AuctionsTooltipContent active label={pinnedDateAuctions} auctionsMerged={auctionsMerged} />
                </div>
              )}
              <div className="comex-legend-list comex-legend-list--horizontal">
                {AUCTION_SECURITY_TYPES.map((t) => (
                  <div key={t} className="metals-legend-row">
                    <input
                      type="checkbox"
                      className="metals-legend-checkbox"
                      checked={auctionSelectedTypes.has(t)}
                      onChange={() =>
                        setAuctionSelectedTypes((prev) => {
                          const next = new Set(prev);
                          if (next.has(t)) next.delete(t);
                          else next.add(t);
                          return next;
                        })
                      }
                      title={auctionSelectedTypes.has(t) ? "Hide this security type" : "Show this security type"}
                    />
                    <button
                      className={`comex-legend-item legend-btn-row${clickedAuctionTypeKey === t ? " legend-btn-row--baseline" : ""}`}
                      onClick={() => setClickedAuctionTypeKey((k) => (k === t ? null : t))}
                      title={`${clickedAuctionTypeKey === t ? "Hide" : "Show"} what a ${t} is, and highlight it on the chart`}
                    >
                      <span className="comex-legend-swatch" style={{ background: AUCTION_TYPE_COLOR[t] }} />
                      <span>
                        <strong>{t}</strong>
                      </span>
                    </button>
                  </div>
                ))}
              </div>
              {clickedAuctionTypeKey && (
                <div className="comex-panel-note comex-panel-note--eli5">
                  {AUCTION_TYPE_DEFS[clickedAuctionTypeKey]}
                </div>
              )}

              <div className="comex-panel-note" style={{ marginTop: 16 }}>
                Buyer mix — who actually bought this security, as a % of the total accepted at
                auction. Only one security type at a time (a Bill's buyer mix isn't comparable to a
                30-Year Bond's on the same chart).
              </div>
              <div className="comex-range-selector" style={{ marginBottom: 8 }}>
                {AUCTION_SECURITY_TYPES.map((t) => (
                  <button
                    key={t}
                    className={`comex-range-btn${auctionMixType === t ? " comex-range-btn--active" : ""}`}
                    onClick={() => setAuctionMixType(t)}
                    title={AUCTION_TYPE_DEFS[t]}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="comex-panel-note comex-panel-note--eli5" style={{ marginTop: 0, marginBottom: 8 }}>
                {AUCTION_TYPE_DEFS[auctionMixType]}
              </div>
              {auctionMixRows.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart
                      data={auctionMixRows}
                      stackOffset="expand"
                      margin={{ top: 4, right: 20, left: 12, bottom: 4 }}
                      onClick={(state) => {
                        if (state?.activeLabel) togglePinnedDate(state.activeLabel);
                      }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                      <XAxis dataKey="date" ticks={auctionMixTicks} tick={{ fill: "#8a94a6", fontSize: 11 }} />
                      <YAxis tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fill: "#8a94a6", fontSize: 11 }} />
                      <Tooltip content={<AuctionMixTooltipContent rows={auctionMixRows} hiddenBuyers={hiddenAuctionBuyers} />} />
                      {pinnedDateAuctionMix && (
                        <ReferenceLine x={pinnedDateAuctionMix} stroke={RATIO_COLOR} strokeDasharray="3 3" />
                      )}
                      {AUCTION_BUYERS.filter((b) => !hiddenAuctionBuyers.has(b.key)).map((b) => (
                        <Area
                          key={b.key}
                          type="monotone"
                          dataKey={`${b.key}_pct`}
                          name={b.label}
                          stackId="mix"
                          stroke={AUCTION_BUYER_COLORS[b.key]}
                          fill={AUCTION_BUYER_COLORS[b.key]}
                          strokeWidth={clickedAuctionBuyerKey === b.key ? 3 : 1}
                          fillOpacity={clickedAuctionBuyerKey && clickedAuctionBuyerKey !== b.key ? 0.2 : 0.7}
                          isAnimationActive={false}
                        />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                  {pinnedDateAuctionMix && (
                    <div style={{ marginTop: 4 }}>
                      <AuctionMixTooltipContent active label={pinnedDateAuctionMix} rows={auctionMixRows} hiddenBuyers={hiddenAuctionBuyers} />
                    </div>
                  )}
                </>
              ) : (
                <div className="comex-empty">
                  No settled {auctionMixType} auctions in the current window.
                </div>
              )}
              <div className="comex-legend-list comex-legend-list--horizontal">
                {AUCTION_BUYERS.map((b) => (
                  <div key={b.key} className="metals-legend-row">
                    <input
                      type="checkbox"
                      className="metals-legend-checkbox"
                      checked={!hiddenAuctionBuyers.has(b.key)}
                      onChange={() =>
                        setHiddenAuctionBuyers((prev) => {
                          const next = new Set(prev);
                          if (next.has(b.key)) next.delete(b.key);
                          else next.add(b.key);
                          return next;
                        })
                      }
                      title={hiddenAuctionBuyers.has(b.key) ? "Show this buyer category" : "Hide this buyer category"}
                    />
                    <button
                      className={`comex-legend-item legend-btn-row${clickedAuctionBuyerKey === b.key ? " legend-btn-row--baseline" : ""}`}
                      onClick={() => setClickedAuctionBuyerKey((k) => (k === b.key ? null : b.key))}
                    >
                      <span className="comex-legend-swatch" style={{ background: AUCTION_BUYER_COLORS[b.key] }} />
                      <span>
                        <strong>{b.label}</strong>
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="comex-empty">
              No data available.
              <div className="comex-empty-note">Auction results accumulate on a rolling basis once the backend has run — check back after the next restart or scheduled fetch.</div>
            </div>
          )}
          <div className="comex-panel-note" style={{ marginTop: 8 }}>
            Source: U.S. Treasury (fiscaldata.treasury.gov) — Auctions Query API. Real persisted
            history is a rolling ~120-day trailing window, refetched daily (not multi-year like the
            other Treasury charts in this panel) — a newly-announced auction has every result field
            null until it settles a few days later, at which point the same record is updated in
            place with real values. "Indirect Bidders" is the closest public proxy for foreign
            central bank and other indirect buyers — it does not identify individual countries.
          </div>
        </div>
      )}
    </details>
  );
}
