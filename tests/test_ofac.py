"""OFAC Sanctions Timeline (sanctionsTimeline-spec.md) — diff-and-persist
semantics (including designation_date backfill on re-seen entities), and
Advanced-XML parsing against a small synthetic fixture (never the real
~126MB sdn_advanced.xml file, per conftest.py's ground rules)."""

import httpx
import respx

from backend import main as main_module


def _entry(uid, **overrides):
    row = {
        "ofac_uid": uid,
        "entity_name": f"Entity {uid}",
        "entity_type": "individual",
        "program_tags": ["IRAN"],
        "list_source": "SDN",
        "designation_date": None,
        "legal_basis": None,
        "vessel_flag": None,
        "vessel_type": None,
    }
    row.update(overrides)
    return row


# --- Diff logic: new / unchanged / delisted, keyed on ofac_uid only -------


def test_new_entities_are_inserted(tmp_db):
    result = tmp_db.diff_and_persist_ofac_designations([_entry("1001"), _entry("1002")], "2026-08-25")
    assert result == {"new": 2, "delisted": 0, "unchanged": 0}
    rows = {r["ofac_uid"]: r for r in tmp_db.get_ofac_designations()}
    assert set(rows) == {"1001", "1002"}
    assert rows["1001"]["first_seen_snapshot_date"] == "2026-08-25"
    assert rows["1001"]["last_seen_snapshot_date"] == "2026-08-25"
    assert rows["1001"]["delisted_date"] is None


def test_reseen_entity_only_bumps_last_seen_not_other_fields(tmp_db):
    """Existence-diffing, not content-diffing — a uid present in both pulls
    is untouched except last_seen_snapshot_date, per spec Story #1. OFAC
    republishes its whole list every pull, so this deliberately does NOT
    treat a same-uid re-fetch as a content update."""
    tmp_db.diff_and_persist_ofac_designations([_entry("1001", entity_name="Original Name")], "2026-08-24")
    result = tmp_db.diff_and_persist_ofac_designations([_entry("1001", entity_name="Renamed")], "2026-08-25")
    assert result == {"new": 0, "delisted": 0, "unchanged": 1}
    rows = tmp_db.get_ofac_designations()
    assert len(rows) == 1
    assert rows[0]["entity_name"] == "Original Name"  # untouched, not overwritten
    assert rows[0]["first_seen_snapshot_date"] == "2026-08-24"
    assert rows[0]["last_seen_snapshot_date"] == "2026-08-25"


def test_absent_entity_is_delisted_not_deleted(tmp_db):
    """A uid present yesterday but absent today gets delisted_date set on
    its EXISTING row — never a row deletion, never a new row."""
    tmp_db.diff_and_persist_ofac_designations([_entry("1001"), _entry("1002")], "2026-08-24")
    result = tmp_db.diff_and_persist_ofac_designations([_entry("1001")], "2026-08-25")
    assert result == {"new": 0, "delisted": 1, "unchanged": 1}
    rows = {r["ofac_uid"]: r for r in tmp_db.get_ofac_designations()}
    assert set(rows) == {"1001", "1002"}  # row still exists
    assert rows["1002"]["delisted_date"] == "2026-08-25"
    assert rows["1001"]["delisted_date"] is None


def test_relisted_entity_clears_delisted_date(tmp_db):
    """A uid that reappears after being delisted is treated as equivalent
    to a fresh new listing (documented decision — the spec is silent on
    this case; leaving a stale delisted_date on a currently-listed entity
    would be the more dishonest reading)."""
    tmp_db.diff_and_persist_ofac_designations([_entry("1001")], "2026-08-24")
    tmp_db.diff_and_persist_ofac_designations([], "2026-08-25")  # delisted
    assert tmp_db.get_ofac_designations()[0]["delisted_date"] == "2026-08-25"

    result = tmp_db.diff_and_persist_ofac_designations([_entry("1001")], "2026-08-26")
    assert result == {"new": 1, "delisted": 0, "unchanged": 0}
    rows = tmp_db.get_ofac_designations()
    assert len(rows) == 1  # same row, not a duplicate
    assert rows[0]["delisted_date"] is None


