# Spike report: decentespresso-mcp as a Decaid plugin

Task 1 of the plugin assignment. Measured 2026-09-29 against the operator's
tablet; source read at the tablet's exact commit.

| | |
|---|---|
| Decaid | `0.8.6+2801`, commit `d4721e53` (`GET /api/v1/info`) |
| Source read | `decentespresso/decaid` at `d4721e5` (same commit as the tablet) |
| Plugins installed on the tablet | time-to-ready 1.0.4, settings 0.1.8, shot-upload 0.2.2, dcamp 0.1.2, **dye2 0.1.15**, decent-profile 1.1.2, visualizer 1.5.6 |
| Machine state during tests | DE1 connected, sleeping (snapshots at ~2 Hz) |
| Spike plugin | `spike/decaid-plugin/` (id `decaid-mcp-spike.reaplugin`), installed via `PUT /source` and via `github-branch`, **uninstalled at the end** |

## Verdict: GO, with one hard constraint

Every go/no-go test passed. A plugin endpoint speaks MCP well enough for Claude
Code and the MCP Inspector, the plugin can read and write Decaid's whole API
through `fetch`, and the diagnostics compute in single-digit milliseconds.

**Constraint:** plugin JavaScript runs on Decaid's main thread. While plugin
code runs synchronously, Decaid stops. It does not serve REST requests or
other plugins, and it produces no machine telemetry. Test 3 measured a 5 s gap
in the snapshot timestamps. During a shot, that gap would be missing data in the
recording, and stop-at-weight would react late. The plugin is still feasible,
because the work it has to do is small (Test 4). But its architecture must
guarantee that every synchronous slice stays at a few milliseconds and yields
between items (`await` between shots). It must also never loop over unbounded
data.

## Results

