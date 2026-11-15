import { usePinnedDate } from "../pinned_date_context";

// Mobile pin handlers (mobile-spec.md G5): one global pin shared with
// desktop. onPin(date) sets it; onPin(null) clears it.
export function usePin() {
  const { pinnedDate, setPinnedDate, clearPinnedDate } = usePinnedDate();
  return { pinnedDate, onPin: (d) => (d ? setPinnedDate(d) : clearPinnedDate()) };
}
