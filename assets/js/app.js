import uPlot from "../vendor/uplot/uPlot.esm.js";
import { HOUR, TZ, buildModel, dayPresets, parseCSV, runStatus, summarize, toCSV } from "./data.js";
import { describeCondition, translator } from "./i18n.js";

const FILES = {
  runs: "data/runs.csv",
  snapshots: "data/snapshots.csv",
  failures: "data/failures.csv",
  weatherHours: "data/weather_hours.csv",
  weatherCurrent: "data/weather_current.csv",
  missions: "data/missions.json",
  routes: "geo/routes.json",
  coastline: "geo/coastline.json",
};
const MAX_FOCUS = 3;
const SYNC_KEY = "mdtrace";
const CLUSTER_ORDERS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const MIN_RANGE = 30 * 60;
const zhDateNames = {
  MMMM: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  MMM: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  WWWW: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"],
  WWW: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
};

const state = {
  lang: "en",
  from: 0,
  to: 0,
  // Each focused mission keeps the colour slot it was given, so removing one never repaints the others.
  focus: [], // [{ k, slot }]
  mapView: "all",
  sort: { key: "order", dir: 1 },
};
let model;
let geo;
let t = translator("en");
let cleanups = [];
let hoveredPlot = null;

// ---------- small helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key === "vars") for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

const locale = () => (state.lang === "zh" ? "zh-CN" : "en-GB");
const formatters = new Map();
function dateFormat(options) {
  const key = state.lang + JSON.stringify(options);
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat(locale(), { timeZone: TZ, hourCycle: "h23", ...options }));
  }
  return formatters.get(key);
}
const fmtClock = (s) => dateFormat({ hour: "2-digit", minute: "2-digit" }).format(s * 1000);
const fmtDay = (s) => dateFormat({ weekday: "short", day: "numeric", month: "short" }).format(s * 1000);
const fmtDayTime = (s) => `${fmtDay(s)} ${fmtClock(s)}`;
const fmtHour = (h) => `${fmtDay(h)} ${fmtClock(h)}–${fmtClock(h + HOUR)}`;
function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return t("none");
  return new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
