# ArgentVigil — Backend

Python / FastAPI service layer, split into two processes:
**`api`** (serves every route, no scheduler by default in the containerized deploy) and
**`collector`** (the background fetch scheduler, no HTTP server). Locally via `vigil.sh`,
both still run in one process for a fast inner loop (`RUN_COLLECTOR_IN_PROCESS=true`,
the default) — day to day, run it via `bash utils/vigil.sh start` / `restart backend`;
always use `.venv`, never bare `python3`.

This is an orientation doc. The durable, exhaustive record (per-route behavior, data
quirks, bug history) is the repo-root `CLAUDE.md`.

## Module map

| Module | Role |
| --- | --- |
| `main.py` | FastAPI app: every route (declared on one `api_router`, mounted at both `/api/v1` — the real prefix — and a temporary bare `/api` alias), refresh/health endpoints, CORS (`CORS_ALLOWED_ORIGINS` env var, no wildcard). Has no `/` route and never serves the built frontend — that's `web`'s (nginx's) job in the containerized deploy, Vite's in local dev. Calls `collector.register_sources()` once at module-import time so `api`'s own health/data-source routes see a populated registry regardless of whether a separate `collector` process has run. |
| `collector.py` | The scheduler (`_schedule_loop`) + every `_fetch_and_persist_*` function + `register_sources()` (the canonical `sources.register(...)` calls). Runnable standalone: `python -m backend.collector`, no FastAPI import. `main.py`'s `lifespan` runs the same scheduler in-process by default (`RUN_COLLECTOR_IN_PROCESS=true`, for `vigil.sh`/local dev); the containerized deploy runs `collector` as its own compose service with that flag `false`, and `main.py` still calls `register_sources()` independently at import time since `api`'s own routes need the registry populated in `api`'s process too. |
| `models.py` | Pydantic response models (`response_model=` on routes) — Stack/OFAC/CoT route groups so far, written against each route's real observed return shape. Money Supply/Inventory/CATCOR/Research are a natural follow-on, not yet done. |
| `db.py` | All SQLite persistence (stdlib `sqlite3`, no ORM). Owns `runtime/argentvigil.db` (or `AV_RUNTIME_DIR`-relative, see below) — the one shared database, opened in WAL mode (`PRAGMA journal_mode=WAL` on every `get_conn()`) since `api` and `collector` are genuinely separate processes touching it concurrently in the containerized deploy. Importable without the venv (no fastapi/httpx). |
| `sources.py` | Canonical data-source registry: one `SourceDefinition` per upstream (cadence, rate limit, table ownership, env requirements), populated by `collector.register_sources()`. The scheduler, health routes, and Data tab all read from it. |
| `units.py` | Canonical unit constants (contract sizes, kg→oz). Stdlib-free; the only place these numbers live backend-side. |
| `price_instruments.py` | Canonical price `instrument` identifiers — the closed set written to `spot_price`/`settlement_price`. Stdlib-free, same constraint as `units.py`. |
| `yahoo_prices.py` | Canonical Yahoo Finance chart-API caller — one `fetch_yahoo_bars()` used by every Yahoo call site in `collector.py`/`catcor.py`. |
| `catcor.py` | CATCOR event calendar, price-tick backfills, reaction snapshot capture. |
| `catcor_research.py` | Research tab: sessions, prompt assembly, model backends (Anthropic / amp-forge), promote/dismiss/discard lifecycle. |
| `delivery_behavior.py` | Derived cross-check signals (reclassification vs. real inflow, FND/LTD date rules, CoT category composition). Computes over data other modules persist. |
| `mc_token.py` | metalcharts.org auth token fetch/cache (single-process). |
| `prompts/` | Research personas — the only contract is a module-level `PROMPT` string; files are auto-discovered, no registration. |

## Core patterns (violating these fails the test suite)

- **Persist-on-fetch**: every upstream fetch (in `collector.py`) writes to SQLite; paired `/db` routes (in `main.py`) read it back with no upstream call. The frontend only ever reads `/db` routes.
- **API versioning**: `/api/v1` is the real prefix; bare `/api` is a temporary alias (90-day deprecation window once a `/v2` exists and the frontend has migrated) — see `CLAUDE.md`'s Standing architectural rules.
- **One scheduler, one process boundary**: `_schedule_loop` in `collector.py` dispatches every source per its `CadenceSpec` (`interval` / `always_on` / `manual_only`, plus `fire_at_startup`). `main.py` never runs fetch logic itself — it reaches into `collector.<name>` only at the handful of routes that need shared state (`refresh/settings`, `refresh/force`, per-source interval overrides, `/api/prices`, CATCOR refresh, Research's model-call sites).
- **Derived values computed at read time**, never persisted (percentiles, `implied_qty_oz`, staleness thresholds).
- **Never manufacture a reading**: upstream "not reported" sentinels become `NULL`; missing inputs yield `NULL`, never `0`.
- **Append-only vs. upsert** is decided by whether the upstream revises published data (CFTC never → append-only; Census/LBMA revise → upsert).
- **New/changed source or table ⇒ same-change updates** to `sources.py` and `frontend/src/data_editorial.json` — the conventions tests enforce this.

## Running as two processes vs. one

- **Local dev (`vigil.sh`)**: one `uvicorn backend.main:app` process, `RUN_COLLECTOR_IN_PROCESS` unset/`true` — `main.py`'s `lifespan` starts the scheduler itself, same as before the split. Fastest inner loop, debugger-attachable.
- **Containerized deploy (`docker compose` / `vigil-docker.sh`)**: `api` (uvicorn, `RUN_COLLECTOR_IN_PROCESS=false`) and `collector` (`python -m backend.collector`) are separate containers sharing the same bind-mounted `runtime/` data directory. Killing/restarting either doesn't break the other — `api` serves stale-but-valid `/db` reads if `collector` is down; `collector` keeps fetching if `api` is down.
- `AV_RUNTIME_DIR` env var (read by `db.py`/`stack_db.py`) selects which `runtime/data/{prod,test}` directory a given process reads/writes — set by `vigil.sh` (prod) and `docker-compose.yml` (Test AV) respectively; unset defaults to bare `runtime/`.

## Schema reference

`docs/data-dictionary.md` is a **generated** per-field reference over every table
(`db.py`'s DDL, cross-referenced against `sources.py`'s registry for provenance/cadence/
rate-limit, plus per-field prose pulled from `frontend/src/data_editorial.json`) with a
mermaid ERD grouped by `affinity_group`. It's documentation only — nothing in the app
imports it. It goes stale the moment the schema, registry, or editorial content changes
without a regeneration, so treat it as a snapshot, not a live source of truth; regenerate
with `.venv/bin/python utils/gen_data_dictionary.py` after any DDL/registry/editorial
change, same as the Data-tab-update rule elsewhere in this repo. A column with no
editorial description shows as an explicit `<!-- TODO: describe field -->` rather than a
guess — an honest gap, not silently omitted.

## Adjacent pieces

- `pipeline/` (sibling, not in this package): stdlib-only CoT fetch/compute, run manually or via cron (`python3 pipeline/run.py`), persists through `backend/db.py`.
- `seed_data/`: hand-maintained static content (event calendar seed, Silver Institute balance, CME rulebook PDFs).
- `runtime/`: gitignored generated state — the database(s) and (for `vigil.sh`) logs.
- `tests/`: pytest + respx; never touches the real DB or live upstreams. Run with `bash utils/vigil.sh test`.
</content>
