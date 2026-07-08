// Static map of every persisted table -> source -> cadence -> fields.
// Hand-maintained (not introspected from SQLite) since provenance/cadence
// is not something the DB schema itself encodes. Keep in sync with
// backend/db.py's DDL and CLAUDE.md's Data flow section when either changes.

export const DATA_SOURCES = [
  {
    key: "cot",
    label: "CFTC CoT (Legacy)",
    origin: "CFTC PRE Socrata API — Legacy Futures-Only dataset (jun7-fc8e). CFTC publishes a new report every Friday, covering positions as of the prior Tuesday.",
    cadenceFrequency: "Weekly",
    cadenceMechanism: "pipeline/run.py — manual or cron only, plus an in-app 'Re-run now' button (rate-limited to once per 7 days, see the Fetch status row below)",
    sourceKeys: ["cot_pipeline"],
    healthMeta: {
      cot_pipeline: { expectedIntervalS: 604800, tier: "pipeline" }, // weekly — CFTC publishes a new report every Friday
    },
    rateLimit: "Socrata public API — no key required, but a full historical pull is slow; incremental since pipeline/fetch.py fetches only rows newer than the latest persisted report_date",
    curl: `curl -G "https://publicreporting.cftc.gov/resource/jun7-fc8e.json" \\
  -H "Accept: application/json" \\
  --data-urlencode "\\$where=cftc_contract_market_code='084691' AND report_date_as_yyyy_mm_dd >= '2011-07-07T00:00:00.000'" \\
  --data-urlencode "\\$order=report_date_as_yyyy_mm_dd ASC" \\
  --data-urlencode "\\$limit=500"`,
    tables: [
      {
        name: "cot_silver",
        fields: [
          ["report_date", "PK — CFTC report date (Tuesday)", "CoT tab — CombinedChart x-axis, StalenessLabel"],
          ["noncomm_long", "Non-commercial (speculative) long contracts", "CoT tab — input to net_long_pct_oi, not shown raw"],
          ["noncomm_short", "Non-commercial (speculative) short contracts", "CoT tab — input to net_long_pct_oi, not shown raw"],
          ["open_interest", "Total open interest, contracts", "CoT tab — Silver panel's SignalBanner"],
          ["net_long", "noncomm_long - noncomm_short", "CoT tab — input to net_long_pct_oi, not shown raw"],
          ["net_long_pct_oi", "net_long as % of open_interest", "CoT tab — CombinedChart line, Positioning Extremes summary, SignalBanner"],
          ["fetched_at", "Row insert timestamp (not report date)", "Not surfaced in any panel — see pipeline_runs.ran_at for the staleness banner's timestamp instead"],
        ],
        note: "Append-only, INSERT OR IGNORE keyed by report_date — a published report is never overwritten.",
      },
      {
        name: "cot_gold",
        fields: [
          ["report_date", "PK — CFTC report date (Tuesday)", "CoT tab — CombinedChart's gold line x-axis, Gold-Silver Ratio chart's shared date axis"],
          ["noncomm_long", "Non-commercial (speculative) long contracts, gold futures", "CoT tab — input to net_long_pct_oi, not shown raw"],
          ["noncomm_short", "Non-commercial (speculative) short contracts, gold futures", "CoT tab — input to net_long_pct_oi, not shown raw"],
          ["open_interest", "Total gold futures open interest, contracts", "CoT tab — Gold panel's SignalBanner"],
          ["net_long", "noncomm_long - noncomm_short", "CoT tab — input to net_long_pct_oi, not shown raw"],
          ["net_long_pct_oi", "net_long as % of open_interest", "CoT tab — CombinedChart's gold line, Gold panel's SignalBanner, and windows.disagree (2yr/5yr classification mismatch warning) in that same SignalBanner"],
          ["fetched_at", "Row insert timestamp (not report date)", "Not surfaced in any panel — see pipeline_runs.ran_at for the staleness banner's timestamp instead"],
        ],
        note: "Append-only, INSERT OR IGNORE keyed by report_date — a published report is never overwritten. Gold's percentile/track-record windows (data.gold.windows, data.gold.signal_track_record) are computed server-side from this table the same way silver's are from cot_silver, via pipeline/compute.py's compute_from_series — a separate call, not a derived/scaled copy of silver's numbers.",
      },
      {
        name: "pipeline_runs",
        fields: [
          ["id", "Always 1 — single-row table", "N/A — internal PK"],
          ["ran_at", "Timestamp of the last completed pipeline/run.py run", "Powers this card's Last fetch readout (via GET /api/cot/db's generated_at); no longer rendered in the CoT tab itself (StalenessLabel dropped its 'pipeline run' clause)"],
        ],
        note: "Stamped unconditionally at the end of every successful run, independent of whether new CoT rows landed.",
      },
    ],
  },
  {
    key: "cot_disaggregated",
    label: "CFTC CoT (Disaggregated)",
    origin: "CFTC PRE Socrata API — Disaggregated Futures-Only dataset (72hh-3qpy)",
    cadence: "Weekly — fetched by pipeline/run.py alongside Legacy CoT",
    sourceKeys: ["cot_pipeline"],
    healthMeta: {
      cot_pipeline: { expectedIntervalS: 604800, tier: "pipeline" },
    },
    rateLimit: "Same Socrata API as Legacy CoT, different dataset ID",
    curl: `curl -G "https://publicreporting.cftc.gov/resource/72hh-3qpy.json" \\
  -H "Accept: application/json" \\
  --data-urlencode "\\$where=cftc_contract_market_code='084691' AND report_date_as_yyyy_mm_dd >= '2011-07-07T00:00:00.000'" \\
  --data-urlencode "\\$order=report_date_as_yyyy_mm_dd ASC" \\
  --data-urlencode "\\$limit=500"
# gold: cftc_contract_market_code='088691'`,
    tables: [
      {
        name: "cot_disaggregated",
        fields: [
          ["report_date", "PK (with metal, category) — CFTC report date"],
          ["metal", "PK — 'silver' or 'gold'"],
          ["category", "PK — producer_merchant / swap_dealer / managed_money / other_reportable"],
          ["long", "Long contracts for this category"],
          ["short", "Short contracts for this category"],
          ["spreading", "Spread contracts (always NULL for producer_merchant — no spread field in CFTC's schema for that category)"],
          ["open_interest", "Total open interest for the report"],
        ],
        note: "Append-only, INSERT OR IGNORE keyed by (report_date, metal, category). Powers Delivery Behavior's category-composition signal.",
      },
    ],
  },
  {
    key: "prices_weekly",
    label: "Yahoo Finance (weekly, CoT pipeline)",
    origin: "Yahoo Finance chart API — SI=F / GC=F, via pipeline/price_fetch.py (urllib, stdlib only)",
    cadence: "Weekly, alongside CoT pipeline runs",
    sourceKeys: ["cot_pipeline"],
    healthMeta: {
      cot_pipeline: { expectedIntervalS: 604800, tier: "pipeline" },
    },
    rateLimit: "Unofficial/unauthenticated endpoint — no documented limit, keep call volume low",
    curl: `curl "https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1wk&range=8y" \\
  -H "User-Agent: Mozilla/5.0" -H "Accept: application/json"
# gold: /v8/finance/chart/GC=F`,
    tables: [
      {
        name: "cot_prices",
        fields: [
          ["ticker", "PK — e.g. SI=F, GC=F"],
          ["date", "PK — weekly close date"],
          ["price", "Close price"],
        ],
        note: "Upsert (ticker+date), not append-only — safe to re-fetch/correct.",
      },
    ],
  },
  {
    key: "metalcharts_silver",
    label: "metalcharts.org — Silver (COMEX)",
    origin: "metalcharts.org reverse-engineered API, authenticated via backend/mc_token.py",
    cadence: "Slow tier (default OFF, runs once at startup) — see main.py lifespan",
    sourceKeys: ["comex_silver_history", "comex_silver_depositories", "silver_leverage", "delivery_notices"],
    healthMeta: {
      comex_silver_history: { expectedIntervalS: 1200, tier: "slow" },
      comex_silver_depositories: { expectedIntervalS: 1200, tier: "slow" },
      silver_leverage: { expectedIntervalS: 1200, tier: "slow" },
      delivery_notices: { expectedIntervalS: 1200, tier: "slow" },
    },
    rateLimit: "Undocumented (reverse-engineered) — treat conservatively, this is why the tiered refresh defaults off",
    curl: `# 1. get a token (short-lived, must be fetched fresh)
curl "https://metalcharts.org/api/security/token" \\
  -H "Referer: https://metalcharts.org/comex/silver" \\
  -H "x-requested-with: XMLHttpRequest"
# -> {"token": "...", "expiresAt": "..."}

# 2. use it on the actual data call
curl "https://metalcharts.org/api/comex/inventory?symbol=XAG&range=ALL" \\
  -H "x-mc-token: <token>" \\
  -H "Referer: https://metalcharts.org/comex/silver" \\
  -H "x-requested-with: XMLHttpRequest"
# depositories: &type=depositories · leverage/OI: drop &range/&type
# delivery notices: &type=mtd (or &type=ytd)`,
    tables: [
      {
        name: "inventory_aggregate",
        fields: [
          ["date", "PK"],
          ["total", "Total COMEX silver vault holdings, troy oz"],
          ["registered", "Registered (deliverable) oz"],
          ["eligible", "Eligible (non-deliverable) oz"],
          ["reg_eligible_ratio", "registered / eligible"],
          ["created_at", "Row insert timestamp"],
        ],
        note: "0 from upstream means 'not reported' and is converted to NULL (see main.py's _parse_aggregate_row) so charts gap instead of showing false dips.",
      },
      {
        name: "inventory_depository",
        fields: [
          ["date", "PK (with depository)"],
          ["depository", "PK — vault name, e.g. 'JPMorgan'"],
          ["registered", "This vault's registered oz"],
          ["eligible", "This vault's eligible oz"],
          ["total", "This vault's total oz"],
          ["prev_registered / prev_eligible / prev_total", "Prior snapshot's values, as reported upstream — hints metalcharts.org sometimes restates figures (flagged, not yet acted on)"],
        ],
        note: "Only accumulates history from whenever this route was first fetched — no upstream backfill exists.",
      },
      {
        name: "volume_oi",
        fields: [
          ["date", "PK"],
          ["open_interest", "COMEX silver open interest, contracts"],
          ["volume", "Daily volume, contracts"],
          ["paper_leverage", "Derived ratio, powers Paper Leverage cards"],
        ],
      },
      {
        name: "delivery_notices",
        fields: [
          ["date", "PK (with type)"],
          ["type", "PK — 'mtd' or 'ytd' (Delivery Behavior uses ytd for ~85 days of coverage)"],
          ["daily_issued", "Delivery notices issued that day, contracts"],
          ["daily_stopped", "Delivery notices stopped that day, contracts"],
        ],
        note: "Upstream's mtdCumulative/ytdCumulative fields are always 0 (confirmed dead) and are dropped, not displayed.",
      },
    ],
  },
  {
    key: "metalcharts_gold",
    label: "metalcharts.org — Gold (COMEX)",
    origin: "Same source as Silver, symbol=XAU / 100oz contracts",
    cadence: "Slow tier, same as Silver",
    sourceKeys: ["comex_gold_history", "comex_gold_depositories", "gold_leverage"],
    healthMeta: {
      comex_gold_history: { expectedIntervalS: 1200, tier: "slow" },
      comex_gold_depositories: { expectedIntervalS: 1200, tier: "slow" },
      gold_leverage: { expectedIntervalS: 1200, tier: "slow" },
    },
    rateLimit: "Same as Silver",
    curl: `curl "https://metalcharts.org/api/comex/inventory?symbol=XAU&range=ALL" \\
  -H "x-mc-token: <token>" \\
  -H "Referer: https://metalcharts.org/comex/gold" \\
  -H "x-requested-with: XMLHttpRequest"
# same token flow as Silver — see that source's curl for step 1`,
    tables: [
      { name: "gold_inventory_aggregate", fields: [["(mirrors inventory_aggregate)", "Gold COMEX vault totals"]] },
      { name: "gold_inventory_depository", fields: [["(mirrors inventory_depository)", "Gold per-vault snapshot"]] },
      { name: "gold_volume_oi", fields: [["(mirrors volume_oi)", "Gold OI/volume/leverage"]] },
    ],
    note: "Fetched+persisted every slow-tier cycle; history/depositories not currently rendered anywhere in the frontend (leverage is).",
  },
  {
    key: "shfe",
    label: "metalcharts.org — SHFE (Shanghai)",
    origin: "Same reverse-engineered metalcharts.org API",
    cadence: "Slow tier",
    sourceKeys: ["shfe_silver_history", "shfe_warehouses"],
    healthMeta: {
      shfe_silver_history: { expectedIntervalS: 1200, tier: "slow" },
      shfe_warehouses: { expectedIntervalS: 1200, tier: "slow" },
    },
    rateLimit: "Same as COMEX routes",
    curl: `curl "https://metalcharts.org/api/comex/inventory?symbol=AG&range=ALL" \\
  -H "x-mc-token: <token>" \\
  -H "Referer: https://metalcharts.org/comex/silver" \\
  -H "x-requested-with: XMLHttpRequest"
# warehouses: &type=warehouses instead of &range=ALL`,
    tables: [
      {
        name: "shfe_inventory",
        fields: [
          ["date", "PK"],
          ["total_kg", "Total SHFE silver warehouse stock, kg (native unit)"],
          ["total_oz", "Converted, 1 kg = 32.1507 oz"],
        ],
      },
      {
        name: "shfe_warehouse",
        fields: [
          ["date", "PK (with warehouse)"],
          ["warehouse", "PK — individual SHFE warehouse name"],
          ["warrant_kg", "Warrant stock at this warehouse, kg"],
          ["warrant_change_kg", "Day-over-day change, kg"],
        ],
      },
    ],
  },
  {
    key: "pslv",
    label: "Sprott (PSLV)",
    origin: "Sprott direct API",
    cadence: "Slow tier",
    sourceKeys: ["pslv"],
    healthMeta: {
      pslv: { expectedIntervalS: 1200, tier: "slow" },
    },
    rateLimit: "Undocumented — treat conservatively, same tiering as metalcharts.org routes",
    curl: `curl "https://sprott.com/api/FinancialData/v1/BullionCalculatorData" \\
  -H "Accept: application/json"`,
    tables: [
      {
        name: "pslv_snapshot",
        fields: [
          ["date", "PK"],
          ["total_oz", "PSLV trust's total silver holdings, oz"],
          ["nav_per_unit", "Net asset value per unit"],
          ["total_nav", "Total NAV"],
          ["units", "Units outstanding"],
        ],
      },
    ],
  },
  {
    key: "spot_prices",
    label: "Spot prices (live quote)",
    origin: "main.py's own fetch (fast tier) — feeds Paper Leverage cards' spot badge and 6H–12M price chart",
    cadence: "Fast tier (default ON, 60s) — the one genuinely intraday source",
    sourceKeys: ["spot_prices"],
    healthMeta: {
      spot_prices: { expectedIntervalS: 60, tier: "fast" },
    },
    rateLimit: "Whatever upstream main.py's spot-price fetch uses — kept on the fast tier deliberately since it's the one figure that's actually intraday-moving",
    curl: `curl "https://metalcharts.org/api/prices" \\
  -H "x-mc-token: <token>" \\
  -H "Referer: https://metalcharts.org/comex/silver" \\
  -H "x-requested-with: XMLHttpRequest"
# same metalcharts.org auth flow as the Silver COMEX source above`,
    tables: [
      {
        name: "spot_price_snapshot",
        fields: [
          ["series_id", "PK (with date) — e.g. XAG, XAU"],
          ["date", "PK — one row per calendar day, overwritten on every fast-tier tick"],
          ["price", "Latest price"],
          ["change_pct_24h", "24h % change, from upstream"],
        ],
        note: "Not a true intraday series (one row/day, overwritten) — see spot_price_tick for that.",
      },
      {
        name: "spot_price_tick",
        fields: [
          ["series_id", "PK (with ts)"],
          ["ts", "PK — timestamp of this tick"],
          ["price", "Price at that tick"],
        ],
        note: "Append-only (INSERT OR IGNORE) — the true intraday series, written on every fast-tier poll alongside spot_price_snapshot. Used by CATCOR's snapshot capture to find prices near an event window, and by GET /api/prices/db/ticks (below) for the Paper Leverage panel's price chart.",
      },
    ],
    note: "GET /api/prices/db/ticks?series_id=&hours= (Paper Leverage panel's 6H/12H/24H/48H/1M/3M/6M/12M price chart) stitches three resolutions since no single table covers every window: spot_price_tick (60s ticks, only from whenever the fast tier first ran — currently back to ~2026-04-22), then fred_observations' XAG_DAILY_CLOSE/XAU_DAILY_CLOSE (daily, ~120 days), then XAG_CLOSE/XAU_CLOSE (month-end, back to 2006) for anything older. See db.get_price_history.",
  },
  {
    key: "fred",
    label: "FRED / ALFRED",
    origin: "FRED API (money supply) and ALFRED point-in-time vintage API (CATCOR actuals) — requires FRED_API_KEY",
    cadence: "Money Supply: on-demand via /api/fred/money-supply/refresh. ALFRED: CATCOR's 30min consensus/actuals loop.",
    // Two source_keys with different cadences under one card — health.js
    // (health metadata) is keyed per source_key, not per card, since a
    // single expectedIntervalS/tier wouldn't fit both.
    sourceKeys: ["money_supply", "catcor_consensus_actuals"],
    healthMeta: {
      money_supply: { expectedIntervalS: 86400, tier: "on-demand" }, // no periodic loop; treat "healthy" window as a day so a quiet card doesn't read stale within hours
      catcor_consensus_actuals: { expectedIntervalS: 1800, tier: "catcor-consensus" },
    },
    rateLimit: "Pre-authorized for reads per prior guidance — avoid hammering, but no explicit throttle needed",
    curl: `# FRED (Money Supply)
curl "https://api.stlouisfed.org/fred/series/observations?series_id=M2SL&api_key=\${FRED_API_KEY}&file_type=json&observation_start=2015-01-01"

# ALFRED (CATCOR point-in-time vintage, e.g. CPI actual as-of the day after a release)
curl "https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=\${FRED_API_KEY}&file_type=json&realtime_start=2026-01-15&realtime_end=2026-01-15&sort_order=desc&limit=2"`,
    tables: [
      {
        name: "fred_observations",
        fields: [
          ["series_id", "PK (with date) — one of 8 values, see the split-out rows below", "—"],
          ["date", "PK — observation date", "—"],
          ["value", "Series value in native FRED/upstream units — NOT normalized across series_id", "—"],
        ],
        note: "Generic (series_id, date, value) store shared by three unrelated fetch paths despite the FRED-sounding name. Split below by series_id group rather than shown as one flat table, since each group has a different origin/cadence/consumer.",
      },
      {
        name: "fred_observations — M2SL, WALCL",
        fields: [
          ["series_id", "'M2SL' or 'WALCL'", "Money Supply tab — M2/WALCL chart"],
          ["date", "Observation date (FRED's native monthly/weekly cadence per series)", "Money Supply tab — chart x-axis"],
          ["value", "Raw level, USD billions (M2SL) / trillions (WALCL) — FRED's native unit, not converted", "Money Supply tab — /api/fred/money-supply/db's YoY computation"],
        ],
        note: "Fetched by /api/fred/money-supply/refresh, on-demand only (source_key money_supply).",
      },
      {
        name: "fred_observations — CPIAUCSL",
        fields: [
          ["series_id", "'CPIAUCSL' — one series_id, two different fetch paths write to it", "—"],
          ["date", "Observation date. Monthly release date (Money Supply's regular fetch) or ALFRED's point-in-time vintage date (CATCOR)", "Money Supply tab (CPI-derived Purchasing Power) — CATCOR panel (actual_value/surprise_delta)"],
          ["value", "Index level (Money Supply's fetch) — same series_id, same native units either way, just fetched via two different code paths (regular FRED vs. ALFRED point-in-time)", "See catcor.py's _fetch_alfred_change for the vintage-diff path"],
        ],
        note: "money_supply's regular fetch and CATCOR's catcor_consensus_actuals loop (_fetch_alfred_change) both write real rows here under the same series_id — the ALFRED path additionally persists the two raw vintage prints it diffs before computing surprise_delta (added so this table's claim to hold CPIAUCSL data is actually true, not just the derived diff living on event_calendar).",
      },
      {
        name: "fred_observations — PAYEMS",
        fields: [
          ["series_id", "'PAYEMS'", "CATCOR panel — NFP actual_value/surprise_delta"],
          ["date", "ALFRED vintage observation date (first-of-month, per FRED convention)", "—"],
          ["value", "Total nonfarm payrolls, thousands of persons (FRED's native unit) — NOT the ForexFactory 'K' consensus format, which is scaled ÷1000 against this before comparison (see CLAUDE.md's CATCOR subsection for the unit bug this caught)", "CATCOR panel — Surprise Magnitude vs. Price Reaction chart, NFP events"],
        ],
        note: "ALFRED only — not fetched via the Money Supply refresh path (backend/catcor.py's _series_id_for_event_type). Both vintage prints _fetch_alfred_change diffs (this month's + prior month's, as ALFRED reported them the day after release) are persisted here before the diff is returned and written to event_calendar.actual_value — only accumulates once CATCOR's actuals loop has run against a real NFP event, so a fresh clone/reset DB shows 0 rows here until then.",
      },
      {
        name: "fred_observations — XAG_CLOSE, XAU_CLOSE",
        fields: [
          ["series_id", "'XAG_CLOSE' or 'XAU_CLOSE'", "Money Supply tab — Dollars vs Silver vs Gold as Purchasing Power chart"],
          ["date", "Month-end date (last trading day on/before month-end)", "Chart x-axis"],
          ["value", "USD/oz close price, resampled from Yahoo daily closes to one row per month", "—"],
        ],
        note: "Fetched by /api/metals/prices/refresh, on-demand only (source_key metals_prices). NOT read by CATCOR — see XAG_DAILY_CLOSE/XAU_DAILY_CLOSE below for that.",
      },
      {
        name: "fred_observations — XAG_DAILY_CLOSE, XAU_DAILY_CLOSE",
        fields: [
          ["series_id", "'XAG_DAILY_CLOSE' or 'XAU_DAILY_CLOSE'", "CATCOR panel — price-reaction capture fallback"],
          ["date", "Daily date, ~120 days back", "—"],
          ["value", "USD/oz close price, unresampled Yahoo daily close", "—"],
        ],
        note: "Fetched by catcor.py's backfill_daily_closes (catcor_snapshot's loop). Deliberately separate keys from XAG_CLOSE/XAU_CLOSE above — those are month-end-only and have no daily granularity, a real bug caught during CATCOR's build when the fallback silently returned NULL against the monthly-only keys. Used only when no spot_price_tick exists near an event window.",
      },
    ],
  },
  {
    key: "metals_prices_monthly",
    label: "Yahoo Finance (monthly, Money Supply)",
    origin: "Yahoo Finance chart API — SI=F/GC=F, httpx directly in main.py (separate from pipeline/price_fetch.py)",
    cadence: "On-demand via /api/metals/prices/refresh",
    sourceKeys: ["metals_prices"],
    healthMeta: {
      metals_prices: { expectedIntervalS: 86400, tier: "on-demand" },
    },
    rateLimit: "Unofficial endpoint — same caution as the weekly CoT-pipeline fetch, different code path",
    curl: `curl "https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1d&range=5y" \\
  -H "User-Agent: Mozilla/5.0" -H "Accept: application/json"
# gold: /v8/finance/chart/GC=F — resampled to one row per month-end server-side`,
    tables: [
      { name: "fred_observations (XAG_CLOSE / XAU_CLOSE keys)", fields: [["value", "Last trading day on/before each month-end — feeds Money Supply's purchasing-power comparison"]], note: "Full field breakdown lives under the FRED / ALFRED card's fred_observations — XAG_CLOSE, XAU_CLOSE table — this card documents the fetch route (/api/metals/prices/refresh) that writes those rows, not a separate table." },
    ],
  },
  {
    key: "catcor_calendar",
    label: "CATCOR — event calendar (seed data)",
    origin: "seed_data/catcor_events_seed.py — manually maintained FOMC/CPI/NFP calendar, cross-checked against ALFRED + Fed meeting calendar",
    cadence: "Re-seeded on every backend startup (idempotent — event_id is deterministic)",
    rateLimit: "N/A — static local file, no upstream call",
    curl: `# no upstream call — loaded from seed_data/catcor_events_seed.py directly`,
    tables: [
      {
        name: "event_calendar",
        fields: [
          ["event_id", "PK — deterministic, f'{event_type}_{date}'"],
          ["event_name", "Human label"],
          ["event_type", "FOMC / CPI / NFP"],
          ["scheduled_time", "Event datetime"],
          ["consensus_value", "From ForexFactory, current-week only"],
          ["actual_value", "From ALFRED"],
          ["surprise_delta", "actual - consensus, once both known"],
          ["source_url", "Reference link"],
          ["source_tier", "Currently always 'government'"],
        ],
      },
    ],
  },
  {
    key: "catcor_forexfactory",
    label: "CATCOR — ForexFactory consensus",
    origin: "nfs.faireconomy.media's free 'this week' calendar export, no API key",
    cadence: "At most once per calendar week (main.py's 30min consensus loop checks first, only fetches if that week isn't cached yet)",
    sourceKeys: ["catcor_consensus_actuals"],
    healthMeta: {
      catcor_consensus_actuals: { expectedIntervalS: 1800, tier: "catcor-consensus" },
    },
    rateLimit: "Confirmed live: repeat hits within the same week trip a 429, community reports of full IP lockout — never re-fetched within a week regardless of call frequency",
    curl: `curl "https://nfs.faireconomy.media/ff_calendar_thisweek.json" \\
  -H "User-Agent: Mozilla/5.0"
# do not repeat within the same calendar week — see rate-limit note above`,
    tables: [
      {
        name: "forexfactory_calendar",
        fields: [
          ["week_key", "PK — that week's Sunday date"],
          ["title", "PK — event title, e.g. 'Non-Farm Employment Change'"],
          ["country", "PK — currency/country code"],
          ["event_date", "PK — scheduled date"],
          ["impact", "Low/Medium/High"],
          ["forecast", "Consensus forecast as given by the feed"],
          ["previous", "Previous period's value"],
        ],
        note: "Append-only, every entry the feed returns (not just USD/CPI/NFP) — replaced a flat-file cache (runtime/forexfactory_thisweek.json) that discarded the rest of the feed on every overwrite.",
      },
    ],
  },
  {
    key: "catcor_reactions",
    label: "CATCOR — price reaction capture",
    origin: "Computed from spot_price_tick / fred_observations (XAG_DAILY_CLOSE etc.) around each event's scheduled_time",
    cadence: "Polled every 60s (main.py's _event_tier_loop, always-on — a missed window is permanent data loss)",
    sourceKeys: ["catcor_snapshot"],
    healthMeta: {
      catcor_snapshot: { expectedIntervalS: 60, tier: "catcor-event" },
    },
    rateLimit: "N/A — pure computation over already-persisted price data",
    curl: `# no upstream call — reads spot_price_tick / fred_observations already in SQLite.
# The ticks themselves come from Yahoo's intraday backfill:
curl "https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=5m&range=60d" \\
  -H "User-Agent: Mozilla/5.0"
# daily-close fallback (older events, past Yahoo's 5m-interval window):
curl "https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1d&range=120d" \\
  -H "User-Agent: Mozilla/5.0"`,
    tables: [
      {
        name: "macro_price_reaction",
        fields: [
          ["event_id", "PK (with metal, window)"],
          ["metal", "PK — XAG or XAU"],
          ["window", "PK — T-30m / T+5m / T+30m / T+2h"],
          ["price", "Captured price at that window"],
          ["price_delta_pct", "% change vs. pre-event price"],
          ["surprise_magnitude", "Copied from event's surprise_delta at capture time"],
        ],
        note: "Idempotent by construction — skips if a row already exists for (event_id, metal, window).",
      },
    ],
  },
  {
    key: "research",
    label: "CATCOR Research Pane (chat)",
    origin: "AV's own backend/catcor_research.py — not a third-party upstream. Each turn is one call to whichever model backend AI_BACKEND resolves to.",
    cadence: "On-demand only — one call per Send click in the Research tab, no background loop.",
    rateLimit: "Whichever backend is active: Anthropic Messages API (real cost/request) or amp-forge, a local Ollama-backed LAN service with no rate limit.",
    curl: `# Anthropic (AI_BACKEND=anthropic)
curl https://api.anthropic.com/v1/messages \\
  -H "x-api-key: \${ANTHROPIC_API_KEY}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{"model": "claude-haiku-4-5-20251001", "max_tokens": 2000, "system": "...", "messages": [...]}'

# amp-forge (AI_BACKEND=forge, the default)
curl -N -X POST http://amp-forge:8001/chat/stream \\
  -H "Content-Type: application/json" \\
  -d '{"message": "...", "system": "...", "model": "qwen3:8b", "persist": false}'`,
    note: "Currently single-call, no tools: every turn goes through prompts/word_count_v1.py, a deliberately trivial word-counting persona used to validate chat plumbing (session/message persistence, backend routing, frontend rendering) independent of real evidence-gathering. The earlier 2-call parser+analyst pipeline (prompts/parser_v1.py + analyst_v1.py — decompose a claim, fetch AV's own CoT/inventory/money-supply/market-balance data via read-only tools, then contextualize it) is built and importable but not wired into send_message right now. research_log/promote/dismiss (SPEC.MD Deliverable 3) are not implemented — sessions can only be created and chatted in, never promoted to event_calendar or dismissed.",
    tables: [
      {
        name: "research_sessions",
        fields: [
          ["session_id", "PK — UUID"],
          ["claim_text", "The pasted claim/first message, as originally entered"],
          ["source_url", "Optional"],
          ["status", "active | promoted | dismissed — always 'active' currently, nothing sets the other two yet"],
          ["user_read", "bullish | bearish | neutral — not currently settable, no /read route yet"],
          ["created_at", "ISO timestamp"],
          ["updated_at", "Bumped on every message"],
        ],
      },
      {
        name: "research_messages",
        fields: [
          ["id", "PK, autoincrement"],
          ["session_id", "FK -> research_sessions"],
          ["role", "user | assistant"],
          ["content", "Raw turn text (user) or a small JSON envelope {\"final_text\": ...} (assistant)"],
          ["created_at", "ISO timestamp, preserves ordering"],
        ],
        note: "Append-only — a turn is never edited or deleted once persisted, same convention as cot_silver/cot_gold.",
      },
      {
        name: "research_log",
        fields: [
          ["id", "PK, autoincrement"],
          ["session_id", "FK -> research_sessions"],
          ["claim_text", "Denormalized copy from the session"],
          ["source_url", "Optional"],
          ["user_read", "bullish | bearish | neutral"],
          ["dismissed_at", "ISO timestamp"],
          ["validation_status", "correct | incorrect | mixed — reserved for a later validation pass, always NULL today"],
        ],
        note: "Table exists in the schema but nothing writes to it yet — the 'log as noise' disposition (SPEC.MD Deliverable 3) isn't built.",
      },
    ],
  },
];
