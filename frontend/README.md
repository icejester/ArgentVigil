# ArgentVigil — Frontend

React 19 + Vite 5 + Recharts. No state library, no router — one page, seven tab-sections
plus a Settings view. Dev server runs on :5173 via `bash utils/vigil-native.sh start` (Vite HMR
picks up edits automatically); `/api` and `/stack_images` are proxied to the backend on
:8000.

This is an orientation doc. The durable, exhaustive record (per-panel behavior,
interaction history, bug narratives) is the repo-root `CLAUDE.md`; `docs/UI_STANDARDS.md`
is the checked-in interactive-UI convention reference.

## Talking to the backend

Every fetch goes through `src/api_client.js`'s `apiFetch(path, options)` — never a bare
`fetch("/api/...")` call site. It does two things: prefixes `path` with
`import.meta.env.VITE_API_BASE_URL` (default `""` — same-origin relative paths, i.e.
today's dev-proxy behavior, unchanged when unset), then rewrites the literal `/api/...`
prefix to `/api/v1/...` via an internal `versionedPath()` before calling `fetch`. Call
sites in source still read `/api/...` — the `/v1` rewrite and the base-URL prefix both
live in this one helper, so a future origin change or version bump is a one-line edit
here, not a per-call-site sweep. A few files (`research_panel.jsx`, `stack_tracker.jsx`,
`comex_inventory.jsx`, `silver_cot_tracker.jsx`) build request URLs in local
`getJSON`/`postJSON`/`fetchInto`-style wrappers; those wrappers call `apiFetch`
internally, so they get both rewrites for free.

- **Local dev**: `VITE_API_BASE_URL` stays unset; Vite's proxy (`vite.config.js`) forwards
  `/api` and `/stack_images` to `http://localhost:8000`.
- **Containerized deploy** (`docker compose` / `vigil.sh` — any environment, including
  prod itself now): frontend and backend are genuinely different origins (`web`/nginx and
  `api` on that environment's own ports, per `environments/<name>.env`). nginx
  serves the built bundle and reverse-proxies `/stack_images/*` to `api` — `<img
  src="/stack_images/...">` tags need zero code change for this, the proxy is nginx-only.
  CORS on the backend is env-driven (`CORS_ALLOWED_ORIGINS`, no wildcard) rather than the
  old permissive `*`.

## Component map (one file per tab, plus shared modules)

| File | Role |
| --- | --- |
| `src/App.jsx` | Top-level composition: nav (`SECTIONS`, 7 entries — cot, moneySupply, inventory, catcor, research, stack, sanctions), tab state, pinned default tab, health dot, ⚙️ Settings toggle. All sections stay mounted; visibility is CSS-toggled so tab switches never refire mount fetches. |
| `src/api_client.js` | The shared `apiFetch` helper — API base URL + `/api/v1` rewrite, see above. **The** file to touch for any origin/versioning change. |
| `src/silver_cot_tracker.jsx` | Trading tab ("Paper Games"): CoT positioning, GSR, leverage/curve/volume charts, category composition. |
| `src/money_supply.jsx` | Money Supply tab ("Dollars and Sense"): M2/WALCL, balance-sheet composition, QE/QT, Treasury Yields/Auctions/Foreign Holdings, purchasing power. |
| `src/comex_inventory.jsx` | Inventory tab shell + COMEX/SHFE panels; nests `delivery_behavior_panel.jsx`, `market_balance.jsx`, `trade_flow_panel.jsx`. |
| `src/catcor_panel.jsx` | CATCOR timeline + surprise/reaction scatter charts. |
| `src/research_panel.jsx` | Research workbench (sessions, turn controls, dispositions). |
| `src/stack_tracker.jsx` | Stack tab: personal holdings CRUD, grouping/filtering, charts. |
| `src/sanctions_panel.jsx` | OFAC tab: searchable/sortable/grouped table over `ofac_designations`. |
| `src/settings_panel.jsx` | Settings view (⚙️ gear icon, not a nav tab) — `ConfigStatusPanel` + mounts `data_panel.jsx`. |
| `src/data_panel.jsx` | Data-source registry/health rendering — joins `data_editorial.json` against live registry/health routes. |
| `src/data_editorial.json` | Hand-written Data-tab prose/curl/field descriptions — **the** file to edit for editorial content (`data_editorial.js` is a re-export wrapper; never edit it). |
| `src/palette.js` | Shared chart color constants. |
| `src/date_utils.js` | Shared `nearestRowDate` (pin-snap nearest-date matching) + `xTicks`. |
| `src/pinned_date_context.jsx` | `PinnedDateProvider`/`usePinnedDate` — the global cross-tab date pin shared by Trading/Money Supply/Inventory. |
| `src/health_context.jsx` | `HealthProvider`/`useHealthRows` — single shared poll of `/api/health/db`. |

## Conventions (see `docs/UI_STANDARDS.md` before inventing a pattern)

- **Fetch only through `apiFetch`, and only `/db`-suffixed API routes** (plus the sanctioned refresh-command allowlist) — enforced by `tests/test_conventions.py`'s frontend fetch scan.
- **Collapsible panes**: native `<details className="collapsible-pane">`, not useState toggles.
- **Legends are hand-rolled**, horizontal, click-not-hover for detail; clicking a legend row also highlights that series on the chart; every relevant item always listed regardless of current value.
- **Tooltips**: one content component per chart, shared by the live hover `<Tooltip>` and any pinned/fixed rendering — never two copies of the markup.
- **Colors** come from `palette.js` / established series constants, never ad hoc hex values.
- **No client-only persistence** — shared settings (pinned tab, etc.) live server-side in SQLite, not `localStorage`.
- No frontend unit tests by design (the user validates UI by eye); backend conventions tests still scan these files.

## Building / serving

- **Local dev**: Vite dev server (`vigil-native.sh start`), HMR, talks to the backend via its proxy — no build step needed.
- **Containerized deploy**: `npm run build` produces `frontend/dist`, served by nginx (`Dockerfile.frontend`) — the backend has no `/` route and never serves this bundle itself (the old `StaticFiles` mount was removed as part of the API split).
</content>
