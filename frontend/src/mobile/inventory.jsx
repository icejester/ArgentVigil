import { useMemo, useState } from "react";
import { useGetAll, useGet } from "./api";
import { DrillChart } from "./charts";
import { Screen, Loading, MetalToggle, WindowBar, GlanceRow, Caveat, SyncedAgo } from "./ui";
import { INVENTORY_WINDOWS, D45 } from "./windows";
import { usePin } from "./pin";
import { sliceWindow, fmtCompact, fmtSignedCompact, DASH } from "./stats";

// Inventory (mobile-spec.md Section 5): COMEX only. Vaults sorted by how
// much they moved on the snapshot day, then delivery behavior.

function snapshot(depo, date) {
  const dates = [...new Set(depo.map((r) => r.date))].sort();
  const i = dates.indexOf(date);
  if (i < 0) return null;
  const prevDate = i > 0 ? dates[i - 1] : null;
  const byVault = new Map();
  for (const r of depo) {
    if (r.date !== date && r.date !== prevDate) continue;
    const v = byVault.get(r.depository) ?? { name: r.depository };
    v[r.date === date ? "cur" : "prev"] = r;
    byVault.set(r.depository, v);
  }
  const vaults = [...byVault.values()].filter((v) => v.cur).map((v) => {
    const dReg = v.prev ? v.cur.registered - v.prev.registered : null;
    const dElig = v.prev ? v.cur.eligible - v.prev.eligible : null;
    const dTot = v.prev ? v.cur.total - v.prev.total : null;
    return { name: v.name, reg: v.cur.registered, elig: v.cur.eligible, total: v.cur.total, dReg, dElig, dTot, move: (Math.abs(dReg ?? 0) + Math.abs(dElig ?? 0)) };
  });
  // Biggest movers first; vaults with no change sink to the bottom by size.
  vaults.sort((a, b) => (b.move !== a.move ? b.move - a.move : b.total - a.total));
  const sum = (k) => vaults.reduce((s, v) => s + (v[k] ?? 0), 0);
  const hasPrev = vaults.some((v) => v.dReg != null);
  return {
    date, prevDate, vaults,
    totals: { reg: sum("reg"), elig: sum("elig"), total: sum("total"), dReg: hasPrev ? sum("dReg") : null, dElig: hasPrev ? sum("dElig") : null, dTot: hasPrev ? sum("dTot") : null },
  };
}

const Delta = ({ label, v }) => (
  <div className="m-delta"><span className="m-delta-label">{label}</span><span className="m-delta-val">{v == null ? DASH : fmtSignedCompact(v)}</span></div>
);

function VaultHistory({ vault, depo, metal, onBack }) {
  const [metric, setMetric] = useState("total");
  const [winKey, setWinKey] = useState(D45.key);
  const { pinnedDate, onPin } = usePin();
  const win = INVENTORY_WINDOWS.find((w) => w.key === winKey);
  const rows = depo.filter((r) => r.depository === vault).map((r) => ({ date: r.date, value: r[metric] }));
  return (
    <Screen title={vault} onBack={onBack} sub={`${metal === "XAG" ? "Silver" : "Gold"} · recent history`}>
      <div className="m-seg" role="group" aria-label="Measure">
        {["total", "registered", "eligible"].map((k) => (
          <button key={k} type="button" className={"m-seg-btn" + (metric === k ? " m-seg-btn--on" : "")} aria-pressed={metric === k} onClick={() => setMetric(k)}>{k[0].toUpperCase() + k.slice(1)}</button>
        ))}
      </div>
      <WindowBar windows={INVENTORY_WINDOWS} value={winKey} onChange={setWinKey} />
      <DrillChart
        lines={[{ key: metric, name: metric, color: "#7b9fff", rows: sliceWindow(rows, win), kind: "line" }]}
        format={(v) => fmtCompact(v) + " oz"}
        axisFormat={(v) => fmtCompact(v, 0)}
        pinnedDate={pinnedDate}
        onPin={onPin}
      />
      <Caveat>Per-vault history only goes back to when AV started recording it, so it grows forward.</Caveat>
    </Screen>
  );
}

