# ArgentVigil v2.17.3

Silver speculative-positioning monitor, with gold as comparative context. Not a trading system: no price targets, no predictions, no risk commentary — instrumentation built to be right about what already happened.

This doc has three altitudes: **Business Level** (what the app does and why, for someone who knows the market but not the code), **Tech Level** (how it's built and run), and **Next Up** (where it's headed). Exhaustive per-panel behavior, data quirks, and development history live in `CLAUDE.md` — the durable engineering record. `backend/README.md` and `frontend/README.md` carry per-layer tech orientation.

> **Version binding**: this file and `CLAUDE.md` share the version number in their title line. The test suite (`tests/test_conventions.py`) fails if they drift — bump both together on feature completion.

---

## BUSINESS LEVEL

### Overview & Goals

*(Intentionally left blank — this section will be iterated on. The one-sentence seed: the governing idea is **selling dollars, not buying metals** — separating "the futures crowd changed its mind" from "metal is actually moving" from "the currency itself is being debased," instead of blurring all three into one number.)*

### Functions / Panels

#### Trading ("Paper Games")

The paper market. Weekly CFTC Commitment of Traders positioning for COMEX silver and gold, normalized as **net-long % of open interest** so a reading from 2011 and one from today are directly comparable, then ranked against rolling 2-year and 5-year percentile windows: ≥90th percentile means the speculative crowd is crowded long (caution), ≤10th means genuinely capitulated (historically the more interesting zone). Around that core sit the supporting reads: the gold/silver ratio; a breakdown of *who* actually holds the long positions (producers/merchants vs. swap dealers vs. managed money vs. other reportables) — because "specs are long" means something different when it's hedge funds vs. commercials; **paper leverage** (total open interest in ounces vs. registered deliverable vault metal — silver runs roughly 5–6× more paper claims than deliverable ounces); the **futures curve spread** (front vs. next contract month, contango vs. backwardation — a physical-tightness tell); and daily trading volume. The question the panel answers: is speculative positioning stretched or washed out, and how does that paper stack up against the metal that could actually settle it?

#### Money Supply ("Dollars and Sense")

The denominator side of every metals chart. M2 money stock with the Fed's balance sheet (WALCL) drawn as the share of M2 it represents; a look inside that balance sheet split correctly into **assets** (Treasuries, MBS, discount-window lending) and **liabilities** (bank reserves, reverse repo) — two sides of one balance sheet, never summed together; a weekly **QE/QT momentum** view (is the balance sheet growing or shrinking, week by week, against its level); the federal fiscal picture — monthly **outlays/receipts/deficit** topline and by department, **Treasury auction** bid-to-cover and buyer mix, and **foreign holdings of U.S. Treasuries** by country; the Treasury yield curve; and a **purchasing-power race** — $100 of fiat vs. gold vs. silver vs. CPI-adjusted dollars since 2006, rebased against any baseline you pick. If the metals panels ask "is silver moving," this panel asks "or is the yardstick shrinking, and who's still buying the debt that shrinks it?"

#### Inventory ("Stock & Flow")

The physical layer. COMEX (New York) registered vs. eligible inventory by individual vault — registered is warranted for delivery, eligible is just stored, and sharp registered drops or reclassification spikes are delivery-pressure signals; SHFE (Shanghai) warehouse stocks for the eastern flow; PSLV's custodial holdings as an investment-demand reference; daily delivery notices (issued/stopped). A nested **Delivery Behavior** layer cross-checks these against each other — flagging days where registered inventory jumped but almost no actual delivery volume accompanied it (paper reshuffling wearing an inflow costume), and computing First Notice Day / Last Trade Day from COMEX's own contract rules. Longer-horizon context: the Silver Institute's annual supply/demand balance (the structural deficit, kept deliberately separate from short-term blips), estimated above-ground stock with explicit ±20% uncertainty, a personal stack calculator, and U.S. **trade flow** — where American silver supply actually comes from, by country, from Census import/export data.

#### CATCOR (Catalyst Correlation)

Did the catalyst actually move the metal? A macro-event calendar (FOMC, CPI, NFP) with consensus expectations and actual prints, and the **surprise** between them, paired against captured silver/gold price reactions at four fixed windows around each event (T−30min, T+5min, T+30min, T+2hr). Observed data only — no interpretation layer, no scoring. The point is to build an honest record of which surprises mattered and which didn't, instead of narrating causation after the fact.

#### Research

A workbench for testing one claim at a time — "SLV shorts are covering," "industrial demand is quietly accelerating" — with a human driving every step. Each turn is assembled from explicitly chosen controls: which model answers, which persona frames it, which AV data blocks get pasted into the prompt (positioning, inventory, money supply, market balance — only what you check), and whether the session remembers prior turns. Nothing is auto-fetched by a model deciding it's relevant. A session ends in a disposition: **promote** (it becomes a tracked event on the CATCOR timeline, hotlinked back to its research record, and gets its price reactions captured like any calendar event), **dismiss** (logged as noise, with a required reason), or **discard**.

#### Settings (⚙️ gear icon, not a tab)