def test_program_tags_round_trip_as_json_list(tmp_db):
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", program_tags=["IRAN", "SDGT"])], "2026-08-25"
    )
    rows = tmp_db.get_ofac_designations()
    assert rows[0]["program_tags"] == ["IRAN", "SDGT"]


def test_get_ofac_designations_filters_by_program(tmp_db):
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", program_tags=["IRAN"]), _entry("1002", program_tags=["RUSSIA-EO14024"])],
        "2026-08-25",
    )
    rows = tmp_db.get_ofac_designations(program="IRAN")
    assert [r["ofac_uid"] for r in rows] == ["1001"]


def test_get_ofac_designations_filters_by_list_source(tmp_db):
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", list_source="SDN"), _entry("1002", list_source="Consolidated")],
        "2026-08-25",
    )
    rows = tmp_db.get_ofac_designations(list_source="Consolidated")
    assert [r["ofac_uid"] for r in rows] == ["1002"]


def test_get_ofac_designations_filters_by_snapshot_date_range(tmp_db):
    tmp_db.diff_and_persist_ofac_designations([_entry("1001")], "2026-08-01")
    tmp_db.diff_and_persist_ofac_designations([_entry("1001"), _entry("1002")], "2026-08-25")
    rows = tmp_db.get_ofac_designations(since="2026-08-10")
    assert [r["ofac_uid"] for r in rows] == ["1002"]


# --- Nulls over zeros: designation_date -----------------------------------


def test_designation_date_persists_null_when_unknown(tmp_db):
    """Real per-entity designation dates ARE available (Advanced XML files
    — see main.py's _parse_ofac_advanced_xml), but an entity with no real
    date (a theoretical edge case not yet observed in real data) must still
    persist NULL — never backfilled from first_seen_snapshot_date or a
    document-level publish date — per the standing nulls-over-zeros
    convention. get_ofac_designations' own chart_date field (COALESCE)
    still gives callers a usable date either way."""
    tmp_db.diff_and_persist_ofac_designations([_entry("1001", designation_date=None)], "2026-08-25")
    rows = tmp_db.get_ofac_designations()
    assert rows[0]["designation_date"] is None
    assert rows[0]["first_seen_snapshot_date"] == "2026-08-25"
    assert rows[0]["chart_date"] == "2026-08-25"  # COALESCE fallback


def test_real_designation_date_persists_and_is_not_overwritten_by_fallback(tmp_db):
    """The common case now: a real designation_date from the Advanced XML
    parse persists as-is, and chart_date prefers it over
    first_seen_snapshot_date."""
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", designation_date="1986-12-10")], "2026-08-25"
    )
    rows = tmp_db.get_ofac_designations()
    assert rows[0]["designation_date"] == "1986-12-10"
    assert rows[0]["chart_date"] == "1986-12-10"


def test_designation_date_backfills_on_reseen_entity_when_previously_null(tmp_db):
    """A row persisted before this table had real dates (designation_date
    NULL) gets backfilled on the next pull if that pull's parse now finds a
    real date — a one-time convergence, not ongoing content-diffing (see
    diff_and_persist_ofac_designations' own docstring for why this is
    different from the entity_name/program overwrite the spec's
    existence-diffing rule warns against)."""
    tmp_db.diff_and_persist_ofac_designations([_entry("1001", designation_date=None)], "2026-08-25")
    assert tmp_db.get_ofac_designations()[0]["designation_date"] is None

    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", designation_date="1986-12-10")], "2026-08-26"
    )
    rows = tmp_db.get_ofac_designations()
    assert rows[0]["designation_date"] == "1986-12-10"
    assert rows[0]["last_seen_snapshot_date"] == "2026-08-26"


def test_designation_date_not_overwritten_once_real_on_reseen_entity(tmp_db):
    """Once a real designation_date is persisted, a later pull's (identical,
    since OFAC's own Created date doesn't change) value doesn't need to
    "win" over anything — this just confirms the backfill logic doesn't
    accidentally null out an already-real date on a later pull that (for
    whatever reason) parses no date that time."""
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", designation_date="1986-12-10")], "2026-08-25"
    )
    tmp_db.diff_and_persist_ofac_designations([_entry("1001", designation_date=None)], "2026-08-26")
    assert tmp_db.get_ofac_designations()[0]["designation_date"] == "1986-12-10"


