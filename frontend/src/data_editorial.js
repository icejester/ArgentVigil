// Editorial per-source documentation: provenance, curl examples, and
// per-field descriptions. Hand-maintained (not introspected from SQLite)
// since provenance/field-purpose is not something the DB schema itself
// encodes. Split from the former data_map.js (datasources-spec.md Story
// #1's operational/editorial split) -- operational metadata (cadence,
// rate limits, expectedIntervalS) now lives backend-side in
// backend/sources.py, served via GET /api/data-sources/db and the
// enriched GET /api/health/db, not duplicated here. Keep the JSON's
// prose in sync with backend/db.py's DDL when either changes; keep
// `key`/`sourceKeys` in sync with backend/sources.py's registry keys
// so DataPanel's editorial+operational join keeps working.
//
// The content itself lives in data_editorial.json (this file is a thin
// re-export) so the Python test suite can consume the same data
// (tests/test_conventions.py's registry<->editorial sync guard) without
// parsing JavaScript — edit the JSON, not this wrapper.
//
// Card-specific note that predates the JSON split (JSON carries no
// comments): the "fred" card deliberately lists two sourceKeys with
// different cadences under one card — health metadata is keyed per
// source_key, not per card, since a single expectedIntervalS/tier
// wouldn't fit both.
import DATA_EDITORIAL_JSON from "./data_editorial.json";

export const DATA_EDITORIAL = DATA_EDITORIAL_JSON;
