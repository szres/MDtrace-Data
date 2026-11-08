import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildModel,
  dayPresets,
  fromWallClock,
  indexAtOrBefore,
  localHourStart,
  localMidnight,
  offsetLabel,
  parseCSV,
  runStatus,
  summarize,
  toCSV,
  tzOffset,
} from "../assets/js/data.js";

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

function smallModel(timeZone = "Asia/Shanghai") {
  return buildModel({
    timeZone,
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

const at = (iso) => Date.parse(iso) / 1000;

test("time zone offsets, including half hours and daylight saving", () => {
  assert.equal(tzOffset("Asia/Shanghai", at("2026-11-07T00:00:00Z")), 8 * 3600);
  assert.equal(tzOffset("Asia/Kolkata", at("2026-11-07T00:00:00Z")), 5.5 * 3600);
  assert.equal(tzOffset("America/New_York", at("2026-11-01T05:59:59Z")), -4 * 3600, "EDT until 02:00 local");
  assert.equal(tzOffset("America/New_York", at("2026-11-01T06:00:00Z")), -5 * 3600, "EST after");
  assert.throws(() => tzOffset("Mars/Olympus", 0), RangeError);
  assert.deepEqual([8 * 3600, 5.5 * 3600, -4 * 3600, 0, 5.75 * 3600].map(offsetLabel), ["UTC+8", "UTC+5:30", "UTC-4", "UTC+0", "UTC+5:45"]);
});

test("local hours and midnights", () => {
  // 10:47 in Kolkata is 05:17 UTC; its hour starts at 10:00 local = 04:30 UTC.
  assert.equal(localHourStart("Asia/Kolkata", at("2026-11-07T05:17:00Z")), at("2026-11-07T04:30:00Z"));
  assert.equal(localHourStart("Asia/Shanghai", at("2026-11-07T05:17:00Z")), at("2026-11-07T05:00:00Z"));
  assert.equal(localMidnight("Asia/Shanghai", at("2026-11-07T15:59:59Z")), at("2026-11-06T16:00:00Z"));
  assert.equal(localMidnight("Asia/Shanghai", at("2026-11-07T16:00:00Z")), at("2026-11-07T16:00:00Z"));
  assert.equal(localMidnight("Asia/Kolkata", at("2026-11-07T05:17:00Z")), at("2026-11-06T18:30:00Z"));
  // Midnight on the day daylight saving ends is still EDT.
  assert.equal(localMidnight("America/New_York", at("2026-11-01T20:00:00Z")), at("2026-11-01T04:00:00Z"));
  assert.equal(fromWallClock("America/New_York", at("2026-11-02T00:00:00Z")), at("2026-11-02T05:00:00Z"));
  assert.equal(fromWallClock("Asia/Kolkata", at("2026-11-07T10:00:00Z")), at("2026-11-07T04:30:00Z"));
});

test("dayPresets split the extent on local days", () => {
  const from = at("2026-11-06T09:00:00Z"); // Fri 17:00 in Zhuhai
  const to = at("2026-11-08T05:00:00Z"); // Sun 13:00
  const days = dayPresets({ from, to }, "Asia/Shanghai");
  assert.equal(days.length, 3);
  assert.equal(days[0].from, from);
  assert.equal(days[1].from, at("2026-11-06T16:00:00Z")); // Sat 00:00
  assert.equal(days[1].to, at("2026-11-07T16:00:00Z") - 1);
  assert.equal(days[2].to, to);
});

test("dayPresets follow a 25-hour day when daylight saving ends", () => {
  const days = dayPresets({ from: at("2026-10-31T12:00:00Z"), to: at("2026-11-02T12:00:00Z") }, "America/New_York");
  assert.deepEqual(days.map((d) => d.day), [at("2026-10-31T04:00:00Z"), at("2026-11-01T04:00:00Z"), at("2026-11-02T05:00:00Z")]);
  assert.equal(days[1].to - days[1].from + 1, 25 * 3600);
});

test("hourly bins follow the event's local hours", () => {
  const m = smallModel("Asia/Kolkata");
  // Runs at 01:00, 01:30 and 03:05 UTC fall in the local hours starting 00:30, 01:30 and 02:30 UTC.
  assert.deepEqual(m.hours.starts, [at("2026-11-07T00:30:00Z"), at("2026-11-07T01:30:00Z"), at("2026-11-07T02:30:00Z")]);
  assert.deepEqual(m.hours.total, [0, 5, 8]);
  assert.equal(m.timeZone, "Asia/Kolkata");
});

test("buildModel needs a valid time zone and some readings", () => {
  const base = { missions, runs: [run(1, "2026-11-07T01:00:00Z")], snapshots: [snap(1, "a", 0)] };
  assert.throws(() => buildModel(base), /time zone/);
  assert.throws(() => buildModel({ ...base, timeZone: "Mars/Olympus" }), RangeError);
  assert.throws(() => buildModel({ ...base, timeZone: "UTC", snapshots: [] }), /no run/);
});

test("published Zhuhai data loads and matches the SQLite totals", () => {
  const dir = "events/md2026-zhuhai/";
  const m = buildModel({
    timeZone: JSON.parse(read(dir + "event.json")).timezone,
    runs: parseCSV(read(dir + "data/runs.csv")),
    snapshots: parseCSV(read(dir + "data/snapshots.csv")),
    failures: parseCSV(read(dir + "data/failures.csv")),
    weatherHours: parseCSV(read(dir + "data/weather_hours.csv")),
    weatherCurrent: parseCSV(read(dir + "data/weather_current.csv")),
    missions: JSON.parse(read(dir + "data/missions.json")).missions,
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

test("the event index matches the published event folders", () => {
  const { events } = JSON.parse(read("events.json"));
  assert.ok(events.length > 0);
  const starts = events.map((e) => Date.parse(e.start));
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a), "newest event first");
  assert.equal(new Set(events.map((e) => e.slug)).size, events.length, "slugs are unique");
  for (const e of events) {
    const dir = `events/${e.slug}/`;
    const detail = JSON.parse(read(dir + "event.json"));
    assert.equal(detail.slug, e.slug);
    assert.deepEqual(detail.name, e.name);
    assert.equal(detail.timezone, e.timezone);
    assert.equal(JSON.parse(read(dir + "data/missions.json")).missions.length, e.missions);
    for (const f of ["runs", "snapshots", "failures", "weather_current", "weather_hours"]) read(`${dir}data/${f}.csv`);
    assert.equal(existsSync(root + dir + "geo/routes.json"), e.geo, `${e.slug}: geo flag`);
    for (const order of detail.mapFocus?.orders ?? []) {
      assert.ok(JSON.parse(read(dir + "data/missions.json")).missions.some((m) => m.order === order), `${e.slug}: focus #${order}`);
    }
  }
});
