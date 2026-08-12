import { createContext, useContext, useEffect, useState } from "react";

// Single shared poll of /api/health/db, consumed by HeaderHealthDot AND
// every per-sub-panel ChartStaleness badge across every tab — avoids N
// independent 60s polls of the same route once staleness badges are spread
// across CoT/Money Supply/Inventory/CATCOR (each with several sub-panels,
// each potentially wanting its own badge). One poll, one source of truth,
// same 60s cadence HeaderHealthDot already used before this consolidation
// (chosen to match, not to change existing behavior).
const HEALTH_POLL_INTERVAL_MS = 60000;

const HealthContext = createContext({ sources: {}, refresh: () => {} });

export function HealthProvider({ children }) {
  const [sources, setSources] = useState({});

  const refresh = () => {
    fetch("/api/health/db")
      .then((r) => r.json())
      .then((j) => setSources(j.sources ?? {}))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return <HealthContext.Provider value={{ sources, refresh }}>{children}</HealthContext.Provider>;
}

// sourceKey may be a single key, an array of keys, or null/undefined to get
// every currently-known row (HeaderHealthDot's own use case — it rolls up
// the whole registry's worst status, not one sub-panel's). A sub-panel
// backed by more than one source (e.g. a chart merging leverage + curve
// spread) gets the worst-of-N status across all of them via this same
// array form, per this repo's default "worst-of-N, one badge per chart"
// convention (see UI_STANDARDS.md).
//
// Also returns `bySourceKey` (the raw key->row map, unfiltered — a
// requested key not yet in `sources` maps to undefined rather than being
// silently dropped) for callers that need to keep each source's own row
// aligned with its own key, e.g. chart_staleness.jsx rendering one popover
// row per underlying source_key — `rows` alone can't do that once
// `.filter(Boolean)` has removed any not-yet-known keys, since that breaks
// positional alignment with the original key list.
export function useHealthRows(sourceKey) {
  const { sources, refresh } = useContext(HealthContext);
  if (sourceKey == null) {
    return { rows: Object.values(sources), bySourceKey: sources, refresh };
  }
  const keys = Array.isArray(sourceKey) ? sourceKey : [sourceKey];
  const rows = keys.map((k) => sources[k]).filter(Boolean);
  const bySourceKey = Object.fromEntries(keys.map((k) => [k, sources[k]]));
  return { rows, bySourceKey, refresh };
}
