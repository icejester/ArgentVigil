# ArgentVigil v2.29.0

Silver market observability, with gold as comparative context. AV exists to help understand the silver market as it actually is — paper positioning, physical movement, and the currency it's priced in — not to trade it. No price targets, no predictions, no risk commentary: instrumentation built to be right about what already happened.

This doc has three altitudes: **Business Level** (what the app does and why, for someone who knows the market but not the code), **Tech Level** (how it's built and run), and **Next Up** (where it's headed). Exhaustive per-panel behavior, data quirks, and development history live in `CLAUDE.md` — the durable engineering record. `backend/README.md` and `frontend/README.md` carry per-layer tech orientation.

> **Version binding**: this file and `CLAUDE.md` share the version number in their title line. The test suite (`tests/test_conventions.py`) fails if they drift — bump both together on feature completion.

---

## BUSINESS LEVEL

### The Story, Overview & Goals

All of this started with my 50th birthday. Literally to the day — stroke of midnight — my social media feed became little other than "boner pills" and "monetary debasement." While "male enhancement" wasn't something I believed I needed, I can't say the same for the panic that ensued from watching all the bullion pushers on YouTube. I bought into the idea that we, collectively as a nation, and a planet, were running out of silver.

As a "good greek boy," I was raised with a heavy respect for silver. It was valuable. It was "lucky." If you ever found a silver quarter, you stashed it away for when you really **needed** it.

I bought "heavy" into the ramp-up of February 2026. The numbers aren't **really** important, especially because the definition of "heavy" changes more or less per person.

That being said, I quickly realized that unless I was willing to lose a LOT, I wasn't going to make money in the short term, so I switched my thinking on it, (some may call that "cope") and decided that the money was deteriorating anyway. Dollars, in my mind, became useless for anything other than a means of transacting.

**I'm not buying silver. I'm selling dollars.**

That reframe is the governing idea behind AV: separating "the futures crowd changed its mind" from "metal is actually moving" from "the currency itself is being debased," instead of blurring all three into one number and one feeling.

AV is an observability layer over the silver market, built on the idea that silver and gold are the measuring stick, not the thing being measured. The metal doesn't move — the dollar does. Every panel here is ultimately reading the dollar's condition off of something that holds still: paper positioning, physical supply, and the money it's all priced in.

### Functions / Panels

#### Trading ("Paper Games")

Silver doesn't move — traders' opinions of the dollar do. This panel reads those opinions off the paper market, but not every sub-panel is reading the same thing. **CoT positioning** is the actual sentiment read: weekly CFTC Commitment of Traders data, normalized as **net-long % of open interest** so a 2011 reading and today's are directly comparable, then ranked against rolling 2-year and 5-year percentiles — ≥90th means the crowd is crowded long (a bet the dollar keeps sliding), ≤10th means genuinely capitulated (that bet unwound). *Who* holds the longs (producers/merchants vs. swap dealers vs. managed money vs. other reportables) sharpens that read further — a hedge fund and a commercial aren't saying the same thing. **Daily volume** adds conviction to it: a positioning shift on heavy volume is a stronger signal than the same shift on thin trading.

The rest of the panel isn't sentiment, and doesn't pretend to be. **Paper leverage** (open interest in ounces vs. registered deliverable metal — silver runs ~5–6× more paper claims than metal that could actually settle them) is structural, not a mood — it moves with the paper market's own growth or shrinkage. The **futures curve spread** (contango vs. backwardation) is a physical-tightness tell, not a feeling — it's useful precisely because it can agree or disagree with what the crowd is doing (capitulated positioning *and* deepening backwardation together is a much stronger story than either alone). Daily highs/lows are price action, downstream of sentiment plus everything else that moves a market that day — reading a wide range as "traders were scared" is an inferential leap this panel deliberately doesn't make on its own.

None of it is a price call — it's a read on how stretched the crowd's dollar-skepticism currently is, and whether the metal underneath, and the market it trades in, actually back that read up.

#### Inventory ("Stock & Flow")

Trading is opinion. Inventory is the thing the opinion would eventually have to settle against — metal actually changing state or location, not sentiment about it. COMEX (New York) registered vs. eligible inventory by individual vault — **registered is warranted for delivery, eligible is just stored** — plus SHFE (Shanghai) warehouse stocks, PSLV's custodial holdings as an investment-demand proxy, and daily delivery notices. A nested **Delivery Behavior** layer is the honesty check on the paper story: it flags days where registered inventory jumped but almost no real delivery volume came with it — paper reshuffling wearing an inflow costume, not actual metal movement — and computes First Notice Day / Last Trade Day from COMEX's own contract rules.

