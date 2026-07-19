import { useState, useEffect, useCallback } from "react";
import { DATA_EDITORIAL } from "./data_editorial";

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
// expected_interval_s — the backend route stays a thin read plus one
// derived field (expected_interval_s, computed from the source's
// CadenceSpec in backend/sources.py); it still does not compute
// ok/stale/error itself (see CLAUDE.md's Data-tab section). Exported so
// App.jsx's HeaderHealthDot can share this exact rule instead of
// re-implementing it inline (a real duplication this fixes).
export function computeStatus(row, expectedIntervalS) {
  if (!row) return "unknown";
  if (row.last_attempt_status === "error") return "error";
  if (!row.last_success_at) return row.last_attempt_status === "skipped" ? "unknown" : "error";
  if (expectedIntervalS == null) return "ok"; // manual_only/startup sources with no cadence number — no staleness rule applies
  const ageS = (Date.now() - new Date(row.last_success_at).getTime()) / 1000;
  if (ageS > 2 * expectedIntervalS) return "stale";
  return "ok";
}

// One row per source_key — a SourceCard may render several when more than
// one backend source maps to a single frontend card (see data_editorial.js's
// sourceKeys, joined against /api/health/db + /api/data-sources/db by key).
function FetchStatusRow({ sourceKey, meta, healthRow, onRefreshed }) {
  const [refreshing, setRefreshing] = useState(false);

  const status = computeStatus(healthRow, meta?.expected_interval_s ?? 3600);
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

// Story #6: render real enforced state, not a static string that can
// drift from what the code does. min_gap_derived shows a live countdown
// from last_attempt_at + min_gap; numeric_quota shows the quota as-is;
// undocumented sources get an explicit advisory badge — never a
// fabricated number.
function RateLimitDisplay({ rateLimit, healthRow }) {
  if (!rateLimit) return null;
  if (rateLimit.kind === "numeric_quota") {
    return <span className="data-meta-val">{rateLimit.quota_per_period ?? "(quota not specified)"}</span>;
  }
  if (rateLimit.kind === "min_gap_derived") {
    const lastAttempt = healthRow?.last_attempt_at;
    if (lastAttempt && rateLimit.min_gap_seconds) {
      const elapsedS = (Date.now() - new Date(lastAttempt).getTime()) / 1000;
      const remainingS = rateLimit.min_gap_seconds - elapsedS;
      if (remainingS > 0) {
        const days = Math.ceil(remainingS / 86400);
        return (
          <span className="data-meta-val">
            {rateLimit.note} — next eligible fetch: in {days} day{days === 1 ? "" : "s"}
          </span>
        );
      }
      return <span className="data-meta-val">{rateLimit.note} — eligible now</span>;
    }
    return <span className="data-meta-val">{rateLimit.note}</span>;
  }
  return (
    <span className="data-meta-val data-ratelimit-advisory" title="Reverse-engineered or otherwise undocumented — this is advisory only, not a confirmed limit">
      undocumented — advisory only{rateLimit.note ? ` (${rateLimit.note})` : ""}
    </span>
  );
}

function SourceCard({ editorial, operationalBySourceKey, health, onRefreshed }) {
  // A card can span multiple sourceKeys (e.g. "metalcharts_silver" covers
  // 4 separate registry keys) — cadence/rate-limit are shown per sourceKey
  // via FetchStatusRow below rather than collapsed into one card-level
  // value, since different sourceKeys under one card can have genuinely
  // different cadences (see comex_silver_history vs silver_leverage).
  const sourceKeys = editorial.sourceKeys ?? [];

  return (
    <details className="collapsible-pane">
      <summary className="collapsible-pane-title">
        <span>{editorial.label}</span>
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-delivery-list">
          <div className="comex-delivery-item">
            <div className="comex-delivery-kv">
              <span className="comex-delivery-key">Origin:</span>
              <span className="comex-delivery-val data-meta-val">{editorial.origin}</span>
            </div>
          </div>
          {sourceKeys.map((sourceKey) => {
            const op = operationalBySourceKey[sourceKey];
            return (
              <div className="comex-delivery-item" key={`cadence-${sourceKey}`}>
                <div className="comex-delivery-kv">
                  <span className="comex-delivery-key">{sourceKey} cadence:</span>
                  <span className="comex-delivery-val data-meta-val">
                    {op ? `${op.cadence.trigger}${op.cadence.interval_seconds ? `, every ${op.cadence.interval_seconds}s` : ""}` : "unknown"}
                  </span>
                </div>
              </div>
            );
          })}
          {sourceKeys.map((sourceKey) => (
            <FetchStatusRow
              key={sourceKey}
              sourceKey={sourceKey}
              meta={operationalBySourceKey[sourceKey]?.cadence}
              healthRow={health[sourceKey]}
              onRefreshed={onRefreshed}
            />
          ))}
          {sourceKeys.map((sourceKey) => {
            const op = operationalBySourceKey[sourceKey];
            if (!op) return null;
            return (
              <div className="comex-delivery-item" key={`ratelimit-${sourceKey}`}>
                <div className="comex-delivery-kv">
                  <span className="comex-delivery-key">{sourceKey} rate limit:</span>
                  <RateLimitDisplay rateLimit={op.rate_limit} healthRow={health[sourceKey]} />
                </div>
              </div>
            );
          })}
        </div>

        {editorial.curl && (
          <div>
            <div className="data-curl-header">
              <div className="chart-title">Equivalent curl</div>
              <CopyButton text={editorial.curl} />
            </div>
            <pre className="data-curl-block"><code>{editorial.curl}</code></pre>
          </div>
        )}

        {editorial.note && <div className="comex-dual-axis-note">{editorial.note}</div>}

        {editorial.tables.map((t) => (
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
// up per-source health (grouped by /api/health/db's server-derived `tier`
// field, computed from backend/sources.py's CadenceSpec — see
// SourceDefinition.tier) into a "healthy/total" count per tier. Summary
// only, no controls — the tier enable/disable toggles were removed along
// with refresh_controls.jsx's UI panel and are not reintroduced here.
function TieredLoopSummary({ health }) {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    fetch("/api/refresh/settings")
      .then((r) => r.json())
      .then((j) => setSettings(j.data ?? j))
      .catch(() => setSettings(null));
  }, []);

  const tierRollup = (tier) => {
    let total = 0;
    let healthy = 0;
    for (const row of Object.values(health)) {
      if (row.tier !== tier) continue;
      total += 1;
      if (computeStatus(row, row.expected_interval_s) === "ok") healthy += 1;
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
  const [operationalBySourceKey, setOperationalBySourceKey] = useState({});

  const fetchHealth = useCallback(() => {
    fetch("/api/health/db")
      .then((r) => r.json())
      .then((j) => setHealth(j.sources ?? {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchHealth();
    // Operational metadata (cadence/rate-limit/affinity_group) is fetched
    // once per mount, not polled like health — it's derived from
    // backend/sources.py's registry, which doesn't change at runtime.
    fetch("/api/data-sources/db")
      .then((r) => r.json())
      .then((j) => setOperationalBySourceKey(j.sources ?? {}))
      .catch(() => {});
  }, [fetchHealth]);

  return (
    <details className="collapsible-pane" open>
      <summary className="collapsible-pane-title">
        <span>Data Sources &amp; Field Map</span>
      </summary>
      <div className="collapsible-pane-body">
        <div className="comex-dual-axis-note">
          Every table AV persists to <code>runtime/argentvigil.db</code>, where its data
          comes from, and how often it's fetched. Editorial content (this note, per-field
          descriptions, curl examples) is hand-maintained in{" "}
          <code>frontend/src/data_editorial.js</code> — see <code>backend/db.py</code> for
          the live schema and <code>backend/sources.py</code> for the canonical cadence/
          rate-limit registry each card's operational rows below are read from.
        </div>
        <TieredLoopSummary health={health} />
        {DATA_EDITORIAL.map((editorial) => (
          <SourceCard
            key={editorial.key}
            editorial={editorial}
            operationalBySourceKey={operationalBySourceKey}
            health={health}
            onRefreshed={fetchHealth}
          />
        ))}
      </div>
    </details>
  );
}