const fmtPct = (p, digits = 1) => (p === null || p === undefined ? t("none") : `${fmtNum(p, digits)}%`);
function fmtSigned(n, digits = 0) {
  if (n === null || n === undefined) return t("none");
  return (n > 0 ? "+" : n < 0 ? "−" : "±") + fmtNum(Math.abs(n), digits);
}
function fmtDuration(ms) {
  if (!ms) return t("none");
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? t("hoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 }) : t("minutes", { m: minutes });
}
const missionLabel = (m) => `#${String(m.order).padStart(2, "0")} ${m.name}`;

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    ink: v("--ink"), ink2: v("--ink-2"), muted: v("--muted"), grid: v("--grid"), axis: v("--axis"),
    surface: v("--surface"), context: v("--context"),
    series: [v("--series-1"), v("--series-2"), v("--series-3")],
    seq: ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"].map(v),
    good: v("--good"), warning: v("--warning"), critical: v("--critical"),
    font: v("--font"),
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// One-hue sequential ramp: f in [0, 1] maps from the lightest to the darkest step.
function ramp(colors, f) {
  const steps = colors.seq;
  const x = Math.min(1, Math.max(0, f)) * (steps.length - 1);
  const i = Math.min(steps.length - 2, Math.floor(x));
  const a = hexToRgb(steps[i]);
  const b = hexToRgb(steps[i + 1]);
  const mix = a.map((c, j) => Math.round(c + (b[j] - c) * (x - i)));
  return `rgb(${mix.join(",")})`;
}

const focusSlot = (k) => state.focus.find((f) => f.k === k)?.slot;

// ---------- URL state ----------

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const lang = params.get("lang");
  state.lang = lang === "zh" || lang === "en" ? lang : navigator.language?.startsWith("zh") ? "zh" : "en";
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  state.from = model.extent.from;
  state.to = model.extent.to;
  if (Number.isFinite(from) && Number.isFinite(to) && from && to) clampRange(from, to);
  state.mapView = params.get("map") === "cluster" ? "cluster" : "all";
  const orders = (params.get("focus") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const byOrder = new Map(model.missions.map((m, k) => [m.order, k]));
  const picked = params.has("focus")
    ? orders.map((o) => byOrder.get(o)).filter((k) => k !== undefined)
    : model.missions.map((_, k) => k).sort((a, b) => (model.counts[b].at(-1) ?? 0) - (model.counts[a].at(-1) ?? 0));
  state.focus = [...new Set(picked)].slice(0, MAX_FOCUS).map((k, slot) => ({ k, slot }));
}

function writeHash() {
  const params = new URLSearchParams();
  params.set("from", String(Math.round(state.from)));
  params.set("to", String(Math.round(state.to)));
  params.set("focus", state.focus.map((f) => model.missions[f.k].order).join(","));
  params.set("lang", state.lang);
  if (state.mapView === "cluster") params.set("map", "cluster");
  history.replaceState(null, "", `#${params}`);
}

function clampRange(from, to) {
  const { extent } = model;
  let a = Math.max(extent.from, Math.min(from, to));
  let b = Math.min(extent.to, Math.max(from, to));
  if (b - a < MIN_RANGE) {
    const mid = (a + b) / 2;
    a = Math.max(extent.from, mid - MIN_RANGE / 2);
    b = Math.min(extent.to, a + MIN_RANGE);
  }
  state.from = a;
  state.to = b;
}

function setRange(from, to) {
  clampRange(from, to);
  update();
}

function toggleFocus(k) {
  const existing = state.focus.findIndex((f) => f.k === k);
  if (existing >= 0) {
    state.focus.splice(existing, 1);
  } else if (state.focus.length < MAX_FOCUS) {
    const used = new Set(state.focus.map((f) => f.slot));
    const slot = [0, 1, 2].find((s) => !used.has(s));
    state.focus.push({ k, slot });
  } else {
    // The oldest focus makes way; its colour passes to the newcomer so the others keep theirs.
    const [oldest] = state.focus.splice(0, 1);
    state.focus.push({ k, slot: oldest.slot });
  }
  update();
}

// ---------- tooltip ----------

const tooltip = () => document.getElementById("tooltip");

function showTooltip(x, y, title, rows) {
  const tip = tooltip();
  tip.replaceChildren(el("div", { class: "tt-title" }, title));
  for (const row of rows) {
    tip.append(el("div", { class: `tt-row${row.dim ? " dim" : ""}` },
      row.color ? el("span", { class: "tt-key", style: { color: row.color } }) : el("span"),
      el("b", {}, row.value),
      el("span", { class: "name" }, row.name ?? "")));
  }
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  const left = x + 14 + width > window.innerWidth - 8 ? x - 14 - width : x + 14;
  const top = Math.min(y + 14, window.innerHeight - height - 8);
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
  tooltip().hidden = true;
}

// ---------- inspect (table view of a panel) ----------

function openInspect(title, { header, rows }) {
  const dialog = document.getElementById("inspect");
  document.getElementById("inspect-title").textContent = t("inspectTitle", { panel: title });
  const table = document.getElementById("inspect-table");
  table.replaceChildren(
    el("thead", {}, el("tr", {}, header.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((cell) => el("td", { class: typeof cell === "number" ? "num" : undefined }, cell ?? t("none")))))));
  const download = document.getElementById("inspect-download");
  download.textContent = t("downloadCSV");
  download.onclick = () => {
    const url = URL.createObjectURL(new Blob([toCSV(header, rows)], { type: "text/csv;charset=utf-8" }));
    const a = el("a", { href: url, download: `${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const close = document.getElementById("inspect-close");
  close.textContent = t("close");
  close.onclick = () => dialog.close();
  dialog.showModal();
}

// ---------- panel shell ----------

function panel({ title, info, span = 24, cls = "", inspect, actions = [] }) {
  const body = el("div", { class: "body" });
  const legend = el("div", { class: "legend" });
  const header = el("header", {},
    el("h2", {}, title),
    info ? el("span", { class: "info", title: info, "aria-label": info, tabindex: "0" }, "i") : null,
    el("div", { class: "actions" }, actions,
      inspect ? el("button", { class: "btn", type: "button", onclick: () => openInspect(title, inspect()) }, t("inspect")) : null));
  const root = el("section", { class: `panel ${cls}`, vars: { "--span": String(span) } }, header, body, legend);
  return { root, body, legend };
}

function contentWidth(node) {
  const style = getComputedStyle(node);
  return Math.max(0, node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
}

// Re-render a panel's content when its width changes (uPlot and SVG sizes depend on it).
function onResize(target, callback) {
  let width = contentWidth(target);
  const observer = new ResizeObserver(() => {
    const next = contentWidth(target);
    if (next !== width) {
      width = next;
      callback(width);
    }
  });
  observer.observe(target);
  cleanups.push(() => observer.disconnect());
}

// ---------- time-series panels (uPlot) ----------

// dayLabelPositions marks where an axis prints the day under the clock time: wherever the day
// changes, and on the first tick unless the next change is too close (in pixels) to fit both.
const DAY_LABEL_PX = 90;
function dayLabelPositions(days, xs) {
  const changes = days.map((d, i) => i > 0 && d !== days[i - 1]);
  const firstChange = changes.indexOf(true);
  return changes.map((changed, i) => changed || (i === 0 && (firstChange < 0 || xs[firstChange] - xs[0] >= DAY_LABEL_PX)));
}

function timeAxis(colors) {
  return {
    stroke: colors.muted,
    font: `11px ${colors.font}`,
    grid: { stroke: colors.grid, width: 1 },
    ticks: { stroke: colors.grid, width: 1, size: 4 },
    size: 44,
    // Clock time on every tick, plus the day wherever it changes.
    values: (u, splits) => {
      const days = splits.map(fmtDay);
      const shown = dayLabelPositions(days, splits.map((s) => u.valToPos(s, "x")));
      return splits.map((s, i) => (shown[i] ? `${fmtClock(s)}\n${days[i]}` : fmtClock(s)));
    },
  };
}

function valueAxis(colors, format) {
  return {
    stroke: colors.muted,
    font: `11px ${colors.font}`,
    grid: { stroke: colors.grid, width: 1 },
    ticks: { show: false },
    size: 52,
    values: (u, splits) => splits.map(format),
  };
}

// timePlot mounts a uPlot chart synced with the others: shared crosshair, drag to zoom every panel.
function timePlot(body, { height, x, series, yRange, yFormat, tooltipFor, draw }) {
  const colors = palette();
  const opts = {
    width: Math.max(200, contentWidth(body)),
    height,
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), TZ),
    fmtDate: (tpl) => uPlot.fmtDate(tpl, state.lang === "zh" ? zhDateNames : undefined),
    scales: { x: { time: true, min: state.from, max: state.to }, y: yRange ? { range: yRange } : {} },
    axes: [timeAxis(colors), valueAxis(colors, yFormat)],
    series: [{}, ...series.map(({ data, ...seriesOpts }) => seriesOpts)],
    legend: { show: false },
    cursor: {
      sync: { key: SYNC_KEY },
      drag: { x: true, y: false, setScale: false },
      points: { size: 7, fill: colors.surface, width: 2 },
    },
    hooks: {
      setSelect: [(u) => {
        if (u.select.width < 4) return;
        const from = u.posToVal(u.select.left, "x");
        const to = u.posToVal(u.select.left + u.select.width, "x");
        u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
        setRange(from, to);
      }],
      setCursor: [(u) => {
        if (hoveredPlot !== u) return;
        const i = u.cursor.idx;
        if (i === null || i === undefined || u.cursor.left < 0) {
          hideTooltip();
          return;
        }
        const rect = u.over.getBoundingClientRect();
        const content = tooltipFor(i);
        showTooltip(rect.left + u.cursor.left, rect.top + u.cursor.top, content.title, content.rows);
      }],
      draw: draw ? [(u) => draw(u, colors)] : [],
    },
  };
  const plot = new uPlot(opts, [x, ...series.map((s) => s.data)], body);
  plot.over.addEventListener("mouseenter", () => { hoveredPlot = plot; });
  plot.over.addEventListener("mouseleave", () => {
    hoveredPlot = null;
    hideTooltip();
  });
  onResize(body, (width) => plot.setSize({ width: Math.max(200, width), height }));
  cleanups.push(() => plot.destroy());
  return plot;
}

const lineSeries = (label, data, color, width = 2) => ({
  label, data, stroke: color, width, spanGaps: false, points: { show: false },
});
const barSeries = (label, data, color) => ({
  label, data, fill: color, stroke: color, width: 0, points: { show: false },
  paths: uPlot.paths.bars({ size: [0.82, 64], align: 0, radius: 0.12 }),
});

// Text drawn on the canvas uses the text inks, never the series colour.
function canvasLabel(u, colors, text, x, y, align = "right") {
  const ctx = u.ctx;
  ctx.save();
  ctx.font = `600 ${12 * uPlot.pxRatio}px ${colors.font}`;
  ctx.fillStyle = colors.ink;
  ctx.textAlign = align;
  ctx.textBaseline = "bottom";
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Direct labels that would collide are pushed apart vertically, keeping their order.
function separateLabels(labels, gap) {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  sorted.forEach((label, i) => {
    if (i > 0) label.y = Math.max(label.y, sorted[i - 1].y + gap);
  });
  return sorted;
}

function lastIndexIn(times, values, to) {
  for (let i = times.length - 1; i >= 0; i--) {
    if (times[i] <= to && values[i] !== null) return i;
  }
  return -1;
}

function totalPanel() {
  const p = panel({
    title: t("panelTotal"), info: t("panelTotalInfo"), span: 12,
    inspect: () => ({
      header: [t("colTime"), t("colTotal")],
      rows: model.times.map((s, i) => [s, i]).filter(([s]) => s >= state.from && s <= state.to)
        .map(([s, i]) => [fmtDayTime(s), model.total[i]]),
    }),
  });
  const colors = palette();
  return {
    root: p.root,
    mount: () => timePlot(p.body, {
      height: 260,
      x: model.times,
      series: [lineSeries(t("panelTotal"), model.total, colors.series[0], 2)],
      yRange: (u, min, max) => [0, Math.max(10, max * 1.12)],
      yFormat: (v) => fmtNum(v),
      tooltipFor: (i) => ({ title: fmtDayTime(model.times[i]), rows: [{ color: colors.series[0], value: fmtNum(model.total[i]), name: t("panelTotal") }] }),
      draw: (u, c) => {
        const i = lastIndexIn(model.times, model.total, state.to);
        if (i < 0) return;
        canvasLabel(u, c, fmtNum(model.total[i]), u.valToPos(model.times[i], "x", true) - 6 * uPlot.pxRatio,
          u.valToPos(model.total[i], "y", true) - 6 * uPlot.pxRatio);
      },
    }),
  };
}

function hourlyPanel(summary) {
  const centers = model.hours.starts.map((h) => h + HOUR / 2);
  const p = panel({
    title: t("panelHourly"), info: t("panelHourlyInfo"), span: 12,
    inspect: () => ({ header: [t("colHour"), t("colTotal")], rows: summary.hours.map((h) => [fmtHour(h.t), h.added]) }),
  });
  const colors = palette();
  return {
    root: p.root,
    mount: () => timePlot(p.body, {
      height: 260,
      x: centers,
      series: [barSeries(t("panelHourly"), model.hours.total, colors.series[0])],
      yRange: (u, min, max) => [0, Math.max(10, max * 1.15)],
      yFormat: (v) => fmtNum(v),
      tooltipFor: (i) => ({ title: fmtHour(model.hours.starts[i]), rows: [{ color: colors.series[0], value: fmtNum(model.hours.total[i]), name: t("perHour") }] }),
      draw: (u, c) => {
        if (!summary.peak) return;
        const j = model.hours.starts.indexOf(summary.peak.t);
        canvasLabel(u, c, fmtNum(summary.peak.added), u.valToPos(centers[j], "x", true),
          u.valToPos(summary.peak.added, "y", true) - 4 * uPlot.pxRatio, "center");
      },
    }),
  };
}

// Per-mission charts: every mission in grey for context, focused missions in their colour on top.
function missionSeriesPanel(summary, { title, info, values, yRange, format, inspectHeader }) {
  const p = panel({
    title, info, span: 12,
    inspect: () => {
      const idx = model.times.map((s, i) => [s, i]).filter(([s]) => s >= state.from && s <= state.to);
      return {
        header: [t("colTime"), ...model.missions.map(missionLabel)],
        rows: idx.map(([s, i]) => [fmtDayTime(s), ...model.missions.map((_, k) => values[k][i])]),
      };
    },
  });
  const colors = palette();
  const order = model.missions.map((_, k) => k).sort((a, b) => (focusSlot(a) !== undefined) - (focusSlot(b) !== undefined));
  const series = order.map((k) => {
    const slot = focusSlot(k);
    return lineSeries(missionLabel(model.missions[k]), values[k], slot === undefined ? colors.context : colors.series[slot], slot === undefined ? 1 : 2);
  });
  for (const f of [...state.focus].sort((a, b) => a.slot - b.slot)) {
    p.legend.append(el("span", {}, el("span", { class: "line", style: { color: colors.series[f.slot] } }), missionLabel(model.missions[f.k])));
  }
  p.legend.append(el("span", {}, el("span", { class: "line", style: { color: colors.context } }), t("otherMissions")));
  return {
    root: p.root,
    mount: () => timePlot(p.body, {
      height: 300,
      x: model.times,
      series,
      yRange,
      yFormat: format,
      tooltipFor: (i) => ({
        title: fmtDayTime(model.times[i]),
        rows: order.map((k) => ({ k, v: values[k][i] })).filter((r) => r.v !== null)
          .sort((a, b) => (focusSlot(b.k) !== undefined) - (focusSlot(a.k) !== undefined) || b.v - a.v)
          .map(({ k, v }) => {
            const slot = focusSlot(k);
            return { color: slot === undefined ? colors.context : colors.series[slot], value: format(v), name: missionLabel(model.missions[k]), dim: slot === undefined };
          }),
      }),
      draw: (u, c) => {
        const labels = state.focus.flatMap((f) => {
          const i = lastIndexIn(model.times, values[f.k], state.to);
          if (i < 0) return [];
          return [{
            text: `#${String(model.missions[f.k].order).padStart(2, "0")} ${format(values[f.k][i])}`,
            x: u.valToPos(model.times[i], "x", true) - 6 * uPlot.pxRatio,
            y: u.valToPos(values[f.k][i], "y", true) - 4 * uPlot.pxRatio,
          }];
        });
        for (const label of separateLabels(labels, 15 * uPlot.pxRatio)) canvasLabel(u, c, label.text, label.x, label.y);
      },
    }),
  };
}

