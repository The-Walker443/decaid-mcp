// Stage costs of the diagnostic pipeline relative to fixture shot-01, printed
// as JSON. Run by budget.test.mjs under `node --jitless`: without the JIT, V8
// interprets like QuickJS on the tablet, so the cost ratio between two shots
// carries over; absolute Node times do not.

import { I, shotFixtures } from "./load.mjs";

// Min of alternating runs of two functions: contention hits both alike, so
// their ratio is stable where absolute times are not.
function ratio(fn, ref, runs = 21) {
  fn(); ref();
  let a = Infinity;
  let b = Infinity;
  for (let i = 0; i < runs; i++) {
    let s = process.hrtime.bigint(); fn(); a = Math.min(a, Number(process.hrtime.bigint() - s));
    s = process.hrtime.bigint(); ref(); b = Math.min(b, Number(process.hrtime.bigint() - s));
  }
  return a / b;
}

// A real shot resampled to exactly `target` points: extra midpoints in the
// first gaps, carrying the earlier point's values. Only the cost matters.
function densify(shot, target) {
  const src = shot.measurements;
  const perGap = Math.floor((target - 1) / (src.length - 1));
  let extra = target - 1 - perGap * (src.length - 1);
  const out = [];
  for (let i = 0; i < src.length - 1; i++) {
    const ta = Date.parse(src[i].machine.timestamp.slice(0, 23) + "Z");
    const tb = Date.parse(src[i + 1].machine.timestamp.slice(0, 23) + "Z");
    const n = perGap + (extra-- > 0 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const p = JSON.parse(JSON.stringify(src[i]));
      p.machine.timestamp = new Date(ta + ((tb - ta) * k) / n).toISOString().replace("Z", "000");
      out.push(p);
    }
  }
  out.push(src[src.length - 1]);
  return { ...shot, measurements: out };
}

// One closure per stage and shot; each runs exactly one slice of that stage.
function stageFns(shot) {
  const ann = shot.annotations || {};
  const text = JSON.stringify(shot);
  const rows = I.rowsFromShot(shot);
  const metrics = I.coreMetrics(rows, ann.actualDoseWeight ?? null, ann.actualYield ?? null);
  const resistance = I.puckResistance(rows);
  const keep = [metrics.t_peak, metrics.t_max_pressure_global];
  const full = I.selectCurvePoints(rows, 0, keep);
  return {
    parse: () => JSON.parse(text),
    rows: () => I.rowBuilder(shot).next(I.ROW_CHUNK),
    metrics: () => I.coreMetrics(rows, ann.actualDoseWeight ?? null, ann.actualYield ?? null),
    puck_resistance: () => I.puckResistance(rows),
    channeling: () => I.channeling(rows, metrics, resistance),
    profile_compliance: () => I.profileCompliance(rows),
    curve_shape: () => I.curveShape(rows, metrics),
    curve_select: () => I.selectCurvePoints(rows, 400, keep),
    curve_chunk: () => I.curveBuilder(full.ordered, full.chosen).next(I.CURVE_CHUNK),
  };
}

const fixtures = shotFixtures();
const anchor = fixtures.find((e) => e.file === "shot-01.json");
const anchorFns = stageFns(anchor.shot);
const relative = (shot) => {
  const fns = stageFns(shot);
  const out = Object.fromEntries(Object.keys(fns).map((k) => [k, ratio(fns[k], anchorFns[k])]));
  // On shot-01 the selection has nothing to do (183 points fit into 400), so
  // it cannot anchor itself; it is measured against shot-01's rows chunk.
  out.curve_select = ratio(fns.curve_select, anchorFns.rows);
  return out;
};
const longest = fixtures.reduce((a, b) => (b.points > a.points ? b : a));
const dense = densify(longest.shot, 600);
const result = {
  anchor: anchor.file,
  shots: fixtures.map((e) => ({ file: e.file, points: e.points, relative: relative(e.shot) })),
  dense: { points: dense.measurements.length, relative: relative(dense) },
};
process.stdout.write(JSON.stringify(result));
