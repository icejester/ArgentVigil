---
description: Walk through onboarding a new upstream data source into ArgentVigil's backend/sources.py registry
---

# Onboard a new data source

Per `specs/datasources-spec.md` Story #4: this command handles the
**judgment half** of adding a new upstream data source — reasoning
through its real response shape, quirks, and correct cadence with the
user. It ends by producing a YAML file that `utils/gen_source_scaffold.py`
(the **deterministic half**) consumes to emit reviewable boilerplate.

**Do not skip straight to writing code.** The whole point of splitting
this into judgment (this conversation) → YAML → generator (mechanical)
is that the boilerplate must be structurally identical to every other
source in this codebase — that's what the generator guarantees by
construction. Freehand-writing a new `SourceDefinition` risks quietly
diverging from the established pattern, which is exactly the problem
`datasources-spec.md` exists to fix.

## Steps

1. **Ask what source and why.** Get the upstream API's name, a sample
   real response (paste it — don't guess the shape), and what AV question
   it answers. If the user doesn't have a sample response yet, ask them
   to fetch one first (e.g. `curl` the endpoint) — this command should
   not fabricate a response shape from documentation alone; upstream
   responses regularly diverge from their own docs (this codebase has
   several documented examples: metalcharts.org's `mtdCumulative`/
   `ytdCumulative` always being 0, Census reporting `qty` as always `"0"`
   for HS 7106/7108, GoldAPI.io silently carrying forward Friday's price
   on weekend dates).

2. **Reason through the response shape together, out loud:**
   - What does a "normal" row look like? What fields, what types?
   - Does this upstream use a null sentinel that isn't literally `null`
     (a magic `0`, a `"-"` string, a repeated stale value)? AV's standing
     nulls-over-zeros convention (see CLAUDE.md's Standing architectural
     rules) means these need to be converted to real `NULL` at persist
     time, not stored as a misleading zero.
   - Are there unit-conversion traps (contracts vs. troy oz, kg vs. oz,
     millions vs. billions — CLAUDE.md documents several real bugs from
     exactly this category)?
   - What's the REAL publication cadence, not the assumed one? (Confirm
     against the upstream's own docs or observed behavior — Census's
     spec'd "~1 month" lag turned out to really be ~2 months, confirmed
     only by testing live.)
   - Does this source have an undocumented or aggressive rate limit?
     Treat anything reverse-engineered as `rate_limit.kind: undocumented`
     unless there's a real published quota.

3. **Decide the CadenceSpec shape** together — walk through
   `backend/sources.py`'s `CadenceSpec` docstring with the user:
   - `trigger`: `interval` (recurring, on a fixed cadence) / `always_on`
     (only if a missed fetch is genuinely irreversible data loss — this
     is rare; CATCOR's reaction-snapshot capture is the only current
     example) / `manual_only` (rate-limited, gated, gone via the manual
     "Re-run now" button) / `startup` (fired once at boot, too slow for
     either tier).
   - If `manual_only` with a real gate: `min_gap` + `gate_on` — does the
     gate key off wall-clock time since the last ATTEMPT, or off the
     PERSISTED data's own age? (See `sources.py`'s CadenceSpec docstring
     for why Census and CoT deliberately differ here.)
   - `enabled_flag`: only set this if the source should be pausable via
     the existing `fast_enabled`/`slow_enabled` settings toggle.

4. **Write the YAML** (see `utils/example_source.yaml` for the exact
   shape) capturing everything decided above. Confirm it with the user
   before running the generator.

5. **Run the generator**:
   ```
   .venv/bin/python utils/gen_source_scaffold.py path/to/source.yaml
   ```
   This prints reviewable boilerplate — a `SourceDefinition` block, a
   fetch-function stub with `# TODO: parse response` at the judgment
   point, a paired `/db` read route, a DDL scaffold, and a
   `data_editorial.js` card stub. **Do not apply it automatically** —
   per this repo's Learning Mode default, walk the user through each
   block and let them decide where/how to paste it in.

6. **Flag remaining manual work** explicitly (the generator's own output
   lists this too): filling in the real fetch/parse logic, adding the
   corresponding `db.upsert_*`/`db.get_*` functions to `backend/db.py`,
   and — critically — landing a `CLAUDE.md` update for the new source per
   the Data-tab-update rule (`backend/sources.py` for operational
   metadata, `frontend/src/data_editorial.js` for editorial prose).
