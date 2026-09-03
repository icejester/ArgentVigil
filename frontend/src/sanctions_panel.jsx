import { useState, useEffect, useMemo, useReducer } from "react";
import ChartStaleness from "./chart_staleness";

// Client-side sort over an already-fetched array — same shape as
// stack_tracker.jsx's own useSort/SortTh (this repo's established pattern
// for a plain sortable table), duplicated here rather than shared since
// that's this codebase's existing convention for a second, independent
// consumer of the same small pattern rather than a premature abstraction.
function useSort(defaultKey, defaultDir = "desc") {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sorted(rows, accessor) {
    const withIndex = rows.map((r, i) => [r, i]);
    withIndex.sort(([a, ai], [b, bi]) => {
      const av = accessor(a, sortKey);
      const bv = accessor(b, sortKey);
      if (av === null || av === undefined) return bv === null || bv === undefined ? ai - bi : 1;
      if (bv === null || bv === undefined) return -1;
      let cmp;
      if (typeof av === "string") cmp = av.localeCompare(bv);
      else cmp = av - bv;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return withIndex.map(([r]) => r);
  }

  return { sortKey, sortDir, toggleSort, sorted };
}

function SortTh({ label, sortKeyName, currentKey, currentDir, onSort, className }) {
  const active = currentKey === sortKeyName;
  return (
    <th className={className} onClick={() => onSort(sortKeyName)} style={{ cursor: "pointer", userSelect: "none" }}>
      {label}
      {active ? (currentDir === "asc" ? " ↑" : " ↓") : ""}
    </th>
  );
}

const PAGE_SIZE = 50;

// Filter/view state as one reducer instead of eight useState hooks. The
// binding rule every one of them shared — "any filter/search/group/sort
// change lands back on page 1" — lives here once (every action except
// SET_PAGE resets page), replacing a resetToFirstPage() wrapper and six
// inline `{ toggleSort(k); setPage(1); }` copies. Changing the group-by
// field additionally clears the drilled-in group (a stale selection from
// a different grouping dimension is meaningless).
const INITIAL_VIEW = {
  search: "",
  entityType: "all",
  listSource: "all",
  program: "all",
  showDelisted: false,
  // Default view (user's explicit 2026-08-29 request): grouped by program,
  // most-recently-changed group first (GroupTable's own useSort defaults to
  // latest_date desc, so this + that together produce exactly that view).
  groupBy: "program",
  openGroup: null,
  page: 1,
};

function viewReducer(state, action) {
  switch (action.type) {
    case "SET_PAGE":
      return { ...state, page: action.page };
    case "SET_GROUP_BY":
      return { ...state, groupBy: action.value, openGroup: null, page: 1 };
    case "OPEN_GROUP":
      return { ...state, openGroup: action.group, page: 1 };
    case "CLOSE_GROUP":
      return { ...state, openGroup: null, page: 1 };
    case "SET_FIELD":
      return { ...state, [action.field]: action.value, page: 1 };
    default:
      return state;
  }
}

// Group-by field options — deliberately parent-row fields only (Program,
// Entity Type, List Source). Country (address-derived, one-to-many via
// ofac_addresses) was considered and deferred: it needs a join plus a
// policy decision for entities with multiple addresses or none at all,
// a real design question the user chose to punt on for this pass rather
// than bake in a guess now.
const GROUP_BY_OPTIONS = [
  { value: "none", label: "No grouping" },
  { value: "program", label: "Program" },
  { value: "entity_type", label: "Entity Type" },
  { value: "list_source", label: "List Source" },
];

// Builds {value, count, latest_date, ofac_uids}[] from the given (already
// filtered/searched) rows for the chosen group-by field — grouping the
// CURRENTLY VISIBLE subset, not always the full unfiltered dataset, so
// group-by composes with search/filters rather than ignoring them.
// "program" is the one field that's an array per row (an entity can carry
// more than one program) — each row's own programs each get their own
// bucket, so a row with ["IRAN","SDGT"] is counted once under IRAN and
// once under SDGT, same "belongs to more than one group" semantics
// program_tags already has everywhere else it's used in this app.
//
// latest_date: the MAX chart_date across a group's own member rows — "when
// was this group (e.g. this program) most recently touched," per the
// user's explicit "sorted to most recently changed... I'd expect to see
// SDGT and IFSR near the top as it was altered 8/28" request. chart_date
// (COALESCE(designation_date, first_seen_snapshot_date), see GET
// /api/ofac/db) is the same real per-designation date the flat table
// already sorts by, so a group's "most recently changed" reads directly
// off data already fetched — no new backend field needed.
function groupRows(rows, groupBy) {
  const buckets = new Map();
  for (const r of rows) {
    const values = groupBy === "program" ? (r.program_tags && r.program_tags.length ? r.program_tags : [null]) : [r[groupBy]];
    for (const v of values) {
      const key = v ?? "(none)";
      if (!buckets.has(key)) buckets.set(key, { value: key, count: 0, latest_date: null, ofac_uids: [] });
      const bucket = buckets.get(key);
      bucket.count += 1;
      bucket.ofac_uids.push(r.ofac_uid);
      if (r.chart_date && (bucket.latest_date === null || r.chart_date > bucket.latest_date)) {
        bucket.latest_date = r.chart_date;
      }
    }
  }
  return Array.from(buckets.values());
}

function GroupTable({ groups, onOpenGroup }) {
  // Default sort: most-recently-changed group first — the user's explicit
  // request for the default view, not just an available sort option.
  const { sortKey, sortDir, toggleSort, sorted } = useSort("latest_date", "desc");
  const rows = sorted(groups, (g, key) => g[key]);
  return (
    <div className="comex-table-wrap" style={{ marginTop: 8 }}>
      <table className="comex-table comex-table--zebra">
        <thead>
          <tr>
            <SortTh label="Value" sortKeyName="value" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
            <SortTh label="Latest" sortKeyName="latest_date" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
            <SortTh label="Count" sortKeyName="count" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} className="right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.value} onClick={() => onOpenGroup(g)} style={{ cursor: "pointer" }}>
              <td>{g.value}</td>
              <td>{g.latest_date ?? "—"}</td>
              <td className="right">{g.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SanctionsPanel() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [view, dispatch] = useReducer(viewReducer, INITIAL_VIEW);
  const { search, entityType, listSource, program, showDelisted, groupBy, openGroup, page } = view;

  // Convenience wrappers so the JSX reads as `setField("search", value)`
  // rather than a raw dispatch each time.
  const setField = (field) => (value) => dispatch({ type: "SET_FIELD", field, value });
  const setPage = (p) => dispatch({ type: "SET_PAGE", page: p });

  // Flat-table sort — used whenever groupBy is "none" (a user-chosen
  // override of the default grouped view) or inside a drill-in. Defaults
  // to chart_date descending ("most recent designations first") for the
  // same reason GroupTable defaults to latest_date descending: chart_date
  // (the backend's own COALESCE(designation_date, first_seen_snapshot_date),
  // GET /api/ofac/db) is a real per-entity date for essentially every row,
  // not a raw column that could occasionally be NULL. Kept as its own
  // independent hook; every SortTh routes through handleFlatSort so a sort
  // change also lands back on page 1, like every filter change does.
  const { sortKey, sortDir, toggleSort, sorted } = useSort("chart_date", "desc");
  const handleFlatSort = (key) => {
    toggleSort(key);
    setPage(1);
  };

  useEffect(() => {
    fetch("/api/ofac/db")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => setRows(json.data ?? []))
      .catch((e) => setError(e.message));
  }, []);

  // Every distinct program tag actually present, for the filter dropdown —
  // derived from the real data rather than a hand-maintained list, so a
  // program AV has never seen doesn't appear as a dead option and a real
  // new one shows up automatically on the next fetch.
  const allPrograms = useMemo(() => {
    if (!rows) return [];
    const set = new Set();
    for (const r of rows) {
      for (const p of r.program_tags || []) set.add(p);
    }
    return Array.from(set).sort();
  }, [rows]);

  // Search now matches across every top-level text field, not just
  // entity_name — one box, one lowercased match against a joined string of
  // name/type/list source/legal basis/programs, per the user's explicit
  // "search by any top-level field" request (a single unified box, not a
  // per-field input row — the simpler of the two options they picked).
  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showDelisted && r.delisted_date) return false;
      if (entityType !== "all" && r.entity_type !== entityType) return false;
      if (listSource !== "all" && r.list_source !== listSource) return false;
      if (program !== "all" && !(r.program_tags || []).includes(program)) return false;
      if (q) {
        const haystack = [
          r.entity_name,
          r.entity_type,
          r.list_source,
          r.legal_basis,
          ...(r.program_tags || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, entityType, listSource, program, showDelisted]);

  // Grouping operates on the filtered/searched set above, so it composes
  // with every other control rather than always reflecting the full
  // unfiltered dataset.
  const groups = useMemo(() => {
    if (groupBy === "none") return null;
    return groupRows(filtered, groupBy);
  }, [filtered, groupBy]);

  // Drill-in rows: the filtered set restricted to the clicked group's
  // ofac_uids. Cleared automatically (openGroup reset) if groupBy itself
  // changes, since a stale group selection from a different field would be
  // meaningless once the grouping dimension changes.
  const drillInRows = useMemo(() => {
    if (!openGroup) return null;
    const uidSet = new Set(openGroup.ofac_uids);
    return filtered.filter((r) => uidSet.has(r.ofac_uid));
  }, [filtered, openGroup]);

  const tableSourceRows = groupBy === "none" ? filtered : (drillInRows ?? []);

  const sortedRows = sorted(tableSourceRows, (r, key) => {
    if (key === "program_tags") return (r.program_tags || []).join(", ");
    return r[key];
  });

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const pageRows = sortedRows.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);

  const showingGroupedOverview = groupBy !== "none" && !openGroup;
  const showingDrillIn = groupBy !== "none" && !!openGroup;
  const groupFieldLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label;

  return (
    <div className="comex-panel">
      <div className="comex-panel-header">
        OFAC
        <ChartStaleness sourceKey="ofac_sanctions" detail={rows ? [<>{rows.length.toLocaleString()} designations loaded</>] : []} />
      </div>

      {error && <div className="comex-empty-note">{error}</div>}

      {!error && rows === null ? (
        <div className="comex-empty-note">Loading…</div>
      ) : (
        <>
          <div className="comex-range-selector ofac-filter-row">
            <input
              type="text"
              className="ofac-search-input"
              placeholder="Search name, type, list, legal basis, programs…"
              value={search}
              onChange={(e) => setField("search")(e.target.value)}
            />
            <select
              value={entityType}
              onChange={(e) => setField("entityType")(e.target.value)}
              className="comex-range-btn"
            >
              <option value="all">All types</option>
              <option value="individual">Individual</option>
              <option value="entity">Entity</option>
              <option value="vessel">Vessel</option>
              <option value="aircraft">Aircraft</option>
            </select>
            <select
              value={listSource}
              onChange={(e) => setField("listSource")(e.target.value)}
              className="comex-range-btn"
            >
              <option value="all">All lists</option>
              <option value="SDN">SDN</option>
              <option value="Consolidated">Consolidated</option>
            </select>
            <select
              value={program}
              onChange={(e) => setField("program")(e.target.value)}
              className="comex-range-btn"
            >
              <option value="all">All programs</option>
              {allPrograms.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <label className="form-inline-label">
              <input
                type="checkbox"
                checked={showDelisted}
                onChange={(e) => setField("showDelisted")(e.target.checked)}
              />
              Include delisted
            </label>
            <label className="form-inline-label">
              Group by
              <select
                value={groupBy}
                onChange={(e) => dispatch({ type: "SET_GROUP_BY", value: e.target.value })}
                className="comex-range-btn"
              >
                {GROUP_BY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="comex-panel-note" style={{ marginTop: 4 }}>
            {showingDrillIn ? (
              <>
                {groupFieldLabel}: <strong>{openGroup.value}</strong> — {sortedRows.length.toLocaleString()} designations
                <button
                  className="comex-range-btn"
                  style={{ marginLeft: 8 }}
                  onClick={() => dispatch({ type: "CLOSE_GROUP" })}
                >
                  ← Back to {groupFieldLabel} groups
                </button>
              </>
            ) : showingGroupedOverview ? (
              <>{groups.length.toLocaleString()} distinct {groupFieldLabel.toLowerCase()} values, {filtered.length.toLocaleString()} designations total</>
            ) : (
              <>{sortedRows.length.toLocaleString()} of {rows.length.toLocaleString()} designations</>
            )}
          </div>

          {showingGroupedOverview ? (
            <GroupTable groups={groups} onOpenGroup={(g) => dispatch({ type: "OPEN_GROUP", group: g })} />
          ) : (
            <>
              <div className="comex-table-wrap" style={{ marginTop: 8 }}>
                <table className="comex-table comex-table--zebra">
                  <thead>
                    <tr>
                      <SortTh label="Date" sortKeyName="chart_date" currentKey={sortKey} currentDir={sortDir} onSort={handleFlatSort} />
                      <SortTh label="Entity" sortKeyName="entity_name" currentKey={sortKey} currentDir={sortDir} onSort={handleFlatSort} />
                      <SortTh label="Type" sortKeyName="entity_type" currentKey={sortKey} currentDir={sortDir} onSort={handleFlatSort} />
                      <SortTh label="Programs" sortKeyName="program_tags" currentKey={sortKey} currentDir={sortDir} onSort={handleFlatSort} />
                      <SortTh label="Legal Basis" sortKeyName="legal_basis" currentKey={sortKey} currentDir={sortDir} onSort={handleFlatSort} />
                      <SortTh label="List" sortKeyName="list_source" currentKey={sortKey} currentDir={sortDir} onSort={handleFlatSort} />
                      {showDelisted && (
                        <SortTh label="Delisted" sortKeyName="delisted_date" currentKey={sortKey} currentDir={sortDir} onSort={handleFlatSort} />
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => (
                      <tr key={r.ofac_uid}>
                        <td>{r.chart_date ?? "—"}</td>
                        <td>
                          {r.entity_name}
                          {r.entity_type === "vessel" && r.vessel_flag && (
                            <span style={{ color: "#8a94a6" }}> ({r.vessel_flag}{r.vessel_type ? `, ${r.vessel_type}` : ""})</span>
                          )}
                        </td>
                        <td>{r.entity_type ?? "—"}</td>
                        <td>{r.program_tags && r.program_tags.length ? r.program_tags.join(", ") : "—"}</td>
                        <td>{r.legal_basis ?? "—"}</td>
                        <td>{r.list_source}</td>
                        {showDelisted && <td>{r.delisted_date ?? "—"}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {sortedRows.length === 0 && (
                <div className="comex-empty">No designations match the current filters.</div>
              )}

              {totalPages > 1 && (
                <div className="comex-range-selector" style={{ marginTop: 8 }}>
                  <button className="comex-range-btn" disabled={pageClamped <= 1} onClick={() => setPage(pageClamped - 1)}>
                    ← Prev
                  </button>
                  <span style={{ fontSize: 12, color: "#8a94a6" }}>
                    Page {pageClamped} of {totalPages}
                  </span>
                  <button className="comex-range-btn" disabled={pageClamped >= totalPages} onClick={() => setPage(pageClamped + 1)}>
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
