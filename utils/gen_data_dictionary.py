"""
Generates docs/data-dictionary.md from backend/db.py's DDL and
backend/sources.py's registry — the mechanical half of the "explain
every field and where it comes from" ask (datasources-spec.md Story #2).

Run with: .venv/bin/python utils/gen_data_dictionary.py  (from repo root)
(or `source .venv/bin/activate` first — needs the venv; see below.)

Mechanical, not editorial: introspects real table/column shape via
PRAGMA table_info against a throwaway in-memory DB (reuses backend.db's
own DDL string, doesn't touch runtime/argentvigil.db), and cross-
references each table against backend.sources.SOURCE_REGISTRY for
source/cadence/rate-limit attribution. Per-field prose (why a column
exists, why it's sometimes NULL) is pulled from data_editorial.js's
hand-written descriptions where available; any column with none gets a
literal "<!-- TODO: describe field -->" marker so a schema change
without documentation shows up as a visible diff, not a silent gap.
This generator does not invent descriptions — an honest TODO beats a
plausible-but-wrong one.

Requires the venv: imports backend.main (to trigger its module-level
sources.register(...) calls, the only thing that actually populates
backend.sources.SOURCE_REGISTRY) transitively pulls in fastapi/httpx/
dotenv, on top of backend.db's own 3.10+ union-type syntax requirement.
Not stdlib-only like pipeline/ — see CLAUDE.md's ".venv, never bare
python3" rule, which backend/ (unlike pipeline/) is not exempt from.
"""

import os
import re
import sqlite3
import sys

_UTILS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_UTILS_DIR)
sys.path.insert(0, _REPO_ROOT)

from backend import db  # noqa: E402  (pure sqlite3/os/contextlib, no venv needed)

try:
    # backend.sources itself only defines SOURCE_REGISTRY = {} — it's
    # backend.main's module-level sources.register(...) calls (run at
    # import time) that actually populate it, same ordering constraint
    # main.py's own registry-building code has. Importing backend.main
    # here does pull in fastapi/httpx/dotenv transitively, but this
    # generator already requires the venv for backend.db's 3.10+ syntax,
    # so that's not a new constraint.
    import backend.main  # noqa: F401,E402
    from backend import sources  # noqa: E402
except ImportError:
    sources = None  # degrade gracefully — every table just shows "no registered source"

OUTPUT_PATH = os.path.join(_REPO_ROOT, "docs", "data-dictionary.md")
EDITORIAL_PATH = os.path.join(_REPO_ROOT, "frontend", "src", "data_editorial.js")

TODO_MARKER = "<!-- TODO: describe field -->"


def introspect_tables() -> dict[str, list[dict]]:
    """Returns {table_name: [{"name", "type", "notnull", "pk"}, ...]},
    via PRAGMA table_info against a throwaway :memory: DB seeded with
    backend.db.DDL — more robust than regexing the DDL string by hand,
    and reuses db.py's own schema definition rather than re-deriving it."""
    con = sqlite3.connect(":memory:")
    try:
        con.executescript(db.DDL)
        tables = {}
        rows = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        for (table_name,) in rows:
            cols = con.execute(f"PRAGMA table_info({table_name})").fetchall()
            tables[table_name] = [
                {"name": c[1], "type": c[2], "notnull": bool(c[3]), "pk": bool(c[5])}
                for c in cols
            ]
        return tables
    finally:
        con.close()


def load_editorial_descriptions() -> dict[str, dict[str, str]]:
    """Best-effort extraction of {table_name: {field_name: description}}
    from frontend/src/data_editorial.js's hand-written `tables` arrays.
    This is a light regex scrape, not a JS parser — data_editorial.js's
    per-table `fields: [[field, desc, reference], ...]` shape is simple
    enough that a full JS AST isn't worth pulling in for a stdlib-only
    script. Returns {} if the file doesn't exist yet or doesn't parse —
    every column then just gets a TODO marker, which is the correct,
    honest fallback per this generator's own stated convention."""
    if not os.path.exists(EDITORIAL_PATH):
        return {}
    text = open(EDITORIAL_PATH, encoding="utf-8").read()
    result: dict[str, dict[str, str]] = {}
    # Matches: name: "table_name", ... fields: [ ["field", "description", ...], ... ]
    for table_block in re.finditer(
        r'name:\s*"(?P<table>\w+)"\s*,\s*fields:\s*\[(?P<body>.*?)\]\s*,?\s*(?:note:|\})',
        text, re.DOTALL,
    ):
        table_name = table_block.group("table")
        body = table_block.group("body")
        fields: dict[str, str] = {}
        for field_row in re.finditer(
            r'\[\s*"(?P<field>[^"]+)"\s*,\s*"(?P<desc>(?:[^"\\]|\\.)*)"', body,
        ):
            fields[field_row.group("field")] = field_row.group("desc").replace('\\"', '"')
        if fields:
            result[table_name] = fields
    return result


