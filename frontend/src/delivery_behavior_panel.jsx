import { useState, useEffect, useCallback } from "react";
import {
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { FORCE_REFRESH_EVENT } from "./refresh_controls";

function DeficitContextChart({ rows }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={rows} margin={{ top: 4, right: 20, left: 12, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
        <XAxis dataKey="year" tick={{ fill: "#8a94a6", fontSize: 11 }} />
        <YAxis
          tick={{ fill: "#8a94a6", fontSize: 11 }}
          label={{ value: "Moz", position: "insideTopLeft", fill: "#5a6278", fontSize: 11 }}
        />
        <Tooltip
          contentStyle={{ background: "#1a1f2b", border: "1px solid #2e3547" }}
          labelStyle={{ color: "#c8d0de" }}
          formatter={(v) => [v != null ? `${v.toFixed(1)} Moz` : "—", "Annual balance"]}
        />
        <ReferenceLine y={0} stroke="#4a5268" />
        <Bar dataKey="net_balance_moz">
          {rows.map((r, i) => (
            <Cell key={i} fill={r.net_balance_moz >= 0 ? "#4caf76" : "#e05252"} />
          ))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function ReclassificationTable({ reclassification }) {
  if (!reclassification.available) {
    return (
      <div className="comex-empty">
        {reclassification.reason}
      </div>
    );
  }

  const flagged = reclassification.days.filter((d) => d.flagged);
  const coverageNote = `Delivery-notice data is only available for ${reclassification.days_with_coverage} day(s) so far — days without a matching delivery-notice record are excluded rather than assumed clean.`;

  if (flagged.length === 0) {
    return (
      <div className="flow-panel-note">
        No days with registered-inventory increases were flagged among the{" "}
        {reclassification.days.length} day(s) with matching delivery-notice data.{" "}
        {coverageNote}
      </div>
    );
  }

  return (
    <>
      <div className="flow-panel-note">
        Days where registered inventory rose but same-day delivery-notice volume (issued +
        stopped) covered less than 10% of that increase — consistent with reclassification
        of existing eligible stock rather than fresh metal arriving. Structural fact, not an
        implication of wrongdoing. {coverageNote}
      </div>
      <div className="comex-table-wrap">
        <table className="comex-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Registered Δ (oz)</th>
              <th>Delivery volume (oz)</th>
            </tr>
          </thead>
          <tbody>
            {flagged.map((d) => (
              <tr key={d.date}>
                <td>{d.date}</td>
                <td>{d.registered_delta.toLocaleString()}</td>
                <td>{d.delivery_volume_oz.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function useDeliveryBehavior(metal) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/delivery-behavior/db?metal=${metal}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json.data ?? null);
    } catch (e) {
      setError(e.message);
    }
  }, [metal]);

  useEffect(() => {
    fetchAll();
    window.addEventListener(FORCE_REFRESH_EVENT, fetchAll);
    return () => window.removeEventListener(FORCE_REFRESH_EVENT, fetchAll);
  }, [fetchAll]);

  return { data, error };
}

export default function DeliveryBehaviorPanel() {
  const [metal, setMetal] = useState("XAG");
  const { data, error } = useDeliveryBehavior(metal);

  return (
    <>
      <div className="comex-panel">
        <div className="comex-panel-header">
          Reclassification vs. Real Inflow
          <select value={metal} onChange={(e) => setMetal(e.target.value)}>
            <option value="XAG">Silver</option>
            <option value="XAU">Gold</option>
          </select>
        </div>

        {data ? (
          <ReclassificationTable reclassification={data.reclassification} />
        ) : error ? (
          <div className="comex-empty">
            No data available.
            <div className="comex-empty-note">{error}</div>
          </div>
        ) : (
          <div className="comex-empty">Loading…</div>
        )}
      </div>

      <div className="comex-panel">
        <div className="comex-panel-header">Short-Term Anomaly vs. Structural Deficit</div>
        <div className="flow-panel-note">
          Annual net balance (Silver Institute) for scale context — a short-term delivery
          anomaly above is a distinct signal from this multi-year structural trend, not
          evidence of it.
        </div>
        {data?.deficit_context?.annual_net_balance_moz?.length > 0 ? (
          <DeficitContextChart rows={data.deficit_context.annual_net_balance_moz} />
        ) : (
          <div className="comex-empty">Loading…</div>
        )}
      </div>
    </>
  );
}
