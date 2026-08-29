import { useState, useEffect, useMemo } from "react";
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
  const [search, setSearch] = useState("");
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [listSourceFilter, setListSourceFilter] = useState("all");
  const [showDelisted, setShowDelisted] = useState(false);
  const [page, setPage] = useState(1);
  // Defaults to grouped-by-program, most-recently-changed-first — the
  // user's explicit request for the tab's default view (2026-08-29):
  // "I want the default display to be grouped by PROGRAM and sorted to
  // most recently changed." GroupTable's own useSort defaults to
  // latest_date desc, so this plus that default together produce exactly
  // that view with no extra wiring.
  const [groupBy, setGroupBy] = useState("program");
  // Set once a group row is clicked (drill-in) — cleared to return to the
  // grouped overview. Holds the clicked group directly ({value, count,
  // ofac_uids}) rather than just a key, so the drill-in view's own header
  // can show which value it's scoped to without re-deriving it.
  const [openGroup, setOpenGroup] = useState(null);

  // Flat-table sort — used whenever groupBy is "none" (a user-chosen
  // override of the default grouped view) or inside a drill-in. Defaults
  // to chart_date descending ("most recent designations first") for the
  // same reason GroupTable defaults to latest_date descending: chart_date
  // (the backend's own COALESCE(designation_date, first_seen_snapshot_date),
  // GET /api/ofac/db) is a real per-entity date for essentially every row,
  // not a raw column that could occasionally be NULL.
  const { sortKey, sortDir, toggleSort, sorted } = useSort("chart_date", "desc");

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
  const [programFilter, setProgramFilter] = useState("all");

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
      if (entityTypeFilter !== "all" && r.entity_type !== entityTypeFilter) return false;
      if (listSourceFilter !== "all" && r.list_source !== listSourceFilter) return false;
      if (programFilter !== "all" && !(r.program_tags || []).includes(programFilter)) return false;
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
  }, [rows, search, entityTypeFilter, listSourceFilter, programFilter, showDelisted]);

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

  // Any filter/search/sort change should land back on page 1 — otherwise a
  // narrower result set can leave the view stuck past its own last page.
  function resetToFirstPage(setter) {
    return (value) => {
      setter(value);
      setPage(1);
    };
  }

  function handleGroupByChange(value) {
    setGroupBy(value);
    setOpenGroup(null);
    setPage(1);
  }

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
          <div className="comex-range-selector" style={{ flexWrap: "wrap", gap: 8 }}>
            <input
              type="text"
              placeholder="Search name, type, list, legal basis, programs…"
              value={search}
              onChange={(e) => resetToFirstPage(setSearch)(e.target.value)}
              style={{
                background: "#141820",
                border: "1px solid #2e3547",
                color: "#e8ecf4",
                padding: "4px 8px",
                fontSize: 12,
                minWidth: 260,
              }}
            />
            <select
              value={entityTypeFilter}
              onChange={(e) => resetToFirstPage(setEntityTypeFilter)(e.target.value)}
              className="comex-range-btn"
            >
              <option value="all">All types</option>
              <option value="individual">Individual</option>
              <option value="entity">Entity</option>
              <option value="vessel">Vessel</option>
              <option value="aircraft">Aircraft</option>
            </select>
            <select
              value={listSourceFilter}
              onChange={(e) => resetToFirstPage(setListSourceFilter)(e.target.value)}
              className="comex-range-btn"
            >
              <option value="all">All lists</option>
              <option value="SDN">SDN</option>
              <option value="Consolidated">Consolidated</option>
            </select>
            <select
              value={programFilter}
              onChange={(e) => resetToFirstPage(setProgramFilter)(e.target.value)}
              className="comex-range-btn"
            >
              <option value="all">All programs</option>
              {allPrograms.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8a94a6" }}>
              <input
                type="checkbox"
                checked={showDelisted}
                onChange={(e) => resetToFirstPage(setShowDelisted)(e.target.checked)}
              />
              Include delisted
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8a94a6" }}>
              Group by
              <select value={groupBy} onChange={(e) => handleGroupByChange(e.target.value)} className="comex-range-btn">
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
                <button className="comex-range-btn" style={{ marginLeft: 8 }} onClick={() => setOpenGroup(null)}>
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
            <GroupTable groups={groups} onOpenGroup={setOpenGroup} />
          ) : (
            <>
              <div className="comex-table-wrap" style={{ marginTop: 8 }}>
                <table className="comex-table comex-table--zebra">
                  <thead>
                    <tr>
                      <SortTh label="Date" sortKeyName="chart_date" currentKey={sortKey} currentDir={sortDir} onSort={(k) => { toggleSort(k); setPage(1); }} />
                      <SortTh label="Entity" sortKeyName="entity_name" currentKey={sortKey} currentDir={sortDir} onSort={(k) => { toggleSort(k); setPage(1); }} />
                      <SortTh label="Type" sortKeyName="entity_type" currentKey={sortKey} currentDir={sortDir} onSort={(k) => { toggleSort(k); setPage(1); }} />
                      <SortTh label="Programs" sortKeyName="program_tags" currentKey={sortKey} currentDir={sortDir} onSort={(k) => { toggleSort(k); setPage(1); }} />
                      <SortTh label="Legal Basis" sortKeyName="legal_basis" currentKey={sortKey} currentDir={sortDir} onSort={(k) => { toggleSort(k); setPage(1); }} />
                      <SortTh label="List" sortKeyName="list_source" currentKey={sortKey} currentDir={sortDir} onSort={(k) => { toggleSort(k); setPage(1); }} />
                      {showDelisted && (
                        <SortTh label="Delisted" sortKeyName="delisted_date" currentKey={sortKey} currentDir={sortDir} onSort={(k) => { toggleSort(k); setPage(1); }} />
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
