# ArgentVigil — MVP Build Spec

## 1. What this is

ArgentVigil is a silver / precious-metals macro tracker for a long-horizon (10–15yr),
dollar-cost-averaging physical silver accumulator. The user's framing: this is
**"selling dollars, not buying silver"** — a currency-debasement hedge, not a
speculative trade. The tool's job is to measure whether the speculative futures
crowd is crowded-long or capitulated, not to predict price.

"Back up the truck" = a reserve/dry-powder strategy: the user holds back some
allocation specifically to deploy harder when a genuine speculative washout occurs.
The core analytical question the app answers every week: **has the speculative
crowd actually capitulated, or is this just a normal pullback?**

## 2. Tone / content rules (hard constraints)

These are non-negotiable product requirements, not style suggestions:

- **No fake-precise price targets.** Never output a specific price level as if it
  were a prediction.
- **No fear-porn / doomer content treated as data.** Manipulation-narrative blogs,
  "hidden demand" dealer marketing copy, and Reddit-style alarmism are explicitly
  excluded as inputs or framing. Documented structural facts (e.g. COMEX registered
  inventory draws, Shanghai-COMEX spread, lease rates) are fine; vibes are not.
- **No unsolicited risk-tolerance commentary.** The app doesn't tell the user
  whether they're taking on too much risk.
- **Push back, don't cheerlead.** If a signal reading would normally invite
  overconfident "to the moon" framing, the copy should stay measured and flag
  uncertainty instead.
- **Be explicit about staleness.** CoT data is one week old by the time it's
  published (data as of Tuesday, released Friday) — surface this in the UI, don't
  bury it.

## 3. Core signal (the MVP's reason to exist)

**Source:** CFTC Commitment of Traders (CoT) report, **Legacy Futures-Only**,
COMEX Silver, contract code **084691**.
**API:** CFTC Public Reporting Environment (PRE), Socrata-based, at
`publicreporting.cftc.gov`. Supports query by date range and contract market,
returns CSV/JSON/XML.

**Calculation:**
1. Pull Non-Commercial (managed money / speculative) Long and Short positions.
2. `net_long = noncommercial_long - noncommercial_short`
3. `net_long_pct_oi = net_long / open_interest` — expressed as % of open interest,
   *not* raw contracts, so it stays comparable across years as market size shifts.
4. Compute the trailing historical percentile of `net_long_pct_oi` against a
   lookback window.
5. **Compute this for both a 2-year and a 5-year lookback window, side by side.**
   This isn't cosmetic — the user specifically wants to stress-test whether the
   two windows diverge, since silver's positioning extremes have reportedly been
   getting more compressed/frequent in recent cycles, which a fixed window can
   understate.

**Signal classification (illustrative thresholds — make these configurable, not
hardcoded magic numbers):**
- High percentile (e.g. top decile) → "Specs crowded long — caution" (downside
  flush risk)
- Low percentile / net short (e.g. bottom decile) → "Specs capitulated — back-up-
  the-truck zone" (accumulation signal)
- Everything else → "Normal range — no signal"

Show the 2yr and 5yr percentile and classification side by side; if they disagree,
say so plainly rather than picking one.

## 4. Macro watchlist (secondary context panel, not the headline signal)

Display as supporting context around the CoT signal, not as additional manufactured
"signals":

- Fed policy stance (Chair Warsh era) — qualitative/news-driven, not a hard number
- DXY (US Dollar Index)
- Core PCE (BEA) — the Fed's preferred inflation gauge
- Fed H.4.1 weekly balance sheet release — QE/QT pace
- COMEX registered silver inventory (drawdown trend)
- Shanghai-COMEX spread
- Gold/silver ratio
- Annual/structural context (low frequency, refresh manually or quarterly): Silver
  Institute World Silver Survey figures — supply/demand deficit, solar/PV thrifting
  trend. Explicitly exclude unfalsifiable "hidden demand" categories (e.g. defense/
  aerospace estimates) from any computed signal — these can be mentioned as a
  citable data gap/footnote at most, never as a number feeding a calculation.

## 5. MVP scope

### In scope
1. **Data pipeline (Python, standard library only — no third-party deps)**
   - Query CFTC PRE Socrata API for COMEX Silver (084691), Legacy Futures-Only.
   - Fetch sufficient history to support a 5-year trailing percentile (so pull at
     least ~6 years of weekly data to have a full 5yr window from day one).
   - Compute `net_long_pct_oi` per week.
   - Compute trailing 2yr and 5yr percentile of the latest reading against history.
   - Classify into signal buckets (Sec. 3).
   - Cache results locally (flat file — JSON or CSV) so the frontend doesn't need
     to hit the API on every load.
   - Handle the one-week publish lag gracefully (don't error if "this week" isn't
     posted yet; fall back to most recent available date and label it clearly).