def test_legal_basis_backfills_on_reseen_entity_when_previously_null(tmp_db):
    """Same one-time backfill convergence as designation_date — a row
    persisted before legal_basis was captured (or before an EntryEvent's
    LegalBasisID happened to resolve to something real) gets it filled in
    on the next pull, never overwritten once real."""
    tmp_db.diff_and_persist_ofac_designations([_entry("1001", legal_basis=None)], "2026-08-25")
    assert tmp_db.get_ofac_designations()[0]["legal_basis"] is None

    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", legal_basis="Executive Order 14024 (Russia)")], "2026-08-26"
    )
    assert tmp_db.get_ofac_designations()[0]["legal_basis"] == "Executive Order 14024 (Russia)"

    # A later pull with no legal_basis (e.g. a parse miss that day) must not
    # null out the already-real value.
    tmp_db.diff_and_persist_ofac_designations([_entry("1001", legal_basis=None)], "2026-08-27")
    assert tmp_db.get_ofac_designations()[0]["legal_basis"] == "Executive Order 14024 (Russia)"


# --- XML parsing against a small synthetic Advanced-format fixture --------
# (never the real ~126MB sdn_advanced.xml file — the schema shape here is
# a hand-trimmed reproduction of the real one, confirmed live 2026-08-26
# against actual fetched sdn_advanced.xml/cons_advanced.xml files: three
# top-level sections — ReferenceValueSets (small ID->label dictionaries),
# DistinctParty (identity/name/vessel-feature detail), SanctionsEntries
# (list membership, EntryEvent dates, SanctionsMeasure program tags) —
# joined by ProfileID/FixedRef, NOT the flat one-sdnEntry-per-party shape
# the plain sdn.xml/consolidated.xml files use.)

# The Advanced XML files' real namespace, confirmed live 2026-08-26 against
# a real sdn_advanced.xml's own root element — genuinely different from the
# plain sdn.xml/consolidated.xml namespace (".../exports/XML", no
# "ADVANCED_" prefix), a real bug this test fixture would silently miss if
# it used the wrong one (every _ofac_tag(...) lookup would match zero
# elements, same as the real bug caught in manual verification).
_SDN_NS = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML"

