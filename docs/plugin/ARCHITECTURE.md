# decaid-mcp plugin: architecture

Task 2 of the plugin assignment: the concept the operator decides on. No product code yet.

Basis:

- [docs/plugin-spike/REPORT.md](../plugin-spike/REPORT.md), measured against Decaid `0.8.6+2801`.
- The operator's scope (assignment §4).
- The operator's decisions on Task 1:
  - no shot time in `stats`;
  - no special handling of ambiguous stored ratings;
  - the restart test feeds only the operations doc.
- Three binding rules from Test 3:
  - cooperative computing;
  - no heavy work and no writes while the machine is busy;
  - write both freeze formats.

The reference implementation is decentespresso-mcp (repo
`The-Walker443/decentespresso-mcp`, read at `main`). It is called "the Python
server" below. Its file names (`metrics.py`, `writes.py`, `freezing.py`,
`stats.py`) refer to that repo.

## 1. Principles

1. **Decaid is the only store.** Every answer is computed from what Decaid returns
   right now. There is no archive, no sync and no cache, and nothing is kept
   between calls except a few flags such as the detected rating scale.
2. **The plugin runs on Decaid's main thread.** Every millisecond of synchronous
   plugin code is a millisecond in which Decaid serves nothing and records
   nothing (Test 3). Every design choice below is judged against that first.
3. **Only native shots.** Ids starting with `de1app-` are invisible everywhere.
4. **Narrow writes, always verified.** Whitelists, validation before sending,
   state read before and read back after. A 200 alone is never taken as proof.
5. **No self-protection.** The plugin trusts its network, as Decaid's own API
   does. Access control belongs to the operator's tunnel or proxy (§11).

## 2. Plugin layout

| Item | Value | Why |
|------|-------|-----|
| Plugin id | `decaid-mcp.reaplugin` | Suffix as with DYE2. It becomes the directory name and the URL path |
| Name | `Decaid MCP` | Shown in Decaid's plugin settings |
| Permissions | `log`, `api` | `api` covers both `fetch` and the HTTP endpoint (Test 2). No `pluginStorage` (no cache), no `events.*` (state is fetched on demand) |
| Settings | none | Nothing to configure. The base URL is fixed to `http://localhost:8080` (Test 2) |
| Endpoints | `mcp` (`type: http`) | One MCP endpoint, `/api/v1/plugins/decaid-mcp.reaplugin/mcp` |
| `onLoad` | Logs one line, returns immediately | The load watchdog allows 1 s, and three failed loads disable auto-load (Test 7). No network in `onLoad` |

Source modules (bundled into one `plugin.js`, §10):

```text
src/
  plugin.js            createPlugin(host): wiring, onLoad, __httpRequestHandler
  mcp/protocol.js      JSON-RPC and Streamable HTTP handling, tool dispatch
  mcp/tools.js         tool definitions (name, description, inputSchema, annotations)
  decaid/client.js     fetch wrapper: base URL, JSON, timing, error mapping
  decaid/guard.js      machine-state check (§6.2)
  decaid/scale.js      rating-scale probe (§7.4)
  runtime/slicer.js    cooperative scheduling and the slice budget (§6.1)
  domain/shots.js      native-shot filter, list paging, shot summary, profile summary
  domain/rows.js       measurements -> rows (decaid_mapping.series_rows_from_decaid)
  domain/metrics.js    compute_metrics: timing, pressure, pour, first drops, warnings
  domain/diagnostics.js puck_resistance, channeling, profile_compliance
  domain/curve.js      curve_shape, downsample_curve
  domain/stats.js      summarise over list metadata
  domain/freezing.js   frost read rule, event mirroring, active age
  domain/rounding.js   Python-compatible rounding (§5.3)
  writes/rules.js      rulesets and value checks (writes.py)
  writes/apply.js      read-before, PUT, read-back, outcome
```

`domain/*` and `writes/rules.js` are pure. They take data and return data,
without `fetch`, `host` or clock access (the clock is passed in), so Node can
test them unchanged (§9).

## 3. Tools

Three classes decide what the machine-state guard (§6.2) does:

- **light**: no measurements, no writes. Always runs.
- **heavy**: processes measurements. Refused while the machine is busy.
- **write**: changes Decaid. Refused while the machine is busy.

All tools return a JSON object as `structuredContent`, and the same object
serialised as one text item in `content`. Tool failures, including a busy
machine, are results with `isError: true` and a sentence that says what to do.
They are never JSON-RPC errors (§8).

Every response states units once in the server instructions (bar, ml/s, g,
°C, s) and never repeats them per field. This follows the Python server.

The starting proposal had 15 tools. `list_batches` is folded into `list_beans`,
which leaves **14**. A batch without its bean's name and roaster is not a
useful answer, both come from the same two Decaid calls, and one tool fewer is
one description fewer in every conversation. Everything else in the proposal
maps to one operator requirement, and nothing was added.

### 3.1 Reading

