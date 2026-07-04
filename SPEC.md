# Persist-on-Fetch — Re-architecture Spec

Standing convention for ArgentVigil: **every upstream fetch is persisted locally before anything is returned to the frontend, and the UI never talks to an upstream source directly.** CATCOR's cross-check and ingestion features assume this is already true — this spec is the prerequisite work, not a CATCOR sub-feature.

---

## 1. Why

- CATCOR's whole premise is anchoring claims against "the data I have" — that only holds if AV's database is the actual record, not a pass-through to someone else's live view
- Exchange inventory and money-supply panels already do this (fetch → upsert SQLite → return); the CoT pipeline does not (writes an overwritten JSON cache each run, no historical archive of its own)
- Once persistence is universal, AV's database becomes a de facto point-in-time archive for sources that don't offer one publicly (metalcharts.org inventory, ingested articles, future FedWatch snapshots) — the same value ALFRED provides for FRED series, but for AV's own free-tier/reverse-engineered sources
- Reduces upstream load: "grab what's needed, when needed" instead of re-fetching on every page load

---

## 2. Current State Audit

| Source | Fetch path | Persists today? | Pattern |
|---|---|---|---|
| Exchange inventory (COMEX/SHFE/PSLV, silver + gold) | `main.py` → metalcharts.org / Sprott | Yes | fetch → upsert SQLite → return |
| Money supply (M2SL, WALCL, CPIAUCSL) | `main.py` → FRED | Yes | fetch → upsert `fred_observations` → return |
| Metal price history (XAG/XAU) | `main.py` → Yahoo Finance | Yes | fetch → upsert `fred_observations` → return |
| Market balance | `main.py` reads `silver_market_balance.json` | N/A — local file already, no upstream fetch | manually maintained |
| **CoT positioning** | `pipeline/run.py` → CFTC Socrata | **No** | fetch → compute → overwrite `cache/cot_data.json` |

The CoT pipeline is the one gap: no historical archive of its own, no point-in-time record, relies on Socrata's own retention rather than AV's.

---

## 3. Target Model

1. **Every fetch writes to SQLite before the response is constructed.** No route returns upstream data without a persistence step in between — this becomes a standing rule for any new data source added to AV, not just a retrofit of existing ones.
2. **Frontend reads only from local `/api/*/db/*`-style endpoints.** Any route that currently proxies-and-returns upstream data live gets split into a `/refresh` (fetch + persist, no data shape guarantees) and a `/db` (read from SQLite, what the UI actually calls) — the pattern money supply already uses.
3. **Mutable vs. immutable persistence are different operations, and both are needed:**
   - **Mutable/upsert** — a value that gets corrected or restated (e.g. today's registered ounces, revised-later economic prints). Current pattern is correct for these.
   - **Append-only/immutable** — a fact about a specific moment that must never be overwritten on re-fetch (e.g. a price snapshot at T+5min after an event, the text of an ingested article as of the date pulled). Schema needs to distinguish these explicitly per table, not assume upsert everywhere. Getting this wrong silently destroys AV's own point-in-time record — the exact failure mode ALFRED exists to avoid for FRED data.

---

## 4. Migration Sequence

1. **CoT pipeline** — add a SQLite table (append-only, keyed by report date) alongside or replacing `cache/cot_data.json`; `run.py` writes to both, or fully migrates. Existing signal/percentile computation logic in `compute.py` doesn't change, only the storage target.
2. **Route audit** — confirm every existing `/api/*` route already follows fetch→persist→return; split any that don't into `/refresh` + `/db` pairs.
3. **Frontend audit** — confirm `App.jsx` and child components call only `/db`-style (or otherwise local-read) endpoints, never a route that hits upstream synchronously on page load.
4. **New-source checklist** — before any future data source is added (FedWatch, ingested articles, event calendar, sentiment scores — i.e., all of CATCOR), it must specify mutable-vs-immutable persistence and a `/refresh` + `/db` split as part of its own spec, not as an afterthought.

---

## 5. Open Questions

- **Retention policy.** Unbounded persistence means SQLite grows indefinitely. Not urgent at current data volumes — worth deciding whether the policy is "keep everything, prune later if needed" or something bounded from the start, since retrofitting retention after the fact is harder than designing it in.
- **Refresh cadence per source.** "Grab what's needed, when needed" implies each source gets its own sensible cadence (daily for CoT, on-demand for inventory, scheduled-around-events for anything CATCOR adds) rather than a single global poll interval — worth enumerating per-source once CATCOR's event-driven fetches (Iteration 1's price snapshots) are in the mix.
- **Backfill vs. go-forward-only.** For sources newly gaining persistence (CoT), is historical backfill worth attempting from Socrata's own history, or does the local archive simply start accumulating from migration date forward.
