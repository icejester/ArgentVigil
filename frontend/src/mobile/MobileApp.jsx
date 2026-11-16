import { useEffect, useState } from "react";
import { HealthProvider } from "../health_context";
import { PinnedDateProvider, usePinnedDate } from "../pinned_date_context";
import { setViewPref } from "../view_mode";
import { SpotHeader, SpotPanel } from "./spot";
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
  const [openMetal, setOpenMetal] = useState(null);
  const go = (k) => {
    setActive(k);
    setVisited((v) => ({ ...v, [k]: true }));
    window.scrollTo(0, 0);
  };
  return (
    <div className="m-app">
      <header className="m-header">
        <div className="m-brand">ArgentVigil</div>
        <SpotHeader openMetal={openMetal} setOpenMetal={setOpenMetal} />
        <PinChip />
      </header>
      <main className="m-main">
        {openMetal && <SpotPanel key={openMetal} metal={openMetal} />}
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
