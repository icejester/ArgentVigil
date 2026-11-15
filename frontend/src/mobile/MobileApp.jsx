import { useEffect, useState } from "react";
import { HealthProvider } from "../health_context";
import { PinnedDateProvider, usePinnedDate } from "../pinned_date_context";
import { setViewPref } from "../view_mode";
import { apiFetch } from "../api_client";
import { fmtNum, fmtSignedPct } from "./stats";
import Trading from "./trading";
import Inventory from "./inventory";
import Money from "./money";
import Stack from "./stack";
import "./mobile.css";

const PANELS = [
  { key: "trading", label: "Trading", icon: "◭", Comp: Trading },
  { key: "inventory", label: "Inventory", icon: "▥", Comp: Inventory },
  { key: "money", label: "Money", icon: "$", Comp: Money },
  { key: "stack", label: "Stack", icon: "◆", Comp: Stack },
];

// G1: silver and gold spot on every screen. /api/prices/db is the same
// persisted read the desktop header ticker uses; 60s matches the fast tier.
function SpotHeader() {
  const [spot, setSpot] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      apiFetch("/api/prices/db").then((r) => r.json()).then((j) => live && setSpot(j.data)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { live = false; clearInterval(id); };
  }, []);
  const cell = (k, label) => {
    const p = spot?.[k];
    return (
      <div className="m-spot">
        <span className="m-spot-label">{label}</span>
        <span className="m-spot-price">{p?.price != null ? "$" + fmtNum(p.price) : "—"}</span>
        <span className="m-spot-chg">{fmtSignedPct(p?.changePercent24h)}</span>
      </div>
    );
  };
  return <div className="m-spots" aria-label="Spot prices">{cell("XAG", "Ag")}{cell("XAU", "Au")}</div>;
}

// G5: the pinned date shows on every screen with a clear control.
function PinChip() {
  const { pinnedDate, clearPinnedDate } = usePinnedDate();
  if (!pinnedDate) return null;
  return (
    <button type="button" className="m-pin-chip" onClick={clearPinnedDate} aria-label={`Clear pinned date ${pinnedDate}`}>
      📌 {pinnedDate} <span aria-hidden="true">✕</span>
    </button>
  );
}

function Shell() {
  const [active, setActive] = useState("trading");
  const [visited, setVisited] = useState({ trading: true });
  const go = (k) => {
    setActive(k);
    setVisited((v) => ({ ...v, [k]: true }));
    window.scrollTo(0, 0);
  };
  return (
    <div className="m-app">
      <header className="m-header">
        <div className="m-brand">ArgentVigil</div>
        <SpotHeader />
        <PinChip />
      </header>
      <main className="m-main">
        {PANELS.map(({ key, Comp }) => (
          // Mounted on first visit, then kept (hidden) so a drill screen and
          // its window choice survive switching panels.
          <div key={key} hidden={active !== key}>{visited[key] ? <Comp /> : null}</div>
        ))}
        <footer className="m-foot">
          <button type="button" className="m-link" onClick={() => setViewPref("desktop")}>Desktop site</button>
        </footer>
      </main>
      <nav className="m-nav" aria-label="Panels">
        {PANELS.map((p) => (
          <button key={p.key} type="button" className={"m-nav-btn" + (active === p.key ? " m-nav-btn--on" : "")} aria-current={active === p.key ? "page" : undefined} onClick={() => go(p.key)}>
            <span className="m-nav-icon" aria-hidden="true">{p.icon}</span>
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function MobileApp() {
  return (
    <HealthProvider>
      <PinnedDateProvider>
        <Shell />
      </PinnedDateProvider>
    </HealthProvider>
  );
}