| Tool | Class | Inputs | Output | Decaid calls |
|------|-------|--------|--------|--------------|
| `status` | light | – | Plugin version; Decaid `fullVersion`; machine `state`/`substate` and `busy`; rating scale (`0-100`, `0-10`, `unknown`, probed lazily §7.4); `last_max_slice_ms` from the slicer (§6.1) | `GET /info`, `GET /machine/state`, scale probe once per plugin load |
| `list_shots` | light | `limit` (1-20, default 10), `cursor`, `bean_id`, `bean_batch_id`, `profile_title`, `search` | Compact rows, newest first: `id`, `timestamp` (as stored, tablet local time), profile title, coffee name and roaster, batch id, dose, yield, ratio, grind setting, rating with scale, notes (first 120 characters), `stopReason`. Plus `next_cursor`. **No shot time** (not in the list, Test 5) | `GET /shots?limit=20&offset=<cursor>&orderBy=timestamp&order=desc` plus the Decaid filters. Pages are fetched until `limit` native shots are collected; the cursor is Decaid's next offset |
| `get_shot` | heavy | `id` (UUID or `"latest"`), `include_curve` (default false), `max_points` (2-400, default 60; `0` = every point) | Metadata as in `list_shots`, plus `duration_s` (shot time). `metrics` (compute_metrics with warnings). `diagnostics`: `puck_resistance`, `channeling` (five indicators), `profile_compliance` with phases. `curve_shape` (segments and markers, as text-like objects). `profile` summary (§3.3). `curve` (parallel arrays `t,p,fi,fo,w,tb`) only with `include_curve` | `GET /shots/latest` (for `"latest"`: metadata only, gives the id), `GET /shots/<id>` (with measurements) |
| `compare_shots` | heavy | `ids` (2-4 UUIDs) | Per shot: key metadata, `duration_s`, the metrics headline (`pi_end`, `peak_pressure_infusion`, `avg_flow_pour`, `ratio`), diagnostics headline (resistance median and trend, channeling risk and fired indicators, compliance bands), profile brief. A `profile_notice` when the shots ran on different profiles (§3.3). Side-by-side deltas against the first shot | `GET /shots/<id>` per shot, one at a time, with the guard re-checked between shots (§6.2) |
| `stats` | light | `period` (`30d`, `12h`, `4w`, `1y` or an ISO date; default `30d`), `compare_previous` (default false) | From list metadata only: `shots`, `excluded` (maintenance profiles, yield < 5 g, as in `stats.py`), `per_day`; means of dose, yield, ratio; rating mean with `rated`/`unrated` counts and the scale; top beans and profiles; `grind_by_bean` (settings used per bean); `batch_usage` (shots and grams per batch); `busiest_day`. `truncated: true` if the cap was hit. **No shot time**, per the operator's decision | `GET /shots?limit=20&offset=…&orderBy=timestamp&order=desc`, paged until a shot is older than the period start. Cap: **500 shots**, twice that with `compare_previous`. The list has no date filter (Test 5) |
| `list_beans` | light | `include_archived` (default false) | Beans (`id`, name, roaster, origin fields when set, decaf) with their batches nested: `id`, roast date, `roast_age_days`, `active_age_days` (frost-corrected), frost state and source (§7.3), weight and weight remaining, archived | `GET /beans`, `GET /bean-batches` |
| `get_batch` | light | `id` | The batch with every field Decaid returns. Bean name and roaster. Roast age, active age, the frost timeline and its source, and a conflict flag (§7.3). The five most recent native shots from that batch (id, timestamp, grind, rating) | `GET /bean-batches/<id>`, `GET /beans/<beanId>`, `GET /shots?beanBatchId=<id>&limit=10` |
| `get_workflow` | light | – | `context`: dose, yield, grinder, grind setting, batch id, coffee name and roaster. Profile summary (§3.3). Whether the batch id resolves (T29: Decaid does not check it) | `GET /workflow`, `GET /bean-batches/<beanBatchId>` if set |

### 3.2 Writing

All write tools take `fields` as an object and answer with `changed`,
`unchanged`, `not_taken` (sent but not read back), and `before`/`after` of the
touched fields. Validation errors are collected and reported together
(`writes.py` style). Rules are in §7.