function weatherPanels(summary) {
  const hours = model.weatherHours;
  if (hours.length === 0) return [];
  const x = hours.map((h) => h.t + HOUR / 2);
  const colors = palette();
  const inRange = () => hours.filter((h) => h.t + HOUR > state.from && h.t <= state.to);
  const temp = panel({
    title: t("panelTemp"), info: t("panelTempInfo"), span: 12,
    inspect: () => ({
      header: [t("colHour"), t("colTemp"), t("colCondition"), t("colRain")],
      rows: inRange().map((h) => [fmtHour(h.t), h.temperature, describeCondition(h.condition, state.lang), h.amount]),
    }),
  });
  const rain = panel({
    title: t("panelRain"), info: t("panelRainInfo"), span: 12,
    inspect: () => ({ header: [t("colHour"), t("colRain")], rows: inRange().map((h) => [fmtHour(h.t), h.amount]) }),
  });
  const weatherRows = (i) => [
    { color: colors.series[0], value: `${fmtNum(hours[i].temperature, 1)} °C`, name: describeCondition(hours[i].condition, state.lang) },
    { value: `${fmtNum(hours[i].amount, 1)} mm`, name: t("panelRain") },
  ];
  return [
    {
      root: temp.root,
      mount: () => timePlot(temp.body, {
        height: 200, x,
        series: [lineSeries(t("panelTemp"), hours.map((h) => h.temperature), colors.series[0], 2)],
        yRange: (u, min, max) => [Math.floor(min - 1), Math.ceil(max + 1)],
        yFormat: (v) => `${fmtNum(v)}°`,
        tooltipFor: (i) => ({ title: fmtHour(hours[i].t), rows: weatherRows(i) }),
      }),
    },
    {
      root: rain.root,
      mount: () => timePlot(rain.body, {
        height: 200, x,
        series: [barSeries(t("panelRain"), hours.map((h) => h.amount), colors.series[0])],
        yRange: (u, min, max) => [0, Math.max(1, max * 1.15)],
        yFormat: (v) => fmtNum(v, Number.isInteger(v) ? 0 : 2),
        tooltipFor: (i) => ({ title: fmtHour(hours[i].t), rows: weatherRows(i) }),
      }),
    },
  ];
}