Provenance, health, and configuration. Opened from a gear icon in the header (next to the data-health dot), not the main nav bar. Every table AV persists, where its data comes from, per-field descriptions, fetch cadence and rate-limit posture, and live fetch health (ok / stale / error) per upstream source with a per-source "re-run now" control. Every source that recurs on its own does so at its own real upstream cadence — daily for exchange-inventory data, weekly/monthly for slower macro sources — rather than one shared polling interval, and that same freshness readout follows the data itself: every tab's sub-panels carry their own compact "how stale is this, refresh now" badge. A read-only Configuration-status panel shows which API keys AV can see in its environment (set / not set only — never the value). This is held to a strict rule: any change to what the app stores or fetches must land a matching Settings/Data update in the same change — enforced by the test suite, not by memory.

#### OFAC

A monitoring view over OFAC's full SDN and Consolidated Sanctions List — every current designation, across every program, with real per-entity designation dates going back to 1981. Search matches across every field at once; group by program, entity type, or list source to see counts before drilling in; sort by any column. Each designation also carries its real legal authority (e.g. "Executive Order 14024 (Russia)") wherever OFAC's own data provides one. Not a correlation tool against the metals/debasement data (that idea was tried as a chart overlay and dropped as noise); just a straight list for keeping an eye on what's currently sanctioned. Every entity's aliases, addresses, and ID/registration documents (passport numbers, SWIFT/BIC codes, and more, wherever OFAC publishes them) are captured server-side.

### Where does the data come from, and why?

Primary and free sources, deliberately. CFTC's own Socrata API for positioning (the source of record, not a chart site's copy); FRED/ALFRED for monetary series and *point-in-time* macro actuals (ALFRED's vintages give what was known on the day, not today's revised history); metalcharts.org's reverse-engineered API for COMEX/SHFE vault data and delivery notices; Yahoo Finance for futures/price history; the U.S. Census Bureau for trade flow; the Silver Institute's annual survey for structural supply/demand; ForexFactory for consensus estimates; GoldAPI.io for the LBMA fix; Sprott directly for PSLV.

Two principles govern the roster. **Primary over aggregator** — when a number matters, AV goes to whoever publishes it, and where a free source is known to be unreliable for a field (metalcharts.org's open-interest figure runs ~15% below CFTC's real one), that field is dropped rather than blended. **Persist-on-fetch** — everything is written to AV's own database on arrival and read back from there; the app is a record, not a pass-through, so cross-checks compare one consistent state. Paid sources (LME inventory, CME's per-contract-month open interest) were investigated, confirmed paid, and declined — their absence is documented rather than approximated.

### What are we trying to see / surface?

Three things that usually get blurred into one, kept separate on purpose:

1. **Paper repositioning** — the speculative futures crowd changing its mind (Trading tab). Loud, fast, usually mean-reverting.
2. **Physical movement** — metal actually changing state or location: registered drawdowns, delivery notices, warehouse flows, import mix (Inventory tab). Slow, and much harder to fake.
3. **Currency debasement** — the dollar side of every "silver is up" headline (Money Supply tab).

CATCOR and Research then keep the *narrative* honest: did the catalyst everyone cites actually move the price, and does a claim survive contact with the data AV already holds? Throughout, the data-integrity rules are strict — never manufacture a reading (nulls over zeros, gaps over guesses), no prediction framing, uncertainty stated explicitly.

---

## TECH LEVEL

### Stack / Architecture

