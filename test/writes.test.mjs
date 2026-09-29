// Write tools: validation, guard, read-before, one write, read-back,
// T28/T29, extras merge, both frost formats, the rating scale.

import { test } from "node:test";
import assert from "node:assert/strict";
import { I, setup, fixture, shotFixtures } from "./load.mjs";

const SHOTS = shotFixtures();
const writes = (s) => s.decaid.calls.filter((c) => c.method !== "GET" && !c.path.includes("scale-probe"));

test("update_shot writes rating and note in one PUT and reads back", async () => {
  const s = setup();
  const id = SHOTS[0].id;
  const r = await s.call("update_shot", { id, fields: { enjoyment: 75, espressoNotes: "PROBE note" } });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.data.changed.sort(), ["enjoyment", "espressoNotes"]);
  assert.deepEqual(r.data.not_taken, []);
  assert.equal(r.data.rating_scale, "0-100");
  const w = writes(s);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], { method: "PUT", path: `/api/v1/shots/${id}`, body: { annotations: { enjoyment: 75, espressoNotes: "PROBE note" } } });
  const again = await s.call("update_shot", { id, fields: { enjoyment: 75 } });
  assert.deepEqual(again.data.unchanged, ["enjoyment"]);
});

test("ratings follow the tablet's scale; 1-10 is refused on 0-100", async () => {
  const s = setup();
  const id = SHOTS[0].id;
  assert.match((await s.call("update_shot", { id, fields: { enjoyment: 8 } })).text, /cannot be told from a 0-10 rating/);
  assert.match((await s.call("update_shot", { id, fields: { enjoyment: 101 } })).text, /outside the range 0 to 100/);
  assert.match((await s.call("update_shot", { id, fields: { enjoyment: 75.5 } })).text, /not a whole number/);
  assert.equal((await s.call("update_shot", { id, fields: { enjoyment: 0 } })).isError, false);

  const ten = setup({ scaleProbe: { status: 400, body: { error: "enjoyment must be between 0 and 10" } } });
  assert.equal((await ten.call("update_shot", { id, fields: { enjoyment: 8.5 } })).isError, false);
  assert.match((await ten.call("update_shot", { id, fields: { enjoyment: 8.55 } })).text, /more than one decimal/);
  assert.match((await ten.call("update_shot", { id, fields: { enjoyment: 11 } })).text, /outside the range 0 to 10/);

  const unknown = setup({ scaleProbe: { status: 500, body: {} } });
  assert.match((await unknown.call("update_shot", { id, fields: { enjoyment: 50 } })).text, /could not be determined/);
  assert.equal((await unknown.call("update_shot", { id, fields: { espressoNotes: "x" } })).isError, false);
});

test("update_shot refuses blocked and unknown fields, all at once, before writing", async () => {
  const s = setup();
  const r = await s.call("update_shot", { id: SHOTS[0].id, fields: { actualYield: 36, workflow: {}, colour: "red" } });
  assert.equal(r.isError, true);
  assert.match(r.text, /actualYield: not writable/);
  assert.match(r.text, /workflow: not writable/);
  assert.match(r.text, /colour: unknown field/);
  assert.equal(writes(s).length, 0);
  assert.match((await s.call("update_shot", { id: "de1app-1719195732", fields: { espressoNotes: "x" } })).text, /not found/);
});

test("set_workflow writes coffee labels with the batch (T28) and checks it exists (T29)", async () => {
  const s = setup();
  const batch = fixture("bean-batches.json").find((b) => !b.archived);
  const bean = fixture("beans.json").find((b) => b.id === batch.beanId);
  const r = await s.call("set_workflow", { fields: { beanBatchId: batch.id, grinderSetting: "3,9", targetDoseWeight: "18,5" } });
  assert.equal(r.isError, false, r.text);
  const put = writes(s).find((c) => c.path === "/api/v1/workflow");
  assert.deepEqual(put.body.context, {
    beanBatchId: batch.id, grinderSetting: "3,9", targetDoseWeight: 18.5, coffeeName: bean.name, coffeeRoaster: bean.roaster,
  });
  assert.deepEqual(r.data.not_taken, []);

  const missing = await s.call("set_workflow", { fields: { beanBatchId: "00000000-0000-4000-8000-00000000ffff" } });
  assert.match(missing.text, /not found/);
  assert.equal(writes(s).length, 1);
});