// ---------- stat tiles ----------

function statTile(title, value, sub) {
  const p = panel({ title, span: 4, cls: "stat" });
  p.body.append(el("div", { class: "value" }, value), el("div", { class: "sub" }, sub));
  return { root: p.root };
}

function statTiles(summary) {
  const leader = [...summary.missions].sort((a, b) => b.added - a.added)[0];
  const rated = summary.missions.filter((m) => m.ratingEnd !== null).length;
  const w = summary.weather;
  return [
    statTile(t("statTotal"), fmtNum(summary.totalEnd), t("statTotalSub", { added: fmtSigned(summary.added) })),
    statTile(t("statPeak"), summary.peak ? fmtHour(summary.peak.t) : t("none"),
      summary.peak ? t("statPeakSub", { count: fmtNum(summary.peak.added) }) : t("noData")),
    statTile(t("statRating"), fmtPct(summary.meanRating), t("statRatingSub", { n: rated })),
    statTile(t("statLeader"), leader && leader.added > 0 ? missionLabel(leader) : t("none"),
      leader && leader.added > 0 ? t("statLeaderSub", { count: fmtNum(leader.added) }) : t("noData")),
    statTile(t("statRuns"), fmtNum(summary.runs.total), t("statRunsSub", { complete: fmtNum(summary.runs.complete), failed: fmtNum(summary.runs.failed) })),
    statTile(t("statWeather"), w ? `${fmtNum(w.min)}–${fmtNum(w.max)} °C` : t("none"),
      w ? t("statWeatherSub", { rain: fmtNum(w.rain, 1), hours: w.rainyHours }) : t("noData")),
  ];
}

// ---------- pace heat map (canvas) ----------

