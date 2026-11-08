# MDTrace Data

**Dashboard: <https://szres.github.io/MDtrace-Data/>** · [中文说明](#中文说明)

Raw data and a static dashboard for Ingress Mission Day events. During each event, completions and
ratings of its missions were read from Ingress Intel every 5 minutes, together with Apple Weather
readings near the routes. The collector is [szres/MDtrace](https://github.com/szres/MDtrace).

| Event | Dates | Missions | Folder |
|---|---|---|---|
| MD 2026 Zhuhai (珠海) | 6–8 November 2026 | 18 | [`events/md2026-zhuhai/`](events/md2026-zhuhai/) |

The dashboard is plain HTML, CSS and JavaScript with no build step. Everything it shows is computed
in your browser from the files below:

- switch between events (the newest opens first; `#event=<slug>` links to one)
- pick any time range: presets, a custom range, or drag across a chart
- highlight up to three missions
- open the table behind any panel and download it as CSV

## Files

`events.json` lists every event, newest first:

```json
{"events": [{"slug": "md2026-zhuhai", "name": {"en": "MD 2026 Zhuhai", "zh": "MD 2026 珠海"},
  "timezone": "Asia/Shanghai", "start": "2026-11-06T08:52:46Z", "end": "2026-11-08T05:00:05Z",
  "missions": 18, "geo": true}]}
```

Each event has its own folder, `events/<slug>/`:

| File | Contents |
|---|---|
| `event.json` | Name, IANA time zone, weather point and, optionally, the map's zoom area |
| `data/snapshots.csv` | One row per mission per collection run |
| `data/runs.csv` | One row per 5-minute collection run |
| `data/failures.csv` | Mission readings that were skipped |
| `data/weather_current.csv` | Current conditions read with each run |
| `data/weather_hours.csv` | Hourly weather for the event days |
| `data/mdtrace.sqlite` | The same five tables as one SQLite database |
| `data/missions.json` | The missions in order, with their Intel links |
| `geo/routes.json` | Route polyline of each mission (`[lat, lng]` points); only when `geo` is true |
| `geo/coastline.json` | Coastline around the routes, from OpenStreetMap; only when `geo` is true |

MD 2026 Zhuhai has 8,447 snapshots, 483 runs, 12 skipped readings, 355 current-weather readings
and 61 weather hours.

All timestamps are UTC in ISO 8601 (`2026-11-07T05:00:00Z`). The dashboard shows them in the
event's own time zone (`timezone` in `event.json`; Zhuhai is UTC+8).

### `snapshots.csv`

| Column | Meaning |
|---|---|
| `run_id` | The collection run (`runs.id`) |
| `mission_order` | Position in the Mission Day set (1–18 in Zhuhai) |
| `mission_guid` | Intel mission GUID |
| `title` | Mission title on Intel |
| `author`, `faction` | Mission author and faction as shown on Intel |
| `completed_count` | Cumulative number of unique agents who completed the mission |
| `rating_e6` | Share of positive ratings × 10⁶ (`rating_e6 / 10000` = percent). It is 0 until the first rating arrives. |
| `average_duration_ms` | Average completion time reported by Intel, in milliseconds |
| `fetched_at` | When this reading was taken |

Intel refreshes each mission's statistics roughly once an hour, each at its own minute. That is why
counts move in steps.

### `runs.csv`

| Column | Meaning |
|---|---|
| `id` | Run number |
| `started_at`, `finished_at` | Start and end of the run |
| `missions_total` | Missions requested |
| `missions_ok` | Missions read successfully |
| `error` | Why the run failed, if it did (for example `intel session not available`) |

### `failures.csv`

| Column | Meaning |
|---|---|
| `run_id`, `mission_guid` | The run and mission whose reading was skipped |
| `error` | Why it was skipped. Intel occasionally served zeroed statistics for a mission; those readings were dropped rather than recorded as a fall to 0. |
| `failed_at` | When it happened |

### `weather_current.csv`

| Column | Meaning |
|---|---|
| `run_id` | The run this reading belongs to |
| `as_of` | Time of the observation |
| `condition` | WeatherKit condition code, such as `MostlyCloudy` or `Rain` |
| `temperature`, `apparent_temperature` | °C |
| `humidity` | Relative humidity, 0–1 |
| `precipitation_intensity` | mm/h |
| `wind_speed` | km/h |

### `weather_hours.csv`

| Column | Meaning |
|---|---|
| `hour_start` | Start of the hour |
| `condition` | WeatherKit condition code |
| `temperature` | °C |
| `precipitation_chance` | 0–1 |
| `precipitation_amount` | mm in that hour |
| `fetched_at` | When the hour was last read (forecast hours are replaced by later readings) |

## Using the data

```sh
sqlite3 events/md2026-zhuhai/data/mdtrace.sqlite \
  "SELECT mission_order, MAX(completed_count) FROM snapshots GROUP BY mission_order"
```

In pandas: `pd.read_csv("events/md2026-zhuhai/data/snapshots.csv", parse_dates=["fetched_at"])`.

## Adding an event

Events are published from the collector repository, which writes the event's folder and updates
`events.json`:

```sh
./scripts/export-dataset.sh <slug> ../MDtrace-Data
```

Then run `npm test` here (it checks that `events.json` and every event folder agree) and commit.

## Dashboard development

Serve the folder with any static server, for example `python3 -m http.server`, and open
<http://localhost:8000>. Browsers do not load ES modules from `file://`.

The data layer has tests that also check the published files:

```sh
npm test   # node --test (tested with Node 26)
```

uPlot 1.6.32 (MIT) is vendored in `assets/vendor/uplot/`.

## Licence and attribution

The dataset and dashboard are licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see `LICENSE`). Please credit
"MDTrace (szres)" and link to this repository. Exceptions:

- **`events/*/geo/coastline.json`** is © OpenStreetMap contributors and available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- **`assets/vendor/uplot/`** is © Leon Sorokin, MIT licence.

**Sources:**

- Mission statistics were read from [Ingress Intel](https://intel.ingress.com). Ingress is a
  trademark of Niantic Spatial, Inc. This project is not affiliated with or endorsed by Niantic.
- Weather data was provided by Apple Weather. See
  [the data sources and attribution](https://weatherkit.apple.com/legal-attribution.html).

---

## 中文说明

**看板：<https://szres.github.io/MDtrace-Data/>**

这里是 Ingress Mission Day 活动的原始数据和一个静态看板。每场活动期间，数据每 5 分钟从 Ingress Intel 读取一次各任务的完成数与评分，同时记录路线附近的 Apple Weather 天气。采集程序见 [szres/MDtrace](https://github.com/szres/MDtrace)。

| 活动 | 日期 | 任务数 | 目录 |
|---|---|---|---|
| MD 2026 珠海 | 2026 年 11 月 6–8 日 | 18 | [`events/md2026-zhuhai/`](events/md2026-zhuhai/) |

看板是纯 HTML、CSS 和 JavaScript，不需要构建。页面内容全部在浏览器中由上面列出的文件计算得出，你可以：

- 切换活动（默认打开最新的一场；`#event=<slug>` 可直接链接到某场活动）
- 选择任意时间范围：预设、自定义范围，或在图上拖动
- 高亮最多 3 个任务
- 查看任意面板背后的数据表并下载 CSV

**文件与字段**见上方英文表格，要点如下：

- `events.json` 按时间从新到旧列出所有活动；每场活动的文件在 `events/<slug>/` 下，`event.json` 记录名称、时区、天气位置和地图的放大区域。
- 所有时间戳均为 UTC（ISO 8601）。看板按活动所在时区显示（珠海为 UTC+8）。
- `completed_count`：累计的独立完成特工数。
- `rating_e6 / 10000`：好评百分比。首个评分出现前为 0。
- `average_duration_ms`：Intel 报告的平均用时（毫秒）。
- Intel 大约每小时刷新一次各任务的统计，每个任务的刷新时间不同，所以完成数呈阶梯状增长。
- `failures.csv` 记录被跳过的读取。Intel 偶尔会对某个任务返回全零数据，这类读取被丢弃，而不是记为跌到 0。
- 天气单位：气温 °C；湿度和降水概率为 0–1；降水强度 mm/h；每小时降水量 mm；风速 km/h。

**本地运行看板**：用任意静态服务器提供本目录（例如 `python3 -m http.server`），然后打开 <http://localhost:8000>。用 `npm test` 运行测试（已在 Node 26 上测试）。

**添加活动**：在采集程序仓库中运行 `./scripts/export-dataset.sh <slug> ../MDtrace-Data`，它会写入该活动的目录并更新 `events.json`；然后在这里运行 `npm test` 并提交。

**许可与来源**：

- 数据集与看板采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans)，使用时请注明 "MDTrace (szres)" 并附上本仓库链接。
- `events/*/geo/coastline.json` © OpenStreetMap 贡献者，采用 ODbL 1.0。
- uPlot 采用 MIT 许可。
- 任务统计来自 Ingress Intel。Ingress 是 Niantic Spatial, Inc. 的商标，本项目与 Niantic 无关。
- 天气数据由 Apple Weather 提供，见 [数据来源与归属](https://weatherkit.apple.com/legal-attribution.html)。