2. **Frontend (React)**
   - Time series chart of `net_long_pct_oi` over time (at least the 5yr window).
   - Signal banner showing current classification, with 2yr and 5yr percentile
     shown side by side.
   - Explicit "data as of [date], published [date]" staleness label.
   - Macro watchlist panel (Sec. 4) — static/manual-entry fields are acceptable for
     MVP; live-fetching every macro series is out of scope for v1.
   - No price-target displays anywhere in the UI.
3. **Config**
   - Percentile thresholds for "crowded"/"capitulated" buckets should be constants
     in one place, easy to tune later — not hardcoded inline in multiple spots.

### Out of scope for MVP (note but don't build)
- Automated/live macro data feeds beyond CoT (DXY, PCE, etc. can be manually
  updated fields for now)
- Alerting/notifications
- Multi-asset support (gold-only or platinum tracking) — silver only for v1
- User accounts / persistence beyond local cache

## 5a. Signal validation: historical hit-rate analysis

**Purpose:** Descriptive, not predictive. Answer the question: "At past positioning
extremes, was the crowd wrong?" This validates whether the crowded/capitulated
thresholds in config are meaningful or arbitrary, and gives an honest track record
for the signal.

**Hard constraints (same tone rules as Sec. 2 apply):**
- Present as historical hit rate only — never as a forward prediction.
- No price targets. "Price was higher 8 weeks later in X of Y cases" is acceptable.
  "Silver will go to $X" is not.
- Make the sample size visible. If there are only 6 historical crowded-long events,
  say so — don't let a thin sample look authoritative.

**Price data source:** FRED API (St. Louis Fed), LBMA silver price series.
Standard library fetch, same pattern as the CFTC pipeline. Cache alongside CoT
data. Series ID: `SLVPRUSD` (LBMA Silver Price, USD, daily — use Friday close
or nearest available to align with CoT report week).

**Lookahead windows:** 4 weeks and 8 weeks.

**What to compute (per signal zone — crowded and capitulated separately):**
1. Find all historical weeks where `net_long_pct_oi` percentile (5yr window)
   crossed into the crowded zone (≥ CROWDED_THRESHOLD) or capitulated zone
   (≤ CAPITULATED_THRESHOLD).
2. For each such week, record the silver price at signal date and at +4w / +8w.
3. Compute: % of cases where price was lower at +4w / +8w (for crowded signal)
   and % of cases where price was higher at +4w / +8w (for capitulated signal).
4. Show median and range of price change, not just win rate — a signal that's
   right 70% of the time but the losses are 3× the gains is not a good signal.

**Frontend:** A separate collapsible "Signal Track Record" panel, clearly labeled
as historical description. Show a small table per signal zone with sample count,
4w hit rate, 8w hit rate, median price change, and range. If sample count < 5,
show a prominent caveat that the sample is too thin to draw conclusions.

**Pipeline:** Add `pipeline/price_fetch.py` for the FRED fetch and extend
`pipeline/compute.py` to join price data and compute the hit-rate stats. Add
results to the cache JSON under a `signal_track_record` key.

## 6. Prior context Claude Code should know

- Two earlier artifacts existed but were built against **estimated** historical
  data due to zip-file access issues with CFTC's legacy bulk data format — they
  need a full rebuild against the **PRE Socrata API**, not the old zip files.
- Prior filenames used: a Python script for the data/signal pipeline, and a React
  component `silver_cot_tracker.jsx` for the chart + signal banner. Reuse those
  names/roles as a starting structure if convenient, but rebuild the actual data
  logic from scratch against live API data rather than patching the estimated
  baseline.

## 7. Acceptance criteria

- [ ] Running the pipeline pulls real CoT data for contract 084691 from the PRE API
      (no estimated/placeholder data).
- [ ] `net_long_pct_oi` is computed correctly as a percentage of open interest.
- [ ] Both 2yr and 5yr trailing percentiles are computed and displayed together.
- [ ] The signal banner shows one of the three classifications with the current
      percentile values, and visibly states the as-of/published dates.
- [ ] No price targets anywhere in the output.
- [ ] Macro watchlist fields are present (even if manually populated) and clearly
      separated from the CoT signal itself.