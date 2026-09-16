// Shared fetch helper so the frontend's API base URL is configurable in one
// place (api-split-implementation-plan.md Story 1.2) instead of every call
// site hardcoding a same-origin relative path. VITE_API_BASE_URL defaults to
// "" (today's behavior — relative paths resolved by the Vite dev proxy or,
// once containerized, nginx) so leaving it unset changes nothing.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

export function apiFetch(path, options) {
  return fetch(`${API_BASE_URL}${path}`, options);
}
