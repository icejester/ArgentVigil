import { useMemo, useState } from "react";
import { useGetAll, useGet } from "./api";
import { DrillChart, PieChart } from "./charts";
import { MM_PIE_COLORS, MM_PIE_OTHER_COLOR } from "../palette";
import { Screen, Loading, MetalToggle, WindowBar, GlanceRow, Caveat, SyncedAgo } from "./ui";
import { INVENTORY_WINDOWS, D45 } from "./windows";
import { usePin } from "./pin";
import { sliceWindow, fmtCompact, fmtSignedCompact, DASH } from "./stats";

// Inventory (mobile-spec.md Section 5): COMEX only. Vaults sorted by how
// much they moved on the snapshot day, then delivery behavior.

// Snapshot at `date` plus each vault's change since the nearest history date
// on/before date - win.days (or the earliest date if history is shorter or
// the window is All). Day-over-day is mostly zeros for vaults, so movement is
// shown over a window instead.
function snapshot(depo, date, win) {
  const dates = [...new Set(depo.map((r) => r.date))].sort();
  if (!dates.includes(date)) return null;
  let baseDate = dates[0];
  if (!win.all) {
    const cutoff = new Date(date + "T00:00:00Z").getTime() - win.days * 86400000;
    for (const d of dates) if (new Date(d + "T00:00:00Z").getTime() <= cutoff) baseDate = d;
  }
  if (baseDate >= date) baseDate = null;
  const byVault = new Map();
  for (const r of depo) {
    if (r.date !== date && r.date !== baseDate) continue;
    const v = byVault.get(r.depository) ?? { name: r.depository };
    v[r.date === date ? "cur" : "base"] = r;
    byVault.set(r.depository, v);
  }
  const vaults = [...byVault.values()].filter((v) => v.cur).map((v) => ({
    name: v.name, cur: v.cur, base: v.base ?? null,
  }));
  return { date, baseDate, vaults, spanDays: baseDate ? Math.round((new Date(date) - new Date(baseDate)) / 86400000) : 0 };
}

// Per-metric view of a snapshot: values, change over the window, shares.
function measureView(snap, metric) {
  const vs = snap.vaults.map((v) => {
    const val = v.cur[metric];
    const prev = v.base ? v.base[metric] : null;
    return { name: v.name, val: val ?? 0, delta: val != null && prev != null ? val - prev : null };
  });
  const total = vs.reduce((s, v) => s + v.val, 0);
  const hasBase = snap.baseDate != null;
  const sumDelta = vs.some((v) => v.delta != null) ? vs.reduce((s, v) => s + (v.delta ?? 0), 0) : null;
  return { vaults: vs.sort((a, b) => b.val - a.val), total, delta: hasBase ? sumDelta : null };
}

const MEASURES = [["total", "Total"], ["registered", "Registered"], ["eligible", "Eligible"]];
const arrow = (v) => (v > 0 ? "▲ " : v < 0 ? "▼ " : "");
const toneOf = (v) => (v > 0 ? "m-pos" : v < 0 ? "m-neg" : "");