_SYNTHETIC_SDN_ADVANCED_XML = f"""<?xml version="1.0" standalone="yes"?>
<Sanctions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="{_SDN_NS}">
  <ReferenceValueSets>
    <DetailReferenceValues>
      <DetailReference ID="705">Tug</DetailReference>
    </DetailReferenceValues>
    <PartySubTypeValues>
      <PartySubType ID="1" PartyTypeID="4">Vessel</PartySubType>
      <PartySubType ID="2" PartyTypeID="4">Aircraft</PartySubType>
      <PartySubType ID="3" PartyTypeID="2">Unknown</PartySubType>
      <PartySubType ID="4" PartyTypeID="1">Unknown</PartySubType>
    </PartySubTypeValues>
    <CountryValues>
      <Country ID="11029">Afghanistan</Country>
      <Country ID="11073">Cuba</Country>
    </CountryValues>
    <LocPartTypeValues>
      <LocPartType ID="1451">ADDRESS1</LocPartType>
      <LocPartType ID="1454">CITY</LocPartType>
      <LocPartType ID="1455">STATE/PROVINCE</LocPartType>
    </LocPartTypeValues>
    <IDRegDocTypeValues>
      <IDRegDocType ID="1571">Passport</IDRegDocType>
    </IDRegDocTypeValues>
    <LegalBasisValues>
      <LegalBasis ID="1">Unknown</LegalBasis>
      <LegalBasis ID="1822">Executive Order 13606 (Iran/Syria)</LegalBasis>
    </LegalBasisValues>
  </ReferenceValueSets>
  <DistinctParties>
    <DistinctParty FixedRef="9640">
      <Profile ID="9640" PartySubTypeID="4">
        <Identity ID="4001" FixedRef="9640">
          <Alias FixedRef="9640" Primary="true" AliasTypeID="1403">
            <DocumentedName ID="4001" FixedRef="9640">
              <DocumentedNamePart>
                <NamePartValue>Jane</NamePartValue>
              </DocumentedNamePart>
              <DocumentedNamePart>
                <NamePartValue>DOE</NamePartValue>
              </DocumentedNamePart>
            </DocumentedName>
          </Alias>
          <Alias FixedRef="9640" Primary="false" AliasTypeID="1400">
            <DocumentedName ID="4003" FixedRef="9640">
              <DocumentedNamePart>
                <NamePartValue>JANE D.</NamePartValue>
              </DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
        <Feature ID="10999" FeatureTypeID="25">
          <FeatureVersion ID="7999">
            <VersionLocation LocationID="501" />
          </FeatureVersion>
        </Feature>
      </Profile>
    </DistinctParty>
    <DistinctParty FixedRef="9641">
      <Profile ID="9641" PartySubTypeID="3">
        <Identity ID="4002" FixedRef="9641">
          <Alias FixedRef="9641" Primary="true">
            <DocumentedName ID="4002" FixedRef="9641">
              <DocumentedNamePart>
                <NamePartValue>ACME CORP</NamePartValue>
              </DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
      </Profile>
    </DistinctParty>
    <DistinctParty FixedRef="4238">
      <Profile ID="4238" PartySubTypeID="1">
        <Identity ID="1663" FixedRef="4238">
          <Alias FixedRef="4238" Primary="true">
            <DocumentedName ID="1663" FixedRef="4238">
              <DocumentedNamePart>
                <NamePartValue>MAR AZUL</NamePartValue>
              </DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
        <Feature ID="10321" FeatureTypeID="3">
          <FeatureVersion ID="7174">
            <VersionDetail>Cuba</VersionDetail>
          </FeatureVersion>
        </Feature>
        <Feature ID="11080" FeatureTypeID="2">
          <FeatureVersion ID="7933">
            <VersionDetail DetailReferenceID="705" />
          </FeatureVersion>
        </Feature>
      </Profile>
    </DistinctParty>
  </DistinctParties>
  <Locations>
    <Location ID="501">
      <LocationCountry CountryID="11029" />
      <LocationPart LocPartTypeID="1451">
        <LocationPartValue>
          <Value>123 Main St</Value>
        </LocationPartValue>
      </LocationPart>
      <LocationPart LocPartTypeID="1454">
        <LocationPartValue>
          <Value>Kabul</Value>
        </LocationPartValue>
      </LocationPart>
    </Location>
  </Locations>
  <IDRegDocuments>
    <IDRegDocument ID="8001" IDRegDocTypeID="1571" IdentityID="4001" IssuedBy-CountryID="11029">
      <IDRegistrationNo>P1234567</IDRegistrationNo>
    </IDRegDocument>
  </IDRegDocuments>
  <SanctionsEntries>
    <SanctionsEntry ID="9640" ProfileID="9640" ListID="1550">
      <EntryEvent ID="9640" EntryEventTypeID="1" LegalBasisID="1822">
        <Date CalendarTypeID="1"><Year>2018</Year><Month>3</Month><Day>4</Day></Date>
      </EntryEvent>
      <SanctionsMeasure ID="1" SanctionsTypeID="1"><Comment>IRAN</Comment></SanctionsMeasure>
      <SanctionsMeasure ID="2" SanctionsTypeID="1"><Comment>SDGT</Comment></SanctionsMeasure>
    </SanctionsEntry>
    <SanctionsEntry ID="9641" ProfileID="9641" ListID="1550">
      <EntryEvent ID="9641" EntryEventTypeID="1" LegalBasisID="1">
        <Date CalendarTypeID="1"><Year>2022</Year><Month>6</Month><Day>15</Day></Date>
      </EntryEvent>
      <SanctionsMeasure ID="3" SanctionsTypeID="1"><Comment>RUSSIA-EO14024</Comment></SanctionsMeasure>
    </SanctionsEntry>
    <SanctionsEntry ID="4238" ProfileID="4238" ListID="1550">
      <EntryEvent ID="4238" EntryEventTypeID="1">
        <Date CalendarTypeID="1"><Year>1986</Year><Month>12</Month><Day>10</Day></Date>
      </EntryEvent>
      <SanctionsMeasure ID="4" SanctionsTypeID="1"><Comment>CUBA</Comment></SanctionsMeasure>
    </SanctionsEntry>
  </SanctionsEntries>
</Sanctions>
"""


