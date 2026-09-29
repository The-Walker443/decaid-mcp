# Task 3 report: core implementation

Implementation of [ARCHITECTURE.md](ARCHITECTURE.md) as approved, 2026-09-29,
against Decaid `0.8.6+2801` on the operator's tablet.

| | |
|---|---|
| Plugin | `decaid-mcp.reaplugin` 0.1.0, one hand-written `plugin.js` (2374 lines) plus `manifest.json` at the repo root |
| Installed from | branch `stable` at `0b3b7f9`, via `github-branch`, enabled, currently **running** on the tablet |
| Tests | 94 in Node (`node --test --test-concurrency=1 "test/*.test.mjs"`), green locally and in GitHub Actions |
| Branches | `main` = `stable` = `task-3-core` at `0b3b7f9`. `stable` is protected (check `test` required, no force push, no deletion) |

## Result

All 14 tools work end to end through Claude Code against the tablet. The
diagnostics compute the same numbers as the Python server on ten real shots,
field by field. On the tablet, the plugin never held Decaid's main thread for
more than **6 ms** at a time. Several points of the tablet acceptance need the
operator at the machine and are still open (§5).

## 1. Deviations from ARCHITECTURE.md

| # | Architecture says | Implemented | Why |
|---|-------------------|-------------|-----|
| A1 | Budget test with a Node-to-tablet factor of 4.5 (§6.1) | Stage costs are measured under `node --jitless` **relative to fixture shot-01**, in alternating runs, and multiplied by the stage maxima measured on the tablet for that same shot | The tablet showed that 4.5 is wrong. The spike's factor compared warm JIT code. For single passes, the real ratio is 7-15 depending on the stage, and absolute Node times on a busy notebook swing by a factor of 2. Ratios between two shots in the same process are stable (three consecutive runs agree to ±5 %) |
| A2 | One slice per pipeline stage | `rows` and the curve arrays are built in **chunks of 150 points** (`ROW_CHUNK`, `CURVE_CHUNK`) | On the tablet `rows` costs about 0.026 ms per point, so a 600-point shot would take about 15 ms in one piece. Chunked, every stage of a 600-point shot is estimated ≤ 9.8 ms. The longest real shot in the archive has 280 points |
| A3 | Slices are the time between two pauses | Time spent waiting for a `fetch` is **excluded** (`slicer.suspend()`/`resume()`) | The first tablet run reported 87-98 ms slices. That was network waiting, which does not block Decaid |
| A4 | `stats` is a light tool and runs while the machine is busy (§6.2) | `stats` is **refused while busy** | Operator decision after measurement: Decaid itself stalls about 200 ms per 20-shot list page it serves, also without the plugin (see §3) |
| A5 | Acceptance: "longest stall ≤ 25 ms" (§9.4, item 2) | Restated: **the plugin's longest slice ≤ 10 ms** (measured: 6 ms). Decaid's own stall while serving a list page is outside the plugin's control | Stalls of 190-205 ms during `stats` came from Decaid serving the pages. A direct fetch of the same pages, without the plugin, stalled 223 ms |
| A6 | `writes.py` sends dates as `YYYY-MM-DD` | Dates are written as **midnight UTC** (`2026-09-01T00:00:00.000Z`) | That is how DYE2 and the existing batches store them. Dart's `DateTime.parse` of a bare date gives local midnight without a zone, which would be a third format |
| A7 | `stats` excludes maintenance profiles by name and yields < 5 g (`stats.py`) | Also excludes `beverage_type` `cleaning`/`calibrate` | The same intent, and a more reliable signal than the name. Decaid does not store such shots anyway (T49) |
| A8 | Scale probe on the first `update_shot` or `status` | Also on the first `list_shots`, `get_shot`, `compare_shots`, `stats` or `get_batch` | Those show ratings with the scale. The probe is one `PUT` to a nonexistent id, once per plugin load. It writes nothing |
| A9 | `status` reports `last_max_slice_ms` | Reports `last_heavy_call` and `last_calls` (the timing of each tool's last call, with the maximum per stage) | Needed to calibrate A1, and useful on any tablet |
| A10 | – | JSON-RPC **responses** from a client (no `method`, with `result`/`error`) get 202 | MCP transport rule. Before, they would have been answered 400 |
| A11 | Tests `node --test` | `--test-concurrency=1` | The budget measurement wants a quiet CPU. The CI workflow uses the same command |
| A12 | Branch protection requires CI for `stable` | Required for pushes and merges, but **not enforced for admins** | GitHub's `enforce_admins` is off, so the owner can still push directly. It can be switched on in the repo settings |

## 2. Parity with the Python server

- `tools/python-reference.py` runs decentespresso-mcp's `metrics.py` and
  `decaid_mapping.py` on the ten fixture shots. It writes `test/golden/`.
- The test compares, field by field: `rows`, all metrics with warnings,
  `puck_resistance`, `channeling`, `profile_compliance` with phases,
  `curve_shape`, and the downsampled curves at 60 and 400 points. **All
  identical.**
- The reference was the operator's **working tree** of decentespresso-mcp. It
  includes uncommitted changes (`db.py`, `decaid_mapping.py`, `guards.py`,
  `server.py`, `sync.py`, new `freezing.py`), which were imported only and not
  modified. Regenerating the golden files after the operator commits or
  reverts them would show any drift.
- Python's `round()` (ties to even, on the exact binary value) is reproduced
  exactly:
  - a fast path, plus an exact decimal path near ties;
  - pinned by fixed cases and by a 200,000-value property test against an
    independent exact reference.

## 3. Measurements on the tablet

**Plugin slices.** From the plugin's own log in `status`, `tools/load-probe.mjs`:

| Call | Duration | Longest plugin slice |
|------|----------|----------------------|
| `get_shot` latest with full raw curve | 229 ms | 5 ms |
| `compare_shots` × 4 | 434 ms | 6 ms |
| `stats 90d` (144 shots) | 2,128 ms | 6 ms |
| `stats 1y` + previous period | 2,187 ms | 6 ms |

**Stage times** for the real shot behind fixture shot-01 (183 points, 12
runs; median / max in ms):

| parse | rows (150-pt chunk) | metrics | puck_resistance | channeling | profile_compliance | curve_shape | curve chunk |
|-------|---------------------|---------|-----------------|------------|--------------------|-------------|-------------|
| 4 / 5 | 5 / 6 | 2 / 4 | 3 / 4 | 2 / 2 | 2 / 3 | 2 / 3 | 2 / 2 |

A 30-shot sweep (88-263 points) gave `rows` about 0.026 ms per point. Every
other stage stayed at ≤ 5 ms.

**Decaid's own cost of serving the shot list**, measured without the plugin:

| Page size | Time per page | Longest `/machine/state` stall |
|-----------|---------------|--------------------------------|
| 5 | 89 ms | 104 ms |
| 10 | 131 ms | 156 ms |
| 20 | 235 ms | 163-223 ms |
| 50 | 510 ms | 409 ms |

So each shot on a list page costs Decaid about 8 ms of main-thread time. This
affects every client that lists shots (skins, DYE2, this plugin). It led to A4.

**Clock.** The plugin's local time equals the tablet's local time (a `stats
12h` window ended at the second of `/machine/state`'s timestamp; the shot
count matched).

## 3a. Findings for the architecture

| # | Finding |
|---|---------|
| F7 | Decaid spends about 8 ms of main-thread time per shot on a list page it serves (table above), independent of the plugin |
| F8 | Tablet/Node ratio for single-pass interpreted code is 7-15 per stage (`--jitless` Node), not 4.3 |
| F9 | `PUT /shots/:id` with `annotations.espressoNotes: null` clears the note (the key is absent afterwards). `updatedAt` moves, and the metadata (Visualizer link, upload markers) stays |
| F10 | `github-branch` from a branch that also contains `spike/decaid-plugin/manifest.json` installs the root plugin. The root manifest wins, as the source says. The whole archive (docs, tests, fixtures, about 2 MB) is copied into the plugin directory |

## 4. Tablet acceptance (ARCHITECTURE §9.4)

| # | Item | Status |
|---|------|--------|
| 1 | `setTimeout(0)` yields to Decaid | **Passed.** `/machine/state` kept answering during every heavy call (worst 56-70 ms against a 37 ms baseline during `get_shot`/`compare_shots`), and the plugin's slices stayed ≤ 6 ms |
| 2 | Load probe during `compare_shots` × 4 and `stats` | **Passed** with the restated criterion (A5): the plugin's slices were ≤ 6 ms |
| 3 | Every tool once through Claude Code in the LAN | **Passed.** A headless Claude Code run called all 8 read tools and all 6 write tools. Every call returned OK |
| 4 | Write tools on PROBE objects with snapshot, read-back and cleanup | **Passed.** Every read-back matched (`not_taken` empty everywhere). Details in §6 |
| 5 | Busy guard with a real shot | **Open.** The operator was away. Node tests cover it, including the race between two shots |
| 6 | `/machine/state` without a connected DE1 | **Open** (needs the DE1 switched off) |
| 7 | Plugin local time equals tablet local time | **Passed** (§3) |
| 8 | Install from `stable`, enable, connect, update, uninstall | **Install, enable, connect: passed** (2.1 s). Update-after-merge is checked at the next release. Uninstall was already verified in the spike |
| + | Beanie shows the frost data the plugin wrote | **Open.** The data format was verified by read-back and matches what Beanie wrote in spike Test 8. The on-screen check needs the operator |
| + | Decaid restart (spike Test 7 remainder, for the ops doc) | **Open** |

## 5. Open, needs the operator at the tablet

About 10 minutes in one session:

1. **Beanie check**: create a PROBE batch with a freeze and a thaw through the
   plugin, and look at it in Beanie (and in DYE2). Then delete it.
2. **Busy guard**: pull a shot, or run a rinse. Meanwhile call `get_shot`,
   `update_shot` and `stats` (all must be refused) and `list_shots` (must
   answer).
3. **Without the DE1**: switch it off and call `status` and `get_shot`.
4. **Restart**: force-close Decaid and reopen it. Measure the time until the
   plugin answers, and confirm that it comes back on its own (`autoLoad`). The
   README section on autostart gets the result.

After that, delete the `spike-plugin` branch (operator decision, Task 1).

## 6. Live changes

| # | Entity | Change | Restore | Status |
|---|--------|--------|---------|--------|
| 1 | Plugin `decaid-mcp.reaplugin` | Installed via `PUT /source` (0.1.0, several revisions during tuning), enabled. Later removed and **reinstalled from `stable`** | – | **Installed and running** (from `stable` `0b3b7f9`, `autoLoad` on). This is the deliverable. Its endpoint is open on the LAN, like the rest of Decaid's API |
| 2 | Bean `PROBE-extras` + batch (Task 2 carry-over) | – | – | Already deleted in Task 2 |
| 3 | Bean `PROBE-accept` (`3f8c0ebf…`) and batch `PROBE-accept-batch` (`1a641fc5…`) | Created. Notes edited. Frozen on 22.09. and thawed on 25.09. through the plugin | `DELETE` both | Deleted (404). Bean and batch lists identical to the snapshot taken before the write tests |
| 4 | Workflow | `set_workflow` to grind 3.4 + the PROBE batch, then back to grind 3.3 + batch `ed9be6f8…` (Keilberg Espresso / KUCHA) | Field by field | Identical to the snapshot taken right before (whole JSON compared) |
| 5 | Real shot `690f5371…` (2026-09-06, rating 50, no note), with the operator's approval | `update_shot` rating 55 + note, then rating 50 + note cleared | Exact values | Rating 50, note absent, metadata unchanged. **`updatedAt` now 2026-09-29T11:40:36Z** (was 2026-09-06). The Visualizer plugin may have forwarded both edits to visualizer.coffee; the net state there is the original rating |
| 6 | Scale probe | `PUT /shots/decaid-mcp-scale-probe` (nonexistent id), once per plugin load | – | Nothing is stored (404) |
| 7 | GitHub | Branches `task-3-core`, `main` (fast-forwarded), `stable` (new) pushed. Branch protection on `stable` | – | Intended |
| 8 | Claude Code local config | MCP server `decaid` added for this project | `claude mcp remove decaid` | **Kept** for the pending acceptance items |

No real bean, batch or profile was written. The only real shot written is
item 5, with the operator's approval.