function DeliveryScreen({ metal, onBack }) {
  const [winKey, setWinKey] = useState(D45.key);
  const { pinnedDate, onPin } = usePin();
  const st = useGet(`/api/delivery-behavior/db?metal=${metal}`);
  const win = INVENTORY_WINDOWS.find((w) => w.key === winKey);
  return (
    <Screen title="Delivery behavior" onBack={onBack} sub="Daily change in total COMEX stock, with registered and delivery context">
      <WindowBar windows={INVENTORY_WINDOWS} value={winKey} onChange={setWinKey} />
      <Loading state={st}>
        {st.data && (() => {
          const rec = st.data.reclassification;
          if (!rec?.available) return <div className="m-empty">{rec?.reason ?? "Not available for this metal."}</div>;
          const rows = rec.days.map((d) => ({ date: d.date, value: d.total_delta, raw: d }));
          const byDate = new Map(rec.days.map((d) => [d.date, d]));
          const FLAG = { reclassification: "Registered rose, little delivery to explain it", deregistration: "Registered fell, little delivery to explain it" };
          return (
            <>
              <DrillChart
                lines={[{ key: "d", name: "Change in total stock", color: "#7b9fff", rows: sliceWindow(rows, win), kind: "bar" }]}
                format={(v) => fmtSignedCompact(v) + " oz"}
                axisFormat={(v) => fmtCompact(v, 0)}
                barColor={(r) => (r.raw?.flag_type ? "#d9a441" : r.value >= 0 ? "#4caf76" : "#e05252")}
                detail={(date) => {
                  const d = byDate.get(date);
                  return d ? [
                    { label: "Registered change", value: fmtSignedCompact(d.registered_delta) + " oz" },
                    { label: "Delivery volume", value: fmtCompact(d.delivery_volume_oz) + " oz" },
                    { label: "Flag", value: d.flag_type ? FLAG[d.flag_type] : "none" },
                  ] : [];
                }}
                pinnedDate={pinnedDate}
                onPin={onPin}
              />
              <Caveat>Amber bars are days flagged either way. Neither direction implies wrongdoing: both are ordinary status changes between registered and eligible. Days before {rec.coverage_start_date} have no delivery data, so they cannot be flagged and are not confirmed clean.</Caveat>
            </>
          );
        })()}
      </Loading>
    </Screen>
  );
}

export default function Inventory() {
  const [metal, setMetal] = useState("XAG");
  const [screen, setScreen] = useState(null); // {kind:'vault', name} | {kind:'delivery'}
  const { pinnedDate, onPin } = usePin();
  const m = metal === "XAG" ? "silver" : "gold";
  const state = useGetAll([`/api/${m}/db/depositories/history`]);

  const depo = state.data?.[0];
  const snap = useMemo(() => {
    if (!depo || depo.length === 0) return { empty: true };
    const dates = [...new Set(depo.map((r) => r.date))].sort();
    if (pinnedDate) {
      // Exact-match rule (desktop's VaultSnapshotPanel): no nearby-date fallback.
      return dates.includes(pinnedDate) ? snapshot(depo, pinnedDate) : { missing: pinnedDate };
    }
    return snapshot(depo, dates[dates.length - 1]);
  }, [depo, pinnedDate]);

  const toggle = <MetalToggle metal={metal} onChange={(k) => { setMetal(k); setScreen(null); }} />;

  if (screen?.kind === "delivery") return <DeliveryScreen metal={metal} onBack={() => setScreen(null)} />;
  if (screen?.kind === "vault") return <VaultHistory vault={screen.name} depo={depo} metal={metal} onBack={() => setScreen(null)} />;

  return (
    <>
      <h2 className="m-h2">Inventory <SyncedAgo sourceKey={[`comex_${m}_depositories`, "delivery_notices"]} /></h2>
      {toggle}
      <Loading state={state}>
        {snap?.empty && <div className="m-empty">No vault data yet for this metal.</div>}
        {snap?.missing && (
          <div className="m-empty">
            No vault snapshot for the pinned date {snap.missing}.
            <div><button type="button" className="m-btn" onClick={() => onPin(null)}>Clear pinned date</button></div>
          </div>
        )}
        {snap?.vaults && (
          <>
            <div className="m-section">COMEX totals · {snap.date}{pinnedDate ? " (pinned)" : ""}</div>
            <div className="m-acq">
              {[["Registered", snap.totals.reg, snap.totals.dReg], ["Eligible", snap.totals.elig, snap.totals.dElig], ["Total", snap.totals.total, snap.totals.dTot]].map(([l, v, d]) => (
                <div className="m-kv" key={l}><span>{l}</span><span>{fmtCompact(v)} oz <b>{d == null ? "" : fmtSignedCompact(d)}</b></span></div>
              ))}
              <div className="m-row-asof">change vs {snap.prevDate ?? DASH}</div>
            </div>
            <div className="m-section">Vaults, biggest movers first</div>
            {snap.vaults.map((v) => (
              <button key={v.name} type="button" className="m-row m-vault" onClick={() => setScreen({ kind: "vault", name: v.name })}>
                <div className="m-row-main">
                  <div className="m-row-label">{v.name}</div>
                  <div className="m-delta-pair"><Delta label="Registered" v={v.dReg} /><Delta label="Eligible" v={v.dElig} /></div>
                  <div className="m-row-sub">Reg {fmtCompact(v.reg)} · Elig {fmtCompact(v.elig)} · Total {fmtCompact(v.total)} oz</div>
                </div>
                <span className="m-chev" aria-hidden="true">›</span>
              </button>
            ))}
          </>
        )}
      </Loading>
      <div className="m-section">Delivery</div>
      <GlanceRow label="Delivery behavior" value="Last 45 days" sub="Daily stock change against registered and delivery volume" onTap={() => setScreen({ kind: "delivery" })} />
    </>
  );
}
