// Capture test fixtures from a live Decaid, read-only, and anonymise them.
//
//   node tools/capture-fixtures.mjs [http://tablet:8080] [--extra dir]
//
// Only GET requests plus one probe PUT to a shot id that cannot exist (the
// rating-scale probe, which Decaid answers without writing anything).
// Anonymisation: ids -> stable fake UUIDs, bean/roaster/coffee names ->
// generic names, free text cleared, machine serial and Visualizer links
// dropped. Numbers, states and timestamps are kept, because the metrics
// depend on them.
//
// --extra dir adds every *.json in dir as a raw batch fixture (used for the
// Beanie-written PROBE batches of the spike, Test 8).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("http")) || "http://10.100.100.171:8080") + "/api/v1";
const extraIdx = args.indexOf("--extra");
const EXTRA = extraIdx >= 0 ? args[extraIdx + 1] : null;
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..", "test", "fixtures");

async function get(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------- anonymise

const idMap = new Map();
function fakeId(real) {
  if (!idMap.has(real)) {
    const h = crypto.createHash("sha256").update("decaid-mcp-fixture:" + real).digest("hex");
    idMap.set(real, `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`);
  }
  return idMap.get(real);
}

const names = new Map();
function generic(kind, real) {
  if (real === null || real === undefined || real === "") return real;
  const key = kind + ":" + real;
  if (!names.has(key)) names.set(key, `${kind} ${[...names.keys()].filter((k) => k.startsWith(kind + ":")).length + 1}`);
  return names.get(key);
}

const ID_KEYS = new Set(["id", "beanId", "beanBatchId", "grinderId", "basketId", "parentId"]);
const TEXT_KEYS = new Set(["espressoNotes", "shotNotes", "notes", "description", "note"]);
const DROP_KEYS = new Set(["serialNumber", "visualizerId", "derek", "derekTweak"]);
const NAME_KEYS = { name: "Bean", roaster: "Roaster", coffeeName: "Bean", coffeeRoaster: "Roaster",
  producer: "Producer", region: "Region" };

function scrub(value, parentKey, inProfile) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, parentKey, inProfile));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEYS.has(k)) continue;
    const profile = inProfile || k === "profile";
    if (ID_KEYS.has(k) && typeof v === "string" && !profile && !v.startsWith("profile:")) out[k] = fakeId(v);
    else if (TEXT_KEYS.has(k) && typeof v === "string" && !profile) out[k] = v ? "(note)" : v;
    else if (k in NAME_KEYS && typeof v === "string" && !profile && parentKey !== "steps") out[k] = generic(NAME_KEYS[k], v);
    else if (k === "author" && profile) out[k] = v;
    else out[k] = scrub(v, k, profile);
  }
  return out;
}

// Profile titles can carry the coffee's name ("Roaster - Bean"). Replace
// known real names inside every string afterwards.
function replaceNames(obj) {
  let text = JSON.stringify(obj);
  const pairs = [...names.entries()].map(([k, v]) => [k.slice(k.indexOf(":") + 1), v])
    .filter(([real]) => real.length > 3).sort((a, b) => b[0].length - a[0].length);
  for (const [real, fake] of pairs) text = text.split(JSON.stringify(real).slice(1, -1)).join(fake);
  return JSON.parse(text);
}

function write(name, data) {
  fs.mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(replaceNames(data), null, 1) + "\n");
  console.log("wrote", name);
}

// ---------------------------------------------------------------- capture

const pages = [];
for (let offset = 0; ; offset += 100) {
  const page = (await get(`/shots?limit=100&offset=${offset}&orderBy=timestamp&order=desc`)).body;
  pages.push(...page.items);
  if (offset + 100 >= page.total) break;
}
const native = pages.filter((s) => !s.id.startsWith("de1app-"));

// Pick shots that cover the paths the metrics take.
const picks = new Map();
const pick = (why, shot) => { if (shot && !picks.has(shot.id)) picks.set(shot.id, why); };
const byTitle = (t) => native.filter((s) => s.workflow?.profile?.title === t);
pick("latest", native[0]);
for (const title of [...new Set(native.map((s) => s.workflow?.profile?.title))]) pick(`profile ${title}`, byTitle(title)[0]);
pick("machineEnded", native.find((s) => s.stopReason === "machineEnded"));
pick("no or tiny yield", native.find((s) => s.annotations?.actualYield == null || s.annotations.actualYield < 5));
pick("rated low", native.filter((s) => typeof s.annotations?.enjoyment === "number" && s.annotations.enjoyment > 10)
  .sort((a, b) => a.annotations.enjoyment - b.annotations.enjoyment)[0]);

const shots = [];
for (const [id, why] of picks) {
  const detail = (await get(`/shots/${id}`)).body;
  shots.push({ why, points: detail.measurements?.length || 0, detail });
}
// The longest recording, for the budget test.
const longest = shots.reduce((a, b) => (b.points > a.points ? b : a));
longest.why += " (longest)";

for (const [i, s] of shots.entries()) {
  write(`shots/shot-${String(i + 1).padStart(2, "0")}.json`, scrub(s.detail));
}
write("shots/index.json", shots.map((s, i) => ({ file: `shot-${String(i + 1).padStart(2, "0")}.json`,
  id: fakeId(s.detail.id), why: s.why, points: s.points })));

// List pages: the newest page, and the page where native and imported meet.
const firstImport = pages.findIndex((s) => s.id.startsWith("de1app-"));
const boundaryOffset = Math.max(0, Math.floor((firstImport - 10) / 20) * 20);
for (const [name, offset] of [["list-page-newest.json", 0], ["list-page-boundary.json", boundaryOffset]]) {
  const page = (await get(`/shots?limit=20&offset=${offset}&orderBy=timestamp&order=desc`)).body;
  write(name, scrub(page));
}
write("shots-latest.json", scrub((await get("/shots/latest")).body));

write("beans.json", scrub((await get("/beans")).body));
write("bean-batches.json", scrub((await get("/bean-batches")).body));
write("workflow.json", scrub((await get("/workflow")).body));
write("machine-state.json", (await get("/machine/state")).body);
const info = (await get("/info")).body;
delete info.localIp;
write("info.json", info);

// Error answers.
write("errors/shot-404.json", await get("/shots/00000000-0000-4000-8000-000000000000"));
write("errors/batch-404.json", await get("/bean-batches/00000000-0000-4000-8000-000000000000"));
const probe = await fetch(BASE + "/shots/decaid-mcp-scale-probe", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ annotations: { enjoyment: 11 } }),
});
write("errors/scale-probe.json", { status: probe.status, body: await probe.json().catch(() => null) });

if (EXTRA) {
  for (const f of fs.readdirSync(EXTRA).filter((f) => f.endsWith(".json"))) {
    write(`batches-extra/${f}`, scrub(JSON.parse(fs.readFileSync(path.join(EXTRA, f), "utf8"))));
  }
}
