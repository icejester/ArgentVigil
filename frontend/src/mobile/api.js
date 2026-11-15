import { useEffect, useState } from "react";
import { apiFetch } from "../api_client";

// Read-only GET hook for /db routes (mobile only ever reads, mobile-spec.md
// Section 1). A small in-memory cache keeps a panel's rows and its drill
// screen from re-fetching the same route, with a short TTL so a long-open
// page still refreshes.
const TTL_MS = 60 * 1000;
const cache = new Map(); // path -> {at, promise}

function load(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = apiFetch(path)
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    })
    .catch((e) => {
      cache.delete(path);
      throw e;
    });
  cache.set(path, { at: Date.now(), promise });
  return promise;
}

// path null/undefined = skip. Returns {data, error, loading}. `data` is the
// route's `data` field (or the whole body for routes that don't wrap it).
export function useGet(path, { raw = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load(path)
      .then((j) => live && setState({ data: raw ? j : j.data, error: null, loading: false }))
      .catch((e) => live && setState({ data: null, error: String(e.message || e), loading: false }));
    return () => {
      live = false;
    };
  }, [path, raw]);
  return state;
}

// Several routes at once; loading until all settle, error if any fails.
export function useGetAll(paths) {
  const key = paths.join("|");
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    Promise.all(paths.map(load))
      .then((js) => live && setState({ data: js.map((j) => j.data), error: null, loading: false }))
      .catch((e) => live && setState({ data: null, error: String(e.message || e), loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