| Tool | Class | Inputs | Decaid calls |
|------|-------|--------|--------------|
| `update_shot` | write | `id`, `fields`: `enjoyment`, `espressoNotes` | Scale probe (§7.4). `GET /shots/<id>` before and after; the measurements are dropped right after parsing. `PUT /shots/<id>` `{annotations: {...}}` (deep merge, Decaid source) |
| `set_workflow` | write | `fields`: `grinderSetting`, `targetDoseWeight`, `targetYield`, `beanBatchId` | `GET /workflow` before. For `beanBatchId`: `GET /bean-batches/<id>` (must exist, T29) and `GET /beans/<beanId>`, so that `coffeeName`/`coffeeRoaster` are written with it (T28). `PUT /workflow` `{context: {...}}`. `GET /workflow` after |
| `create_bean` | write | `fields` (bean ruleset; `name` required) | `POST /beans`, then `GET /beans/<id>` |
| `update_bean` | write | `id`, `fields` | `GET /beans/<id>`, `PUT /beans/<id>`, `GET /beans/<id>` |
| `create_batch` | write | `bean_id`, `fields` (batch ruleset), optional `frost: {type: "frozen", at?}` | `GET /beans/<bean_id>` (must exist). `POST /beans/<bean_id>/batches`. With `frost`, then the `update_batch` frost path. `GET /bean-batches/<id>` |
| `update_batch` | write | `id`, `fields` (batch ruleset), optional `frost: {type: "frozen"\|"thawed", at?}` | `GET /bean-batches/<id>`, `PUT /bean-batches/<id>` (fields plus mirrored frost data, §7.3), `GET /bean-batches/<id>` |

There are no profile tools and no profile selection. `profile`, `profileId`,
steam, hot water and rinse settings are blocked with an explanation.

### 3.3 Profile summary

The summary is built from the profile object embedded in the shot or workflow.
The workflow carries no profile id (T38), so the id is not used.

- `title`, `beverage_type`, `target_weight`, `target_volume`, `tank_temperature`.
- `steps`: `name`, `pump` (`pressure`/`flow`), `target` (the `pressure` or
  `flow` value), `temperature`, `seconds`, `transition`, `exit` (`type`,
  `condition`, `value`) and `limiter` when set, `weight`/`volume` when set.

`compare_shots` shows only a brief: title, type, target weight, step count. It
derives profile equality from a canonical JSON of the brewing content, meaning
the steps and the targets, without `title`, `notes` or `author`. That mirrors
Decaid's own content hash (T37) without depending on it. Equal content gives
no notice. Equal title with different content: "same name, different content".
Different titles: "different profiles".

## 4. Data access

| Need | Endpoint | Notes |
|------|----------|-------|
| Base URL | `http://localhost:8080` | Fastest of the three working addresses (Test 2) |
| Shot list | `GET /api/v1/shots` | `limit` ≤ 100 is allowed, but the plugin uses **20**: one page measured 70 kB, and its `JSON.parse` is one atomic slice of about 5 ms (§6.1). `orderBy=timestamp&order=desc` |
| One shot with measurements | `GET /api/v1/shots/<id>` | 76 kB on average, 95 kB for a 45 s shot. There is **no metadata-only read of a single shot**: `GET /shots?ids=a,b` (checked live and in `shots_handler.dart`) returns a plain array of full records **with** measurements, and any other filter makes Decaid ignore `ids`. The plugin does not use `ids` |
| Latest shot | `GET /api/v1/shots/latest` | Metadata. If it is a `de1app-` shot (unlikely, since imports are old), `get_shot` falls back to the list |
| Beans and batches | `/beans`, `/beans/<id>`, `/bean-batches`, `/bean-batches/<id>`, `/beans/<id>/batches` | |
| Workflow | `GET` / `PUT /api/v1/workflow` | `PUT` deep-merges `context` (Decaid spec) |
| Machine state | `GET /api/v1/machine/state` | Guard (§6.2) |
| Version | `GET /api/v1/info` | `status` only |

**Native shots.** A shot is native if its `id` does not start with `de1app-`.
List pages are filtered after fetching. Decaid's `total` includes imports and
is therefore not reported. `get_shot` and `compare_shots` answer a `de1app-`
id with "not found".

**Paging.** A Decaid page is 20 items, and the cursor is Decaid's offset. There
is a yield (§6.1) between pages. A tool never starts a page after its deadline
(§8).

**Time.** Timestamps are shown as Decaid stores them. For native shots that is
tablet local time without a zone. `stats` computes the period start on the
tablet's own clock and compares as local time. There is no zone conversion,
as decided. Measurement times are differences between the points' own
`machine.timestamp` values (parsed with microseconds, as in the spike).

**Cache.** None. Test 4 (about 25 ms of compute per shot for the full
diagnostics, 0.3 s for four shots) and Test 5 (stats from the list only) show
there is no need. A shot-time cache for `stats` is an Aufgabe 4 candidate,
per the operator.

## 5. Diagnostics port

### 5.1 Scope

Everything in `metrics.py` that `get_shot` and `compare_shots` need is ported,
with **thresholds and constants copied unchanged**, including the comments that
justify them:

| Python | JS module | Content |
|--------|-----------|---------|
| `decaid_mapping.series_rows_from_decaid`, `decaid_client.measurement_times` | `domain/rows.js` | Measurements to rows, elapsed from timestamps, de-duplication |
| `compute_metrics` and helpers (`phase_boundaries`, `_pi_end`, `substate_change`, `frame_boundaries`) | `domain/metrics.js` | `pi_end` and its source, the two pressure maxima, dip, pour flow and stability, trend, temperatures, end pressure, first drops with the tare check, `duration_s`, ratio, warnings |
| `settled_window`, `puck_resistance`, `_theil_sen`, `channeling`, `_flow_jitter`, `_flow_divergence`, `profile_compliance`, `_phase_compliance`, `control_mode` | `domain/diagnostics.js` | The five channeling indicators and compliance per control mode and phase |
| `curve_shape`, `_describe`, `_is_linear`, `downsample_curve` | `domain/curve.js` | Shape as text-like segments; raw curve on request |

