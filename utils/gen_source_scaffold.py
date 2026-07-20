"""
Deterministic scaffold generator for onboarding a new data source
(datasources-spec.md Story #4). Emits reviewable boilerplate — never
writes files directly (this repo's standing Learning Mode rule: never
auto-apply, the user makes the final call).

Run with: .venv/bin/python utils/gen_source_scaffold.py path/to/source.yaml
(stdlib-only otherwise, but needs the venv for the same reason
gen_data_dictionary.py does — it introspects backend.sources' real
dataclass shapes so the generated snippet can't silently drift from
them.)

Input YAML is the SERIALIZED OUTPUT of the judgment phase (a conversation
that reasons through the new source's real response shape, quirks, and
correct cadence — see the accompanying .claude/commands/onboard-source.md),
not a hand-authored starting point. This generator only does the
boilerplate half: producing a SourceDefinition block, a DDL scaffold, a
paired fetch/db route pair, and a data_editorial.js stub — all
structurally identical to every other source in this codebase by
construction, so a new source #N can't quietly diverge from source #1's
conventions the way the pre-datasources-spec.md sources did.

What this does NOT do: parse the response shape, infer null sentinels,
or guess the real cadence — those need a human (or a conversation) who
has actually looked at a real response. Every generated fetch function
carries a literal "# TODO: parse response" marker at exactly the point
where that judgment is required.

YAML shape (see utils/example_source.yaml for a worked example):

    key: some_new_source
    label: "Some New API — Widget Counts"
    affinity_group: exchange_market   # gov_regulatory | exchange_market | calendar_events | static_internal
    base_url: "https://api.example.com/v1/widgets"
    auth:
      type: api_key   # none | api_key | token_fetch
      header: "x-api-key"          # only for api_key
      env_var: SOME_API_KEY         # only for api_key
    cadence:
      trigger: interval             # startup | interval | manual_only | always_on
      interval_seconds: 86400       # only for interval/always_on
      min_gap_days: null            # only for manual_only sources with a rate-limit gate
      gate_on: last_attempt_at      # last_attempt_at | persisted_data_age
      enabled_flag: null            # "fast_enabled" | "slow_enabled" | null
    rate_limit:
      kind: numeric_quota           # numeric_quota | min_gap_derived | undocumented
      quota_per_period: "500/month"
      note: "Free tier"
    fields:
      - { name: widget_count, type: REAL, description: "Total widgets reported" }
      - { name: date, type: TEXT, pk: true }
"""

import os
import sys

_UTILS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_UTILS_DIR)
sys.path.insert(0, _REPO_ROOT)

try:
    # Import backend.main (not just backend.sources) so SOURCE_REGISTRY is
    # actually populated — backend.sources itself only defines the empty
    # dict; main.py's module-level sources.register(...) calls are what
    # fill it in, same ordering quirk gen_data_dictionary.py works around.
    import backend.main  # noqa: F401,E402
    import backend.sources as sources_module  # noqa: E402
except ImportError as e:
    print(f"Warning: could not import backend.main ({e}) — proceeding without a live key-collision check.", file=sys.stderr)
    sources_module = None