| # | Test | Result | Measured | Consequence |
|---|------|--------|----------|-------------|
| 1 | MCP over a plugin endpoint | **Pass** | `Accept`, `Content-Type`, `Mcp-Session-Id` and custom headers arrive (names lower-cased). Status 200/202/400/404/405/204 settable; 202 and 405 with empty body. `Content-Type` and `Mcp-Session-Id` response headers set. `claude mcp list` → Connected; headless Claude Code called `ping` → `pong - Decaid 0.8.6+2801, fetched in 17 ms`. MCP Inspector CLI `tools/list` and `tools/call` OK | Streamable HTTP with plain JSON responses works. A body that is not JSON never reaches the plugin: Decaid itself answers **500** (MCP would want a -32700 parse error) |
| 2 | Plugin uses Decaid's own API | **Pass** | `http://localhost:8080`, `127.0.0.1:8080` and the tablet IP all work. Reads: info 5-17 ms, workflow 4 ms, beans 10 ms, bean-batches 8 ms, shot list (5) 105 ms, full shot 48 ms. Writes: `POST /beans` 201 in 26 ms, `PUT /beans/:id` 200 in 19 ms, `DELETE` 200 in 22 ms (GET afterwards 404), `PUT /workflow` with an unchanged value 200 in 9 ms. Read-back identical | Base URL `http://localhost:8080` (DYE2 uses the same). The `api` permission is enough, `fetch` sends JSON bodies for POST/PUT/DELETE |
| 3 | Does long computation block? | **Blocks everything** | Burn 2/5/10 s: `/machine/state` stalls for 2.1/5.1/10.2 s (baseline p50 41 ms). A parallel call to the same plugin, a call to another plugin (`settings.reaplugin/ui`) and plain `GET /info` are all served only after the burn. WebSocket `/ws/v1/machine/snapshot`: 5.0 s arrival gap **and** 5.0 s gap in frame timestamps, so no snapshots are produced, not merely delayed | Hard rule: no synchronous work beyond a few ms. Yield between shots. Bound every loop. The optional shot-under-load run was skipped on purpose: the result is already conclusive, and a real shot under load would pollute the history and risk a stop-at-weight overshoot |
| 4 | Time limit and compute cost | **Ample headroom** | Plugin HTTP timeout **30 s** (`pluginHttpTimeout`, confirmed: 29 s answers, 31 s → 500 `Plugin did not respond in time`). Puck resistance + profile compliance per shot: **7 ms** (50 repetitions averaged), `JSON.parse` 3-5 ms, fetch 36-50 ms. One shot: 61 ms total. Four shots: 211 ms sequential, 205 ms parallel. Port identical to the Python reference for all 4 shots | The full diagnostics are estimated at 3× these two metrics (compute_metrics, channeling, curve shape are linear passes of the same kind), so about 25 ms of compute per shot and about 0.3 s for a four-shot comparison. That leaves roughly 100× headroom to 30 s. **No cache needed**, and comparing four shots needs no cap |
| 5 | Metadata in the shot list | **No shot time in the list** | List entry fields: `id`, `timestamp`, `createdAt`, `updatedAt`, `workflow` (profile, context: dose, yield, grinder, setting, batch, coffee labels), `annotations` (actualDoseWeight, actualYield, enjoyment, espressoNotes, extras), `shotNotes`, `stopReason`, `metadata`. No duration field. List filters: `limit` ≤ 100, `offset`, `orderBy`, `order`, grinder, bean, batch, coffee, profile, `search`, `ids`. **No date filter.** 30 days = 146 native shots: 146 single fetches in 5.4 s, 10.9 MB (avg 76 kB). With parsing and both metrics: 6.4 s (parse 0.47 s, compute 0.85 s, largest single parse 20 ms). `createdAt − timestamp` is duration + 1.8..4.6 s and needs a UTC/local conversion | Stats with shot time need single fetches. 30 days is feasible (~6 s) but costs 11 MB of reading on the tablet. Excluding shot time from stats is the cheaper option; the operator decides (open question 1). `createdAt` is not a usable substitute |
| 6 | Size limits | **Pass** | Responses of 50 kB, 500 kB, 2 MB and 8 MB arrive complete (0.11 / 0.27 / 0.76 / 3.1 s). Requests: 1,000 KiB accepted, 1,030 KiB → **413** `Request body is too large` (`largeRequestBodyBytes` = 1 MiB). `fetch` responses are capped at 10 MiB (`maxFetchResponseBytes`). Raw curve of a real shot: 184 points, 92 kB (whole shot 95 kB) | A raw curve on request fits easily. The 8 MB response took 3.1 s, mostly synchronous `JSON.stringify`, so large responses also block. Keep responses small |
| 7 | Lifecycle and errors | **Pass; restart pending** | Globals survive between calls (counter kept) and reset on every load (`PUT /source`, enable, reinstall). Sync `throw` → 500 `{"error":"Error: …"}` in 50 ms. Rejected promise → the same. Returning `null` → no answer until the 30 s timeout. `status` not an int → 500. Object as `body` → 500 (body must be a string). 20 consecutive handler errors → plugin stays loaded. Watchdog (source): counts **load** failures only, `onLoad` has a 1 s timeout, and 3 consecutive failures disable auto-load. Recovery: `POST /plugins/:id/enable` or plugin settings. A load interrupted by an app exit disables the plugin at once | The handler must always return an object with a string body, and must catch everything. `onLoad` must be trivial and must not await network calls. Behaviour **after a Decaid restart** (globals, time until the plugin is reachable) is **not yet measured**: the operator was remote and could not restart the app. Needs one short session at the tablet; the watcher script is ready |
| 8 | Freeze data | **Pass, two schemes** | Beanie freeze + thaw on a PROBE batch writes `extras.storageEvents = [{type:"frozen",at}, {type:"thawed",at}]` and `frozen`; it does **not** set `freezeDate`/`unfreezeDate`. `freezeDate`/`unfreezeDate` alone written by API → Beanie shows "On shelf", active age 28 d (ignored). `extras.storageEvents` written by API in Beanie's format → Beanie shows "Thawed", freezer 10.09., shelf 20.09., active age 18 d (read correctly). DYE2 (source) reads and writes `freezeDate`/`unfreezeDate`. Decaid itself interprets neither (only model fields) | To keep Beanie, DYE2 and the plugin consistent, the plugin must **read** `extras.storageEvents` first and fall back to `freezeDate`/`unfreezeDate`/`frozen`. It must **write both**: the events list, plus `freezeDate`/`unfreezeDate` of the latest cycle, plus `frozen`. Existing live batches carry only `frozen` + `freezeDate` (written by DYE2 or an import) |
| 9 | Rating scale detection | **Pass** | `PUT /shots/<nonexistent>` with `enjoyment: 11` → **404** `Shot not found` on 0.8.6. The same with 5 → 404. Decaid `main` (`8975a2f`) validates the range in `shots_handler.dart` **before** the lookup (→ 400). `/api/v1/info` gives `version`, `buildNumber`, `commit`, but no release contains #887 yet, so there is nothing to map a version against | Probe by write attempt against a nonexistent id (T46), done once per plugin load and kept in a global. `/info` is not sufficient today |
| 10 | Plugin storage | **Skipped** | Not needed: neither Test 4 nor Test 5 forces a cache | – |