def source_for_table(table_name: str):
    """Returns the SourceDefinition that owns table_name, or None if no
    registered source claims it (infrastructure tables like source_health/
    pipeline_runs/ui_settings, or a table not yet attributed)."""
    if sources is None:
        return None
    for source in sources.SOURCE_REGISTRY.values():
        if table_name in source.tables:
            return source
    return None


def format_rate_limit(rate_limit) -> str:
    if rate_limit.kind == "numeric_quota":
        return rate_limit.quota_per_period or "(quota not specified)"
    if rate_limit.kind == "min_gap_derived":
        days = rate_limit.min_gap.days if rate_limit.min_gap else "?"
        return f"~{days}-day minimum gap between fetch attempts"
    return "undocumented — advisory only"


def generate_markdown(tables: dict[str, list[dict]], editorial: dict[str, dict[str, str]]) -> str:
    lines = [
        "<!-- GENERATED FILE — do not hand-edit. Regenerate with:",
        "     .venv/bin/python utils/gen_data_dictionary.py",
        "     Source: backend/db.py's DDL (schema) + backend/sources.py (provenance/cadence/rate-limit)",
        "     + frontend/src/data_editorial.js (per-field prose, where available). -->",
        "",
        "# ArgentVigil Data Dictionary",
        "",
        f"{len(tables)} tables. Generated field lists are mechanical (from SQLite's own schema); "
        "per-field descriptions are pulled from data_editorial.js where hand-written, "
        f"or marked `{TODO_MARKER}` where they are not yet documented.",
        "",
    ]

    todo_count = 0
    total_fields = 0

    for table_name in sorted(tables):
        columns = tables[table_name]
        source = source_for_table(table_name)
        table_editorial = editorial.get(table_name, {})

        lines.append(f"## `{table_name}`")
        lines.append("")
        if source is not None:
            lines.append(f"**Source**: {source.label} (`{source.key}`, {source.affinity_group})  ")
            lines.append(f"**Cadence**: `{source.cadence.trigger}`"
                          + (f", every {source.cadence.interval_seconds}s" if source.cadence.interval_seconds else "")
                          + "  ")
            lines.append(f"**Rate limit**: {format_rate_limit(source.rate_limit)}  ")
        else:
            lines.append("**Source**: infrastructure table (no registered upstream source)  ")
        lines.append("")
        lines.append("| Field | Type | PK | Description |")
        lines.append("|---|---|---|---|")
        for col in columns:
            total_fields += 1
            desc = table_editorial.get(col["name"])
            if desc is None:
                desc = TODO_MARKER
                todo_count += 1
            pk_marker = "✓" if col["pk"] else ""
            lines.append(f"| `{col['name']}` | {col['type']} | {pk_marker} | {desc} |")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"**Coverage**: {total_fields - todo_count}/{total_fields} fields documented, "
                  f"{todo_count} pending (`{TODO_MARKER}`).")
    lines.append("")
    lines.append(generate_erd(tables))
    return "\n".join(lines)


def generate_erd(tables: dict[str, list[dict]]) -> str:
    """Second deliverable per Story #2: a mermaid erDiagram, grouped by
    affinity_group rather than one flat wall of every table — generated
    from the registry, not hand-drawn."""
    groups: dict[str, list[str]] = {}
    unattributed: list[str] = []
    for table_name in sorted(tables):
        source = source_for_table(table_name)
        if source is None:
            unattributed.append(table_name)
        else:
            groups.setdefault(source.affinity_group, []).append(table_name)

    lines = ["## Entity groups (by affinity group)", "", "```mermaid", "erDiagram"]
    for group_name in sorted(groups):
        for table_name in groups[group_name]:
            safe_cols = tables[table_name][:6]  # keep the diagram legible; full field list is in the table above
            lines.append(f'    "{table_name}" {{')
            for col in safe_cols:
                lines.append(f"        {col['type'] or 'TEXT'} {col['name']}")
            lines.append("    }")
    lines.append("```")
    lines.append("")
    if unattributed:
        lines.append(f"Infrastructure tables (no registered source): {', '.join(f'`{t}`' for t in unattributed)}")
    return "\n".join(lines)


def main():
    tables = introspect_tables()
    editorial = load_editorial_descriptions()
    markdown = generate_markdown(tables, editorial)
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(markdown)
    todo_count = markdown.count(TODO_MARKER)
    print(f"Wrote {OUTPUT_PATH}: {len(tables)} tables, {todo_count} fields pending description.")


if __name__ == "__main__":
    main()
