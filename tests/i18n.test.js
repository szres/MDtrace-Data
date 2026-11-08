import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { describeCondition, languages, translator } from "../assets/js/i18n.js";

test("every language defines the same keys as English", async () => {
  const source = await readFile(new URL("../assets/js/app.js", import.meta.url), "utf8");
  const used = new Set([...source.matchAll(/\bt\("(\w+)"/g)].map((m) => m[1]));
  for (const key of ["complete", "partial", "failed"]) used.add(key);
  assert.ok(used.size > 40, "app.js should look up its text through t()");
  for (const lang of languages) {
    const t = translator(lang);
    for (const key of used) assert.doesNotThrow(() => t(key), `${lang} is missing ${key}`);
  }
});

test("placeholders are filled and unknown keys throw", () => {
  const en = translator("en");
  const zh = translator("zh");
  assert.equal(en("last", { hours: 6 }), "Last 6 h of data");
  assert.equal(zh("last", { hours: 6 }), "数据的最后 6 小时");
  assert.throws(() => en("no-such-key"), /missing en text no-such-key/);
  assert.equal(en("title", { event: "MD 2026 Zhuhai" }), "MD 2026 Zhuhai · Mission tracker");
  assert.equal(zh("times", { zone: "Asia/Kolkata", offset: "UTC+5:30" }), "所有时间均为活动当地时间：Asia/Kolkata（UTC+5:30）。");
});

test("no text names a particular event", () => {
  for (const lang of languages) {
    const t = translator(lang);
    for (const key of ["title", "subtitle", "times", "panelTotalInfo", "panelTempInfo", "mapAll", "fileSnapshots", "colTime"]) {
      assert.doesNotMatch(t(key), /Zhuhai|珠海|情侣路|\b18\b|UTC\+8/, `${lang} ${key}`);
    }
  }
});

test("weather conditions read as words", () => {
  assert.equal(describeCondition("MostlyCloudy", "en"), "mostly cloudy");
  assert.equal(describeCondition("MostlyCloudy", "zh"), "多云");
  assert.equal(describeCondition("SomethingNew", "zh"), "something new");
});