def test_parse_ofac_advanced_xml_extracts_individual_entity_and_vessel():
    parsed = main_module._parse_ofac_advanced_xml(_SYNTHETIC_SDN_ADVANCED_XML.encode())
    entries = parsed["entries"]
    by_uid = {e["ofac_uid"]: e for e in entries}
    assert len(entries) == 3

    individual = by_uid["9640"]
    assert individual["entity_name"] == "Jane DOE"
    assert individual["entity_type"] == "individual"
    assert individual["program_tags"] == ["IRAN", "SDGT"]
    assert individual["designation_date"] == "2018-03-04"  # the real fix — no longer NULL
    assert individual["list_source"] == "SDN"
    assert individual["legal_basis"] == "Executive Order 13606 (Iran/Syria)"

    entity = by_uid["9641"]
    assert entity["entity_name"] == "ACME CORP"
    assert entity["entity_type"] == "entity"
    assert entity["vessel_flag"] is None
    assert entity["designation_date"] == "2022-06-15"
    # LegalBasisID="1" resolves to the dictionary's own "Unknown" placeholder
    # — persisted as None, never the literal string, per nulls-over-zeros.
    assert entity["legal_basis"] is None

    vessel = by_uid["4238"]
    assert vessel["entity_type"] == "vessel"
    assert vessel["vessel_flag"] == "Cuba"
    assert vessel["vessel_type"] == "Tug"  # resolved via DetailReferenceID lookup
    assert vessel["designation_date"] == "1986-12-10"
    assert vessel["legal_basis"] is None  # no LegalBasisID attribute on this entry at all


def test_parse_ofac_advanced_xml_extracts_aliases_addresses_and_id_documents():
    """Entity-detail follow-up (2026-08-26) — the richer parse the plain
    ofac_designations row never captured: every alias (not just primary),
    Location-sourced addresses reached via Feature/FeatureVersion/
    VersionLocation, and IDRegDocument entries joined by IdentityID."""
    parsed = main_module._parse_ofac_advanced_xml(_SYNTHETIC_SDN_ADVANCED_XML.encode())

    aliases_9640 = [a for a in parsed["aliases"] if a["ofac_uid"] == "9640"]
    assert len(aliases_9640) == 2
    names = {a["name"] for a in aliases_9640}
    assert names == {"Jane DOE", "JANE D."}
    primary = next(a for a in aliases_9640 if a["name"] == "Jane DOE")
    assert primary["is_primary"] is True
    assert primary["alias_type"] == "Name"
    aka = next(a for a in aliases_9640 if a["name"] == "JANE D.")
    assert aka["is_primary"] is False
    assert aka["alias_type"] == "A.K.A."

    addresses_9640 = [a for a in parsed["addresses"] if a["ofac_uid"] == "9640"]
    assert len(addresses_9640) == 1
    addr = addresses_9640[0]
    assert addr["address1"] == "123 Main St"
    assert addr["city"] == "Kabul"
    assert addr["country"] == "Afghanistan"
    assert addr["state_province"] is None  # not present in this fixture — nulls over zeros

    ids_9640 = [d for d in parsed["id_documents"] if d["ofac_uid"] == "9640"]
    assert len(ids_9640) == 1
    doc = ids_9640[0]
    assert doc["id_type"] == "Passport"
    assert doc["id_number"] == "P1234567"
    assert doc["issuing_country"] == "Afghanistan"

    # Entities with no aliases/address/ID data beyond their primary name
    # should simply have no rows — never a fabricated placeholder.
    assert not [a for a in parsed["addresses"] if a["ofac_uid"] == "9641"]
    assert not [d for d in parsed["id_documents"] if d["ofac_uid"] == "9641"]


