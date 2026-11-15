import { useState } from "react";
import { useGetAll } from "./api";
import { Screen, Loading, GlanceRow, Caveat } from "./ui";
import { fmtUsd, fmtSignedUsd, fmtSignedPct, fmtOz, DASH } from "./stats";

// Stack (mobile-spec.md Section 7): read-only. The pile at a glance, then a
// per-purchase-date view of what each buy did. Descriptive only.

const sign = (v) => (v == null || v === 0 ? "" : v > 0 ? "m-pos" : "m-neg");
const arrow = (v) => (v == null ? "" : v > 0 ? "▲ " : v < 0 ? "▼ " : "");

function sumPaid(rows) {
  // Null (not a partial sum) if any purchase has no recorded price.
  if (rows.length === 0 || rows.some((r) => r.paid == null)) return null;
  return rows.reduce((s, r) => s + r.paid, 0);
}

function AcqCard({ a, onTap }) {
  return (
    <button type="button" className="m-acq m-acq--btn" onClick={onTap}>
      <div className="m-acq-head"><span>{a.date}</span><span aria-hidden="true">›</span></div>
      <div className="m-kv"><span>Bought</span><span>{fmtOz(a.oz)} for {fmtUsd(a.paid)}</span></div>
      <div className="m-kv"><span>Paid vs. that day's market</span>
        <span>{a.premium_per_oz == null ? DASH : <>{fmtSignedUsd(a.premium_per_oz)}/oz ({fmtSignedPct(a.premium_pct)})</>}</span></div>
      <div className="m-kv"><span>Average cost, before → after</span>
        <span>{fmtUsd(a.dca_before)} → {fmtUsd(a.dca_after)}</span></div>
      <div className="m-kv"><span>Change in average cost</span>
        <span>{a.dca_change == null ? DASH : <>{arrow(a.dca_change)}{fmtSignedUsd(a.dca_change)}/oz</>}</span></div>
      <div className="m-kv"><span>This purchase today</span>
        <span className={sign(a.now_gain)}>{a.now_gain == null ? DASH : <>{fmtSignedUsd(a.now_gain)} ({fmtSignedPct(a.now_gain_pct)})</>}</span></div>
    </button>
  );
}

export default function Stack() {
  const [screen, setScreen] = useState(null); // {metal} | {metal, date}
  const state = useGetAll(["/api/stack/summary/db", "/api/stack/acquisitions/db"]);

  return (
    <Loading state={state}>
      {state.data && (() => {
        const [sum, acq] = state.data;
        const META = {
          silver: { label: "Silver", oz: sum.total_silver_oz, value: sum.value_by_metal?.silver, spot: sum.spot_silver },
          gold: { label: "Gold", oz: sum.total_gold_oz, value: sum.value_by_metal?.gold, spot: sum.spot_gold },
        };

        if (screen?.date) {
          const a = acq[screen.metal].find((x) => x.date === screen.date);
          return (
            <Screen title={`${META[screen.metal].label} · ${screen.date}`} onBack={() => setScreen({ metal: screen.metal })}>
              {a?.purchases.map((p) => (
                <div className="m-acq" key={p.id}>
                  <div className="m-acq-head"><span>{p.description ?? "Item"}</span></div>
                  <div className="m-kv"><span>Series</span><span>{p.series ?? DASH}</span></div>
                  <div className="m-kv"><span>Count</span><span>{p.count ?? DASH}</span></div>
                  <div className="m-kv"><span>Weight</span><span>{fmtOz(p.oz)}</span></div>
                  <div className="m-kv"><span>Price paid</span><span>{fmtUsd(p.purchase_price)}</span></div>
                </div>
              ))}
            </Screen>
          );
        }

        if (screen?.metal) {
          const meta = META[screen.metal];
          const rows = acq[screen.metal];
          return (
            <Screen title={`${meta.label} · acquisitions`} onBack={() => setScreen(null)} sub="Newest first. One row per purchase date.">
              {rows.length === 0 && <div className="m-empty">No dated purchases.</div>}
              {rows.map((a) => <AcqCard key={a.date} a={a} onTap={() => setScreen({ metal: screen.metal, date: a.date })} />)}
              <Caveat>"Paid vs. that day's market" compares your price per ounce with that day's real daily close, so a positive number is what you paid above the market and a negative one is what you paid below it. "Change in average cost" is the pile's cost per ounce after this buy minus before it. Neither is a judgment of the buy. Gain or loss today uses live spot melt value.</Caveat>
            </Screen>
          );
        }

        const metalRow = (k) => {
          const meta = META[k];
          if (!meta.oz) return null;
          const paid = sumPaid(acq[k]);
          const diff = paid != null && meta.value != null ? meta.value - paid : null;
          return (
            <GlanceRow
              key={k}
              label={`${meta.label} · ${fmtOz(meta.oz)}`}
              value={meta.value != null ? fmtUsd(meta.value) : DASH}
              sub={<>Paid {fmtUsd(paid)} · <span className={sign(diff)}>{diff == null ? DASH : `${fmtSignedUsd(diff)} (${fmtSignedPct(paid ? (diff / paid) * 100 : null)})`}</span></>}
              asOf={meta.spot != null ? `spot ${fmtUsd(meta.spot)}/oz` : undefined}
              onTap={() => setScreen({ metal: k })}
            />
          );
        };
        return (
          <>
            <h2 className="m-h2">Stack</h2>
            <div className="m-acq">
              <div className="m-kv"><span>Current value</span><span><b>{fmtUsd(sum.total_current_value)}</b></span></div>
              <div className="m-kv"><span>Paid</span><span>{fmtUsd(sum.total_spent)}</span></div>
              <div className="m-kv"><span>Difference</span>
                <span className={sign(sum.total_unrealized_gain)}>{sum.total_unrealized_gain == null ? DASH : `${fmtSignedUsd(sum.total_unrealized_gain)} (${fmtSignedPct(sum.total_unrealized_gain_pct)})`}</span></div>
            </div>
            {metalRow("silver")}
            {metalRow("gold")}
            <Caveat>The metal rows are melt value at live spot. The stack total also includes any numismatic value entered on desktop.</Caveat>
          </>
        );
      })()}
    </Loading>
  );
}
