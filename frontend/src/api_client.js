// Shared fetch helper so the frontend's API base URL is configurable in one
// place (api-split-implementation-plan.md Story 1.2) instead of every call
// site hardcoding a same-origin relative path. VITE_API_BASE_URL defaults to
// "" (today's behavior — relative paths resolved by the Vite dev proxy or,
// once containerized, nginx) so leaving it unset changes nothing.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

// Story 3.1: every call site still passes a literal "/api/..." path — rather
// than rewrite every call site to spell "/api/v1/..." by hand, this helper
// inserts the version segment once, here, so call sites stay unchanged and
// a future version bump (e.g. /v2) is again a one-line change. The backend
// still answers on bare /api/... too (a temporary alias, see main.py), but
// the frontend itself should only ever address /api/v1/....
function versionedPath(path) {
  return path.startsWith("/api/") ? `/api/v1${path.slice(4)}` : path;
}

export function apiFetch(path, options) {
  return fetch(`${API_BASE_URL}${versionedPath(path)}`, options);
}
