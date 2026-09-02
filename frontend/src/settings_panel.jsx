import { useEffect, useState } from "react";
import DataPanel from "./data_panel";

// Read-only Configuration status — one row per env var AV uses, set/not-set
// only (never the value). `used_by` is derived server-side from each
// source's requires_env. AI_BACKEND is not a secret, so its effective
// value is shown directly. Backed by GET /api/config/status.
function ConfigStatusPanel() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    fetch("/api/config/status")
      .then((r) => r.json())
      .then((j) => setRows(j.data ?? []))
      .catch(() => setRows([]));
  }, []);

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        <span>Configuration status</span>
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-dual-axis-note">
          Which API keys AV can see in its environment. Presence only — the
          actual key values are never read back here or sent to the browser.
          Editing keys through the UI is a deliberate non-feature for now
          (see the cleanup spec); set them in the environment that launches
          the backend.
        </div>
        {rows === null ? (
          <div className="comex-empty">Loading…</div>
        ) : (
          <table className="config-status-table">
            <thead>
              <tr>
                <th>Env var</th>
                <th>Status</th>
                <th>Used by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td><code>{row.key}</code></td>
                  <td>
                    {row.key === "AI_BACKEND" ? (
                      <span className="config-status-pill config-status-pill--set">
                        {row.value}
                      </span>
                    ) : row.set ? (
                      <span className="config-status-pill config-status-pill--set">set</span>
                    ) : (
                      <span className="config-status-pill config-status-pill--unset">not set</span>
                    )}
                  </td>
                  <td className="config-status-usedby">
                    {row.used_by.length ? row.used_by.join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

// The Settings view: opened by the header gear icon, a sibling of the nav
// tabs (not a 7th tab, not a route). Holds what used to be the Data tab —
// source health, refresh controls, per-source cards — plus the new
// read-only Configuration status panel.
export default function SettingsView({ onClose }) {
  return (
    <div className="app-shell">
      <div className="settings-view-header">
        <span className="settings-view-title">Settings</span>
        <button type="button" className="settings-view-close" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <ConfigStatusPanel />
      <DataPanel />
    </div>
  );
}
