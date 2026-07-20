# ArgentVigil — Backend

Python / FastAPI service layer. Invoked as `uvicorn backend.main:app` (package-qualified — `backend/` is a real package). Day to day, run it via `bash utils/vigil.sh start` / `restart backend`; always use `.venv`, never bare `python3`.

This is an orientation doc. The durable, exhaustive record (per-route behavior, data quirks, bug history) is the repo-root `CLAUDE.md`.

## Module map

| Module | Role |
| --- | --- |
| `main.py` | FastAPI app: every `_fetch_and_persist_*` function, every `/db` read route, the scheduler loop, refresh/health endpoints. Serves `frontend/dist`. |
| `db.py` | All SQLite persistence (stdlib `sqlite3`, no ORM). Owns `runtime/argentvigil.db` — the one shared database. Importable without the venv (no fastapi/httpx). |
| `sources.py` | Canonical data-source registry: one `SourceDefinition` per upstream (cadence, rate limit, table ownership, env requirements). The scheduler, health routes, and Data tab all read from it. |
| `units.py` | Canonical unit constants (contract sizes, kg→oz). Stdlib-free; the only place these numbers live backend-side. |
| `catcor.py` | CATCOR event calendar, price-tick backfills, reaction snapshot capture. |
| `catcor_research.py` | Research tab: sessions, prompt assembly, model backends (Anthropic / amp-forge), promote/dismiss/discard lifecycle. |
| `delivery_behavior.py` | Derived cross-check signals (reclassification vs. real inflow, FND/LTD date rules, CoT category composition). Computes over data other modules persist. |
| `mc_token.py` | metalcharts.org auth token fetch/cache (single-process). |
| `prompts/` | Research personas — the only contract is a module-level `PROMPT` string; files are auto-discovered, no registration. |

## Core patterns (violating these fails the test suite)

- **Persist-on-fetch**: every upstream fetch writes to SQLite; paired `/db` routes read it back with no upstream call. The frontend only ever reads `/db` routes.
- **One scheduler**: `_schedule_loop` in `main.py` dispatches every source per its `CadenceSpec` (`interval` / `always_on` / `manual_only`, plus `fire_at_startup`). No per-source bespoke loops.
- **Derived values computed at read time**, never persisted (percentiles, `implied_qty_oz`, staleness thresholds).
- **Never manufacture a reading**: upstream "not reported" sentinels become `NULL`; missing inputs yield `NULL`, never `0`.
- **Append-only vs. upsert** is decided by whether the upstream revises published data (CFTC never → append-only; Census/LBMA revise → upsert).
- **New/changed source or table ⇒ same-change updates** to `sources.py` and `frontend/src/data_editorial.json` — the conventions tests enforce this.

## Adjacent pieces

- `pipeline/` (sibling, not in this package): stdlib-only CoT fetch/compute, run manually or via cron (`python3 pipeline/run.py`), persists through `backend/db.py`.
- `seed_data/`: hand-maintained static content (event calendar seed, Silver Institute balance, CME rulebook PDFs).
- `runtime/`: gitignored generated state — just the database and logs.
- `tests/`: pytest + respx; never touches the real DB or live upstreams. Run with `bash utils/vigil.sh test`.
