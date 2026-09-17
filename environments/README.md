# Environments

Each `<name>.env` file here is one containerized ArgentVigil environment —
a disposable or persistent instance of the `docker-compose.yml` stack
(api + collector + web), run alongside every other registered environment
with zero manual port juggling, all through `utils/vigil.sh up <name>`.

`prod` is one of these environments too, as of the containerized-prod
cutover — see `prod.env` in this directory. `utils/vigil-native.sh` (the
old bare-process `vigil.sh`, before the rename) is now only a faster
local-dev fallback that happens to default to the same `runtime/data/prod/`
directory; it must never run at the same time as this directory's `prod`
environment — see `prod.env`'s own comment.

Adding environment #`n` is: copy an existing file, pick two free ports and
a runtime dir, done — no changes to `docker-compose.yml` or the scripts.

## Fields

| Key | Meaning |
|---|---|
| `AV_ENV_NAME` | Must match the filename (without `.env`). Stitched into container names (`av-<name>-api`, `av-<name>-collector`, `av-<name>-web`) and the frontend's `VITE_AV_ENV` build arg (drives the non-prod header indicator). |
| `API_PORT` | Host port the `api` service's :8000 is published on. |
| `WEB_PORT` | Host port the `web` service's :80 is published on. |
| `HOST_RUNTIME_DIR` | Directory bind-mounted to `/app/runtime` inside `api`/`collector` — this environment's own `argentvigil.db`/`stack.db`/`stack_images/`. Never point two environments' `.env` files at the same directory — that reintroduces the exact same-file-open-by-two-writers hazard the prod/test split exists to avoid, and nothing currently checks for it, so treat this as a hard manual rule. |
| `REFRESH_POLICY` | `snapshot` — `utils/refresh-test-db.sh` may overwrite `HOST_RUNTIME_DIR` from prod on demand; this environment's data is disposable. `protected` — that script refuses to target this environment at all, regardless of `UPDATE_MODE`. |
| `UPDATE_MODE` | `live` — the `collector` service (compose profile `live`) is started alongside `api`/`web`, so this environment keeps fetching from real upstreams on its own schedule while it's up. `frozen` — `collector` is never started; this environment only ever serves whatever's already in its DB, until flipped back to `live` and brought up again. Independent of `REFRESH_POLICY` — an environment can be any combination, e.g. `frozen` + `protected` for a pinned reference dataset nothing may touch, or `live` + `snapshot` for a disposable env that both self-updates and can be reseeded from prod. |
| `AI_BACKEND` | Passed through to `api`/`collector`; `forge` unless you want this environment burning real Anthropic spend. |

**Two independent axes, not one** — it's easy to conflate "does this refresh from prod" with "does this update itself from upstream," but they're separate questions answered by separate fields:
- `REFRESH_POLICY` — can `refresh-test-db.sh` overwrite this environment's data *from prod*?
- `UPDATE_MODE` — does this environment fetch fresh data *from live upstreams* (FRED, metalcharts.org, etc.) on its own, via its own `collector` service?

## API keys / secrets

`docker-compose.yml` reads `FRED_API_KEY`/`GAPI_API_KEY`/`CENSUS_API_KEY`/
`ANTHROPIC_API_KEY` as plain `${VAR:-}` interpolations — **not** from
anything in `environments/*.env`. None of these `.env` files carry a real
API key, on purpose (they're the opposite of secret — meant to be
committed and diffed like any other config). Compose resolves `${VAR}`
references in the compose file from whatever's in **the shell that invokes
`docker compose`/`vigil.sh`** at that moment — i.e. it inherits your
real, exported shell environment, the same way `vigil-native.sh`'s bare-process
backend already does.

**This means `utils/vigil.sh up <env>` only has real API keys if the
shell you run it from already has them exported.** If it doesn't, compose
silently falls back to an empty string (`${FRED_API_KEY:-}` → `""`) rather
than erroring — the container boots fine, and that source's fetch function
just quietly no-ops (same "logs a skip message, rest of the app boots
normally" behavior documented in CLAUDE.md's "Running it" section for a
missing key locally). There is no check today that catches this at
`vigil.sh up` time — a key silently missing for a `live`-mode
environment is easy to miss until you notice a `source_health` row stuck
in `error`/`skipped`.

Practically: before running `vigil.sh up prod` (or any `live`-mode
environment where you actually want real upstream data), confirm the
invoking shell has the real keys exported — `env | grep -E
'FRED_API_KEY|GAPI_API_KEY|CENSUS_API_KEY|ANTHROPIC_API_KEY'` — the same
keys `.env.example` at the repo root documents. If you're running this
from a fresh shell, a cron job, or CI, that environment needs its own way
of exporting these before invoking the script; nothing in this framework
does it for you.

## Port bookkeeping

There's no automated port-collision check yet (see the TODO in
`utils/vigil.sh`) — when adding a new environment, eyeball the other
files here and pick a pair that isn't in use by another environment file
*or* by whatever is currently running (`utils/vigil.sh status`
lists live projects). `vigil.sh up` will fail loudly at the Docker
level if you get it wrong (port already bound), it just won't warn you
ahead of time.

## Usage

```bash
utils/vigil.sh up test          # or staging, or any other <name>.env here
utils/vigil.sh status           # all AV-managed compose projects currently up
utils/vigil.sh logs test api
utils/vigil.sh down staging
```

`utils/refresh-test-db.sh <name>` seeds a `snapshot`-mode environment's
`HOST_RUNTIME_DIR` from prod's real data. It reads `environments/<name>.env`
to resolve the destination and to check `REFRESH_POLICY` before touching
anything.
