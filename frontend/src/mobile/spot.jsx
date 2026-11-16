import { useState } from "react";
import { useTicks } from "./api";
import { Sparkline, TickChart } from "./charts";
import { fmtNum, fmtSigned, fmtSignedPct, DASH } from "./stats";

// Header spot rows (desktop HeaderTicker parity): price plus the change over
// the last 6 hours from real persisted ticks, with a tiny sparkline. Tapping
// a metal opens a tick chart with 6H / 24H / 7D.
const HOUR = 3600 * 1000;
export const SPOT_WINDOWS = [
  { key: "6h", label: "6H", ms: 6 * HOUR },
  { key: "24h", label: "24H", ms: 24 * HOUR },
  { key: "7d", label: "7D", ms: 7 * 24 * HOUR },
];
const METALS = [["XAG", "Ag", "#5aa9e6"], ["XAU", "Au", "#e0c14c"]];

function Cell({ metal, label, color, open, onToggle }) {
  const { rows } = useTicks(metal, 6 * HOUR);
  const last = rows?.length ? rows[rows.length - 1].price : null;
  const first = rows?.length ? rows[0].price : null;
  const chg = last != null && first != null ? last - first : null;
  const pct = chg != null && first ? (chg / first) * 100 : null;
  const tone = chg == null || chg === 0 ? "" : chg > 0 ? "m-pos" : "m-neg";
  const spark = rows ? rows.map((r) => ({ date: new Date(r.t).toISOString(), value: r.price })) : [];
  return (
    <button type="button" className={"m-spot-cell" + (open ? " m-spot-cell--on" : "")} aria-expanded={open} onClick={onToggle}>
      <span className="m-spot-label" style={{ color }}>{label}</span>
      <span className="m-spot-price">{last != null ? "$" + fmtNum(last) : DASH}</span>
      <span className={"m-spot-chg " + tone}>
        {chg == null ? DASH : `${chg > 0 ? "▲" : chg < 0 ? "▼" : ""} ${fmtSigned(chg)} (${fmtSignedPct(pct)})`}
        <span className="m-spot-win"> 6H</span>
      </span>
      <span className="m-spot-spark"><Sparkline rows={spark} color={color} width={64} height={22} /></span>
    </button>
  );
}

export function SpotHeader({ openMetal, setOpenMetal }) {
  return (
    <div className="m-spots" aria-label="Spot prices">
      {METALS.map(([k, l, c]) => (
        <Cell key={k} metal={k} label={l} color={c} open={openMetal === k} onToggle={() => setOpenMetal(openMetal === k ? null : k)} />
      ))}
    </div>
  );
}

export function SpotPanel({ metal }) {
  const [winKey, setWinKey] = useState("6h");
  const win = SPOT_WINDOWS.find((w) => w.key === winKey);
  const m = METALS.find((x) => x[0] === metal);
  const { rows } = useTicks(metal, win.ms);
  return (
    <div className="m-spot-panel">
      <div className="m-seg" role="group" aria-label="Spot window">
        {SPOT_WINDOWS.map((w) => (
          <button key={w.key} type="button" className={"m-seg-btn" + (winKey === w.key ? " m-seg-btn--on" : "")} aria-pressed={winKey === w.key} onClick={() => setWinKey(w.key)}>{w.label}</button>
        ))}
      </div>
      {rows == null ? <div className="m-empty">Loading…</div> : <TickChart rows={rows} color={m[2]} fmt={(v) => "$" + v.toFixed(2)} />}
      <div className="m-hint">{m[1] === "Ag" ? "Silver" : "Gold"} spot ticks, refreshed every minute. Market-closed periods have no ticks.</div>
    </div>
  );
}
