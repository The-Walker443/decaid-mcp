// Main-thread budget (ARCHITECTURE §6.1).
//
// Node cannot measure tablet time, and absolute times on a busy notebook or
// CI runner are noise. So the test is anchored on the tablet: TABLET_MS are
// the stage maxima measured there for the real shot behind fixture shot-01
// (183 points; 12 runs of get_shot, Decaid 0.8.6, 2026-09-29, the plugin's own
// slice log). budget-measure.mjs measures, under `node --jitless`, how much
// more work each stage does on another shot than on shot-01 - alternating
// runs, so machine load cancels out - and the estimate is anchor x ratio.
//
// Measured medians on the tablet for shot-01 were parse 4, rows 5, metrics 2,
// puck_resistance 3, channeling 2, profile_compliance 2, curve_shape 2,
// curve select 0, curve chunk 2 ms; the maxima below are the conservative
// anchor. (The spike's factor 4.3 compared warm JIT code and does not hold
// for single passes; a uniform factor overstated some stages 3x.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { I, setup, shotFixtures } from "./load.mjs";

const TABLET_MS = {
  parse: 5, rows: 6, metrics: 4, puck_resistance: 4, channeling: 2,
  profile_compliance: 3, curve_shape: 3, curve_select: 1, curve_chunk: 2,
};
const ATOMIC_BUDGET_MS = 20;

const measured = (() => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "budget-measure.mjs");
  const run = spawnSync(process.execPath, ["--jitless", "--no-warnings", script], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`budget-measure failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
})();

// curve_select is relative to shot-01's rows chunk (see budget-measure.mjs).
const ANCHOR_OF = { curve_select: "rows" };
const estimate = (relative) => Object.fromEntries(Object.entries(relative).map(([k, r]) => [k, r * TABLET_MS[ANCHOR_OF[k] || k]]));

function check(relative, limit, label) {
  const report = [];
  for (const [name, ms] of Object.entries(estimate(relative))) {
    if (name === "parse") continue;
    report.push(`${name} ${ms.toFixed(1)}`);
    assert.ok(ms <= limit, `${label}: stage ${name} estimated ${ms.toFixed(2)} ms on the tablet (limit ${limit})`);
  }
  return report.join(", ");
}

test("every stage of every fixture shot stays within the 10 ms ceiling", (t) => {
  for (const { file, points, relative } of measured.shots) {
    t.diagnostic(`${file} (${points} pts): ${check(relative, I.SLICE_CEILING_MS, file)}`);
  }
});

test("a 600-point shot stays within the 10 ms ceiling", (t) => {
  assert.equal(measured.dense.points, 600);
  t.diagnostic(`600 pts: ${check(measured.dense.relative, I.SLICE_CEILING_MS, "600-point shot")}`);
});

test("the atomic parse of one Decaid response stays within 20 ms", () => {
  for (const { file, relative } of [...measured.shots, { file: "600-point shot", relative: measured.dense.relative }]) {
    const ms = relative.parse * TABLET_MS.parse;
    assert.ok(ms <= ATOMIC_BUDGET_MS, `${file}: parse estimated ${ms.toFixed(2)} ms`);
  }
});

test("the 5 ms target holds for the median stage of a typical shot", (t) => {
  const all = measured.shots.filter((e) => e.points >= 100 && e.points <= 250)
    .flatMap((e) => Object.entries(estimate(e.relative)).filter(([n]) => n !== "parse").map(([, ms]) => ms)).sort((a, b) => a - b);
  const med = all[all.length >> 1];
  t.diagnostic(`median stage ${med.toFixed(1)} ms, worst ${all[all.length - 1].toFixed(1)} ms`);
  assert.ok(med <= I.SLICE_TARGET_MS, `median stage estimated ${med.toFixed(2)} ms`);
});

test("heavy tools pause between every stage, shot and page", async () => {
  // Every pause is a setTimeout(0) in the fake deps; each stage and each
  // Decaid response is followed by one.
  const s = setup();
  const ids = shotFixtures().slice(0, 4).map((e) => e.id);

  const one = await s.call("get_shot", { id: ids[0], include_curve: true });
  assert.equal(one.isError, false);
  // guard, scale probe, shot fetch = 3 responses; 7 stages with the curve.
  assert.ok(s.state.lastHeavy.slices >= 3 + 7, `get_shot: ${s.state.lastHeavy.slices} slices`);

  s.pauses.length = 0;
  const many = await s.call("compare_shots", { ids });
  assert.equal(many.isError, false);
  // Per shot: guard + fetch + 6 stages (the scale is already known).
  assert.ok(s.pauses.length >= 4 * (2 + 6), `compare_shots: ${s.pauses.length} pauses`);
  assert.ok(s.pauses.every((ms) => ms === 0));

  s.pauses.length = 0;
  const stats = await s.call("stats", { period: "1y" });
  assert.equal(stats.isError, false);
  const pages = s.decaid.calls.filter((c) => c.path.startsWith("/api/v1/shots?limit=20")).length;
  assert.ok(s.pauses.length >= pages * 2, `stats: ${s.pauses.length} pauses for ${pages} pages`);
});

test("a slice over the ceiling is logged with its stage", async () => {
  let clock = 0;
  const deps = { now: () => clock, setTimeout: (fn) => setImmediate(fn) };
  const slicer = I.createSlicer(deps, "test");
  slicer.stage("slow stage");
  clock += 12;
  await slicer.pause();
  const timing = slicer.finish();
  assert.equal(timing.max_slice_ms, 12);
  assert.equal(timing.max_slice_stage, "slow stage");
  assert.deepEqual(timing.over_ceiling, ["slow stage 12 ms"]);
});