This tab also answers the question that started all of this: are we actually running out of silver? Not with a take — with the Silver Institute's annual supply/demand balance (the real structural deficit, kept deliberately separate from short-term noise), estimated above-ground stock with an honest ±20% uncertainty band, and U.S. **trade flow** by country from Census data, so import mix can be checked against the shortage story rather than taken on a YouTube bullion pusher's word. A personal stack calculator sits alongside it, for scale.

#### Money Supply ("Dollars and Sense")

The denominator side of every metals chart. M2 money stock with the Fed's balance sheet (WALCL) drawn as the share of M2 it represents; a look inside that balance sheet split correctly into **assets** (Treasuries, MBS, discount-window lending) and **liabilities** (bank reserves, reverse repo) — two sides of one balance sheet, never summed together; a weekly **QE/QT momentum** view (is the balance sheet growing or shrinking, week by week, against its level); the federal fiscal picture — monthly **outlays/receipts/deficit** topline and by department, **Treasury auction** bid-to-cover and buyer mix, and **foreign holdings of U.S. Treasuries** by country; the Treasury yield curve; and a **purchasing-power race** — $100 of fiat vs. gold vs. silver vs. CPI-adjusted dollars since 2006, rebased against any baseline you pick. If the metals panels ask "is silver moving," this panel asks "or is the yardstick shrinking, and who's still buying the debt that shrinks it?"

#### Money Management

How the Fed is actually put together, and how that reaches the banks people use. **Governance**: the Board of Governors, the 12 regional Reserve Banks and their presidents, and this year's FOMC voters (computed from the statutory rotation). **Bank lookup**: search any FDIC-insured institution, active or long gone, to see its Federal Reserve district, regulator, Fed membership, and holding company. **Transmission chain**: the policy rate → overnight funding → prime/mortgage/card rates → bank credit → discount window → loan officers' own reported lending standards (SLOOS), each charted on its own scale. No composite score, no soundness ratings.

#### CATCOR (Catalyst Correlation)

Did the catalyst actually move the metal? A macro-event calendar (FOMC, CPI, NFP) with consensus expectations and actual prints, and the **surprise** between them, paired against captured silver/gold price reactions at four fixed windows around each event (T−30min, T+5min, T+30min, T+2hr). Observed data only — no interpretation layer, no scoring. The point is to build an honest record of which surprises mattered and which didn't, instead of narrating causation after the fact.