## Port check (Test 4)

`puck_resistance` and `profile_compliance` (with per-phase compliance) were
ported to JavaScript with the thresholds unchanged. On the four newest native
shots, the port gives results identical to `decentespresso_mcp.metrics` fed by
`decaid_mapping.series_rows_from_decaid`, compared field by field after
normalising integers to floats. Median resistance on these shots was 6.66,
5.47, 5.23 and 6.30.

One pitfall for Task 3: Python's `round()` rounds half to even, while
`Math.round` rounds half up. The test shots produced no difference, but the
parity tests have to pin this, or a helper has to mirror Python.

## Deviations between `doc/Plugins.md` and the tablet

| # | Doc says | Tablet / source 0.8.6 does |
|---|----------|----------------------------|
| D1 | "HTTP/fetch cannot reach localhost or private IPs (except for the Decaid API)" | No such check in `_performFetch`. A fetch to `192.168.1.1` was attempted and failed with a 10 s connect timeout, not with a rejection |
| D2 | Plugins "run in a sandboxed JavaScript environment" (no word on threading) | One shared `flutter_js` runtime on the app's main thread: synchronous plugin code stalls the REST server, other plugins and machine telemetry (Test 3) |
| D3 | Request `body` is the "parsed JSON request body" | A body that is not JSON is rejected by Decaid with 500 before dispatch. The Content-Type is ignored, and any body is JSON-decoded |
| D4 | Timeouts and limits not documented | Plugin HTTP response timeout 30 s → 500 `Plugin did not respond in time`. `fetch` timeout 30 s, connect timeout 10 s, `fetch` response cap 10 MiB. Request body cap 1 MiB → 413 |
| D5 | Handler "returns a response or a promise for one" | Returning `null`/`undefined` sends nothing: the client waits 30 s. `body` must be a string or the answer is 500. `status` must be an int. `headers` omitted → `text/plain; charset=utf-8` |
| D6 | Header case not documented | Request header names arrive lower-cased. Response header names are sent lower-cased |
| D7 | Install sections do not say whether a new plugin is started | Both `PUT /plugins/:id/source` (new id) and `install/github-branch` leave it `loaded:false, autoLoad:false`. `POST /enable` is required |
| D8 | "A GitHub archive … may wrap its content in one directory" | Confirmed, and it means the plugin files must sit at the branch root (or one level below). A plugin in `spike/decaid-plugin/` of a normal repo branch is not found. The spike therefore used an orphan branch |
| D9 | `storageWrite` is a "confirmation of storage write" | Its payload is the written data, without the key (source), so concurrent writes cannot be told apart. Not exercised (Test 10 skipped) |

## Open questions for Task 2

1. **Shot time in stats.** Stats with shot time need one full fetch per shot
   (about 6 s and 11 MB for 30 days). Options: (a) keep shot time, cap the
   period (for example at 200 shots) and yield between fetches; (b) drop shot
   time from stats and show it only per shot. The operator decides.
