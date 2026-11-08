// Data layer for the dashboard: parses the published CSV/JSON files and derives every series the
// panels draw. Pure functions only (no DOM), so they run unchanged under `node --test`.

export const HOUR = 3600;
// Mission Day ran in Zhuhai (Asia/Shanghai, UTC+8, no daylight saving); hours align with UTC hours.
export const TZ = "Asia/Shanghai";

// parseCSV reads RFC 4180 CSV (quoted fields, doubled quotes, CRLF, optional BOM) into objects
// keyed by the header row.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => !(r.length === 1 && r[0] === "")).map((r, n) => {
    if (r.length !== header.length) {
      throw new Error(`CSV row ${n + 2} has ${r.length} fields, expected ${header.length}`);
    }
    return Object.fromEntries(header.map((h, k) => [h, r[k]]));
  });
}

function seconds(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp ${JSON.stringify(iso)}`);
  return ms / 1000;
}

function number(value, name) {
  const n = Number(value);
  if (value === "" || !Number.isFinite(n)) throw new Error(`invalid ${name} ${JSON.stringify(value)}`);
  return n;
}

// buildModel aligns every mission on the run timeline. Each run is plotted at its start time, so a
// run never straddles an hour boundary. A mission missing from a run (failed or skipped reading)
// keeps its previous value; before its first reading it is null.
export function buildModel({ runs, snapshots, failures = [], weatherHours = [], weatherCurrent = [], missions }) {
  const missionList = [...missions].sort((a, b) => a.order - b.order).map((m) => ({
    guid: m.missionGuid,
    order: m.order,
    name: m.displayName,
    title: m.title,
    url: m.missionUrl,
    author: "",
    faction: "",
  }));
  const missionIndex = new Map(missionList.map((m, k) => [m.guid, k]));

  const runList = runs.map((r) => ({
    id: number(r.id, "run id"),
    t: seconds(r.started_at),
    total: number(r.missions_total, "missions_total"),
    ok: number(r.missions_ok, "missions_ok"),
    error: r.error || "",
    skipped: 0,
  })).sort((a, b) => a.t - b.t);
  const runById = new Map(runList.map((r) => [r.id, r]));
  for (const f of failures) {
    const run = runById.get(number(f.run_id, "failure run_id"));
    if (run) run.skipped++;
  }

  const byRun = new Map();
  for (const s of snapshots) {
    const runId = number(s.run_id, "snapshot run_id");
    const k = missionIndex.get(s.mission_guid);
    if (k === undefined || !runById.has(runId)) continue;
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId).push({
      k,
      count: number(s.completed_count, "completed_count"),
      rating: number(s.rating_e6, "rating_e6") / 1e4,
      duration: number(s.average_duration_ms, "average_duration_ms"),
    });
    missionList[k].author = s.author;
    missionList[k].faction = s.faction;
  }

  const plotted = runList.filter((r) => byRun.has(r.id));
  const n = plotted.length;
  const times = plotted.map((r) => r.t);
  const counts = missionList.map(() => new Array(n).fill(null));
  const ratings = missionList.map(() => new Array(n).fill(null));
  const durations = missionList.map(() => new Array(n).fill(null));
  const last = missionList.map(() => ({ count: null, rating: null, duration: null }));
  plotted.forEach((run, i) => {
    for (const s of byRun.get(run.id)) {
      last[s.k].count = s.count;
      // Intel reports 0% until a mission's first rating arrives; later zeros are real.
      if (s.rating > 0 || last[s.k].rating !== null) last[s.k].rating = s.rating;
      if (s.duration > 0) last[s.k].duration = s.duration;
    }
    last.forEach((v, k) => {
      counts[k][i] = v.count;
      ratings[k][i] = v.rating;
      durations[k][i] = v.duration;
    });
  });
  const total = times.map((_, i) => counts.reduce((sum, c) => sum + (c[i] ?? 0), 0));

  // Completions added per hour, attributed to the hour of the run that first saw them.
  const hourStarts = [];
  const hourly = [];
  const hourlyByMission = [];
  let previous = missionList.map(() => null);
  plotted.forEach((run, i) => {
    const hour = Math.floor(run.t / HOUR) * HOUR;
    if (hourStarts.length === 0 || hourStarts[hourStarts.length - 1] !== hour) {
      // Fill empty hours so bars and heat-map columns sit on a regular grid.
      for (let h = hourStarts.length ? hourStarts[hourStarts.length - 1] + HOUR : hour; h <= hour; h += HOUR) {
        hourStarts.push(h);
        hourly.push(0);
        hourlyByMission.push(missionList.map(() => 0));
      }
    }
    const slot = hourStarts.length - 1;
    counts.forEach((c, k) => {
      if (c[i] !== null && previous[k] !== null && c[i] > previous[k]) {
        const added = c[i] - previous[k];
        hourly[slot] += added;
        hourlyByMission[slot][k] += added;
      }
      if (c[i] !== null) previous[k] = c[i];
    });
  });

  const firstActivity = times.find((_, i) => total[i] > 0) ?? times[0];
  return {
    missions: missionList,
    runs: runList,
    times,
    counts,
    ratings,
    durations,
    total,
    hours: { starts: hourStarts, total: hourly, byMission: hourlyByMission },
    weatherHours: weatherHours.map((w) => ({
      t: seconds(w.hour_start),
      condition: w.condition,
      temperature: number(w.temperature, "temperature"),
      chance: number(w.precipitation_chance, "precipitation_chance"),
      amount: number(w.precipitation_amount, "precipitation_amount"),
    })).sort((a, b) => a.t - b.t),
    weatherCurrent: weatherCurrent.map((w) => ({
      runId: number(w.run_id, "weather run_id"),
      t: seconds(w.as_of),
      condition: w.condition,
      temperature: number(w.temperature, "temperature"),
      apparent: number(w.apparent_temperature, "apparent_temperature"),
      humidity: number(w.humidity, "humidity"),
      intensity: number(w.precipitation_intensity, "precipitation_intensity"),
      wind: number(w.wind_speed, "wind_speed"),
    })).sort((a, b) => a.t - b.t),
    // The default view starts an hour before the first completion, skipping the quiet lead-in.
    extent: { from: Math.max(times[0], Math.floor(firstActivity / HOUR) * HOUR - HOUR), to: times[n - 1] },
  };
}

// indexAtOrBefore returns the last index whose time is <= t, or -1.
export function indexAtOrBefore(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// summarize describes the range [from, to]: each mission's count and rating at the start and end
// of the range, the completions added inside it, and range-wide figures for the stat tiles.
export function summarize(model, from, to) {
  const start = indexAtOrBefore(model.times, from);
  const end = indexAtOrBefore(model.times, to);
  const at = (series, i) => (i < 0 ? null : series[i]);
  // A mission first rated inside the range compares with that first rating.
  const firstIn = (series) => {
    for (let i = Math.max(0, start); i <= end; i++) if (series[i] !== null) return series[i];
    return null;
  };
  const missions = model.missions.map((m, k) => {
    const countStart = at(model.counts[k], start) ?? 0;
    const countEnd = at(model.counts[k], end) ?? 0;
    return {
      ...m,
      index: k,
      countStart,
      countEnd,
      added: countEnd - countStart,
      ratingStart: firstIn(model.ratings[k]),
      ratingEnd: at(model.ratings[k], end),
      duration: at(model.durations[k], end),
    };
  });
  const hours = [];
  model.hours.starts.forEach((h, j) => {
    if (h + HOUR > from && h <= to) hours.push({ t: h, added: model.hours.total[j], byMission: model.hours.byMission[j] });
  });
  const peak = hours.reduce((best, h) => (h.added > (best?.added ?? 0) ? h : best), null);
  const runs = model.runs.filter((r) => r.t >= from && r.t <= to);
  const rated = missions.filter((m) => m.ratingEnd !== null);
  const weather = model.weatherHours.filter((w) => w.t + HOUR > from && w.t <= to);
  return {
    from,
    to,
    missions,
    hours,
    peak,
    added: missions.reduce((sum, m) => sum + m.added, 0),
    totalEnd: missions.reduce((sum, m) => sum + m.countEnd, 0),
    meanRating: rated.length ? rated.reduce((sum, m) => sum + m.ratingEnd, 0) / rated.length : null,
    runs: {
      total: runs.length,
      complete: runs.filter((r) => !r.error && r.ok === r.total).length,
      failed: runs.filter((r) => r.error || r.ok === 0).length,
    },
    weather: weather.length
      ? {
          min: Math.min(...weather.map((w) => w.temperature)),
          max: Math.max(...weather.map((w) => w.temperature)),
          rain: weather.reduce((sum, w) => sum + w.amount, 0),
          rainyHours: weather.filter((w) => w.amount >= 0.1).length,
        }
      : null,
  };
}

// runStatus classifies a run for the collection-health timeline.
export function runStatus(run) {
  if (run.error || run.ok === 0) return "failed";
  if (run.ok < run.total || run.skipped > 0) return "partial";
  return "complete";
}

// dayPresets lists each local calendar day the data touches, clipped to the data's extent.
export function dayPresets(extent, offsetSeconds = 8 * HOUR) {
  const presets = [];
  let dayStart = Math.floor((extent.from + offsetSeconds) / 86400) * 86400 - offsetSeconds;
  for (; dayStart <= extent.to; dayStart += 86400) {
    presets.push({ from: Math.max(dayStart, extent.from), to: Math.min(dayStart + 86400 - 1, extent.to), day: dayStart });
  }
  return presets;
}

// toCSV turns rows (arrays) into CSV text, quoting fields that need it.
export function toCSV(header, rows) {
  const quote = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(quote).join(",")).join("\r\n") + "\r\n";
}
