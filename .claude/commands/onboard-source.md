---
description: Walk through onboarding a new upstream data source into ArgentVigil's backend/sources.py registry
---

# Onboard a new data source

This command handles the **judgment half** of adding a new upstream data
source — reasoning through its real response shape, quirks, and correct
cadence with the user. It ends by producing a YAML file that
`utils/gen_source_scaffold.py` (the **deterministic half**) consumes to
emit reviewable boilerplate. (The originating spec for this split,
`datasources-spec.md`, has since landed and been retired per this repo's
ephemeral-spec convention — `backend/sources.py`'s own registry/
`CadenceSpec`/`RateLimitSpec` definitions and CLAUDE.md's Standing
architectural rules are the durable record now, not a spec file.)

**Do not skip straight to writing code.** The whole point of splitting
this into judgment (this conversation) → YAML → generator (mechanical)
is that the boilerplate must be structurally identical to every other
source in this codebase — that's what the generator guarantees by
construction. Freehand-writing a new `SourceDefinition` risks quietly
diverging from the established pattern.

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
   - `trigger`: one of three values — `interval` (recurring, on a fixed
     cadence, subject to `enabled_flag` if set) / `always_on` (fired
     unconditionally every `interval_seconds`, no `enabled_flag` ever
     consulted — only if a missed fetch is genuinely irreversible data
     loss; this is rare, CATCOR's reaction-snapshot capture is the only
     current example) / `manual_only` (never ticked on a recurring
     basis — reachable only via the manual "Re-run now" button, plus
     once at boot if `fire_at_startup=True`). There is no separate
     `"startup"` trigger value — a source that should fire once at boot
     and nothing else is `manual_only` with `fire_at_startup=True`; one
     that fires at boot AND then repeats on a schedule is `interval`
     with `fire_at_startup=True` — `fire_at_startup` is an orthogonal
     flag on top of `trigger`, not a fourth trigger of its own (an
     earlier, since-folded-in design briefly had a real fourth
     `"startup"` value dispatched outside the generic scheduler
     entirely; don't resurrect that shape).
   - If `manual_only` (or any trigger) has a real cooldown: `min_gap` +
     `gate_on` — does the gate key off wall-clock time since the last
     fetch ATTEMPT (`gate_on="last_attempt_at"`), or off the PERSISTED
     data's own age (`gate_on="persisted_data_age"`, which additionally
     requires a `persisted_age_fn`)? (See `sources.py`'s `CadenceSpec`
     docstring for why Census and CoT deliberately differ here.)
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
   `data_editorial.json` card stub (a JSON object to append to that
   file's top-level array — **never** `data_editorial.js`, which is only
   a thin re-export wrapper around the JSON since datasources-spec.md's
   editorial/operational split). **Do not apply it automatically** —
   per this repo's Learning Mode default, walk the user through each
   block and let them decide where/how to paste it in.

6. **Flag remaining manual work** explicitly (the generator's own output
   lists this too): filling in the real fetch/parse logic, adding the
   corresponding `db.upsert_*`/`db.get_*` functions to `backend/db.py`,
   registering the new `SourceDefinition` alongside the others in
   `backend/collector.py`'s `register_sources()` (not `main.py` — the
   registry-population block lives with the scheduler post-API-split),
   optionally regenerating `docs/data-dictionary.md`
   (`utils/gen_data_dictionary.py`) to confirm the new table/source shows
   up correctly, and — critically — landing a `CLAUDE.md` update for the
   new source per the Data-tab-update rule (`backend/sources.py` for
   operational metadata, `frontend/src/data_editorial.json` for editorial
   prose).
