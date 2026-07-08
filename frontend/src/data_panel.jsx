import { useState, useEffect, useCallback } from "react";
import { DATA_SOURCES } from "./data_map";

const COT_MIN_REFRESH_DAYS = 7;

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      type="button"
      className={`data-copy-btn${copied ? " data-copy-btn--copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function timeAgo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ok/stale/error computed client-side per source_key against its own
// expectedIntervalS — the backend route stays a thin read (see
// dataHealth-spec.md's Route section: two sources of truth for cadence
// would defeat the point of data_map.js being the single one).
function computeStatus(row, expectedIntervalS) {
  if (!row) return "unknown";
  if (row.last_attempt_status === "error") return "error";
  if (!row.last_success_at) return row.last_attempt_status === "skipped" ? "unknown" : "error";
  const ageS = (Date.now() - new Date(row.last_success_at).getTime()) / 1000;
  if (ageS > 2 * expectedIntervalS) return "stale";
  return "ok";
}

// One row per source_key — a SourceCard may render several when more than
// one backend source maps to a single frontend card (see data_map.js's
// sourceKeys/healthMeta).
function FetchStatusRow({ sourceKey, meta, healthRow, onRefreshed }) {
  const [refreshing, setRefreshing] = useState(false);

  const status = computeStatus(healthRow, meta?.expectedIntervalS ?? 3600);
  const lastSuccess = healthRow?.last_success_at;
  const lastError = healthRow?.last_attempt_status === "error" ? healthRow?.last_error : null;

  const isCotPipeline = sourceKey === "cot_pipeline";
  const cotGated =
    isCotPipeline &&
    healthRow?.last_report_date &&
    (Date.now() - new Date(healthRow.last_report_date).getTime()) / 86400000 < COT_MIN_REFRESH_DAYS;

  const handleRefresh = () => {
    if (refreshing || cotGated) return;
    setRefreshing(true);
    fetch(`/api/health/refresh/${sourceKey}`, { method: "POST" })
      .then(() => onRefreshed())
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="data-fetch-row">
      <span className={`health-dot health-dot--${status}`} title={status} />
      <span className="comex-delivery-key">{sourceKey}:</span>
      <span className="data-fetch-timestamp">
        {lastSuccess ? `last success: ${timeAgo(lastSuccess)}` : "no successful fetch recorded yet"}
      </span>
      {lastError && <span className="data-error-text" title={lastError}>{lastError}</span>}
      <button
        type="button"
        className="data-refresh-btn"
        onClick={handleRefresh}
        disabled={refreshing || cotGated}
        title={cotGated ? "CFTC publishes a new report ~weekly — re-enables 7 days after the latest report date" : undefined}
      >
        {refreshing ? "Refreshing…" : cotGated ? "Re-run now (rate-limited)" : "Re-run now"}
      </button>
    </div>
  );
}

function SourceCard({ source, health, onRefreshed }) {
  const cadenceFrequency = source.cadenceFrequency ?? source.cadence;
  const cadenceMechanism = source.cadenceMechanism;

  return (
    <details className="collapsible-pane">
      <summary className="collapsible-pane-title">
        <span>{source.label}</span>
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-delivery-list">
          <div className="comex-delivery-item">
            <div className="comex-delivery-kv">
              <span className="comex-delivery-key">Origin:</span>
              <span className="comex-delivery-val data-meta-val">{source.origin}</span>
            </div>
          </div>
          <div className="comex-delivery-item">
            <div className="comex-delivery-kv">
              <span className="comex-delivery-key">Cadence:</span>
              <span className="comex-delivery-val data-meta-val">{cadenceFrequency}</span>
            </div>
            {cadenceMechanism && (
              <div className="comex-delivery-kv">
                <span className="comex-delivery-key">Fetched by:</span>
                <span className="comex-delivery-val data-meta-val">{cadenceMechanism}</span>
              </div>
            )}
          </div>
          {(source.sourceKeys ?? []).map((sourceKey) => (
            <FetchStatusRow
              key={sourceKey}
              sourceKey={sourceKey}
              meta={source.healthMeta?.[sourceKey]}
              healthRow={health[sourceKey]}
              onRefreshed={onRefreshed}
            />
          ))}
          <div className="comex-delivery-item">
            <div className="comex-delivery-kv">
              <span className="comex-delivery-key">Rate limit notes:</span>
              <span className="comex-delivery-val data-meta-val">{source.rateLimit}</span>
            </div>
          </div>
        </div>

        {source.curl && (
          <div>
            <div className="data-curl-header">
              <div className="chart-title">Equivalent curl</div>
              <CopyButton text={source.curl} />
            </div>
            <pre className="data-curl-block"><code>{source.curl}</code></pre>
          </div>
        )}

        {source.note && <div className="comex-dual-axis-note">{source.note}</div>}

        {source.tables.map((t) => (
          <div key={t.name}>
            <div className="chart-title">{t.name}</div>
            <div className="comex-table-wrap">
              <table className="comex-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Description</th>
                    <th className="data-reference-col">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {t.fields.map(([field, desc, reference]) => (
                    <tr key={field}>
                      <td><code>{field}</code></td>
                      <td>{desc}</td>
                      <td className="data-reference-col">{reference ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {t.note && <div className="comex-dual-axis-note data-table-note">{t.note}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

// Tier-level summary (Story #9) — sits above the per-source card list.
// Reads the existing /api/refresh/settings for enabled/interval, and rolls
// up per-source health (grouped by data_map.js's healthMeta tier field)
// into a "healthy/total" count per tier. Summary only, no controls — the
// tier enable/disable toggles were removed along with refresh_controls.jsx's
// UI panel and are not reintroduced here.
function TieredLoopSummary({ health }) {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    fetch("/api/refresh/settings")
      .then((r) => r.json())
      .then((j) => setSettings(j.data ?? j))
      .catch(() => setSettings(null));
  }, []);

  const tierRollup = (tier, expectedIntervalSForKey) => {
    let total = 0;
    let healthy = 0;
    for (const source of DATA_SOURCES) {
      for (const [sourceKey, meta] of Object.entries(source.healthMeta ?? {})) {
        if (meta.tier !== tier) continue;
        total += 1;
        const status = computeStatus(health[sourceKey], meta.expectedIntervalS);
        if (status === "ok") healthy += 1;
      }
    }
    return { total, healthy };
  };

  const fast = tierRollup("fast");
  const slow = tierRollup("slow");

  if (!settings) return null;

  return (
    <div className="data-health-summary">
      <div className="data-health-summary-row">
        <span className="data-health-summary-tier">Fast</span>
        <span className="data-health-summary-state">
          {settings.fast_enabled ? `enabled, every ${settings.fast_interval_s}s` : "disabled (startup-only fetch)"}
        </span>
        <span className="data-health-summary-rollup">{fast.healthy}/{fast.total} healthy</span>
      </div>
      <div className="data-health-summary-row">
        <span className="data-health-summary-tier">Slow</span>
        <span className="data-health-summary-state">
          {settings.slow_enabled ? `enabled, every ${settings.slow_interval_s}s` : "disabled (startup-only fetch)"}
        </span>
        <span className="data-health-summary-rollup">{slow.healthy}/{slow.total} healthy</span>
      </div>
    </div>
  );
}

export default function DataPanel() {
  const [health, setHealth] = useState({});

  const fetchHealth = useCallback(() => {
    fetch("/api/health/db")
      .then((r) => r.json())
      .then((j) => setHealth(j.sources ?? {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        <span>Data Sources &amp; Field Map</span>
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-dual-axis-note">
          Every table AV persists to <code>runtime/argentvigil.db</code>, where its data
          comes from, and how often it's fetched. Hand-maintained — see{" "}
          <code>backend/db.py</code> for the live schema and <code>CLAUDE.md</code>'s
          Data flow section for the full mechanism behind each source.
        </div>
        <TieredLoopSummary health={health} />
        {DATA_SOURCES.map((s) => (
          <SourceCard key={s.key} source={s} health={health} onRefreshed={fetchHealth} />
        ))}
      </div>
    </details>
  );
}