function Movement({ view, metric }) {
  const rows = [...view.vaults].filter((v) => v.delta != null).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const max = Math.max(...rows.map((v) => Math.abs(v.delta)), 0);
  if (rows.length === 0) return <div className="m-empty">No earlier snapshot to compare with yet.</div>;
  if (max === 0) return <div className="m-empty">No vault moved over this window.</div>;
  return rows.filter((v) => v.delta !== 0).map((v) => {
    const w = (Math.abs(v.delta) / max) * 50;
    return (
      <div className="m-move-row" key={v.name}>
        <div className="m-move-head"><span>{v.name}</span><b className={toneOf(v.delta)}>{arrow(v.delta)}{fmtSignedCompact(v.delta)} oz</b></div>
        <div className="m-move-track" aria-hidden="true">
          <div className="m-move-fill" style={v.delta > 0 ? { left: "50%", width: w + "%", background: "#4caf76" } : { right: "50%", width: w + "%", background: "#e05252" }} />
        </div>
      </div>
    );
  });
}

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
  const [metric, setMetric] = useState("total");
  const [winKey, setWinKey] = useState("30d");
  const [screen, setScreen] = useState(null); // {kind:'vault', name} | {kind:'delivery'}
  const { pinnedDate, onPin } = usePin();
  const m = metal === "XAG" ? "silver" : "gold";
  const win = INVENTORY_WINDOWS.find((w) => w.key === winKey);
  const state = useGetAll([`/api/${m}/db/depositories/history`]);

  const depo = state.data?.[0];
  const snap = useMemo(() => {
    if (!depo || depo.length === 0) return { empty: true };
    const dates = [...new Set(depo.map((r) => r.date))].sort();
    if (pinnedDate) {
      // Exact-match rule (desktop's VaultSnapshotPanel): no nearby-date fallback.
      return dates.includes(pinnedDate) ? snapshot(depo, pinnedDate, win) : { missing: pinnedDate };
    }
    return snapshot(depo, dates[dates.length - 1], win);
  }, [depo, pinnedDate, win]);
  const view = snap?.vaults ? measureView(snap, metric) : null;

  const toggle = <MetalToggle metal={metal} onChange={(k) => { setMetal(k); setScreen(null); }} />;

  if (screen?.kind === "delivery") return <DeliveryScreen metal={metal} onBack={() => setScreen(null)} />;
  if (screen?.kind === "vault") return <VaultHistory vault={screen.name} depo={depo} metal={metal} onBack={() => setScreen(null)} />;

  // Pie: top 7 vaults get the validated hues; the rest fold into one gray "Other".
  const pieSlices = (() => {
    if (!view) return [];
    const pos = view.vaults.filter((v) => v.val > 0);
    const top = pos.slice(0, 7).map((v, i) => ({ key: v.name, label: v.name, value: v.val, delta: v.delta, color: MM_PIE_COLORS[i] }));
    const rest = pos.slice(7);
    if (rest.length) {
      const ds = rest.filter((v) => v.delta != null);
      top.push({ key: "__other", label: `Other (${rest.length} vaults)`, value: rest.reduce((s, v) => s + v.val, 0), delta: ds.length ? ds.reduce((s, v) => s + v.delta, 0) : null, color: MM_PIE_OTHER_COLOR, onTap: false });
    }
    return top;
  })();
  const spanText = snap?.baseDate ? `${snap.spanDays} days, since ${snap.baseDate}` : "no earlier snapshot";

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
        {view && (
          <>
            <div className="m-seg" role="group" aria-label="Measure">
              {MEASURES.map(([k, l]) => (
                <button key={k} type="button" className={"m-seg-btn" + (metric === k ? " m-seg-btn--on" : "")} aria-pressed={metric === k} onClick={() => setMetric(k)}>{l}</button>
              ))}
            </div>
            <WindowBar windows={INVENTORY_WINDOWS} value={winKey} onChange={setWinKey} />
            <div className="m-section">Where it sits · {snap.date}{pinnedDate ? " (pinned)" : ""}</div>
            <div className="m-acq">
              <div className="m-kv"><span>{MEASURES.find((x) => x[0] === metric)[1]} stock</span><span>{fmtCompact(view.total)} oz</span></div>
              <div className="m-kv"><span>Change, {spanText}</span><span className={toneOf(view.delta)}>{view.delta == null ? DASH : arrow(view.delta) + fmtSignedCompact(view.delta) + " oz"}</span></div>
            </div>
            <div className="m-pie-wrap">
              <PieChart slices={pieSlices} ariaLabel={`Share of COMEX ${metal === "XAG" ? "silver" : "gold"} ${metric} by vault`} onSlice={(sl) => setScreen({ kind: "vault", name: sl.key })} />
              <div className="m-pie-legend">
                {pieSlices.map((sl) => {
                  const body = (
                    <>
                      <span className="m-swatch" style={{ background: sl.color }} />
                      <span className="m-pie-name">{sl.label}</span>
                      <span className="m-pie-share">{((sl.value / view.total) * 100).toFixed(1)}%</span>
                      <span className="m-pie-sub">{fmtCompact(sl.value)} oz · <span className={toneOf(sl.delta)}>{sl.delta == null ? DASH : sl.delta === 0 ? "no change" : arrow(sl.delta) + fmtSignedCompact(sl.delta)}</span></span>
                    </>
                  );
                  return sl.onTap === false
                    ? <div key={sl.key} className="m-pie-row">{body}</div>
                    : <button key={sl.key} type="button" className="m-pie-row" onClick={() => setScreen({ kind: "vault", name: sl.key })}>{body}</button>;
                })}
              </div>
            </div>
            <div className="m-section">Movement · {spanText}</div>
            <div className="m-acq"><Movement view={view} metric={metric} /></div>
            <Caveat>Tap a slice or a row for that vault's history. Per-vault history only goes back to when AV started recording it, so short windows may cover the whole record.</Caveat>
          </>
        )}
      </Loading>
      <div className="m-section">Delivery</div>
      <GlanceRow label="Delivery behavior" value="Daily stock change" sub="1W, 2W, 30D and longer, against registered and delivery volume" onTap={() => setScreen({ kind: "delivery" })} />
    </>
  );
}