def _load_yaml_minimal(path: str) -> dict:
    """A minimal, dependency-free YAML reader covering exactly the subset
    this generator's input shape uses (nested maps, lists of maps, scalars,
    null/true/false) — avoids requiring PyYAML as a new dependency for a
    single onboarding script. Not a general YAML parser; raises on
    anything it doesn't recognize rather than silently misreading it."""
    try:
        import yaml  # if PyYAML happens to be installed, prefer it — it's strictly more correct
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except ImportError:
        pass

    def parse_scalar(s: str):
        s = s.strip()
        if s in ("null", "~", ""):
            return None
        if s == "true":
            return True
        if s == "false":
            return False
        if s.startswith('"') and s.endswith('"'):
            return s[1:-1]
        if s.startswith("'") and s.endswith("'"):
            return s[1:-1]
        try:
            return int(s)
        except ValueError:
            pass
        try:
            return float(s)
        except ValueError:
            pass
        return s

    with open(path, encoding="utf-8") as f:
        raw_lines = f.readlines()

    lines = []
    for line in raw_lines:
        stripped = line.split("#", 1)[0].rstrip("\n")
        if stripped.strip() == "":
            continue
        lines.append(stripped)

    def indent_of(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

    def parse_block(idx: int, indent: int):
        result = {}
        while idx < len(lines):
            line = lines[idx]
            cur_indent = indent_of(line)
            if cur_indent < indent:
                return result, idx
            if cur_indent > indent:
                raise ValueError(f"unexpected indent at line: {line!r}")
            content = line.strip()
            if content.startswith("- "):
                raise ValueError(f"list item found where a map key was expected: {line!r}")
            if ":" not in content:
                raise ValueError(f"expected 'key: value' at line: {line!r}")
            key, _, rest = content.partition(":")
            key = key.strip()
            rest = rest.strip()
            if rest == "" :
                # nested block or list — peek next line
                if idx + 1 < len(lines) and indent_of(lines[idx + 1]) > indent:
                    next_indent = indent_of(lines[idx + 1])
                    if lines[idx + 1].strip().startswith("- "):
                        items, idx = parse_list(idx + 1, next_indent)
                        result[key] = items
                    else:
                        sub, idx = parse_block(idx + 1, next_indent)
                        result[key] = sub
                    continue
                else:
                    result[key] = None
                    idx += 1
                    continue
            elif rest.startswith("{") and rest.endswith("}"):
                # inline map: { name: x, type: REAL, description: "..." }
                inline = {}
                body = rest[1:-1]
                for part in _split_inline(body):
                    k, _, v = part.partition(":")
                    inline[k.strip()] = parse_scalar(v.strip())
                result[key] = inline
                idx += 1
            else:
                result[key] = parse_scalar(rest)
                idx += 1
        return result, idx

    def parse_list(idx: int, indent: int):
        items = []
        while idx < len(lines):
            line = lines[idx]
            cur_indent = indent_of(line)
            if cur_indent < indent:
                return items, idx
            content = line.strip()
            if not content.startswith("- "):
                return items, idx
            item_body = content[2:].strip()
            if item_body.startswith("{") and item_body.endswith("}"):
                inline = {}
                body = item_body[1:-1]
                for part in _split_inline(body):
                    k, _, v = part.partition(":")
                    inline[k.strip()] = parse_scalar(v.strip())
                items.append(inline)
                idx += 1
            else:
                items.append(parse_scalar(item_body))
                idx += 1
        return items, idx

    def _split_inline(body: str) -> list[str]:
        # splits on top-level commas only (naive but sufficient for this
        # generator's own inline-map inputs, which never nest quotes with commas)
        parts = []
        depth = 0
        cur = ""
        for ch in body:
            if ch == '"':
                depth = 1 - depth
            if ch == "," and depth == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += ch
        if cur.strip():
            parts.append(cur)
        return parts

    data, _ = parse_block(0, 0)
    return data


def _pascal_case(key: str) -> str:
    return "".join(part.capitalize() for part in key.split("_"))


def generate_source_definition_block(spec: dict) -> str:
    key = spec["key"]
    label = spec["label"]
    affinity_group = spec["affinity_group"]
    cadence = spec.get("cadence", {})
    rate_limit = spec.get("rate_limit", {})
    auth = spec.get("auth", {"type": "none"})

    cadence_args = [f'trigger="{cadence.get("trigger", "manual_only")}"']
    if cadence.get("interval_seconds") is not None:
        cadence_args.append(f'interval_seconds={cadence["interval_seconds"]}')
    if cadence.get("min_gap_days") is not None:
        cadence_args.append(f'min_gap=timedelta(days={cadence["min_gap_days"]})')
    if cadence.get("gate_on") and cadence.get("gate_on") != "last_attempt_at":
        cadence_args.append(f'gate_on="{cadence["gate_on"]}"')
    if cadence.get("enabled_flag"):
        cadence_args.append(f'enabled_flag="{cadence["enabled_flag"]}"')
    cadence_str = ", ".join(cadence_args)

    rl_kind = rate_limit.get("kind", "undocumented")
    rl_args = [f'kind="{rl_kind}"']
    if rate_limit.get("quota_per_period"):
        rl_args.append(f'quota_per_period="{rate_limit["quota_per_period"]}"')
    if rate_limit.get("min_gap_days") is not None:
        rl_args.append(f'min_gap=timedelta(days={rate_limit["min_gap_days"]})')
    elif cadence.get("min_gap_days") is not None and rl_kind == "min_gap_derived":
        rl_args.append("min_gap=cadence.min_gap")  # reuse the same value, not re-typed — see sources.py's own convention
    if rate_limit.get("note"):
        rl_args.append(f'note="{rate_limit["note"]}"')
    rl_str = ", ".join(rl_args)

    requires_env = []
    if auth.get("type") == "api_key" and auth.get("env_var"):
        requires_env.append(auth["env_var"])
    requires_env_str = repr(requires_env)

    tables_str = repr([key])  # default: one table named after the source key — adjust by hand if the source writes to more than one

    return f'''sources.register(SourceDefinition(
    key="{key}", label="{label}",
    affinity_group="{affinity_group}", fetch_fn=_fetch_and_persist_{key},
    tables={tables_str}, requires_env={requires_env_str},
    cadence=CadenceSpec({cadence_str}),
    rate_limit=RateLimitSpec({rl_str}),
))'''


def generate_fetch_function(spec: dict) -> str:
    key = spec["key"]
    base_url = spec.get("base_url", "https://TODO")
    auth = spec.get("auth", {"type": "none"})
    fields = spec.get("fields", [])
    field_names = [f["name"] for f in fields]

    auth_lines = ""
    headers_expr = "{}"
    if auth.get("type") == "api_key":
        env_var = auth.get("env_var", "TODO_API_KEY")
        header = auth.get("header", "x-api-key")
        auth_lines = f'    api_key = os.environ["{env_var}"]\n'
        headers_expr = f'{{"{header}": api_key}}'
    elif auth.get("type") == "token_fetch":
        auth_lines = "    hdrs = await authed_headers(_client)  # TODO: confirm this source's own token-fetch mechanism, if different from mc_token.py's\n"
        headers_expr = "hdrs"

    return f'''async def _fetch_and_persist_{key}() -> dict:
    """TODO: fill in real fetch/persist logic — this is generated
    boilerplate, not a working integration. Judgment items still needed
    (per datasources-spec.md Story #4's deterministic/judgment split):
    real response shape, null sentinels (does this upstream use 0 or a
    magic string to mean "not reported"? see AV's nulls-over-zeros
    convention in CLAUDE.md), unit conversions, and the real cadence this
    source should run on (confirm the YAML's cadence guess against how
    often this upstream source actually updates)."""
{auth_lines}    resp = await _client.get(
        "{base_url}",
        headers={headers_expr},
        timeout=15,
    )
    resp.raise_for_status()
    raw = resp.json()
    # TODO: parse response — fields expected: {field_names}
    rows = []  # TODO: build real {{field: value}} dicts from raw
    if rows:
        db.upsert_{key}_rows(rows)  # TODO: add db.upsert_{key}_rows to backend/db.py
    return raw'''


def generate_db_route(spec: dict) -> str:
    key = spec["key"]
    return f'''@app.get("/api/{key}/db")
async def {key}_db():
    rows = db.get_{key}(...)  # TODO: add db.get_{key} to backend/db.py
    return {{"success": True, "data": rows}}'''


def generate_ddl(spec: dict) -> str:
    key = spec["key"]
    fields = spec.get("fields", [])
    col_lines = []
    pk_cols = []
    for f in fields:
        name = f["name"]
        sqltype = f.get("type", "TEXT")
        col_lines.append(f"    {name} {sqltype}")
        if f.get("pk"):
            pk_cols.append(name)
    pk_clause = f",\n    PRIMARY KEY ({', '.join(pk_cols)})" if pk_cols else ""
    cols = ",\n".join(col_lines)
    return f'''CREATE TABLE IF NOT EXISTS {key} (
{cols}{pk_clause}
);'''


def generate_editorial_stub(spec: dict) -> str:
    key = spec["key"]
    label = spec["label"]
    fields = spec.get("fields", [])
    field_rows = ",\n".join(
        f'          ["{f["name"]}", "<!-- TODO: describe field -->", "<!-- TODO: where is this used in the UI -->"]'
        for f in fields
    )
    return f'''  {{
    key: "{key}",
    label: "{label}",
    origin: "<!-- TODO: describe upstream source -->",
    sourceKeys: ["{key}"],
    curl: `<!-- TODO: equivalent curl example -->`,
    tables: [
      {{
        name: "{key}",
        fields: [
{field_rows}
        ],
        note: "<!-- TODO: any upsert/append-only/nulls-over-zeros notes -->",
      }},
    ],
  }}'''


def generate_scaffold(spec: dict) -> str:
    key = spec["key"]
    parts = [
        f"{'=' * 70}",
        f"Scaffold for source: {key}",
        f"{'=' * 70}",
        "",
        "This is REVIEWABLE OUTPUT, not applied automatically (per this",
        "repo's Learning Mode standing rule). Copy each block into its real",
        "home by hand, filling in every TODO first.",
        "",
        "--- 1. backend/sources.py: add near the other SourceDefinitions ---",
        "",
        generate_source_definition_block(spec),
        "",
        "--- 2. backend/main.py: fetch function (module-level, before the",
        "       sources.register(...) block that references it) ---",
        "",
        generate_fetch_function(spec),
        "",
        "--- 3. backend/main.py: paired /db read route (persist-on-fetch —",
        "       the frontend calls only this, never the fetch function",
        "       directly; see CLAUDE.md's Standing architectural rules) ---",
        "",
        generate_db_route(spec),
        "",
        "--- 4. backend/db.py: DDL scaffold — add to the DDL string constant ---",
        "",
        generate_ddl(spec),
        "",
        "--- 5. frontend/src/data_editorial.js: card stub — add to the",
        "       DATA_EDITORIAL array ---",
        "",
        generate_editorial_stub(spec),
        "",
        "--- Remaining manual steps (not generated, need judgment) ---",
        "",
        "  - Fill in every '# TODO: parse response' / '<!-- TODO -->' marker above.",
        "  - Add db.upsert_" + key + "_rows / db.get_" + key + " to backend/db.py.",
        "  - Confirm the YAML's cadence guess against how often this source",
        "    really updates upstream — re-run utils/gen_data_dictionary.py",
        "    once wired up to confirm the new table/source shows up correctly.",
        "  - If this source needs a startup call in lifespan (trigger=startup),",
        "    add it explicitly — sources.py's registry doesn't auto-dispatch",
        "    startup-trigger sources (see CadenceSpec's own docstring).",
        "",
    ]
    return "\n".join(parts)


def main():
    if len(sys.argv) != 2:
        print("Usage: .venv/bin/python utils/gen_source_scaffold.py path/to/source.yaml", file=sys.stderr)
        sys.exit(1)
    yaml_path = sys.argv[1]
    spec = _load_yaml_minimal(yaml_path)

    if not spec.get("key"):
        print("Error: YAML must have a 'key' field.", file=sys.stderr)
        sys.exit(1)
    if sources_module is not None and spec["key"] in sources_module.SOURCE_REGISTRY:
        print(f"Error: source_key '{spec['key']}' already exists in backend.sources.SOURCE_REGISTRY — pick a new key.", file=sys.stderr)
        sys.exit(1)

    print(generate_scaffold(spec))


if __name__ == "__main__":
    main()