_SYNTHETIC_CONS_ADVANCED_XML = f"""<?xml version="1.0" standalone="yes"?>
<Sanctions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="{_SDN_NS}">
  <ReferenceValueSets>
    <DetailReferenceValues />
  </ReferenceValueSets>
  <DistinctParties>
    <DistinctParty FixedRef="7001">
      <Profile ID="7001" PartySubTypeID="3">
        <Identity ID="5001" FixedRef="7001">
          <Alias FixedRef="7001" Primary="true">
            <DocumentedName ID="5001" FixedRef="7001">
              <DocumentedNamePart>
                <NamePartValue>CONSOLIDATED ONLY CO</NamePartValue>
              </DocumentedNamePart>
            </DocumentedName>
          </Alias>
        </Identity>
      </Profile>
    </DistinctParty>
  </DistinctParties>
  <SanctionsEntries>
    <SanctionsEntry ID="7001" ProfileID="7001" ListID="91512">
      <EntryEvent ID="7001" EntryEventTypeID="1">
        <Date CalendarTypeID="1"><Year>2020</Year><Month>1</Month><Day>9</Day></Date>
      </EntryEvent>
      <SanctionsMeasure ID="1" SanctionsTypeID="1"><Comment>VENEZUELA</Comment></SanctionsMeasure>
    </SanctionsEntry>
  </SanctionsEntries>
</Sanctions>
"""


async def test_fetch_and_persist_ofac_designations_requires_user_agent(tmp_db, upstream_client, monkeypatch):
    """Confirmed live 2026-08-25: OFAC's download endpoint 403s a request
    with no User-Agent header. This test asserts the header is actually
    sent — a mocked 403 isn't a meaningful thing to assert against here,
    per this repo's convention of not testing what a mock can't represent.
    Also confirms both sdn_advanced.xml and cons_advanced.xml are fetched
    and their (disjoint, in this fixture) entities land under the correct
    list_source, with real designation_date values parsed through."""
    seen_headers: list[httpx.Headers] = []

    def _callback(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers)
        if request.url.path.endswith("cons_advanced.xml"):
            body = _SYNTHETIC_CONS_ADVANCED_XML
        else:
            body = _SYNTHETIC_SDN_ADVANCED_XML
        return httpx.Response(200, content=body.encode())

    with respx.mock:
        respx.get(url__startswith=main_module.OFAC_BASE).mock(side_effect=_callback)
        result = await main_module._fetch_and_persist_ofac_designations()

    assert result["new"] == 4  # 3 SDN + 1 Consolidated, disjoint uids in this fixture
    for headers in seen_headers:
        assert "user-agent" in headers
        assert headers["user-agent"] == main_module._OFAC_USER_AGENT

    rows = {r["ofac_uid"]: r for r in tmp_db.get_ofac_designations()}
    assert rows["9640"]["list_source"] == "SDN"
    assert rows["7001"]["list_source"] == "Consolidated"
    assert rows["7001"]["designation_date"] == "2020-01-09"


async def test_ofac_db_route_returns_persisted_rows(tmp_db, client):
    tmp_db.diff_and_persist_ofac_designations([_entry("1001", program_tags=["IRAN"])], "2026-08-25")
    resp = await client.get("/api/ofac/db")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["data"][0]["ofac_uid"] == "1001"
    assert body["data"][0]["program_tags"] == ["IRAN"]


async def test_ofac_db_route_filters_by_program_query_param(tmp_db, client):
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", program_tags=["IRAN"]), _entry("1002", program_tags=["CUBA"])],
        "2026-08-25",
    )
    resp = await client.get("/api/ofac/db", params={"program": "CUBA"})
    body = resp.json()
    assert [r["ofac_uid"] for r in body["data"]] == ["1002"]


async def test_sanctions_tab_is_pinnable(client):
    """Regression test for the exact class of bug CLAUDE.md documents from
    the Stack tab build: a nav tab added to frontend/src/App.jsx's SECTIONS
    but not to main.py's _VALID_NAV_SECTIONS allowlist pins silently
    (the frontend's togglePin doesn't surface a failed POST) — confirmed
    as a real prior incident, not a hypothetical, so this is checked
    directly for the new Sanctions tab rather than assumed fixed."""
    resp = await client.post("/api/ui/pinned-section", json={"section": "sanctions"})
    assert resp.status_code == 200
    assert resp.json()["data"]["pinned_section"] == "sanctions"

    resp = await client.get("/api/ui/pinned-section")
    assert resp.json()["data"]["pinned_section"] == "sanctions"


# --- Entity detail: aliases/addresses/id_documents (2026-08-26 follow-up) --


