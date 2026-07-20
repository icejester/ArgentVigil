# ArgentVigil — Frontend

React 19 + Vite 5 + Recharts. No state library, no router — one page, six tab-sections. Dev server runs on :5173 via `bash utils/vigil.sh start` (Vite HMR picks up edits automatically); `/api` is proxied to the backend on :8000.

This is an orientation doc. The durable, exhaustive record (per-panel behavior, interaction history, bug narratives) is the repo-root `CLAUDE.md`; `docs/UI_STANDARDS.md` is the checked-in interactive-UI convention reference.

## Component map (one file per tab, plus shared modules)

| File | Role |
| --- | --- |
| `src/App.jsx` | Top-level composition: nav, tab state, pinned default tab, health dot. All six sections stay mounted; visibility is CSS-toggled so tab switches never refire mount fetches. |
| `src/silver_cot_tracker.jsx` | Trading tab ("Paper Games"): CoT positioning, GSR, leverage/curve/volume charts, category composition. |
| `src/money_supply.jsx` | Money Supply tab ("Dollars and Sense"): M2/WALCL, balance-sheet composition, QE/QT, purchasing power. |
| `src/comex_inventory.jsx` | Inventory tab shell + COMEX/SHFE panels; nests `delivery_behavior_panel.jsx`, `market_balance.jsx`, `trade_flow_panel.jsx`. |
| `src/catcor_panel.jsx` | CATCOR timeline + surprise/reaction scatter charts. |
| `src/research_panel.jsx` | Research workbench (sessions, turn controls, dispositions). |
| `src/data_panel.jsx` | Data tab rendering — joins `data_editorial.json` against live registry/health routes. |
| `src/data_editorial.json` | Hand-written Data-tab prose/curl/field descriptions — **the** file to edit for editorial content (`data_editorial.js` is a re-export wrapper; never edit it). |
| `src/palette.js` | Shared chart color constants. |
| `src/date_utils.js` | Shared `nearestRowDate` (pin-snap nearest-date matching). |

## Conventions (see `docs/UI_STANDARDS.md` before inventing a pattern)

- **Fetch only `/db`-suffixed API routes** (plus the sanctioned refresh-command allowlist) — enforced by `tests/test_conventions.py`'s frontend fetch scan.
- **Collapsible panes**: native `<details className="collapsible-pane">`, not useState toggles.
- **Legends are hand-rolled**, horizontal, click-not-hover for detail; clicking a legend row also highlights that series on the chart; every relevant item always listed regardless of current value.
- **Tooltips**: one content component per chart, shared by the live hover `<Tooltip>` and any pinned/fixed rendering — never two copies of the markup.
- **Colors** come from `palette.js` / established series constants, never ad hoc hex values.
- **No client-only persistence** — shared settings (pinned tab, etc.) live server-side in SQLite, not `localStorage`.
- No frontend unit tests by design (the user validates UI by eye); backend conventions tests still scan these files.