2. **Heavy tools during a shot.** Should the plugin refuse diagnostics and stats
   while the machine is in `espresso`? Or is yielding between shots enough?
   Even 20-30 ms slices during a shot are small against a sample interval of
   about 250 ms, but they are not zero.
3. **Mixed rating values on 0.8.6.** Two native shots (2026-09-16/17) carry
   4.0 and 5.0 while the rest are 40-100. Presumably DYE2 0.1.15 already
   writes 0-10 (T46). How should `update_shot` and the stats treat values ≤ 10
   while Decaid still reports the 0-100 scale?
4. **MCP sessions.** Sessions live in a global and are lost on every plugin
   reload. Should they be stateless (accept any session id, or none)? Or should
   the plugin answer 404 and rely on clients to re-initialise? Claude Code's
   re-initialise behaviour after a 404 has not been tested yet.
5. **Merging `extras` on batch writes.** Not tested yet: does `PUT
   /bean-batches/:id` with `extras` replace the whole object or merge it? If it
   replaces, `update_batch` must read, merge and write, so it does not drop
   Beanie's or other keys.
6. **Test 7 remainder.** Decaid restart: do globals reset, and how long until
   the plugin answers? Needs the operator at the tablet (about 5 minutes).
7. **Repo structure** is largely settled by the operator's choice of the new
   repo `The-Walker443/decaid-mcp`. Decaid's install rule (D8) means the
   installable plugin must live at the root of a branch or in a release ZIP.
   So releases (DYE2 pattern: a ZIP asset whose tag equals the manifest
   version) are the natural path, with the source in the repo.
8. **Invalid JSON gives 500.** MCP clients only send JSON, so this is probably
   acceptable. It should be documented.

## Live changes and restore status

| # | Entity | Change | Restore | Status |
|---|--------|--------|---------|--------|
| 1 | Plugin `decaid-mcp-spike.reaplugin` | Installed via `PUT /source` (0.0.1, then 0.0.2), enabled, removed; installed via `github-branch` (0.0.2), enabled, removed | `DELETE /plugins/:id` | Removed: plugin list back to the 7 original plugins, endpoint answers 404. Decaid may keep watchdog or auto-load preference keys for the id (not visible through the API). Plugin storage was never written |
| 2 | Bean `PROBE-spike-bean` (`f877de85…`) | Created, `notes` edited, deleted (Test 2) | `DELETE` | Gone (404). Bean list identical to the snapshot |
| 3 | Workflow | `PUT` `context.grinderSetting = "3.8"` (unchanged value) | – | Workflow JSON identical to the snapshot taken before Test 2, compared field by field after the last test |
| 4 | Shot `PROBE-does-not-exist` | 3 × `PUT` with `enjoyment` (Test 9) | – | 404, nothing stored. The 150 newest shots have unchanged `updatedAt` |
| 5 | Bean `PROBE-frost` (`46a6235f…`) with batches A `e3802476…`, B `7ad0762d…`, C `3dc23695…` | Created; B: `freezeDate`/`unfreezeDate`; C: `extras.storageEvents`; A: frozen and thawed in Beanie by the operator | `DELETE` batches, then the bean | Gone (404). Bean and batch lists identical to the snapshots |
| 6 | GitHub `The-Walker443/decaid-mcp`, branch `spike-plugin` | Orphan branch with `manifest.json` and `plugin.js` (commit `891b0aa`) | – | **Still exists** (public). It is needed to repeat the `github-branch` install and the pending restart test. Delete it after the operator signs off |
| 7 | Claude Code local config | MCP server `decaid-spike` added | `claude mcp remove` | Removed |
| 8 | Local git config of this repo | `user.name` / `user.email` set to the GitHub noreply identity (operator's choice) | – | Intended, kept |

No real shot, bean, batch or profile was written. The existing
decentespresso-mcp server and its repository were only read.
