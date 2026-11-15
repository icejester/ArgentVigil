import { useState } from "react";
import { useHealthRows } from "../health_context";
import { Sparkline } from "./charts";
import { DASH } from "./stats";

export function Screen({ title, onBack, children, sub }) {
  return (
    <section className="m-screen">
      <header className="m-screen-head">
        {onBack && <button type="button" className="m-back" onClick={onBack} aria-label="Back">‹ Back</button>}
        <h2 className="m-h2">{title}</h2>
        {sub && <div className="m-sub">{sub}</div>}
      </header>
      {children}
    </section>
  );
}

export function Loading({ state, children }) {
  if (state.loading) return <div className="m-empty">Loading…</div>;
  if (state.error) return <div className="m-empty m-empty--err">Couldn't load this ({state.error}).</div>;
  return children;
}

export function MetalToggle({ metal, onChange }) {
  return (
    <div className="m-seg" role="group" aria-label="Metal">
      {[["XAG", "Silver"], ["XAU", "Gold"]].map(([k, l]) => (
        <button key={k} type="button" className={"m-seg-btn" + (metal === k ? " m-seg-btn--on" : "")} aria-pressed={metal === k} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}

// windows: [{key,label,days|all|since}]
export function WindowBar({ windows, value, onChange, custom }) {
  return (
    <div className="m-seg m-seg--scroll" role="group" aria-label="Time window">
      {windows.map((w) => (
        <button key={w.key} type="button" className={"m-seg-btn" + (value === w.key ? " m-seg-btn--on" : "")} aria-pressed={value === w.key} onClick={() => onChange(w.key)}>{w.label}</button>
      ))}
      {custom}
    </div>
  );
}

// A glance row: label, big value, delta/context line, as-of date, sparkline.
export function GlanceRow({ label, value, sub, asOf, spark, sparkColor, onTap, tone }) {
  const body = (
    <>
      <div className="m-row-main">
        <div className="m-row-label">{label}</div>
        <div className={"m-row-value" + (tone ? " m-tone-" + tone : "")}>{value ?? DASH}</div>
        {sub && <div className="m-row-sub">{sub}</div>}
        {asOf && <div className="m-row-asof">as of {asOf}</div>}
      </div>
      {spark && <div className="m-row-spark"><Sparkline rows={spark} color={sparkColor} /></div>}
      {onTap && <span className="m-chev" aria-hidden="true">›</span>}
    </>
  );
  return onTap ? (
    <button type="button" className="m-row" onClick={onTap}>{body}</button>
  ) : (
    <div className="m-row m-row--static">{body}</div>
  );
}

export function Caveat({ children }) {
  return <p className="m-caveat">{children}</p>;
}

// Principle 3: every value carries its as-of date. This adds the source's
// own last-sync age from the shared health poll (same data ChartStaleness
// uses), for panel headers.
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 129600) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
export function SyncedAgo({ sourceKey }) {
  const { bySourceKey } = useHealthRows(sourceKey);
  const times = Object.values(bySourceKey).map((r) => r?.last_success_at).filter(Boolean).sort();
  if (times.length === 0) return null;
  return <span className="m-synced">synced {ago(times[0])}</span>;
}

export function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="m-card">
      <button type="button" className="m-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="m-card-body">{children}</div>}
    </div>
  );
}
