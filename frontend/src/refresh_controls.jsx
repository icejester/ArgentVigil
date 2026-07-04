import { useState, useEffect } from "react";

// Backend owns the actual refresh cadence (two tiers: fast for spot prices —
// feeds the CoT panel's Paper Leverage cards — and slow for everything else,
// mostly Stock & Flow's exchange-inventory data — see main.py's lifespan
// background tasks). Both tiers default OFF server-side: startup does one
// fetch to populate the DB, then each tier stays idle until toggled on here
// (or the user hits Force update). This control reads/writes that
// server-side setting. App-level (not scoped to one panel) since the two
// tiers span both the CoT and Stock & Flow panels.

const INTERVAL_OPTIONS_FAST = [30, 60, 120, 300];
const INTERVAL_OPTIONS_SLOW = [300, 600, 1200, 1800, 3600];

// Dispatched on window after a successful force-update so panels can re-fetch
// their own /db data immediately instead of waiting for their next poll tick.
export const FORCE_REFRESH_EVENT = "av:force-refresh";

export default function RefreshControls() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [forceResult, setForceResult] = useState(null); // {at, succeeded, failed} | {at, error}

  useEffect(() => {
    fetch("/api/refresh/settings")
      .then((r) => r.json())
      .then((j) => setSettings(j.data ?? null))
      .catch(() => {});
  }, []);

  async function updateSetting(key, value) {
    setSaving(true);
    try {
      const r = await fetch("/api/refresh/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const j = await r.json();
      setSettings(j.data ?? null);
    } catch (e) {
      // leave settings as-is on failure
    } finally {
      setSaving(false);
    }
  }

  async function forceUpdate() {
    setForcing(true);
    try {
      const r = await fetch("/api/refresh/force", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setForceResult({ at: Date.now(), succeeded: j.succeeded, failed: j.failed });
      // Only tell panels to re-fetch if at least something actually succeeded —
      // otherwise they'd just re-read the same (unchanged) DB rows.
      if (j.succeeded > 0) {
        window.dispatchEvent(new CustomEvent(FORCE_REFRESH_EVENT));
      }
    } catch (e) {
      setForceResult({ at: Date.now(), error: e.message });
    } finally {
      setForcing(false);
    }
  }

  if (!settings) return null;

  return (
    <div className="refresh-controls">
      <div className="refresh-controls-row">
        <label className="refresh-controls-toggle">
          <input
            type="checkbox"
            checked={settings.fast_enabled}
            disabled={saving}
            onChange={(e) => updateSetting("fast_enabled", e.target.checked)}
          />
          Prices
        </label>
        <select
          value={settings.fast_interval_s}
          disabled={saving}
          onChange={(e) => updateSetting("fast_interval_s", Number(e.target.value))}
        >
          {INTERVAL_OPTIONS_FAST.map((s) => (
            <option key={s} value={s}>every {s}s</option>
          ))}
        </select>
      </div>
      <div className="refresh-controls-row">
        <label className="refresh-controls-toggle">
          <input
            type="checkbox"
            checked={settings.slow_enabled}
            disabled={saving}
            onChange={(e) => updateSetting("slow_enabled", e.target.checked)}
          />
          Macro
        </label>
        <select
          value={settings.slow_interval_s}
          disabled={saving}
          onChange={(e) => updateSetting("slow_interval_s", Number(e.target.value))}
        >
          {INTERVAL_OPTIONS_SLOW.map((s) => (
            <option key={s} value={s}>every {Math.round(s / 60)}min</option>
          ))}
        </select>
      </div>
      <div className="refresh-controls-row">
        <button className="refresh-controls-force" onClick={forceUpdate} disabled={forcing}>
          {forcing ? "Updating…" : "Force update"}
        </button>
      </div>
      {forceResult && !forcing && (
        <div className="refresh-controls-row">
          {forceResult.error || forceResult.failed > 0 ? (
            <span className="refresh-controls-note refresh-controls-note--error">
              {new Date(forceResult.at).toLocaleTimeString()} — update failed
              {forceResult.error ? `: ${forceResult.error}` : ` (${forceResult.failed} of ${forceResult.succeeded + forceResult.failed} sources unreachable)`}
            </span>
          ) : (
            <span className="refresh-controls-note">
              DB updated {new Date(forceResult.at).toLocaleTimeString()} — panels refreshing…
            </span>
          )}
        </div>
      )}
    </div>
  );
}