test("set_workflow refuses profile selection and out-of-range targets", async () => {
  const s = setup();
  const r = await s.call("set_workflow", { fields: { profileId: "profile:abc", coffeeName: "x", targetYield: 300, targetDoseWeight: null } });
  assert.match(r.text, /profileId: not writable/);
  assert.match(r.text, /coffeeName: not writable/);
  assert.match(r.text, /targetYield: 300 g is outside/);
  assert.equal(writes(s).length, 0);
  assert.match((await s.call("set_workflow", { fields: { targetYield: null } })).text, /cannot be cleared/);
});

test("create_bean and update_bean validate, write once and read back", async () => {
  const s = setup();
  assert.match((await s.call("create_bean", { fields: { roaster: "PROBE" } })).text, /name: required/);
  const c = await s.call("create_bean", { fields: { name: "PROBE-bean", roaster: "PROBE", variety: "Heirloom, 74110", altitude: [1800, 2100], decaf: "false" } });
  assert.equal(c.isError, false, c.text);
  const created = s.decaid.store.beans.get(c.data.id);
  assert.deepEqual(created.variety, ["Heirloom", "74110"]);
  const u = await s.call("update_bean", { id: c.data.id, fields: { notes: "PROBE edited", archived: true } });
  assert.match(u.text, /archived: not writable/);
  const u2 = await s.call("update_bean", { id: c.data.id, fields: { notes: "PROBE edited" } });
  assert.deepEqual(u2.data.changed, ["notes"]);
  assert.match((await s.call("create_bean", { fields: { name: "x", altitude: [3000, 1000] } })).text, /lower value first/);
});

test("batch dates are validated and stored as midnight UTC", async () => {
  const s = setup();
  const bean = fixture("beans.json")[0];
  const bad = await s.call("create_batch", { bean_id: bean.id, fields: { roastDate: "01.09.2026", buyDate: "2099-01-01" } });
  assert.match(bad.text, /roastDate: .*not an ISO date/);
  assert.match(bad.text, /buyDate: .*lies in the future/);
  const ok = await s.call("create_batch", { bean_id: bean.id, fields: { roastDate: "2026-09-01", bestBeforeDate: "2027-03-01", weight: 250 } });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(s.decaid.store.batches.get(ok.data.id).roastDate, "2026-09-01T00:00:00.000Z");
  assert.equal(ok.data.frost.state, "ambient");
  assert.match((await s.call("create_batch", { bean_id: "nope", fields: { weight: 250 } })).text, /not found/);
});

test("frost is written in both formats and extras keys of others survive", async () => {
  const s = setup();
  const bean = fixture("beans.json")[0];
  const c = await s.call("create_batch", { bean_id: bean.id, fields: { roastDate: "2026-09-01" }, frost: { type: "frozen", at: "2026-09-10T08:00:00.000Z" } });
  assert.equal(c.isError, false, c.text);
  const id = c.data.id;
  let b = s.decaid.store.batches.get(id);
  assert.deepEqual(b.extras.storageEvents, [{ type: "frozen", at: "2026-09-10T08:00:00.000Z" }]);
  assert.equal(b.freezeDate, "2026-09-10T08:00:00.000Z");
  assert.equal(b.frozen, true);

  // Another writer's key in extras must survive our PUT (Decaid replaces extras whole).
  b.extras.otherPlugin = { keep: 1 };
  const t = await s.call("update_batch", { id, frost: { type: "thawed", at: "2026-09-20" } });
  assert.equal(t.isError, false, t.text);
  b = s.decaid.store.batches.get(id);
  assert.deepEqual(b.extras.otherPlugin, { keep: 1 });
  assert.deepEqual(b.extras.storageEvents.map((e) => e.type), ["frozen", "thawed"]);
  // A bare date takes the current UTC time of day (the fake clock), as Beanie does.
  assert.equal(b.extras.storageEvents[1].at, new Date(s.deps.now()).toISOString().replace(/^.{10}/, "2026-09-20"));
  assert.equal(b.unfreezeDate, b.extras.storageEvents[1].at);
  assert.equal(b.freezeDate, "2026-09-10T08:00:00.000Z");
  assert.equal(b.frozen, false);
  assert.equal(t.data.frost.source, "events");
  assert.equal(t.data.frost.conflict, undefined);

  // Thawing again re-times the latest thaw instead of adding one.
  const again = await s.call("update_batch", { id, frost: { type: "thawed", at: "2026-09-21T10:00:00Z" } });
  assert.equal(again.isError, false, again.text);
  assert.deepEqual(s.decaid.store.batches.get(id).extras.storageEvents.map((e) => e.at), ["2026-09-10T08:00:00.000Z", "2026-09-21T10:00:00.000Z"]);
  assert.match((await s.call("update_batch", { id, fields: { frozen: true } })).text, /frozen: not writable/);
  assert.match((await s.call("update_batch", { id, frost: { type: "frozen", at: "2099-01-01T00:00:00Z" } })).text, /future/);
  assert.match((await s.call("update_batch", { id, frost: { type: "frozen", at: "2026-08-01T00:00:00Z" } })).text, /before the roast date/);
});

