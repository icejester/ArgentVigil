import { DATA_SOURCES } from "./data_map";

function SourceCard({ source }) {
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
              <span className="comex-delivery-val">{source.origin}</span>
            </div>
          </div>
          <div className="comex-delivery-item">
            <div className="comex-delivery-kv">
              <span className="comex-delivery-key">Fetch cadence:</span>
              <span className="comex-delivery-val">{source.cadence}</span>
            </div>
          </div>
          <div className="comex-delivery-item">
            <div className="comex-delivery-kv">
              <span className="comex-delivery-key">Rate limit notes:</span>
              <span className="comex-delivery-val">{source.rateLimit}</span>
            </div>
          </div>
        </div>

        {source.curl && (
          <div>
            <div className="chart-title">Equivalent curl</div>
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
                  </tr>
                </thead>
                <tbody>
                  {t.fields.map(([field, desc]) => (
                    <tr key={field}>
                      <td><code>{field}</code></td>
                      <td>{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {t.note && <div className="comex-dual-axis-note">{t.note}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

export default function DataPanel() {
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
        {DATA_SOURCES.map((s) => (
          <SourceCard key={s.key} source={s} />
        ))}
      </div>
    </details>
  );
}