#### Research (sub-pane of CATCOR)

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
- **Frontend**: React 19 + Vite 5 + Recharts. No state library, no router — one page, seven tab-sections plus a gear-icon Settings view, all mounted once and toggled by visibility. Two React contexts wrap the app: `HealthProvider` (one shared `/api/health/db` poll) and `PinnedDateProvider` (one date pin shared across Trading / Money Supply / Inventory).
- **Tests**: pytest + respx, 241 tests in ~11s, never touch the real DB or a live upstream. Includes convention guards that mechanically enforce the documented rules (Settings/Data registry sync, persist-on-fetch, table ownership, nav-list ↔ backend allowlist sync, this doc's version binding).

*(Carve-out: architecture diagram, table schematic, and relationship map to land here. Until then, `utils/gen_data_dictionary.py` generates `docs/data-dictionary.md` from the live DDL + source registry.)*

Layer-level detail: [`backend/README.md`](backend/README.md) · [`frontend/README.md`](frontend/README.md).

### Housekeeping

- **Database**: one shared SQLite file per environment (`argentvigil.db`, gitignored, owned by `backend/db.py`), under that environment's own `runtime/data/<name>/` directory — see `environments/README.md`. There is no per-tab or per-layer database.
- **Primary path — containerized, N named environments** (`environments/*.env`, including `prod` itself as of the containerized-prod cutover):

  ```bash
  bash utils/vigil.sh up prod        # build + start prod's api + collector + web
  bash utils/vigil.sh down prod
  bash utils/vigil.sh status         # every av-* project currently running
  bash utils/vigil.sh logs prod api
  bash utils/vigil.sh test           # full test suite (253 tests, ~12s), pytest args pass through
  bash utils/refresh-test-db.sh test # snapshot prod's data into a snapshot-mode env (on demand)
  python3 pipeline/run.py            # CoT pipeline — run once before first frontend use
  ```

  See `environments/README.md` for the full field reference (ports, `REFRESH_POLICY`,
  `UPDATE_MODE`) and how to add a new environment.

- **Local dev fallback — bare host processes, no Docker** (`utils/vigil-native.sh`,
  formerly this repo's `vigil.sh`) — faster inner loop for local Python/JS edits, or a
  fallback if Docker/Colima itself is unavailable. Must never run against
  `runtime/data/prod/` at the same time as the containerized `prod` environment above
  (see `environments/prod.env`'s own comment for the two-writer hazard this would cause):

  ```bash
  bash utils/vigil-native.sh start            # venv bootstrap + backend :8000 + frontend :5173
  bash utils/vigil-native.sh restart backend  # after backend Python edits
  bash utils/vigil-native.sh stop
  ```

- **Python**: always through `.venv` (`vigil.sh test` or `vigil-native.sh start` creates it) — `pipeline/` is the sole stdlib-only exception.
- **API keys** (all optional at boot; a missing key leaves that source's table empty, nothing crashes): `FRED_API_KEY` (Money Supply, CATCOR actuals), `GAPI_API_KEY` (LBMA fix), `CENSUS_API_KEY` (trade flow), `ANTHROPIC_API_KEY` (Research, only if `AI_BACKEND=anthropic` — default is the local `forge` backend).
- **Versioning**: this README and `CLAUDE.md` carry the same `vX.Y.Z` in their titles, bumped together on feature completion (not per commit); `tests/test_conventions.py` fails on drift.
- **Pre-commit hook**: `utils/githooks/pre-commit` runs the full test suite (~11s) on every commit — including the version-binding guard. Per-clone, one-time setup: `git config core.hooksPath utils/githooks`. Bypass deliberately with `git commit --no-verify`.

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
| Bank registry (institutions, Fed district, regulator, holding company — full history) | FDIC BankFind Suite API | Weekly |
| Rate transmission (IORB, EFFR, SOFR, prime, 30yr mortgage, card rate, bank credit) + SLOOS lending standards | FRED | Weekly |
| Fed Board / Reserve Bank presidents / FOMC rotation | federalreserve.gov (hand-maintained seed, weekly roster drift check) | Weekly check |
| Annual supply/demand balance | Silver Institute World Silver Survey (manually transcribed) | Annual |
| Research (CATCOR sub-pane) chat backend | Anthropic Messages API / amp-forge LAN service | On-demand |
| COMEX rulebook (Ch. 112/113 — Last Trade Day rule) | CME Group, static reference PDFs | One-time reference |

LME (London) requires a paid subscription and is not tracked. CME's per-contract-month open interest (Market Data Platform) is also paid and not integrated — the features that would need it are documented as permanently out of scope rather than approximated.

---

## NEXT UP

Carved out for forward-looking goals, business- or tech-centric. Seeded from threads already flagged in `CLAUDE.md`'s TODO / known-gaps sections; add freely.

- **MVP → release cleanup** (`specs/cleanup-spec.md`, in progress) — Settings page + global date pin (done), per-tab readability refactor pass (in progress), then containerization + a deploy doc. Splitting the data collectors into their own always-on process, independent of the API/UI, is a flagged sub-decision for the containerization stage.

### Business-centric

- **Spot price done right** — a real answer for "spot price now" and "spot history as far back as possible," plus a coherent map of all the distinct prices around silver/gold (spot, front-month futures, LBMA fix, daily closes). Needs its own spec when picked up.
- **Official-source revision visibility** — surface *when* Fed/Census-grade numbers drift across revisions instead of silently overwriting them (ALFRED vintages are the likely mechanism).
- **Squeeze case log frontend** — the hand-maintained historical squeeze/dislocation case table exists in the DB with a read route; it has no UI view yet.

### Tech-centric

- **Architecture diagram + table schematic** in this doc's Stack section (see carve-out above).
- **Repo-root reorg** — the flat root has accumulated; a tiered layout is wanted eventually, not now.
- **Data-health validator layer** — extract per-source `validate_*` contract functions so the live fetch paths and the upstream-contract tests assert the same shape, instead of duplicating it.
- **Frontend test coverage** — deliberately out of scope for the current suite; revisit if UI regressions start costing real time.
