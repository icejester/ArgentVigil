import { createContext, useContext, useState } from "react";

// One shared "pinned date" string, consumed by every chart on the tabs
// that opt in — Trading (CoT), Money Supply, and Inventory. Same shape of
// problem, same solution as health_context.jsx: one source of truth, every
// consumer reads via a hook instead of owning local useState.
//
// Only these three tabs share the pin: they already run on a common
// market-timeline logic (a CoT report date, a Fed-balance-sheet Wednesday,
// a vault-inventory day are all meaningfully "the same moment"). Stack
// (personal purchase dates) and OFAC (designation dates) deliberately do
// NOT consume this — those date grids aren't comparable to a market
// timeline, so Stack keeps its own local pinnedDate and OFAC has none.
// A tab's decision to call usePinnedDate() vs. keep local state is a
// per-tab call, the same way whether a chart originates a pin already is.
//
// Persistence is in-memory only: App.jsx keeps every tab section mounted
// simultaneously (never unmounted on tab switch), so a plain context
// carries the pin across tabs with no backend round-trip. A page reload
// clears it — acceptable; server-side persistence (a ui_settings.pinned_date
// column) is a flagged optional follow-on, not built.
const PinnedDateContext = createContext({
  pinnedDate: null,
  setPinnedDate: () => {},
  clearPinnedDate: () => {},
  togglePinnedDate: () => {},
});

export function PinnedDateProvider({ children }) {
  const [pinnedDate, setPinnedDate] = useState(null);

  const clearPinnedDate = () => setPinnedDate(null);
  // Click a point to pin it; click that same date again (anywhere, on any
  // of the three sharing tabs) to clear it. Inventory's chart clicks
  // already had this toggle semantics locally; it's lifted into the
  // context so it holds across tabs.
  const togglePinnedDate = (date) =>
    setPinnedDate((prev) => (prev === date ? null : date));

  return (
    <PinnedDateContext.Provider
      value={{ pinnedDate, setPinnedDate, clearPinnedDate, togglePinnedDate }}
    >
      {children}
    </PinnedDateContext.Provider>
  );
}

export function usePinnedDate() {
  return useContext(PinnedDateContext);
}