test("the latest event of the same type is re-timed, not duplicated (Beanie semantics)", () => {
  const batch = { roastDate: "2026-09-01T00:00:00.000Z", frozen: true, freezeDate: "2026-09-10T08:00:00.000Z",
    extras: { storageEvents: [{ type: "frozen", at: "2026-09-10T08:00:00.000Z" }] } };
  const w = I.frostWrite(batch, "frozen", "2026-09-11", Date.parse("2026-09-29T09:30:00Z"));
  assert.deepEqual(w.extras.storageEvents, [{ type: "frozen", at: "2026-09-11T08:00:00.000Z" }]);
  assert.equal(w.freezeDate, "2026-09-11T08:00:00.000Z");
  assert.throws(() => I.frostWrite({ roastDate: "2026-09-01T00:00:00.000Z" }, "thawed", null, Date.now()), /not frozen/);
});

test("frost read rule: events, then fields, then the flag; conflicts are shown", () => {
  const now = Date.parse("2026-09-29T09:30:00Z");
  const a = fixture("batches-extra/batchA_after.json"); // frozen and thawed in Beanie (events only)
  const b = fixture("batches-extra/batchB_after.json"); // DYE2-style fields only
  const c = fixture("batches-extra/batchC_after.json"); // events 10.09.-20.09.

  const fa = I.frostOf(a);
  assert.equal(fa.source, "events");
  assert.equal(fa.state, "thawed");

  const fb = I.batchAges(b, now);
  assert.equal(fb.frost.source, "fields");
  assert.equal(fb.roast_age_days, 28);
  assert.equal(fb.active_age_days, 18);

  // Beanie showed 28 d roast age and 18 d active age for batch C (spike Test 8).
  const fc = I.batchAges(c, now);
  assert.equal(fc.frost.source, "events");
  assert.equal(fc.roast_age_days, 28);
  assert.equal(fc.active_age_days, 18);

  const both = { ...c, freezeDate: "2026-09-01T00:00:00.000Z", unfreezeDate: "2026-09-05T00:00:00.000Z" };
  const fx = I.frostOf(both);
  assert.equal(fx.source, "events");
  assert.equal(fx.conflict, true);
  const agree = { ...c, freezeDate: "2026-09-10T00:00:00.000Z", unfreezeDate: "2026-09-20T00:00:00.000Z" };
  assert.equal(I.frostOf(agree).conflict, undefined);

  assert.deepEqual(I.frostOf({ frozen: true }), { state: "frozen", source: "flag", certain: false, periods: [] });
  assert.equal(I.frostOf({ frozen: false, freezeDate: "2026-09-10T00:00:00.000Z" }).certain, false);
  assert.equal(I.frostOf({}).state, "ambient");
});

test("write outcome separates changed, unchanged and not taken", () => {
  const o = I.writeOutcome({ a: 1, b: "x", c: "2026-09-01T00:00:00.000Z" }, { a: 1, b: "y" }, { a: 1, b: "x", c: "2026-09-02T00:00:00.000Z" });
  assert.deepEqual(o.unchanged, ["a"]);
  assert.deepEqual(o.changed, ["b"]);
  assert.deepEqual(o.not_taken, ["c"]);
});