- **Backend**: Python / FastAPI + uvicorn, stdlib `sqlite3` (no ORM), `httpx` for all outbound calls. Every upstream source is a `SourceDefinition` in `backend/sources.py` (cadence, rate limit, table ownership) dispatched by one scheduler loop; every fetch persists to SQLite, and the frontend reads only `/db`-suffixed routes — never upstream directly.
- **Pipeline**: `pipeline/` — stdlib-only CoT fetch/compute (CFTC Socrata), runnable without the venv, persists through the same shared `backend/db.py`.
- **Frontend**: React 19 + Vite 5 + Recharts. No state library, no router — one page, six tab-sections, all mounted once and toggled by visibility.
- **Tests**: pytest + respx, ~54 tests in <0.5s, never touch the real DB or a live upstream. Includes convention guards that mechanically enforce the documented rules (Data-tab sync, persist-on-fetch, table ownership, this doc's version binding).

*(Carve-out: architecture diagram, table schematic, and relationship map to land here. Until then, `utils/gen_data_dictionary.py` generates `docs/data-dictionary.md` from the live DDL + source registry.)*

Layer-level detail: [`backend/README.md`](backend/README.md) · [`frontend/README.md`](frontend/README.md).

### Housekeeping

- **Database**: one shared SQLite file, `runtime/argentvigil.db` (gitignored), owned by `backend/db.py`. There is no per-tab or per-layer database.
- **Start / stop** (background daemons, PID-tracked, logs in `runtime/logs/`):

  ```bash
  bash utils/vigil.sh start            # venv bootstrap + backend :8000 + frontend :5173
  bash utils/vigil.sh restart backend  # after backend Python edits
  bash utils/vigil.sh stop
  bash utils/vigil.sh test             # full test suite, pytest args pass through
  python3 pipeline/run.py              # CoT pipeline — run once before first frontend use
  ```

- **Python**: always through `.venv` (`vigil.sh start` creates it) — `pipeline/` is the sole stdlib-only exception.
- **API keys** (all optional at boot; a missing key leaves that source's table empty, nothing crashes): `FRED_API_KEY` (Money Supply, CATCOR actuals), `GAPI_API_KEY` (LBMA fix), `CENSUS_API_KEY` (trade flow), `ANTHROPIC_API_KEY` (Research, only if `AI_BACKEND=anthropic` — default is the local `forge` backend).
- **Versioning**: this README and `CLAUDE.md` carry the same `vX.Y.Z` in their titles, bumped together on feature completion (not per commit); `tests/test_conventions.py` fails on drift.
- **Pre-commit hook**: `utils/githooks/pre-commit` runs the full test suite (<0.5s) on every commit — including the version-binding guard. Per-clone, one-time setup: `git config core.hooksPath utils/githooks`. Bypass deliberately with `git commit --no-verify`.

### Data source detail

| Data | Source | Cadence |
| --- | --- | --- |
| CFTC CoT Legacy + Disaggregated (Silver, Gold) | CFTC Public Reporting Environment Socrata API | Weekly (Friday) |
| Silver / Gold prices, GSR, purchasing-power closes | Yahoo Finance (SLV/GLD ETF, GC=F/SI=F futures) | Weekly / Monthly |
| Futures curve spread (front/next contract months) | Yahoo Finance (deferred-month COMEX symbols) | Daily (slow tier) |
| COMEX inventory, volume/OI, delivery notices (silver + gold) | metalcharts.org proxy (CME Group vaults) | Daily (slow tier) |
| SHFE inventory / warehouses | metalcharts.org proxy (Shanghai Futures Exchange) | Daily (slow tier) |
| PSLV holdings | Sprott direct API | Daily (slow tier) |
| Spot prices (XAG / XAU) | metalcharts.org | Intraday (fast tier) |
| LBMA fix (gold AM, silver daily) | GoldAPI.io (free tier) | Startup + manual re-run |
| M2, Fed balance sheet + composition, Treasury yields, foreign Treasury holdings by country, CPI | FRED (M2SL, WALCL, WRESBAL, RRPONTSYD, WSHOTSL, WSHOMCB, WLCFLPCL, CPIAUCSL, DGS*/DFII10/T10Y2Y, FORLTTREASPOS*) | Monthly / Weekly |
| Federal outlays/receipts/deficit, topline + by department | fiscaldata.treasury.gov Monthly Treasury Statement | Startup + manual re-run |
| Treasury auction bid-to-cover + buyer mix | Treasury Auctions Query API | Startup + manual re-run |
| Macro event actuals (CPI, NFP) | ALFRED (FRED's point-in-time vintage API) | Per release |
| Macro event consensus | ForexFactory free calendar feed | Cached weekly (current Sun–Sat week only) |
| Event-window price reactions (XAG / XAU) | Yahoo Finance intraday (5-min bars) / daily close fallback | Per event |
| International trade flow, HS 7106 (silver) / 7108 (gold) | U.S. Census Bureau International Trade API | Monthly, ~25-day gated |
| OFAC sanctions designations (SDN + Consolidated, all programs, real designation dates) | Treasury OFAC Sanctions List Service (bulk Advanced XML) | Daily (slow tier) |
| Annual supply/demand balance | Silver Institute World Silver Survey (manually transcribed) | Annual |
| Research tab chat backend | Anthropic Messages API / amp-forge LAN service | On-demand |
| COMEX rulebook (Ch. 112/113 — Last Trade Day rule) | CME Group, static reference PDFs | One-time reference |

LME (London) requires a paid subscription and is not tracked. CME's per-contract-month open interest (Market Data Platform) is also paid and not integrated — the features that would need it are documented as permanently out of scope rather than approximated.

---

## NEXT UP

Carved out for forward-looking goals, business- or tech-centric. Seeded from threads already flagged in `CLAUDE.md`'s TODO / known-gaps sections; add freely.

### Business-centric

- **Spot price done right** — a real answer for "spot price now" and "spot history as far back as possible," plus a coherent map of all the distinct prices around silver/gold (spot, front-month futures, LBMA fix, daily closes). Needs its own spec when picked up.
- **Official-source revision visibility** — surface *when* Fed/Census-grade numbers drift across revisions instead of silently overwriting them (ALFRED vintages are the likely mechanism).
- **Squeeze case log frontend** — the hand-maintained historical squeeze/dislocation case table exists in the DB with a read route; it has no UI view yet.

### Tech-centric

- **Architecture diagram + table schematic** in this doc's Stack section (see carve-out above).
- **Repo-root reorg** — the flat root has accumulated; a tiered layout is wanted eventually, not now.
- **Data-health validator layer** — extract per-source `validate_*` contract functions so the live fetch paths and the upstream-contract tests assert the same shape, instead of duplicating it.
- **Frontend test coverage** — deliberately out of scope for the current suite; revisit if UI regressions start costing real time.
