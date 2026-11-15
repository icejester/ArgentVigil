// Run: node frontend/src/mobile/stats.test.mjs
import assert from "node:assert/strict";
import * as s from "./stats.js";

const r = (d, v) => ({ date: d, value: v });
// sliceWindow anchors on the last row, not today
const rows = [r("2026-01-01", 1), r("2026-02-01", 2), r("2026-03-01", 3), r("2026-03-20", 4)];
assert.deepEqual(s.sliceWindow(rows, { days: 30 }).map((x) => x.date), ["2026-03-01", "2026-03-20"]);
assert.equal(s.sliceWindow(rows, { all: true }).length, 4);
assert.equal(s.sliceWindow(rows, { since: "2026-02-01" }).length, 3);
// percentile: needs enough points, strictly-below share
assert.equal(s.percentileRank(rows), null);
const p = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v, i) => r(`2026-01-${String(i + 1).padStart(2, "0")}`, v));
assert.equal(s.percentileRank(p), 90);
assert.equal(s.ordinal(82), "82nd"); assert.equal(s.ordinal(1), "1st"); assert.equal(s.ordinal(11), "11th"); assert.equal(s.ordinal(23), "23rd");
// nulls are gaps, never zeros
assert.equal(s.lastChange([r("a", null), r("b", null)]), null);
assert.equal(s.lastChange([r("2026-01-01", 5), r("2026-01-02", null)]).change, null);
// indexing + as-of
const idx = s.indexTo100([r("2020-01-01", 50), r("2020-02-01", 100)], "2020-01-15");
// base is the as-of reading on/before the date (50), so Feb is 200
assert.equal(idx[0].value, 200); assert.equal(idx[0].date, "2020-02-01");
assert.equal(s.indexTo100([r("2020-01-01", 50), r("2020-02-01", 100)], "2020-01-01")[1].value, 200);
assert.equal(s.pctSince([r("2000-01-01", 100), r("2001-01-01", 150)], "2000-06-01").pct, 50);
// divergence: A rises while B falls
const A = [1, 2, 3, 4, 5, 6].map((v, i) => r(`2020-0${i + 1}-01`, v));
const B = [6, 5, 4, 3, 4, 5].map((v, i) => r(`2020-0${i + 1}-01`, v));
const bands = s.divergenceBands(A, B, 2);
assert.ok(bands.length >= 1 && bands[0].from === "2020-01-01");
assert.equal(s.divergenceBands(A, A, 2).length, 0);
// formatting: nulls show a dash
assert.equal(s.fmtUsd(null), "—"); assert.equal(s.fmtSignedPct(undefined), "—");
assert.equal(s.fmtSignedUsd(-3), "−$3.00"); assert.equal(s.fmtCompact(1.5e6), "1.5M");
console.log("stats ok");