function pacePanel(summary) {
  const p = panel({
    title: t("panelPace"), info: t("panelPaceInfo"), span: 14,
    inspect: () => ({
      header: [t("colHour"), ...model.missions.map(missionLabel)],
      rows: summary.hours.map((h) => [fmtHour(h.t), ...h.byMission]),
    }),
  });
  const colors = palette();
  const max = Math.max(1, ...summary.hours.flatMap((h) => h.byMission));
  p.legend.append(el("span", {}, t("low"), el("span", { class: "ramp", style: { background: `linear-gradient(90deg, ${colors.seq.join(",")})` } }),
    `${t("high")} (${fmtNum(max)} ${t("perHour")})`));
  const draw = () => {
    p.body.replaceChildren();
    if (summary.hours.length === 0) {
      p.body.append(el("div", { class: "empty" }, t("noData")));
      return;
    }
    const width = contentWidth(p.body);
    const labelWidth = Math.min(170, width * 0.32);
    const rowH = 18;
    const axisH = 34;
    const height = model.missions.length * rowH + axisH;
    const ratio = window.devicePixelRatio || 1;
    const canvas = el("canvas", { width: Math.round(width * ratio), height: Math.round(height * ratio), role: "img", "aria-label": t("panelPace") });
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    p.body.append(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const cols = summary.hours.length;
    const cellW = (width - labelWidth) / cols;
    ctx.font = `12px ${colors.font}`;
    ctx.textBaseline = "middle";
    model.missions.forEach((m, k) => {
      ctx.fillStyle = colors.ink2;
      ctx.textAlign = "right";
      ctx.fillText(missionLabel(m), labelWidth - 8, k * rowH + rowH / 2, labelWidth - 12);
      summary.hours.forEach((h, j) => {
        const v = h.byMission[k];
        ctx.fillStyle = v > 0 ? ramp(colors, v / max) : colors.grid;
        // A 2px surface gap separates the cells.
        ctx.fillRect(labelWidth + j * cellW + 1, k * rowH + 1, Math.max(1, cellW - 2), rowH - 2);
      });
    });
    ctx.fillStyle = colors.muted;
    ctx.font = `11px ${colors.font}`;
    ctx.textAlign = "center";
    // Label whole local hours that are a multiple of `every`, keeping at least 64px between labels.
    const every = [1, 2, 3, 4, 6, 8, 12, 24].find((n) => n * cellW >= 64) ?? 24;
    const ticks = summary.hours.map((h, j) => j)
      .filter((j) => (Math.floor((summary.hours[j].t + 8 * HOUR) / HOUR) % 24) % every === 0);
    if (ticks.length === 0 || ticks[0] >= every) ticks.unshift(0);
    const days = ticks.map((j) => fmtDay(summary.hours[j].t));
    const showDay = dayLabelPositions(days, ticks.map((j) => j * cellW));
    ticks.forEach((j, n) => {
      const x = labelWidth + j * cellW;
      ctx.textAlign = n === 0 ? "left" : "center";
      ctx.fillText(fmtClock(summary.hours[j].t), x, model.missions.length * rowH + 10);
      if (showDay[n]) ctx.fillText(days[n], x, model.missions.length * rowH + 25);
    });
    canvas.addEventListener("mousemove", (event) => {
      const rect = canvas.getBoundingClientRect();
      const j = Math.floor((event.clientX - rect.left - labelWidth) / cellW);
      const k = Math.floor((event.clientY - rect.top) / rowH);
      if (j < 0 || j >= cols || k < 0 || k >= model.missions.length) {
        hideTooltip();
        return;
      }
      const h = summary.hours[j];
      showTooltip(event.clientX, event.clientY, fmtHour(h.t), [{ value: fmtNum(h.byMission[k]), name: missionLabel(model.missions[k]) }]);
    });
    canvas.addEventListener("mouseleave", hideTooltip);
  };
  return { root: p.root, mount: () => { draw(); onResize(p.body, draw); } };
}

// ---------- map (SVG) ----------

function mapPanel(summary) {
  const seg = el("div", { class: "seg", role: "group" },
    ["all", "cluster"].map((view) => el("button", {
      type: "button", "aria-pressed": String(state.mapView === view),
      onclick: () => { state.mapView = view; update(); },
    }, t(view === "all" ? "mapAll" : "mapCluster"))));
  const p = panel({
    title: t("panelMap"), info: t("panelMapInfo"), span: 10, cls: "map", actions: [seg],
    inspect: () => ({
      header: [t("colMission"), t("colAdded"), t("colCompleted")],
      rows: summary.missions.map((m) => [missionLabel(m), m.added, m.countEnd]),
    }),
  });
  const colors = palette();
  const routes = geo.routes.filter((r) => state.mapView === "all" || CLUSTER_ORDERS.has(r.order));
  const byGuid = new Map(summary.missions.map((m) => [m.guid, m]));
  const max = Math.max(1, ...routes.map((r) => byGuid.get(r.missionGuid)?.added ?? 0));
  p.legend.append(el("span", {}, t("low"), el("span", { class: "ramp", style: { background: `linear-gradient(90deg, ${colors.seq.slice(2).join(",")})` } }),
    `${t("high")} (+${fmtNum(max)})`), el("a", { href: "https://www.openstreetmap.org/copyright", rel: "noopener" }, "© OpenStreetMap contributors"));

  const points = routes.flatMap((r) => r.points);
  const lats = points.map((q) => q[0]);
  const lngs = points.map((q) => q[1]);
  const pad = state.mapView === "all" ? 0.012 : 0.003;
  const box = { s: Math.min(...lats) - pad, n: Math.max(...lats) + pad, w: Math.min(...lngs) - pad, e: Math.max(...lngs) + pad };
  const kx = Math.cos(((box.s + box.n) / 2) * Math.PI / 180);
  const scale = 10000;
  const project = ([lat, lng]) => [((lng - box.w) * kx * scale).toFixed(1), ((box.n - lat) * scale).toFixed(1)];
  const vbW = (box.e - box.w) * kx * scale;
  const vbH = (box.n - box.s) * scale;

  const draw = () => {
    p.body.replaceChildren();
    const root = svg("svg", { viewBox: `0 0 ${vbW.toFixed(1)} ${vbH.toFixed(1)}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": t("panelMap") });
    // Text and strokes are sized in screen pixels whatever the zoom of the view box.
    const unitsPerPx = Math.max(vbW / Math.max(1, contentWidth(p.body)), vbH / 360);
    for (const way of geo.coastline.ways) {
      root.append(svg("polyline", { points: way.map(project).map((q) => q.join(",")).join(" "), fill: "none", stroke: colors.axis, "stroke-width": String(unitsPerPx), "stroke-linejoin": "round" }));
    }
    const sorted = [...routes].sort((a, b) => (byGuid.get(a.missionGuid)?.added ?? 0) - (byGuid.get(b.missionGuid)?.added ?? 0));
    for (const route of sorted) {
      const m = byGuid.get(route.missionGuid);
      if (!m) continue;
      const pts = route.points.map(project).map((q) => q.join(",")).join(" ");
      const color = m.added > 0 ? ramp({ seq: colors.seq.slice(2) }, m.added / max) : colors.context;
      const group = svg("g", { tabindex: "0", role: "img", "aria-label": `${missionLabel(m)}: +${m.added}` });
      group.append(
        svg("polyline", { points: pts, fill: "none", stroke: "transparent", "stroke-width": String(14 * unitsPerPx), "stroke-linecap": "round" }),
        svg("polyline", { points: pts, fill: "none", stroke: colors.surface, "stroke-width": String(6 * unitsPerPx), "stroke-linecap": "round", "stroke-linejoin": "round" }),
        svg("polyline", { points: pts, fill: "none", stroke: color, "stroke-width": String(4 * unitsPerPx), "stroke-linecap": "round", "stroke-linejoin": "round" }));
      const [lx, ly] = project(route.points[0]);
      const label = svg("text", { x: lx, y: ly, dx: String(7 * unitsPerPx), dy: String(4 * unitsPerPx), "font-size": String(11 * unitsPerPx), fill: colors.ink, "font-family": colors.font, "font-weight": focusSlot(m.index) !== undefined ? "700" : "500" });
      label.textContent = String(m.order).padStart(2, "0");
      group.append(label);
      const show = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX ?? rect.right;
        const y = event.clientY ?? rect.top;
        showTooltip(x, y, missionLabel(m), [
          { color, value: fmtSigned(m.added), name: t("colAdded") },
          { value: fmtNum(m.countEnd), name: t("colCompleted") },
        ]);
      };
      group.addEventListener("mousemove", show);
      group.addEventListener("focus", show);
      group.addEventListener("mouseleave", hideTooltip);
      group.addEventListener("blur", hideTooltip);
      group.addEventListener("click", () => toggleFocus(m.index));
      root.append(group);
    }
    p.body.append(root);
  };
  return { root: p.root, mount: () => { draw(); onResize(p.body, draw); } };
}

// ---------- collection health (state timeline) ----------

function healthPanel() {
  const runs = model.runs.filter((r) => r.t >= state.from && r.t <= state.to);
  const colors = palette();
  const statusColor = { complete: colors.good, partial: colors.warning, failed: colors.critical };
  const statusIcon = { complete: "✓", partial: "◐", failed: "✕" };
  const p = panel({
    title: t("panelHealth"), info: t("panelHealthInfo"),
    inspect: () => ({
      header: [t("colRun"), t("colTime"), t("colStatus"), t("colMissionsOk"), t("colError")],
      rows: runs.map((r) => [r.id, fmtDayTime(r.t), t(runStatus(r)), `${r.ok}/${r.total}`, r.error || (r.skipped ? t("skippedReadings", { n: r.skipped }) : "")]),
    }),
  });
  const counts = { complete: 0, partial: 0, failed: 0 };
  runs.forEach((r) => counts[runStatus(r)]++);
  for (const status of ["complete", "partial", "failed"]) {
    p.legend.append(el("span", { class: "status" },
      el("span", { class: "swatch", style: { background: statusColor[status] } }),
      `${statusIcon[status]} ${t(status)} · ${fmtNum(counts[status])}`));
  }
  const draw = () => {
    p.body.replaceChildren();
    const width = contentWidth(p.body);
    const height = 30;
    const root = svg("svg", { width: String(width), height: String(height), role: "img", "aria-label": t("panelHealth") });
    const span = state.to - state.from || 1;
    const runWidth = Math.max(2, (5 * 60 / span) * width - 1);
    for (const r of runs) {
      const status = runStatus(r);
      const x = ((r.t - state.from) / span) * (width - runWidth);
      const rect = svg("rect", { x: x.toFixed(1), y: "2", width: runWidth.toFixed(1), height: String(height - 4), rx: "1", fill: statusColor[status] });
      rect.addEventListener("mousemove", (event) => showTooltip(event.clientX, event.clientY, fmtDayTime(r.t), [
        { color: statusColor[status], value: `${statusIcon[status]} ${t(status)}`, name: `${r.ok}/${r.total}` },
        ...(r.error ? [{ value: t("colError"), name: r.error }] : []),
      ]));
      rect.addEventListener("mouseleave", hideTooltip);
      root.append(rect);
    }
    p.body.append(root);
  };
  return { root: p.root, mount: () => { draw(); onResize(p.body, draw); } };
}

// ---------- missions table ----------

function tablePanel(summary) {
  const colors = palette();
  const columns = [
    { key: "order", label: t("colOrder"), num: true, value: (m) => m.order, show: (m) => String(m.order).padStart(2, "0") },
    { key: "name", label: t("colMission"), value: (m) => m.name, show: (m) => m.name },
    { key: "countEnd", label: t("colCompleted"), num: true, value: (m) => m.countEnd, show: (m) => fmtNum(m.countEnd) },
    { key: "added", label: t("colAdded"), num: true, value: (m) => m.added, show: (m) => fmtSigned(m.added) },
    { key: "ratingEnd", label: t("colRating"), num: true, value: (m) => m.ratingEnd ?? -1, show: (m) => fmtPct(m.ratingEnd) },
    {
      key: "ratingChange", label: t("colRatingChange"), num: true,
      value: (m) => (m.ratingEnd !== null && m.ratingStart !== null ? m.ratingEnd - m.ratingStart : -1e9),
      show: (m) => (m.ratingEnd !== null && m.ratingStart !== null ? fmtSigned(m.ratingEnd - m.ratingStart, 1) : t("none")),
    },
    { key: "duration", label: t("colDuration"), num: true, value: (m) => m.duration ?? 0, show: (m) => fmtDuration(m.duration) },
    { key: "author", label: t("colAuthor"), value: (m) => m.author, show: (m) => m.author },
    { key: "faction", label: t("colFaction"), value: (m) => m.faction, show: (m) => m.faction },
  ];
  const p = panel({
    title: t("panelTable"), info: t("panelTableInfo"),
    inspect: () => ({ header: columns.map((c) => c.label), rows: summary.missions.map((m) => columns.map((c) => c.value(m))) }),
  });
  const { key, dir } = state.sort;
  const column = columns.find((c) => c.key === key) ?? columns[0];
  const rows = [...summary.missions].sort((a, b) => {
    const va = column.value(a);
    const vb = column.value(b);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir || a.order - b.order;
  });
  const head = el("tr", {}, columns.map((c) => el("th", { class: c.num ? "num" : undefined, "aria-sort": c.key === key ? (dir > 0 ? "ascending" : "descending") : undefined },
    el("button", {
      type: "button",
      onclick: () => {
        state.sort = { key: c.key, dir: c.key === key ? -dir : c.num ? -1 : 1 };
        update();
      },
    }, c.label, c.key === key ? (dir > 0 ? " ↑" : " ↓") : ""))));
  const body = rows.map((m) => {
    const slot = focusSlot(m.index);
    return el("tr", {
      tabindex: "0",
      class: slot !== undefined ? "focused" : undefined,
      vars: slot !== undefined ? { "--row-key": colors.series[slot] } : undefined,
      "aria-pressed": String(slot !== undefined),
      onclick: () => toggleFocus(m.index),
      onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleFocus(m.index);
        }
      },
    }, columns.map((c) => {
      const cell = el("td", { class: [c.num ? "num" : "", c.key === "added" && m.added > 0 ? "up" : ""].join(" ").trim() || undefined }, c.show(m));
      if (c.key === "name" && m.url) {
        cell.append(" ", el("a", { href: m.url, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation(), "aria-label": t("openMission", { name: m.name }) }, "↗"));
      }
      return cell;
    }));
  });
  p.body.append(el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, body))));
  return { root: p.root };
}

function downloadsPanel() {
  const p = panel({ title: t("panelDownloads"), cls: "downloads" });
  const files = [
    ["data/snapshots.csv", "fileSnapshots"], ["data/runs.csv", "fileRuns"], ["data/failures.csv", "fileFailures"],
    ["data/weather_hours.csv", "fileWeatherHours"], ["data/weather_current.csv", "fileWeatherCurrent"],
    ["data/mdtrace.sqlite", "fileSqlite"], ["data/missions.json", "fileMissions"], ["geo/routes.json", "fileRoutes"],
  ];
  p.body.append(el("p", {}, t("downloadsIntro")),
    el("ul", {}, files.map(([href, key]) => el("li", {}, el("a", { href }, href), ` — ${t(key)}`))));
  return { root: p.root };
}

// ---------- controls ----------

function rangeControl() {
  const presets = [
    { label: t("wholeEvent"), from: model.extent.from, to: model.extent.to },
    ...dayPresets(model.extent).map((d) => ({ label: fmtDay(d.day), from: d.from, to: d.to })),
    ...[6, 12, 24].map((hours) => ({ label: t("last", { hours }), from: model.extent.to - hours * HOUR, to: model.extent.to })),
  ];
  const toLocalInput = (s) => new Date((s + 8 * HOUR) * 1000).toISOString().slice(0, 16);
  const fromLocalInput = (v) => Date.parse(`${v}:00Z`) / 1000 - 8 * HOUR;
  const fromInput = el("input", { type: "datetime-local", value: toLocalInput(state.from), min: toLocalInput(model.extent.from), max: toLocalInput(model.extent.to) });
  const toInput = el("input", { type: "datetime-local", value: toLocalInput(state.to), min: toLocalInput(model.extent.from), max: toLocalInput(model.extent.to) });
  const popover = el("div", { class: "popover", hidden: true, role: "menu" },
    presets.map((preset) => {
      const selected = Math.abs(preset.from - state.from) < 60 && Math.abs(preset.to - state.to) < 60;
      return el("button", { class: "preset", type: "button", role: "menuitemradio", "aria-checked": String(selected), onclick: () => setRange(preset.from, preset.to) },
        el("span", { class: "check" }, selected ? "✓" : ""), preset.label);
    }),
    el("div", { class: "custom" },
      el("strong", {}, t("custom")),
      el("label", {}, t("from"), fromInput),
      el("label", {}, t("to"), toInput),
      el("button", {
        class: "btn", type: "button",
        onclick: () => {
          const a = fromLocalInput(fromInput.value);
          const b = fromLocalInput(toInput.value);
          if (Number.isFinite(a) && Number.isFinite(b)) setRange(a, b);
        },
      }, t("apply"))));
  const button = el("button", {
    class: "btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: () => {
      popover.hidden = !popover.hidden;
      button.setAttribute("aria-expanded", String(!popover.hidden));
    },
  }, el("span", { class: "muted" }, "🕑"), `${fmtDayTime(state.from)} – ${fmtDayTime(state.to)}`);
  const wrap = el("div", { class: "range-wrap" }, button, popover);
  const close = (event) => {
    if (!wrap.contains(event.target)) {
      popover.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", close);
  cleanups.push(() => document.removeEventListener("click", close));
  return wrap;
}

function focusControl() {
  const colors = palette();
  const chips = [...state.focus].sort((a, b) => a.slot - b.slot).map((f) => el("span", { class: "chip" },
    el("span", { class: "key", style: { color: colors.series[f.slot] } }),
    missionLabel(model.missions[f.k]),
    el("button", { type: "button", "aria-label": `${t("clearFocus")} ${missionLabel(model.missions[f.k])}`, onclick: () => toggleFocus(f.k) }, "×")));
  const select = el("select", {
    "aria-label": t("focus"),
    onchange: (event) => {
      const k = Number(event.target.value);
      if (Number.isInteger(k) && k >= 0) toggleFocus(k);
    },
  }, el("option", { value: "" }, `+ ${t("focus")}`),
  model.missions.map((m, k) => (focusSlot(k) === undefined ? el("option", { value: String(k) }, missionLabel(m)) : null)));
  return el("div", { class: "chips", title: t("focusHint") }, chips, select,
    state.focus.length ? el("button", { class: "btn", type: "button", onclick: () => { state.focus = []; update(); } }, t("clearFocus")) : null);
}

function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function renderControls() {
  const zoomOut = el("button", {
    class: "btn", type: "button", title: t("zoomHint"),
    onclick: () => {
      const span = state.to - state.from;
      setRange(state.from - span / 2, state.to + span / 2);
    },
  }, "⊖ ", t("zoomOut"));
  const lang = el("button", { class: "btn", type: "button", onclick: () => { state.lang = state.lang === "zh" ? "en" : "zh"; update(); } }, t("language"));
  const theme = el("button", {
    class: "btn", type: "button",
    onclick: () => {
      const next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("mdtrace-theme", next);
      } catch {
        // Storage can be blocked; the choice then lasts for this page view.
      }
      update();
    },
  }, effectiveTheme() === "dark" ? t("themeLight") : t("themeDark"));
  document.getElementById("controls").replaceChildren(
    rangeControl(), zoomOut, el("span", { class: "hint" }, t("zoomHint")), focusControl(),
    el("span", { class: "spacer" }), lang, theme);
}

// ---------- render ----------

function update() {
  writeHash();
  render();
}

function render() {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  hoveredPlot = null;
  hideTooltip();
  t = translator(state.lang);
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  document.title = t("title");
  document.getElementById("title").textContent = t("title");
  document.getElementById("lede").textContent = `${t("subtitle")}. ${t("times")}`;
  document.getElementById("footer").replaceChildren(t("footer"), " · ",
    el("a", { href: "https://weatherkit.apple.com/legal-attribution.html", rel: "noopener" }, t("weatherAttribution")), " · ",
    el("a", { href: "https://github.com/szres/MDtrace-Data", rel: "noopener" }, t("sourceLink")));
  renderControls();

  const summary = summarize(model, state.from, state.to);
  const panels = [
    ...statTiles(summary),
    totalPanel(),
    hourlyPanel(summary),
    missionSeriesPanel(summary, {
      title: t("panelMissions"), info: t("panelMissionsInfo"), values: model.counts,
      yRange: (u, min, max) => [0, Math.max(10, max * 1.1)], format: (v) => fmtNum(v),
    }),
    missionSeriesPanel(summary, {
      title: t("panelRatings"), info: t("panelRatingsInfo"), values: model.ratings,
      yRange: () => [0, 100], format: (v) => fmtPct(v, 0),
    }),
    pacePanel(summary),
    mapPanel(summary),
    ...weatherPanels(summary),
    healthPanel(),
    tablePanel(summary),
    downloadsPanel(),
  ];
  const grid = document.getElementById("grid");
  grid.replaceChildren(...panels.map((p) => p.root));
  for (const p of panels) p.mount?.();
}

function showError(error) {
  const grid = document.getElementById("grid");
  const message = error instanceof Error ? error.message : String(error);
  grid.replaceChildren(el("div", { class: "banner error", role: "alert", "data-error": message }, t("loadFailed", { error: message })));
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

async function main() {
  window.addEventListener("error", (event) => showError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => showError(event.reason));
  const status = document.getElementById("status");
  t = translator(navigator.language?.startsWith("zh") ? "zh" : "en");
  status.textContent = t("loading");
  const entries = await Promise.all(Object.entries(FILES).map(async ([key, path]) => [key, await fetchText(path)]));
  const raw = Object.fromEntries(entries);
  model = buildModel({
    runs: parseCSV(raw.runs),
    snapshots: parseCSV(raw.snapshots),
    failures: parseCSV(raw.failures),
    weatherHours: parseCSV(raw.weatherHours),
    weatherCurrent: parseCSV(raw.weatherCurrent),
    missions: JSON.parse(raw.missions).missions,
  });
  geo = { routes: JSON.parse(raw.routes).routes, coastline: JSON.parse(raw.coastline) };
  readHash();
  writeHash();
  render();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) render();
  });
  window.addEventListener("hashchange", () => {
    readHash();
    render();
  });
  document.documentElement.dataset.ready = "true";
}

main().catch(showError);
