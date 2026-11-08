import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildModel, dayPresets, indexAtOrBefore, parseCSV, runStatus, summarize, toCSV } from "../assets/js/data.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(root + path, "utf8");

test("parseCSV handles BOM, quotes, commas and CRLF", () => {
  const rows = parseCSV('﻿a,b\r\n1,"x, ""y"""\r\n2,\r\n');
  assert.deepEqual(rows, [{ a: "1", b: 'x, "y"' }, { a: "2", b: "" }]);
  assert.throws(() => parseCSV('a\n"open'), /quoted field/);
  assert.throws(() => parseCSV("a,b\n1\n"), /fields/);
});

test("toCSV round-trips through parseCSV", () => {
  const text = toCSV(["name", "n"], [["MD 2026: Zhuhai, 海滨泳场", 3], ['say "hi"', null]]);
  assert.deepEqual(parseCSV(text), [{ name: "MD 2026: Zhuhai, 海滨泳场", n: "3" }, { name: 'say "hi"', n: "" }]);
});

const missions = [
  { order: 2, missionGuid: "b", displayName: "B", title: "MD 2026: Zhuhai, B" },
  { order: 1, missionGuid: "a", displayName: "A", title: "MD 2026: Zhuhai, A" },
];
const run = (id, iso, ok = 2, error = "") => ({ id: String(id), started_at: iso, missions_total: "2", missions_ok: String(ok), error });
const snap = (runId, guid, count, rating = 0) => ({
  run_id: String(runId), mission_guid: guid, completed_count: String(count), rating_e6: String(rating),
  average_duration_ms: "600000", author: "NIA", faction: "RESISTANCE",
});

function smallModel() {
  return buildModel({
    missions,
    runs: [
      run(1, "2026-11-07T01:00:00Z"),
      run(2, "2026-11-07T01:30:00Z", 1),
      run(3, "2026-11-07T02:10:00Z", 0, "intel session not available"),
      run(4, "2026-11-07T03:05:00Z"),
    ],
    snapshots: [
      snap(1, "a", 0), snap(1, "b", 0),
      snap(2, "a", 5, 800000), // b missing: carried forward
      snap(4, "a", 9, 0), snap(4, "b", 4, 500000),
    ],
    failures: [{ run_id: "2", mission_guid: "b", error: "skipped" }],
  });
}

test("buildModel orders missions and carries values across missing readings", () => {
  const m = smallModel();
  assert.deepEqual(m.missions.map((x) => x.guid), ["a", "b"]);
  assert.equal(m.times.length, 3, "a run without snapshots is not plotted");
  assert.deepEqual(m.counts[0], [0, 5, 9]);
  assert.deepEqual(m.counts[1], [0, 0, 4]);
  assert.deepEqual(m.total, [0, 5, 13]);
  // Leading zero ratings mean "not rated yet"; a later zero is a real reading.
  assert.deepEqual(m.ratings[0], [null, 80, 0]);
  assert.deepEqual(m.ratings[1], [null, null, 50]);
  assert.equal(m.missions[0].author, "NIA");
});

test("hourly completions fill empty hours", () => {
  const m = smallModel();
  const h = Date.parse("2026-11-07T01:00:00Z") / 1000;
  assert.deepEqual(m.hours.starts, [h, h + 3600, h + 7200]);
  assert.deepEqual(m.hours.total, [5, 0, 8]);
  assert.deepEqual(m.hours.byMission[2], [4, 4]);
});

test("run status", () => {
  const m = smallModel();
  assert.deepEqual(m.runs.map(runStatus), ["complete", "partial", "failed", "complete"]);
});

test("summarize a range", () => {
  const m = smallModel();
  const s = summarize(m, Date.parse("2026-11-07T01:15:00Z") / 1000, Date.parse("2026-11-07T03:30:00Z") / 1000);
  assert.equal(s.added, 13);
  assert.deepEqual(s.missions.map((x) => [x.countStart, x.countEnd, x.added]), [[0, 9, 9], [0, 4, 4]]);
  assert.equal(s.peak.added, 8);
  assert.equal(s.meanRating, 25);
  assert.deepEqual(s.missions.map((x) => [x.ratingStart, x.ratingEnd]), [[80, 0], [50, 50]]);
  assert.deepEqual(s.runs, { total: 3, complete: 1, failed: 1 });
  assert.equal(s.weather, null);
});

test("indexAtOrBefore", () => {
  assert.equal(indexAtOrBefore([10, 20, 30], 5), -1);
  assert.equal(indexAtOrBefore([10, 20, 30], 20), 1);
  assert.equal(indexAtOrBefore([10, 20, 30], 99), 2);
});

test("dayPresets split the extent on local (UTC+8) days", () => {
  const from = Date.parse("2026-11-06T09:00:00Z") / 1000; // Fri 17:00 CST
  const to = Date.parse("2026-11-08T05:00:00Z") / 1000; // Sun 13:00 CST
  const days = dayPresets({ from, to });
  assert.equal(days.length, 3);
  assert.equal(days[0].from, from);
  assert.equal(days[1].from, Date.parse("2026-11-06T16:00:00Z") / 1000); // Sat 00:00 CST
  assert.equal(days[2].to, to);
});

test("published data loads and matches the SQLite totals", () => {
  const m = buildModel({
    runs: parseCSV(read("data/runs.csv")),
    snapshots: parseCSV(read("data/snapshots.csv")),
    failures: parseCSV(read("data/failures.csv")),
    weatherHours: parseCSV(read("data/weather_hours.csv")),
    weatherCurrent: parseCSV(read("data/weather_current.csv")),
    missions: JSON.parse(read("data/missions.json")).missions,
  });
  assert.equal(m.missions.length, 18);
  assert.equal(m.runs.length, 483);
  assert.equal(m.times.length, 470);
  assert.equal(m.total.at(-1), 2756);
  assert.equal(m.hours.total.reduce((a, b) => a + b, 0), 2756, "hourly bars add up to the final total");
  assert.equal(m.runs.filter((r) => runStatus(r) === "failed").length, 14);
  const s = summarize(m, m.extent.from, m.extent.to);
  assert.equal(s.totalEnd, 2756);
  assert.ok(s.weather && s.weather.min < s.weather.max);
});
