import { useEffect, useState } from "react";

// Mobile vs. desktop view selection (mobile-spec.md G3). Opens mobile
// automatically on a narrow viewport; an explicit choice ("Desktop site" /
// "Mobile site" link) is remembered per device in localStorage. localStorage
// is a per-device convenience, not shared state, so this deliberately does
// not go through the server like the pinned-tab setting does.
export const MOBILE_MAX_WIDTH_PX = 720;
const KEY = "av_view";

function readPref() {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "mobile" || v === "desktop" ? v : null;
  } catch {
    return null;
  }
}

export function setViewPref(pref) {
  try {
    if (pref) window.localStorage.setItem(KEY, pref);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* private mode etc. — the switch still works for this page load */
  }
  window.dispatchEvent(new Event("av-view-change"));
}

export function useViewMode() {
  const compute = () => {
    const pref = readPref();
    if (pref) return pref;
    return window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH_PX}px)`).matches ? "mobile" : "desktop";
  };
  const [mode, setMode] = useState(compute);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH_PX}px)`);
    const update = () => setMode(compute());
    mq.addEventListener("change", update);
    window.addEventListener("av-view-change", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("av-view-change", update);
    };
  }, []);
  return mode;
}