Not ported: `METRICS_VERSION` (there is no cache), `metrics_for_shot`,
`warm_metrics_cache`, and everything DB-related. Dose and yield come from
`annotations.actualDoseWeight`/`actualYield`, as in `annotation_fields`.

### 5.2 Parity

The spike ported `puck_resistance` and `profile_compliance`. Both gave results
identical to the Python code on four real shots, after one fix to the flow
rounding. Task 3 extends this to every ported function, with golden files
(§9.2).

### 5.3 Rounding

Python's `round()` rounds half to even, and JavaScript's `Math.round` rounds
half up. `domain/rounding.js` implements Python's behaviour on the decimal
representation, so outputs match to the last digit. The parity tests pin the
difference with constructed half-way values.

## 6. The main-thread rules

### 6.1 Cooperative computing

**Budget.** Measured on the tablet with `Date.now()` around a slice:

| Kind of slice | Budget | Measured basis |
|---------------|--------|----------------|
| Plugin-controlled computation (one pipeline stage of one shot, one page of list processing, response building) | **≤ 5 ms** target, **≤ 10 ms** hard ceiling | Two metrics for one 184-point shot took 7 ms in total (Test 4). The full pipeline is split into seven stages of about 1-4 ms each at 184 points. Shots up to 600 points stay under the ceiling |
| Atomic host step (Decaid's hand-off of one fetch response into JS, plus `JSON.parse` of it) | **≤ 20 ms** | Cannot be split: the bridge evaluates the whole body at once. It is kept bounded through response sizes: one shot per request (3-5 ms, maximum 20 ms measured), list pages of 20 (~100 kB) |

**Mechanism.** `runtime/slicer.js` provides `await slicer.pause()`, a macrotask
yield: `new Promise(r => setTimeout(r, 0))`. A microtask (`await
Promise.resolve()`) does **not** return control to Decaid, because the host
drains all pending jobs in one go (`executePendingJob` loop). The tablet
acceptance must confirm that `setTimeout(0)` really lets Decaid's event loop
run (§9.4, item 1).

**Where the pipeline yields:**

- after every fetch and parse;
- after each stage of a shot: rows, core metrics, resistance, channeling,
  compliance, curve shape, and optional downsampling;
- between list pages;
- between shots in `compare_shots`;
- before serialising a response larger than 100 kB.

Stage functions stay synchronous and pure, which keeps them testable against
Python. Only the orchestration around them is async.

**Measurement.** `slicer` records the length of every slice, meaning the time
between two pauses, per tool call. A call whose longest slice exceeds 10 ms is
logged with its tool and stage (`host.log`). `status` reports the longest slice
of the last heavy call (`last_max_slice_ms`).

**Budget test.** Two parts. Node cannot measure tablet time directly, so it
works with a calibration factor.

1. *Stage cost (Node).* Each stage function runs warm (median of 50 runs) on
   every fixture shot and on a synthetic 600-point shot. The factor from Node
   to the tablet is **4.5**: the spike measured 4.3 (1.62 ms Node against
   7.0 ms tablet for the same code and shot) and 4.2 for `JSON.parse`, rounded
   up. The test fails if `median × 4.5 > 5 ms` for a fixture shot, or `> 10 ms`
   for the 600-point shot.
2. *Yield structure (Node).* A fake host records every `setTimeout(0)` and
   every stage entry. The test asserts that heavy tools pause between every pair
   of stages, between shots and between pages. Taking out one pause fails it.

The tablet acceptance (§9.4) re-measures the real ceiling: `/machine/state` is
polled every 50 ms while `compare_shots` (4 shots) and `stats 90d` run. The
longest stall must stay ≤ 25 ms (the 20 ms atomic step plus request
overhead), and `last_max_slice_ms` must stay ≤ 10. The calibration factor is
re-checked there too: the logged stage times against the Node run on the same
fixture.

### 6.2 No heavy work and no writes while the machine is busy

**Check.** Before every heavy and every write tool: `GET /machine/state`.
**Busy** means `state.state` is one of:

- `espresso`, `steam`, `hotWater`, `flush`, `steamRinse` (the four activities
  the operator named: shot, steam, hot water, rinse);
- `skipStep` (a step change during one of them);
- `cleaning`, `descaling`, `calibration`, `airPurge`, `selfTest`, `fwUpgrade`
  (maintenance runs, in which a write or stall is just as unwelcome);
- `busy` (Decaid's generic state; unknown work counts as work).

Not busy: `idle`, `schedIdle`, `sleeping`, `heating`, `preheating`, `booting`,
`needsWater`, `error`. No machine connected (the request fails or has no
`state`) also counts as not busy, because nothing can run. Task 3 verifies what
Decaid answers without a DE1.

**Answer when busy:** `isError: true`, with the text
`The machine is busy (espresso). Ask again after the shot - nothing was
computed or written.` The state name is filled in. No other Decaid call is made.

**Race.** A shot can start after the check. Heavy tools therefore re-check
between shots and between pages, and stop with the same answer and whatever
was not yet started. Write tools do one write each, so the check directly
before the PUT is the last point anything could change. The remaining window
is one Decaid request.

**Light tools** (`status`, `list_shots`, `stats`, `list_beans`, `get_batch`,
`get_workflow`) run regardless. `stats` pages through the list, but its slices
are bounded (§6.1), and the operator allowed tools without measurements.

## 7. Write paths

### 7.1 Rulesets

These are taken from `writes.py` and narrowed to the operator's scope. For the
check kinds, see `writes.py`: collected errors, `,` accepted as the decimal
separator, 5,000 characters for text, ISO dates with the roast-age and
future-date rules, UUID shape for identifiers.

| Ruleset | Allowed | Blocked (with a reason each) |
|---------|---------|------------------------------|
| Shot | `enjoyment`, `espressoNotes` | `id`, timestamps, `stopReason`, `measurements`, `workflow`, `extras`. `actualDoseWeight`/`actualYield` are allowed in `writes.py` but **left out**: the scope says rating and notes |
| Workflow | `grinderSetting`, `targetDoseWeight` (5-30 g), `targetYield` (5-150 g), `beanBatchId` | `profile`, `profileId` (no profile selection), `coffeeName`/`coffeeRoaster` (they follow from the batch, T28), `grinderModel` (not in scope), steam, hot water, rinse, `id` |
| Bean | `name`, `roaster`, `species`, `processing`, `notes`, `decaf`, `country`, `region`, `producer`, `variety`, `altitude`, `decafProcess` | `id`, timestamps, `archived` |
| Batch | `roastDate`, `buyDate`, `openDate`, `bestBeforeDate`, `roastLevel`, `harvestDate`, `qualityScore`, `price`, `currency`, `notes`, `weight`, `weightRemaining` | `id`, `beanId`, timestamps, `archived`. Also `freezeDate`, `unfreezeDate`, `frozen` and `extras`: frost goes only through `frost` (§7.3), so that the two formats cannot drift apart |

### 7.2 Procedure for every write

1. Validate against the ruleset. Refuse with every problem listed at once.
2. Run the guard (§6.2).
3. Read before, using the endpoints listed in §3.2 (for a shot that means the
   full record, see §4).
4. Send one `PUT` or `POST` with only the validated fields.
5. Read back. Compare field by field. Report `changed`, `unchanged` and
   `not_taken`.

Special checks:

- **T28**: `set_workflow` with a `beanBatchId` writes `coffeeName` and
  `coffeeRoaster` from the batch's bean in the same `PUT`.
- **T29**: the batch is fetched first. A 404 refuses the write. An archived
  batch is written, with a warning.
- **`update_shot`** refuses `de1app-` ids.
- **`extras` merge**: a `PUT` with `extras` replaces the whole object. This was
  measured on 2026-09-29 on a PROBE batch: a key `keepMe` was lost. Fields on
  the top level are patch-merged, and `null` clears them. `update_batch`
  therefore always sends `extras` as *read, then merged*, never as built from
  scratch.

### 7.3 Frost data

**Formats.** From Test 8:

- **Beanie** keeps `extras.storageEvents = [{type: "frozen"|"thawed", at:
  ISO}]` and `frozen`. It never sets the date fields, and it ignores them when
  reading.
- **DYE2** keeps `freezeDate`, `unfreezeDate` and `frozen`.
- **Decaid** interprets neither.

**Reading: fixed precedence rule.**

1. `extras.storageEvents`, if it contains at least one valid event. Invalid
   entries are dropped and the rest sorted by time, as in Beanie's
   `normalizeStorageEvents` and `freezing.events_of`.
2. Otherwise `freezeDate`/`unfreezeDate`: one period, open if `frozen` is true
   and `unfreezeDate` is absent.
3. Otherwise `frozen` alone: state known, dates unknown, so the active age is
   an upper bound (`certain: false`).

Why the events win:

- They are the only format that can hold more than one freeze cycle.
- Beanie, the operator's skin, writes only them. After any freeze or thaw in
  Beanie, the date fields are stale by construction, whereas the events go
  stale only if DYE2 edits a batch that already has events.
- Reading them first matches what the operator sees on the tablet.

This **reverses the Python server's rule**, where the fields win (see
`freezing.py`). Test 8 is the reason: Beanie shows "On shelf, 28 d" for a batch
with only date fields, and the correct frozen period for one with only events.

**Conflict.** If both formats are present and the last cycle of the events
differs from the date fields by more than one day, the answer carries `frost:
{source: "events", conflict: true, fields: {freezeDate, unfreezeDate}}`, so the
difference is visible instead of silently resolved.

**Writing: always both.** `frost: {type, at?}` on `update_batch` or
`create_batch` sends one `PUT` with:

- `extras.storageEvents`: Beanie's `appendBatchStorageEvent` semantics, as in
  `freezing.mirrored_events`. The same type as the latest event replaces its
  time, and another type is appended. `at` defaults to now. A date alone keeps
  the previous event's time of day, as Beanie's date input does.
- `freezeDate` and `unfreezeDate`: the latest cycle. On `frozen`, `freezeDate =
  at` and `unfreezeDate = null`. On `thawed`, `unfreezeDate = at`, and
  `freezeDate` is kept or taken from the open event.
- `frozen` from the latest event.
- The other `extras` keys, unchanged.

**Active age.** Roast age minus the frozen days of every period, as in
`freezing.frozen_days`. Beanie shows the same number (18 d for batch C in
Test 8).

### 7.4 Rating scale

- **Detection** by write attempt (T46, Test 9): `PUT
  /shots/decaid-mcp-scale-probe` with `{annotations: {enjoyment: 11}}`.
  - 400 whose error mentions `enjoyment` → **0-10**.
  - 404 → **0-100**.
  - Anything else → `unknown`, and rating writes are refused with that reason.
- **When** it runs: on the first `update_shot` or `status` after a load, never
  in `onLoad`. The result is kept in a global for the plugin's lifetime.
  `/info` is not used: no release carries #887 yet.
- **Validation** (`writes._enjoyment`): on 0-10, one decimal at most; on
  0-100, whole numbers.

Per the operator's decision there is no special handling of ambiguous
*stored* values: ratings are shown as stored, together with the scale.
`writes.py` also refuses *writing* 1-10 on a 0-100 tablet, because Decaid's
0-10 migration would leave such a value unscaled. That rule is kept in this
draft, but it touches the same decision (open point 1).

## 8. MCP protocol layer

- **Transport**: Streamable HTTP, `2025-06-18`, plain JSON responses and no
  SSE. This is what Test 1 verified with Claude Code and the MCP Inspector.
- **Stateless**: no `Mcp-Session-Id` is issued, and none is required.
  Sessions in a global would be lost on every plugin reload (Test 7), and the
  plugin keeps no per-client state anyway. The spec allows a server without
  sessions.
- **Methods**:
  - `initialize` answers `protocolVersion` = the client's if it is one of
    `2025-06-18` or `2025-03-26`, otherwise `2025-06-18`. It also answers
    `capabilities: {tools: {listChanged: false}}`, `serverInfo` and
    `instructions`.
  - `instructions` carry the units, the terms (`pi_end` sources, the two
    pressure maxima, `warnings`, the channeling indicators, the rating scale,
    frost sources), the busy rule, and that only native shots are visible.
    They are taken from the Python server's instructions and shortened.
  - `ping` is answered; `tools/list` and `tools/call` are answered.
  - Notifications get 202 with an empty body.
  - Anything else gets `-32601`.
- **HTTP**:
  - `POST` only. `GET` and `DELETE` get 405 with `Allow: POST`.
  - A JSON array (batching was removed in 2025-06-18) or a non-object body
    gets 400 with a JSON-RPC `-32600`.
  - A body that is not JSON never reaches the plugin: Decaid answers 500
    itself (Test 1, D3). This is documented, not worked around.
- **Tool annotations**: `readOnlyHint` on light and heavy tools,
  `destructiveHint: false` and `idempotentHint` where they apply on write
  tools.
- **Origin header**: not validated. The MCP spec asks servers to validate it
  against DNS rebinding. On this port, Decaid's whole unauthenticated API
  answers anyway, so a check in the plugin would protect nothing that the port
  does not already expose. That follows the operator's decision that the plugin
  does not protect itself. The deviation is documented in the README.
- **Deadline**: Decaid gives a plugin request 30 s (Test 4). Every tool call
  runs against an internal **25 s** deadline, checked at each pause. Paging
  tools return what they have with `truncated: true`, and others return an
  error result. Expected durations are far below that: `get_shot` 0.1 s,
  `compare_shots` 0.3 s, `stats 30d` under 1 s.

**Error handling for the watchdog and the host (Test 7):**

- `__httpRequestHandler` wraps everything in one `try/catch` and a `.catch`,
  and always returns `{status, headers, body: string}`.
- It never returns `null` (that would leave the client waiting 30 s).
- It never throws (a throw would reach the client as a bare 500).
- Decaid failures map to tool results with `isError: true`:
  - `fetch` rejects → "Decaid did not answer".
  - A 4xx or 5xx from Decaid → its `error` text.
- Handler errors never count against the load watchdog. Only `onLoad` does, and
  it is trivial.

## 9. Test strategy

### 9.1 Tooling

- Node ≥ 20 with the built-in `node:test` and `node:assert`. No test
  framework.
- Pure modules are imported directly.
- The bundled `plugin.js` is also loaded as a whole through `new
  Function(src + "; return createPlugin;")` with a fake host. This is the same
  technique used for the calibration run in Task 2.

### 9.2 Fixtures and golden files

**Fixtures** are real Decaid responses, captured once from the tablet by
`tools/capture-fixtures.mjs` (read-only) and anonymised. The anonymiser:

- replaces ids with stable fake UUIDs;
- replaces bean, roaster and coffee names with generic ones;
- clears notes;
- drops `workflow.machine.serialNumber`;
- keeps every number, state and timestamp.

The set:

| Fixture | Why |
|---------|-----|
| 4-6 normal shots (different profiles, one 20-30 s, one 60 s+) | Main path, parity |
| A flush or cleaning run, and an aborted shot (if one is stored) | No settled window, warnings |
| A shot without scale data, and one with an untared scale if one exists | `t_first_drops`, dropped indicators |
| A synthetic 600-point shot (a real shot resampled) | Budget ceiling |
| List pages including a `de1app-` shot | Native filter, paging |
| Beans and batches: events only, fields only, both agreeing, both conflicting, `frozen` only | Frost rule |
| Workflow; machine states `sleeping`, `idle`, `espresso` | Guard |
| Error answers: 404 shot, 404 batch, 400 validation, the scale probe on 0.8.6 | Error mapping |

**Golden files**: `tools/python-reference.py` runs the Python server's
`metrics.py` (and `freezing.py` for the frost fixtures) on the same fixture
files and writes `test/golden/*.json`. The Python repo is read, not changed.
The JS tests compare field by field, after normalising integers to floats. Any
difference fails. The golden files are committed, so CI needs no Python.

### 9.3 What is tested in Node

- **Every tool**, through the fake host: the Decaid calls it makes (method,
  path, body, order), its output shape, and its error results.
- **Every write**: validation rejects, the guard refusal, read-before, the
  single PUT, the read-back outcome, T28 labels, T29 refusal, the `extras`
  merge, both frost formats, and the scale probe paths (400, 404, other).
- **Protocol**: handshake, notification 202, 405, 400 on arrays, unknown
  method, the tool error format, and the version negotiation.
- **Budget**: the two tests in §6.1.
- **Deadline**: a fake clock past 25 s gives `truncated` or an error result,
  never a missing answer.

### 9.4 Tablet acceptance (Task 3)

1. `setTimeout(0)` yields to Decaid. Check: `/machine/state` answers during a
   sliced 2 s loop.
2. The load probe during `compare_shots` (4 shots) and `stats 90d`: longest
   stall ≤ 25 ms, `last_max_slice_ms` ≤ 10.
3. Every tool once through Claude Code in the LAN.
4. Every write tool on `PROBE-` objects with snapshot, read-back and cleanup.
   The workflow is saved and restored field by field.
5. The busy guard with the operator pulling a real shot: a heavy tool and a
   write tool are refused, a light tool answers.
6. What `/machine/state` answers without a connected DE1 (guard edge case).
7. Plugin `Date` local time equals tablet local time (the `stats` period).
8. Install from the release ZIP, `enable`, connect, and uninstall.

## 10. Repo structure (decision template)

The repo itself is decided: the operator created
`The-Walker443/decaid-mcp` as a fresh project, independent of
decentespresso-mcp. What remains open is how the installable plugin comes out
of it. Decaid needs `manifest.json` and `plugin.js` at the root of a branch
archive, or in a release ZIP (D8).

| Option | Layout | Pros | Cons |
|--------|--------|------|------|
| **A: sources + build + release ZIP** (recommended) | `src/` modules, `test/`, `tools/`. `npm run build` bundles with **esbuild** (the only dev dependency) into `dist/decaid-mcp.reaplugin/`. A GitHub Action on tag `vX.Y.Z` runs the tests, checks tag = manifest version, and attaches one ZIP (the DYE2 pattern) | Small modules, each tested alone. Install and update via `github-release` with Decaid's update and permission rules. Tags equal versions | One build step, one dev dependency |
| B: hand-written single `plugin.js` at repo root | `manifest.json` and `plugin.js` at the root, tests beside them | No build. Installable via `github-branch` from `main` | A 2,500+ line file. Every push to `main` is a live update for branch installs. Tests load the whole file |
| C: like A, but a zero-dependency concat script instead of esbuild | Same as A | No npm dependency at all | A home-made module system (ordering, naming) to maintain |

Documents stay in `docs/`. `spike/` remains as a record of Task 1.

## 11. Operations documentation (outline)

1. **What it is**: tools, limits, only native shots, no shot time in `stats`.
2. **Install**:
   - `POST /api/v1/plugins/install/github-release` with
     `{"repo": "The-Walker443/decaid-mcp"}`;
   - then `POST /api/v1/plugins/decaid-mcp.reaplugin/enable`, which is
     required (D7);
   - updates through Decaid's plugin update check;
   - uninstall.
3. **Connect in the LAN**:
   - Claude Code: `claude mcp add --transport http decaid
     http://<tablet>:8080/api/v1/plugins/decaid-mcp.reaplugin/mcp`;
   - Claude Desktop through its connector settings or a local bridge;
   - testing with the MCP Inspector.
4. **Publishing through a tunnel or reverse proxy**, with the **mandatory
   notice**: on port 8080, Decaid's entire unauthenticated API answers. That
   includes `PUT /api/v1/plugins/:id/source`, which installs arbitrary code.
   A publication must pass **only** `/api/v1/plugins/decaid-mcp.reaplugin/mcp`,
   and must enforce access itself (for example Cloudflare Access or proxy
   authentication). Examples: a Cloudflare Tunnel with a path rule, and
   Caddy/nginx with a path allowlist.
5. **Autostart**: Decaid does not start after a tablet reboot. The fixes are
   Android autostart options, a launcher, or a kiosk mode. The result of the
   pending restart test (Test 7) goes here: how long until the plugin answers,
   and the fact that the plugin keeps no state.
6. **Limits and behaviour**:
   - the busy refusal during shots, steam, hot water and rinse;
   - `stats` capped at 500 shots;
   - requests up to 1 MiB;
   - the 30 s host timeout;
   - a body that is not JSON gets 500;
   - the rating-scale detection;
   - both frost formats.
7. **Troubleshooting**:
   - the plugin is not loaded (enable it; the watchdog disables it after 3
     failed loads);
   - "machine busy";
   - `truncated`;
   - the tablet is not reachable.

## 12. Open points for the operator

1. **Writing ratings 1-10 on a 0-100 tablet.** `writes.py` refuses them,
   because after Decaid's 0-10 migration such a value would stay unscaled and
   read ten times too high. That is write-side protection, not handling of
   stored values, so it is kept in this draft. Keep it (recommended), or drop
   it under decision (2)?
2. **The busy set is wider than the four activities named.** It also covers
   cleaning, descaling, calibration, air purge, self-test, firmware update,
   `skipStep` and `busy`. Agreed?
3. **Frost precedence: events before date fields.** This reverses the Python
   server's rule (§7.3). Agreed?
4. **Frost history edits.** The plugin only appends or re-times the latest
   freeze or thaw. Correcting an older cycle stays in Beanie. Sufficient?
5. **`stats` bounds**: the cap at 500 shots (about 100 days at the current
   rate), and `compare_previous` off by default (it doubles the paging). Agreed?
6. **`list_batches` folded into `list_beans`** (14 tools instead of 15). Agreed?
7. **Build**: option A with esbuild as the single dev dependency, B, or C
   (§10)?
8. **`actualDoseWeight`/`actualYield` on shots** are left out (the scope says
   rating and notes, while `writes.py` allows them). Confirm, or add them?
9. **Stateless MCP and no Origin check** (§8). Confirm that this matches "the
   plugin does not protect itself".
10. **CI**: a GitHub Action for tests and release (option A). Agreed?

## 13. Findings made during Task 2

These were verified live on 2026-09-29 or read at Decaid `d4721e5`, because
the design depends on them.

| # | Finding | How verified |
|---|---------|--------------|
| F1 | `PUT /bean-batches/:id` with `extras` **replaces** the whole `extras` object. Top-level fields are patch-merged, and `null` clears one | PROBE batch: `extras {keepMe, storageEvents}` → `PUT extras {storageEvents}` → `keepMe` gone. `PUT {notes}` kept `extras`. `PUT {freezeDate: null}` cleared it |
| F2 | `GET /shots?ids=a,b` returns a plain array of full records, **with** measurements, and is ignored as soon as another filter is set | Live (2 ids → array of 2 with `measurements`), `shots_handler.dart` lines 52-86 |
| F3 | `GET /shots/latest` returns metadata without measurements | Live |
| F4 | A list page of 20 shots is 70 kB | Live |
| F5 | Machine states: `schedIdle` exists in the model (`machine.dart`) but is missing from `rest_v1.yml` | Source |
| F6 | Node runs the ported metrics 4.3× faster than the tablet (1.62 ms against 7.0 ms per shot), and `JSON.parse` of a shot 4.2× faster (0.96 ms against 3-5 ms) | Spike plugin code run under Node on the same shot |

## 14. Live changes during Task 2

| Entity | Change | Status |
|--------|--------|--------|
| Bean `PROBE-extras` with one batch (`notes` `PROBE-x`/`PROBE-y`) | Created, then `extras`, `notes` and `freezeDate` writes (F1) | Both deleted (GET 404). Bean and batch lists identical to the snapshots taken before |
| GitHub branch `task-1-spike` | Pushed (operator's decision 4) | Intended |

No real shot, bean, batch, profile or workflow was written.
