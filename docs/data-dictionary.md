<!-- GENERATED FILE — do not hand-edit. Regenerate with:
     .venv/bin/python utils/gen_data_dictionary.py
     Source: backend/db.py's DDL (schema) + backend/sources.py (provenance/cadence/rate-limit)
     + frontend/src/data_editorial.js (per-field prose, where available). -->

# ArgentVigil Data Dictionary

31 tables. Generated field lists are mechanical (from SQLite's own schema); per-field descriptions are pulled from data_editorial.js where hand-written, or marked `<!-- TODO: describe field -->` where they are not yet documented.

## `census_trade`

**Source**: U.S. Census Bureau — International Trade (`census_trade`, gov_regulatory)  
**Cadence**: `startup`  
**Rate limit**: ~25-day minimum gap between fetch attempts  

| Field | Type | PK | Description |
|---|---|---|---|
| `metal` | TEXT | ✓ | PK — 'XAG' (HS 7106) or 'XAU' (HS 7108, comparison-only) |
| `flow` | TEXT | ✓ | PK — 'import' or 'export' |
| `hs_code` | TEXT | ✓ | PK — '7106' or '7108' |
| `cty_code` | TEXT | ✓ | PK — Census country code, '-' = all countries total |
| `cty_name` | TEXT |  | Country name |
| `year` | INTEGER | ✓ | PK |
| `month` | INTEGER | ✓ | PK |
| `value_general_usd` | INTEGER |  | Imports: GEN_VAL_MO (general import value). Exports: ALL_VAL_MO. |
| `value_consumption_usd` | INTEGER |  | Imports only, CON_VAL_MO (value for consumption — excludes bonded-warehouse/re-export flow). NULL for exports. |
| `qty` | REAL |  | Confirmed live (2025-01, 2024-06, both flows, both metals): always NULL today — Census reports no quantity/weight for HS 7106 or 7108 (GEN_QY1_MO/CON_QY1_MO/QTY_1_MO are always "0"). Not an error case; do not build oz-conversion logic against this field. |
| `qty_unit` | TEXT |  | Same confirmed-live gap as qty — always NULL today (UNIT_QY1 is always Census's '-' not-applicable sentinel for these two HS codes). |
| `fetched_at` | TEXT |  | Row upsert timestamp |

## `cot_disaggregated`

**Source**: CFTC Commitment of Traders (Legacy + Disaggregated) (`cot_pipeline`, gov_regulatory)  
**Cadence**: `manual_only`  
**Rate limit**: ~7-day minimum gap between fetch attempts  

| Field | Type | PK | Description |
|---|---|---|---|
| `report_date` | TEXT | ✓ | PK (with metal, category) — CFTC report date |
| `metal` | TEXT | ✓ | PK — 'silver' or 'gold' |
| `category` | TEXT | ✓ | PK — producer_merchant / swap_dealer / managed_money / other_reportable |
| `long` | REAL |  | Long contracts for this category |
| `short` | REAL |  | Short contracts for this category |
| `spreading` | REAL |  | Spread contracts (always NULL for producer_merchant — no spread field in CFTC's schema for that category) |
| `open_interest` | REAL |  | Total open interest for the report |

## `cot_gold`

**Source**: CFTC Commitment of Traders (Legacy + Disaggregated) (`cot_pipeline`, gov_regulatory)  
**Cadence**: `manual_only`  
**Rate limit**: ~7-day minimum gap between fetch attempts  

| Field | Type | PK | Description |
|---|---|---|---|
| `report_date` | TEXT | ✓ | PK — CFTC report date (Tuesday) |
| `noncomm_long` | REAL |  | Non-commercial (speculative) long contracts, gold futures |
| `noncomm_short` | REAL |  | Non-commercial (speculative) short contracts, gold futures |
| `open_interest` | REAL |  | Total gold futures open interest, contracts |
| `net_long` | REAL |  | noncomm_long - noncomm_short |
| `net_long_pct_oi` | REAL |  | net_long as % of open_interest |
| `fetched_at` | TEXT |  | Row insert timestamp (not report date) |

## `cot_prices`

**Source**: CFTC Commitment of Traders (Legacy + Disaggregated) (`cot_pipeline`, gov_regulatory)  
**Cadence**: `manual_only`  
**Rate limit**: ~7-day minimum gap between fetch attempts  

| Field | Type | PK | Description |
|---|---|---|---|
| `ticker` | TEXT | ✓ | PK — e.g. SI=F, GC=F |
| `date` | TEXT | ✓ | PK — weekly close date |
| `price` | REAL |  | Close price |

## `cot_silver`

**Source**: CFTC Commitment of Traders (Legacy + Disaggregated) (`cot_pipeline`, gov_regulatory)  
**Cadence**: `manual_only`  
**Rate limit**: ~7-day minimum gap between fetch attempts  

| Field | Type | PK | Description |
|---|---|---|---|
| `report_date` | TEXT | ✓ | PK — CFTC report date (Tuesday) |
| `noncomm_long` | REAL |  | Non-commercial (speculative) long contracts |
| `noncomm_short` | REAL |  | Non-commercial (speculative) short contracts |
| `open_interest` | REAL |  | Total open interest, contracts |
| `net_long` | REAL |  | noncomm_long - noncomm_short |
| `net_long_pct_oi` | REAL |  | net_long as % of open_interest |
| `fetched_at` | TEXT |  | Row insert timestamp (not report date) |

## `delivery_notices`

**Source**: Delivery Notices (`delivery_notices`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | PK (with type) |
| `type` | TEXT | ✓ | PK — 'mtd' or 'ytd' (Delivery Behavior uses ytd for ~85 days of coverage) |
| `daily_issued` | REAL |  | Delivery notices issued that day, contracts |
| `daily_stopped` | REAL |  | Delivery notices stopped that day, contracts |

## `event_calendar`

**Source**: CATCOR — ForexFactory Consensus + ALFRED Actuals (`catcor_consensus_actuals`, calendar_events)  
**Cadence**: `interval`, every 1800s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `event_id` | TEXT | ✓ | PK — deterministic, f'{event_type}_{date}' |
| `event_name` | TEXT |  | Human label |
| `event_type` | TEXT |  | FOMC / CPI / NFP |
| `scheduled_time` | TEXT |  | Event datetime |
| `consensus_value` | REAL |  | From ForexFactory, current-week only |
| `actual_value` | REAL |  | From ALFRED |
| `surprise_delta` | REAL |  | actual - consensus, once both known |
| `source_url` | TEXT |  | Reference link |
| `source_tier` | TEXT |  | Currently always 'government' |

## `forexfactory_calendar`

**Source**: CATCOR — ForexFactory Consensus + ALFRED Actuals (`catcor_consensus_actuals`, calendar_events)  
**Cadence**: `interval`, every 1800s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `week_key` | TEXT | ✓ | PK — that week's Sunday date |
| `title` | TEXT | ✓ | PK — event title, e.g. 'Non-Farm Employment Change' |
| `country` | TEXT | ✓ | PK — currency/country code |
| `event_date` | TEXT | ✓ | PK — scheduled date |
| `impact` | TEXT |  | Low/Medium/High |
| `forecast` | TEXT |  | Consensus forecast as given by the feed |
| `previous` | TEXT |  | Previous period's value |

## `fred_observations`

**Source**: FRED — Money Supply (M2, WALCL, Composition) (`money_supply`, gov_regulatory)  
**Cadence**: `startup`  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `series_id` | TEXT | ✓ | PK (with date) — one of 8 values, see the split-out rows below |
| `date` | TEXT | ✓ | PK — observation date |
| `value` | REAL |  | Series value in native FRED/upstream units — NOT normalized across series_id |

## `futures_curve_spread`

**Source**: Futures Curve Spread (`futures_curve_spread`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `metal` | TEXT | ✓ | PK — 'XAG' or 'XAU' |
| `date` | TEXT | ✓ | PK |
| `front_month_symbol` | TEXT |  | Yahoo contract symbol picked as front month that day (e.g. 'SIU26.CMX') — highest real volume among probed candidates, not necessarily the nearest calendar month |
| `front_month_price` | REAL |  | Front-month daily settlement close, USD |
| `next_month_symbol` | TEXT |  | Second-highest-volume candidate's symbol |
| `next_month_price` | REAL |  | Next-month daily settlement close, USD |
| `curve_spread_pct` | REAL |  | (next_month_price - front_month_price) / front_month_price. Positive = contango, negative = backwardation. NULL (not 0) if either leg has no real price that day. |
| `fetched_at` | TEXT |  | Row upsert timestamp |

## `gold_inventory_aggregate`

**Source**: Comex Gold History (`comex_gold_history`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | <!-- TODO: describe field --> |
| `total` | REAL |  | <!-- TODO: describe field --> |
| `registered` | REAL |  | <!-- TODO: describe field --> |
| `eligible` | REAL |  | <!-- TODO: describe field --> |
| `reg_eligible_ratio` | REAL |  | <!-- TODO: describe field --> |
| `created_at` | TEXT |  | <!-- TODO: describe field --> |

## `gold_inventory_depository`

**Source**: Comex Gold Depositories (`comex_gold_depositories`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | <!-- TODO: describe field --> |
| `depository` | TEXT | ✓ | <!-- TODO: describe field --> |
| `registered` | REAL |  | <!-- TODO: describe field --> |
| `eligible` | REAL |  | <!-- TODO: describe field --> |
| `total` | REAL |  | <!-- TODO: describe field --> |
| `prev_registered` | REAL |  | <!-- TODO: describe field --> |
| `prev_eligible` | REAL |  | <!-- TODO: describe field --> |
| `prev_total` | REAL |  | <!-- TODO: describe field --> |

## `gold_volume_oi`

**Source**: Gold Leverage (`gold_leverage`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | <!-- TODO: describe field --> |
| `open_interest` | REAL |  | <!-- TODO: describe field --> |
| `volume` | REAL |  | <!-- TODO: describe field --> |
| `paper_leverage` | REAL |  | <!-- TODO: describe field --> |
| `created_at` | TEXT |  | <!-- TODO: describe field --> |

## `inventory_aggregate`

**Source**: Comex Silver History (`comex_silver_history`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | PK |
| `total` | REAL |  | Total COMEX silver vault holdings, troy oz |
| `registered` | REAL |  | Registered (deliverable) oz |
| `eligible` | REAL |  | Eligible (non-deliverable) oz |
| `reg_eligible_ratio` | REAL |  | registered / eligible |
| `created_at` | TEXT |  | Row insert timestamp |

## `inventory_depository`

**Source**: Comex Silver Depositories (`comex_silver_depositories`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | PK (with depository) |
| `depository` | TEXT | ✓ | PK — vault name, e.g. 'JPMorgan' |
| `registered` | REAL |  | This vault's registered oz |
| `eligible` | REAL |  | This vault's eligible oz |
| `total` | REAL |  | This vault's total oz |
| `prev_registered` | REAL |  | <!-- TODO: describe field --> |
| `prev_eligible` | REAL |  | <!-- TODO: describe field --> |
| `prev_total` | REAL |  | <!-- TODO: describe field --> |

## `lbma_fix`

**Source**: GoldAPI.io — LBMA Fix (`lbma_fix`, exchange_market)  
**Cadence**: `startup`  
**Rate limit**: 500/month  

| Field | Type | PK | Description |
|---|---|---|---|
| `metal` | TEXT | ✓ | PK — 'XAU' or 'XAG' |
| `fix_type` | TEXT | ✓ | PK — 'AM' for gold (GoldAPI.io exposes no PM-fix-distinct field — gold's real 15:00 London PM fix is NOT available from this source), 'daily' for silver |
| `date` | TEXT | ✓ | PK — calendar date requested, not a verified per-metal fix-moment timestamp (see note) |
| `price_usd` | REAL |  | Fix price, USD/oz |
| `fetched_at` | TEXT |  | Row upsert timestamp |

## `macro_price_reaction`

**Source**: CATCOR — Reaction Snapshot Capture (`catcor_snapshot`, calendar_events)  
**Cadence**: `always_on`, every 60s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `event_id` | TEXT | ✓ | PK (with metal, window) |
| `metal` | TEXT | ✓ | PK — XAG or XAU |
| `window` | TEXT | ✓ | PK — T-30m / T+5m / T+30m / T+2h |
| `price` | REAL |  | Captured price at that window |
| `price_delta_pct` | REAL |  | % change vs. pre-event price |
| `surprise_magnitude` | REAL |  | Copied from event's surprise_delta at capture time |

## `pipeline_runs`

**Source**: CFTC Commitment of Traders (Legacy + Disaggregated) (`cot_pipeline`, gov_regulatory)  
**Cadence**: `manual_only`  
**Rate limit**: ~7-day minimum gap between fetch attempts  

| Field | Type | PK | Description |
|---|---|---|---|
| `id` | INTEGER | ✓ | Always 1 — single-row table |
| `ran_at` | TEXT |  | Timestamp of the last completed pipeline/run.py run |

## `pslv_snapshot`

**Source**: Pslv (`pslv`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | PK |
| `total_oz` | REAL |  | PSLV trust's total silver holdings, oz |
| `nav_per_unit` | REAL |  | Net asset value per unit |
| `total_nav` | REAL |  | Total NAV |
| `units` | REAL |  | Units outstanding |

## `research_log`

**Source**: infrastructure table (no registered upstream source)  

| Field | Type | PK | Description |
|---|---|---|---|
| `id` | INTEGER | ✓ | PK, autoincrement |
| `session_id` | TEXT |  | FK -> research_sessions |
| `claim_text` | TEXT |  | Denormalized copy from the session |
| `source_url` | TEXT |  | Optional |
| `user_read` | TEXT |  | bullish | bearish | neutral |
| `dismissed_at` | TEXT |  | ISO timestamp |
| `dismiss_reason` | TEXT |  | Required, non-empty — why this claim didn't hold up |
| `validation_status` | TEXT |  | correct | incorrect | mixed — reserved for a later validation pass, always NULL today |

## `research_messages`

**Source**: infrastructure table (no registered upstream source)  

| Field | Type | PK | Description |
|---|---|---|---|
| `id` | INTEGER | ✓ | PK, autoincrement |
| `session_id` | TEXT |  | FK -> research_sessions |
| `role` | TEXT |  | user | assistant |
| `content` | TEXT |  | Raw turn text (user) or a small JSON envelope {"final_text": ...} (assistant) |
| `created_at` | TEXT |  | ISO timestamp, preserves ordering |
| `backend` | TEXT |  | assistant rows only — 'anthropic' | 'forge', which backend answered |
| `model` | TEXT |  | assistant rows only — resolved model string actually used |
| `persona` | TEXT |  | assistant rows only — persona filename stem active for this turn |
| `context_blocks` | TEXT |  | user rows only — JSON array of the context blocks checked for this turn |
| `memory_mode` | TEXT |  | user rows only — stateless | accumulating, the mode this turn was sent under |
| `memory_changed` | INTEGER |  | user rows only — 1 if this turn's memory_mode differs from the session's previous turn, else 0; drives the transcript's memory-switch divider |
| `assembled_prompt` | TEXT |  | user rows only — the exact system+messages payload sent to the model, for transcript replay |

## `research_sessions`

**Source**: infrastructure table (no registered upstream source)  

| Field | Type | PK | Description |
|---|---|---|---|
| `session_id` | TEXT | ✓ | PK — UUID |
| `claim_text` | TEXT |  | The pasted claim/first message, as originally entered |
| `source_url` | TEXT |  | Optional |
| `status` | TEXT |  | active | promoted | dismissed — discarded sessions are deleted outright, never a 4th stored value |
| `user_read` | TEXT |  | bullish | bearish | neutral — settable via POST .../read |
| `memory_mode` | TEXT |  | stateless | accumulating — the session's current setting, defaults to accumulating; used to default the turn composer's toggle to wherever it was left |
| `created_at` | TEXT |  | ISO timestamp |
| `updated_at` | TEXT |  | Bumped on every message |

## `shfe_inventory`

**Source**: Shfe Silver History (`shfe_silver_history`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | PK |
| `total_kg` | REAL |  | Total SHFE silver warehouse stock, kg (native unit) |
| `total_oz` | REAL |  | Converted, 1 kg = 32.1507 oz |
| `created_at` | TEXT |  | <!-- TODO: describe field --> |

## `shfe_warehouse`

**Source**: Shfe Warehouses (`shfe_warehouses`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | PK (with warehouse) |
| `warehouse` | TEXT | ✓ | PK — individual SHFE warehouse name |
| `warrant_kg` | REAL |  | Warrant stock at this warehouse, kg |
| `warrant_change_kg` | REAL |  | Day-over-day change, kg |

## `source_health`

**Source**: infrastructure table (no registered upstream source)  

| Field | Type | PK | Description |
|---|---|---|---|
| `source_key` | TEXT | ✓ | <!-- TODO: describe field --> |
| `last_attempt_at` | TEXT |  | <!-- TODO: describe field --> |
| `last_attempt_status` | TEXT |  | <!-- TODO: describe field --> |
| `last_success_at` | TEXT |  | <!-- TODO: describe field --> |
| `last_error` | TEXT |  | <!-- TODO: describe field --> |
| `consecutive_failures` | INTEGER |  | <!-- TODO: describe field --> |

## `spot_price_snapshot`

**Source**: Spot Prices (metalcharts.org) (`spot_prices`, exchange_market)  
**Cadence**: `interval`, every 60s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `series_id` | TEXT | ✓ | PK (with date) — e.g. XAG, XAU |
| `date` | TEXT | ✓ | PK — one row per calendar day, overwritten on every fast-tier tick |
| `price` | REAL |  | Latest price |
| `change_pct_24h` | REAL |  | 24h % change, from upstream |

## `spot_price_tick`

**Source**: Spot Prices (metalcharts.org) (`spot_prices`, exchange_market)  
**Cadence**: `interval`, every 60s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `series_id` | TEXT | ✓ | PK (with ts) — "XAG"/"XAU" (real metalcharts.org spot ticks, this card's source) or "XAG_FUTURES"/"XAU_FUTURES" (Yahoo SI=F/GC=F futures bars, a different instrument backfilled by CATCOR — see the catcor_reactions card) |
| `ts` | TEXT | ✓ | PK — timestamp of this tick |
| `price` | REAL |  | Price at that tick |

## `sqlite_sequence`

**Source**: infrastructure table (no registered upstream source)  

| Field | Type | PK | Description |
|---|---|---|---|
| `name` |  |  | <!-- TODO: describe field --> |
| `seq` |  |  | <!-- TODO: describe field --> |

## `squeeze_case_log`

**Source**: infrastructure table (no registered upstream source)  

| Field | Type | PK | Description |
|---|---|---|---|
| `id` | INTEGER | ✓ | PK, autoincrement |
| `event_name` | TEXT |  | Human label, e.g. '2011 Silver Blow-off' |
| `metal` | TEXT |  | silver / gold |
| `date_range_start` | TEXT |  | <!-- TODO: describe field --> |
| `date_range_end` | TEXT |  | <!-- TODO: describe field --> |
| `cot_reading_snapshot` | TEXT |  | Free text/small JSON — MM net-long %ile at relevant points, hand-recorded |
| `curve_reading_snapshot` | TEXT |  | Free text/small JSON, nullable — curve spread at relevant points, where backfill data was obtainable (best-effort, not guaranteed for cases predating futures_curve_spread's own ingestion start) |
| `mechanism_tag` | TEXT |  | e.g. 'squeeze', 'liquidity_panic', 'other' — 2020 gold is a different mechanism than 2011/2026 silver and is not conflated with it |
| `outcome_notes` | TEXT |  | Free text description of what actually happened to price after — descriptive, not predictive framing, per AV Voice Rules |
| `created_at` | TEXT |  | <!-- TODO: describe field --> |
| `updated_at` | TEXT |  | <!-- TODO: describe field --> |

## `ui_settings`

**Source**: infrastructure table (no registered upstream source)  

| Field | Type | PK | Description |
|---|---|---|---|
| `id` | INTEGER | ✓ | <!-- TODO: describe field --> |
| `pinned_section` | TEXT |  | <!-- TODO: describe field --> |

## `volume_oi`

**Source**: Silver Leverage (`silver_leverage`, exchange_market)  
**Cadence**: `interval`, every 1200s  
**Rate limit**: undocumented — advisory only  

| Field | Type | PK | Description |
|---|---|---|---|
| `date` | TEXT | ✓ | PK |
| `open_interest` | REAL |  | COMEX silver open interest, contracts |
| `volume` | REAL |  | Daily volume, contracts |
| `paper_leverage` | REAL |  | Derived ratio, powers Paper Leverage cards |
| `created_at` | TEXT |  | <!-- TODO: describe field --> |

---

**Coverage**: 149/187 fields documented, 38 pending (`<!-- TODO: describe field -->`).

## Entity groups (by affinity group)

```mermaid
erDiagram
    "event_calendar" {
        TEXT event_id
        TEXT event_name
        TEXT event_type
        TEXT scheduled_time
        REAL consensus_value
        REAL actual_value
    }
    "forexfactory_calendar" {
        TEXT week_key
        TEXT title
        TEXT country
        TEXT event_date
        TEXT impact
        TEXT forecast
    }
    "macro_price_reaction" {
        TEXT event_id
        TEXT metal
        TEXT window
        REAL price
        REAL price_delta_pct
        REAL surprise_magnitude
    }
    "delivery_notices" {
        TEXT date
        TEXT type
        REAL daily_issued
        REAL daily_stopped
    }
    "futures_curve_spread" {
        TEXT metal
        TEXT date
        TEXT front_month_symbol
        REAL front_month_price
        TEXT next_month_symbol
        REAL next_month_price
    }
    "gold_inventory_aggregate" {
        TEXT date
        REAL total
        REAL registered
        REAL eligible
        REAL reg_eligible_ratio
        TEXT created_at
    }
    "gold_inventory_depository" {
        TEXT date
        TEXT depository
        REAL registered
        REAL eligible
        REAL total
        REAL prev_registered
    }
    "gold_volume_oi" {
        TEXT date
        REAL open_interest
        REAL volume
        REAL paper_leverage
        TEXT created_at
    }
    "inventory_aggregate" {
        TEXT date
        REAL total
        REAL registered
        REAL eligible
        REAL reg_eligible_ratio
        TEXT created_at
    }
    "inventory_depository" {
        TEXT date
        TEXT depository
        REAL registered
        REAL eligible
        REAL total
        REAL prev_registered
    }
    "lbma_fix" {
        TEXT metal
        TEXT fix_type
        TEXT date
        REAL price_usd
        TEXT fetched_at
    }
    "pslv_snapshot" {
        TEXT date
        REAL total_oz
        REAL nav_per_unit
        REAL total_nav
        REAL units
    }
    "shfe_inventory" {
        TEXT date
        REAL total_kg
        REAL total_oz
        TEXT created_at
    }
    "shfe_warehouse" {
        TEXT date
        TEXT warehouse
        REAL warrant_kg
        REAL warrant_change_kg
    }
    "spot_price_snapshot" {
        TEXT series_id
        TEXT date
        REAL price
        REAL change_pct_24h
    }
    "spot_price_tick" {
        TEXT series_id
        TEXT ts
        REAL price
    }
    "volume_oi" {
        TEXT date
        REAL open_interest
        REAL volume
        REAL paper_leverage
        TEXT created_at
    }
    "census_trade" {
        TEXT metal
        TEXT flow
        TEXT hs_code
        TEXT cty_code
        TEXT cty_name
        INTEGER year
    }
    "cot_disaggregated" {
        TEXT report_date
        TEXT metal
        TEXT category
        REAL long
        REAL short
        REAL spreading
    }
    "cot_gold" {
        TEXT report_date
        REAL noncomm_long
        REAL noncomm_short
        REAL open_interest
        REAL net_long
        REAL net_long_pct_oi
    }
    "cot_prices" {
        TEXT ticker
        TEXT date
        REAL price
    }
    "cot_silver" {
        TEXT report_date
        REAL noncomm_long
        REAL noncomm_short
        REAL open_interest
        REAL net_long
        REAL net_long_pct_oi
    }
    "fred_observations" {
        TEXT series_id
        TEXT date
        REAL value
    }
    "pipeline_runs" {
        INTEGER id
        TEXT ran_at
    }
```

Infrastructure tables (no registered source): `research_log`, `research_messages`, `research_sessions`, `source_health`, `sqlite_sequence`, `squeeze_case_log`, `ui_settings`