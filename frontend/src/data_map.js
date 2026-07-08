// Static map of every persisted table -> source -> cadence -> fields.
// Hand-maintained (not introspected from SQLite) since provenance/cadence
// is not something the DB schema itself encodes. Keep in sync with
// backend/db.py's DDL and CLAUDE.md's Data flow section when either changes.

export const DATA_SOURCES = [
  {
    key: "cot",
    label: "CFTC CoT (Legacy)",
    origin: "CFTC PRE Socrata API — Legacy Futures-Only dataset (jun7-fc8e)",
    cadence: "Weekly (CFTC publishes Fridays) — fetched by pipeline/run.py, manual/cron only, never on-request",
    rateLimit: "Socrata public API — no key required, but a full historical pull is slow; pipeline is not meant to run per-request",
    curl: `curl -G "https://publicreporting.cftc.gov/resource/jun7-fc8e.json" \\
  -H "Accept: application/json" \\
  --data-urlencode "\\$where=cftc_contract_market_code='084691' AND report_date_as_yyyy_mm_dd >= '2011-07-07T00:00:00.000'" \\
  --data-urlencode "\\$order=report_date_as_yyyy_mm_dd ASC" \\
  --data-urlencode "\\$limit=500"`,
    tables: [
      {
        name: "cot_silver",
        fields: [
          ["report_date", "PK — CFTC report date (Tuesday)"],
          ["noncomm_long", "Non-commercial (speculative) long contracts"],
          ["noncomm_short", "Non-commercial (speculative) short contracts"],
          ["open_interest", "Total open interest, contracts"],
          ["net_long", "noncomm_long - noncomm_short"],
          ["net_long_pct_oi", "net_long as % of open_interest"],
          ["fetched_at", "Row insert timestamp (not report date)"],
        ],
        note: "Append-only, INSERT OR IGNORE keyed by report_date — a published report is never overwritten.",
      },
      {
        name: "cot_gold",
        fields: [["(same shape as cot_silver)", "Gold Legacy CoT, same columns"]],
        note: "Append-only, same convention as cot_silver.",
      },
      {
        name: "pipeline_runs",
        fields: [
          ["id", "Always 1 — single-row table"],
          ["ran_at", "Timestamp of the last completed pipeline/run.py run"],
        ],
        note: "Stamped unconditionally at the end of every successful run, independent of whether new CoT rows landed. Powers the CoT staleness banner.",
      },
    ],
  },
  {
    key: "cot_disaggregated",
    label: "CFTC CoT (Disaggregated)",
    origin: "CFTC PRE Socrata API — Disaggregated Futures-Only dataset (72hh-3qpy)",
    cadence: "Weekly — fetched by pipeline/run.py alongside Legacy CoT",
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
    cadence: "Slow tier (default OFF, runs once at startup) — see refresh_controls.jsx / main.py lifespan",
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
    origin: "main.py's own fetch (fast tier) — feeds Paper Leverage cards' spot badge",
    cadence: "Fast tier (default OFF, runs once at startup) — the one genuinely intraday source",
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
        note: "Append-only (INSERT OR IGNORE) — the true intraday series, written on every fast-tier poll alongside spot_price_snapshot. Used by CATCOR's snapshot capture to find prices near an event window.",
      },
    ],
  },
  {
    key: "fred",
    label: "FRED / ALFRED",
    origin: "FRED API (money supply) and ALFRED point-in-time vintage API (CATCOR actuals) — requires FRED_API_KEY",
    cadence: "Money Supply: on-demand via /api/fred/money-supply/refresh. ALFRED: CATCOR's 30min consensus/actuals loop.",
    rateLimit: "Pre-authorized for reads per prior guidance — avoid hammering, but no explicit throttle needed",
    curl: `# FRED (Money Supply)
curl "https://api.stlouisfed.org/fred/series/observations?series_id=M2SL&api_key=\${FRED_API_KEY}&file_type=json&observation_start=2015-01-01"

# ALFRED (CATCOR point-in-time vintage, e.g. CPI actual as-of the day after a release)
curl "https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=\${FRED_API_KEY}&file_type=json&realtime_start=2026-01-15&realtime_end=2026-01-15&sort_order=desc&limit=2"`,
    tables: [
      {
        name: "fred_observations",
        fields: [
          ["series_id", "PK (with date) — M2SL, WALCL, CPIAUCSL, XAG_CLOSE, XAU_CLOSE, XAG_DAILY_CLOSE, XAU_DAILY_CLOSE"],
          ["date", "PK — observation date"],
          ["value", "Series value in native FRED units"],
        ],
        note: "Generic (series_id, date, value) store — also holds Yahoo-derived metal close prices under XAG_CLOSE/XAU_CLOSE (month-end resampled, Money Supply) and XAG_DAILY_CLOSE/XAU_DAILY_CLOSE (daily, CATCOR fallback) keys despite the FRED-sounding table name.",
      },
    ],
  },
  {
    key: "metals_prices_monthly",
    label: "Yahoo Finance (monthly, Money Supply)",
    origin: "Yahoo Finance chart API — SI=F/GC=F, httpx directly in main.py (separate from pipeline/price_fetch.py)",
    cadence: "On-demand via /api/metals/prices/refresh",
    rateLimit: "Unofficial endpoint — same caution as the weekly CoT-pipeline fetch, different code path",
    curl: `curl "https://query1.finance.yahoo.com/v8/finance/chart/SI=F?interval=1d&range=5y" \\
  -H "User-Agent: Mozilla/5.0" -H "Accept: application/json"
# gold: /v8/finance/chart/GC=F — resampled to one row per month-end server-side`,
    tables: [
      { name: "fred_observations (XAG_CLOSE / XAU_CLOSE keys)", fields: [["value", "Last trading day on/before each month-end — feeds Money Supply's purchasing-power comparison"]] },
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
];