def test_replace_ofac_entity_detail_replaces_not_appends(tmp_db):
    """Entity detail is 'OFAC's current claim,' not append-only history —
    a second call for the same uid must fully replace the first call's
    rows, never accumulate duplicates alongside them."""
    tmp_db.replace_ofac_entity_detail(
        aliases=[{"ofac_uid": "1001", "name": "First Alias", "is_primary": True, "alias_type": "Name"},
                 {"ofac_uid": "1001", "name": "Second Alias", "is_primary": False, "alias_type": "A.K.A."}],
        addresses=[{"ofac_uid": "1001", "address1": "1 Old St", "address2": None, "address3": None,
                    "city": "Oldtown", "state_province": None, "postal_code": None, "country": "Cuba"}],
        id_documents=[{"ofac_uid": "1001", "id_type": "Passport", "id_number": "OLD123", "issuing_country": "Cuba"}],
    )
    assert len(tmp_db.get_ofac_aliases("1001")) == 2
    assert len(tmp_db.get_ofac_addresses("1001")) == 1
    assert len(tmp_db.get_ofac_id_documents("1001")) == 1

    # Refetch: this uid now has only 1 alias, no address, no id document —
    # a real refetch's honest current state.
    tmp_db.replace_ofac_entity_detail(
        aliases=[{"ofac_uid": "1001", "name": "First Alias", "is_primary": True, "alias_type": "Name"}],
        addresses=[],
        id_documents=[],
    )
    assert len(tmp_db.get_ofac_aliases("1001")) == 1
    assert tmp_db.get_ofac_addresses("1001") == []
    assert tmp_db.get_ofac_id_documents("1001") == []


def test_replace_ofac_entity_detail_does_not_touch_other_uids(tmp_db):
    """Replace-all is scoped per-uid (via the delete WHERE ofac_uid IN (...)
    computed from the union of uids present in this call's own rows) — a
    call carrying only uid 1001's data must not clear uid 1002's existing
    rows."""
    tmp_db.replace_ofac_entity_detail(
        aliases=[{"ofac_uid": "1002", "name": "Untouched Entity", "is_primary": True, "alias_type": "Name"}],
        addresses=[], id_documents=[],
    )
    tmp_db.replace_ofac_entity_detail(
        aliases=[{"ofac_uid": "1001", "name": "Different Entity", "is_primary": True, "alias_type": "Name"}],
        addresses=[], id_documents=[],
    )
    assert len(tmp_db.get_ofac_aliases("1002")) == 1
    assert tmp_db.get_ofac_aliases("1002")[0]["name"] == "Untouched Entity"


async def test_ofac_designation_detail_route_returns_full_record(tmp_db, client):
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", entity_name="Some Entity", legal_basis="Executive Order 14024 (Russia)")],
        "2026-08-25",
    )
    tmp_db.replace_ofac_entity_detail(
        aliases=[{"ofac_uid": "1001", "name": "Some Entity", "is_primary": True, "alias_type": "Name"}],
        addresses=[{"ofac_uid": "1001", "address1": None, "address2": None, "address3": None,
                    "city": None, "state_province": None, "postal_code": None, "country": "Cuba"}],
        id_documents=[{"ofac_uid": "1001", "id_type": "Passport", "id_number": "X123", "issuing_country": "Cuba"}],
    )
    resp = await client.get("/api/ofac/1001/db")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["entity_name"] == "Some Entity"
    assert data["legal_basis"] == "Executive Order 14024 (Russia)"
    assert len(data["aliases"]) == 1
    assert data["addresses"][0]["country"] == "Cuba"
    assert data["id_documents"][0]["id_number"] == "X123"


async def test_ofac_db_route_returns_legal_basis(tmp_db, client):
    tmp_db.diff_and_persist_ofac_designations(
        [_entry("1001", legal_basis="Executive Order 13224 (Terrorism)")], "2026-08-25"
    )
    resp = await client.get("/api/ofac/db")
    assert resp.json()["data"][0]["legal_basis"] == "Executive Order 13224 (Terrorism)"


async def test_ofac_designation_detail_route_404s_for_unknown_uid(tmp_db, client):
    resp = await client.get("/api/ofac/nonexistent-uid/db")
    assert resp.status_code == 404
