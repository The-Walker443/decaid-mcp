// Every tool through the MCP layer against the fake Decaid: Decaid calls,
// output shape, error results, busy guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { I, setup, fixture, shotFixtures } from "./load.mjs";

const SHOTS = shotFixtures();
const BUSY = { timestamp: "2026-09-29T11:00:00.000000", state: { state: "espresso", substate: "pouring" } };
const paths = (s) => s.decaid.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);

test("tools/list names exactly the 14 tools of the architecture", async () => {
  const s = setup();
  const res = await s.mcp.handle({ method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  const names = JSON.parse(res.body).result.tools.map((t) => t.name);
  assert.deepEqual(names, ["status", "list_shots", "get_shot", "compare_shots", "stats", "list_beans", "get_batch",
    "get_workflow", "update_shot", "set_workflow", "create_bean", "update_bean", "create_batch", "update_batch"]);
});

test("status reports version, machine state and the probed scale", async () => {
  const s = setup();
  const r = await s.call("status");
  assert.equal(r.isError, false);
  assert.equal(r.data.decaid, "0.8.6+2801");
  assert.deepEqual(r.data.machine, { state: "sleeping", substate: "idle", busy: false });
  assert.equal(r.data.rating_scale, "0-100");
  assert.ok(paths(s).includes("PUT /api/v1/shots/decaid-mcp-scale-probe"));
});

test("the scale probe maps 400/enjoyment to 0-10 and anything else to unknown", async () => {
  const ten = setup({ scaleProbe: { status: 400, body: { error: "enjoyment must be between 0 and 10" } } });
  assert.equal((await ten.call("status")).data.rating_scale, "0-10");
  const odd = setup({ scaleProbe: { status: 500, body: { error: "boom" } } });
  assert.equal((await odd.call("status")).data.rating_scale, "unknown");
});

test("list_shots hides de1app shots, pages with a cursor, and has no shot time", async () => {
  const imported = { ...SHOTS[0].shot, id: "de1app-1719195732", timestamp: "2099-01-01T00:00:00.000Z" };
  const s = setup({ extraShots: [imported] });
  const first = await s.call("list_shots", { limit: 3 });
  assert.equal(first.isError, false);
  assert.equal(first.data.shots.length, 3);
  assert.ok(first.data.shots.every((x) => !x.id.startsWith("de1app-")));
  assert.ok(first.data.shots.every((x) => !("duration_s" in x)));
  assert.ok(first.data.next_cursor);
  const second = await s.call("list_shots", { limit: 20, cursor: first.data.next_cursor });
  const seen = new Set([...first.data.shots, ...second.data.shots].map((x) => x.id));
  assert.equal(seen.size, SHOTS.length);
  assert.equal(second.data.next_cursor, null);
});

test("get_shot returns diagnostics, shape, profile and no curve by default", async () => {
  const s = setup();
  const r = await s.call("get_shot", { id: SHOTS[0].id });
  assert.equal(r.isError, false);
  assert.equal(r.data.shot.id, SHOTS[0].id);
  assert.equal(typeof r.data.shot.duration_s, "number");
  assert.ok(r.data.diagnostics.channeling.risk);
  assert.ok(Array.isArray(r.data.curve_shape.segments));
  assert.ok(r.data.profile.steps.length > 0);
  assert.equal(r.data.curve, undefined);
  assert.equal(r.data.metrics.n_points, undefined);
  assert.deepEqual(paths(s), ["GET /api/v1/machine/state", "PUT /api/v1/shots/decaid-mcp-scale-probe", `GET /api/v1/shots/${SHOTS[0].id}`]);
});

test("get_shot latest, curve on request and every point with max_points 0", async () => {
  const s = setup();
  const latest = await s.call("get_shot", { id: "latest", include_curve: true, max_points: 30 });
  assert.equal(latest.data.shot.id, SHOTS[0].id);
  // Grid points may coincide, so the curve can come out shorter than asked (as in Python).
  assert.ok(latest.data.curve.t.length >= 2 && latest.data.curve.t.length <= 34);
  const all = await s.call("get_shot", { id: SHOTS[0].id, include_curve: true, max_points: 0 });
  assert.equal(all.data.curve.t.length, SHOTS[0].points);
  const bad = await s.call("get_shot", { id: SHOTS[0].id, include_curve: true, max_points: 1 });
  assert.equal(bad.isError, true);
});

test("get_shot refuses de1app ids and reports unknown ids", async () => {
  const s = setup();
  assert.match((await s.call("get_shot", { id: "de1app-123456789" })).text, /not found/);
  assert.match((await s.call("get_shot", { id: "00000000-0000-4000-8000-00000000abcd" })).text, /not found/);
});

test("compare_shots gives briefs, deltas and a profile notice", async () => {
  const s = setup();
  const ids = [SHOTS[1].id, SHOTS[4].id, SHOTS[5].id];
  const r = await s.call("compare_shots", { ids });
  assert.equal(r.isError, false);
  assert.equal(r.data.shots.length, 3);
  assert.equal(r.data.deltas_vs_first.length, 2);
  assert.ok(r.data.shots.every((x) => typeof x.shot.duration_s === "number"));
  assert.match(r.data.profile_notice, /different profiles/);
  assert.equal((await s.call("compare_shots", { ids: [SHOTS[0].id] })).isError, true);
  assert.equal((await s.call("compare_shots", { ids: [SHOTS[0].id, SHOTS[0].id] })).isError, true);
});

test("heavy tools, stats and write tools are refused while the machine is busy; light tools run", async () => {
  const s = setup({ machine: BUSY });
  for (const [name, args] of [["get_shot", { id: SHOTS[0].id }], ["compare_shots", { ids: [SHOTS[0].id, SHOTS[1].id] }],
    ["update_shot", { id: SHOTS[0].id, fields: { espressoNotes: "x" } }], ["set_workflow", { fields: { grinderSetting: "3.9" } }],
    ["create_bean", { fields: { name: "PROBE" } }], ["update_bean", { id: "x", fields: { notes: "x" } }],
    ["create_batch", { bean_id: "x", fields: { notes: "x" } }], ["update_batch", { id: "x", fields: { notes: "x" } }],
    ["stats", { period: "30d" }]]) {
    s.decaid.calls.length = 0;
    const r = await s.call(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.text, /busy \(espresso\)\. Ask again after the shot - nothing was computed or written\./, name);
    assert.ok(s.decaid.calls.every((c) => c.method === "GET" && c.path === "/api/v1/machine/state"), `${name} made other calls`);
  }
  for (const name of ["status", "list_shots", "list_beans", "get_workflow"]) {
    assert.equal((await s.call(name, {})).isError, false, name);
  }
});

test("compare_shots stops when a shot starts between two shots", async () => {
  let n = 0;
  const s = setup({ machine: () => [200, n++ === 0 ? { state: { state: "idle" } } : BUSY] });
  const r = await s.call("compare_shots", { ids: [SHOTS[0].id, SHOTS[1].id] });
  assert.equal(r.isError, true);
  assert.match(r.text, /busy/);
});

test("stats uses list metadata only, excludes maintenance and tiny yields, caps pages", async () => {
  const s = setup();
  const r = await s.call("stats", { period: "1y", compare_previous: true });
  assert.equal(r.isError, false);
  assert.ok(s.decaid.calls.every((c) => !/\/api\/v1\/shots\/[0-9a-f-]{36}$/.test(c.path)), "stats fetched a full shot");
  const tiny = SHOTS.filter((e) => (e.shot.annotations?.actualYield ?? 99) < 5).length;
  assert.equal(r.data.shots + r.data.excluded, SHOTS.length);
  assert.ok(r.data.excluded >= tiny);
  assert.ok(!("duration_s" in r.data.averages));
  assert.ok(r.data.comparison.deltas);
  assert.equal(r.data.rating_scale, "0-100");
  assert.equal((await s.call("stats", { period: "soon" })).isError, true);
});

test("stats stops at the period start", async () => {
  const s = setup({}, { now: Date.parse("2026-09-29T12:00:00") });
  const r = await s.call("stats", { period: "1d" });
  const expected = SHOTS.filter((e) => e.shot.timestamp >= "2026-09-28T12:00:00" && e.shot.timestamp <= "2026-09-29T12:00:00").length;
  assert.equal(r.data.shots + r.data.excluded, expected);
});

test("list_beans nests batches with ages and frost", async () => {
  const s = setup();
  const r = await s.call("list_beans");
  assert.equal(r.isError, false);
  const batches = r.data.beans.flatMap((b) => b.batches);
  assert.ok(batches.length > 0);
  assert.ok(batches.every((b) => "active_age_days" in b && b.frost.state));
  const all = await s.call("list_beans", { include_archived: true });
  assert.ok(all.data.beans.length >= r.data.beans.length);
});

test("get_batch gives bean, ages, frost and recent native shots", async () => {
  const s = setup();
  const batchId = SHOTS[0].shot.workflow.context.beanBatchId;
  const r = await s.call("get_batch", { id: batchId });
  assert.equal(r.isError, false);
  assert.ok(r.data.bean.name);
  assert.ok(r.data.recent_shots.length >= 1 && r.data.recent_shots.length <= 5);
  assert.equal(r.data.batch.extras, undefined);
  assert.match((await s.call("get_batch", { id: "00000000-0000-4000-8000-00000000ffff" })).text, /not found/);
});

test("get_workflow shows context, batch existence and profile", async () => {
  const s = setup();
  const r = await s.call("get_workflow");
  assert.equal(r.isError, false);
  assert.equal(typeof r.data.context.target_dose_g, "number");
  assert.equal(r.data.context.batch.exists, true);
  assert.ok(r.data.profile.title);
});

test("a Decaid that does not answer gives an error result, not a crash", async () => {
  const s = setup({ failFetch: true });
  const r = await s.call("list_beans");
  assert.equal(r.isError, true);
  assert.match(r.text, /Decaid did not answer/);
});

test("a call past the 25 s deadline ends with a result", async () => {
  const s = setup({}, { tick: 13000 }); // every clock read advances 13 s
  const r = await s.call("stats", { period: "1y" });
  assert.equal(r.isError, false);
  assert.equal(r.data.truncated, true);
  const heavy = await s.call("compare_shots", { ids: SHOTS.slice(0, 4).map((e) => e.id) });
  assert.equal(heavy.isError, true);
  assert.match(heavy.text, /time budget/);
});

test("the fixtures contain what the tests assume", () => {
  assert.ok(fixture("machine-state.json").state);
  assert.equal(fixture("errors/scale-probe.json").status, 404);
  assert.ok(I.TOOLS.length === 14);
});
