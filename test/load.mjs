// Loads the shipped plugin.js exactly as Decaid gets it, plus a fake Decaid
// over the fixtures for tool tests.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, "..");
export const FIXTURES = path.join(here, "fixtures");
export const GOLDEN = path.join(here, "golden");

const source = fs.readFileSync(path.join(ROOT, "plugin.js"), "utf8");
export const createPlugin = new Function(`${source}; return createPlugin;`)();
export const I = createPlugin.internals;

export function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

export function shotFixtures() {
  return fixture("shots/index.json").map((e) => ({ ...e, shot: fixture(`shots/${e.file}`) }));
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

// A fake Decaid with the behaviour measured on 0.8.6 (spike report, F1-F4).
export function fakeDecaid(options = {}) {
  const shots = shotFixtures().map((e) => clone(e.shot));
  const extraList = options.extraShots || [];
  const all = [...shots, ...extraList].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const store = {
    shots: new Map(all.map((s) => [s.id, s])),
    order: all.map((s) => s.id),
    beans: new Map(fixture("beans.json").map((b) => [b.id, b])),
    batches: new Map([...fixture("bean-batches.json"), ...(options.extraBatches || [])].map((b) => [b.id, b])),
    workflow: fixture("workflow.json"),
    machine: options.machine || { timestamp: "2026-09-29T11:00:00.000000", state: { state: "sleeping", substate: "idle" } },
    scaleProbe: options.scaleProbe || { status: 404, body: { error: "Shot not found" } },
  };
  const calls = [];
  let nextId = 1;
  const newId = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const meta = (s) => { const c = clone(s); delete c.measurements; return c; };

  function route(method, url, body) {
    const u = new URL(url);
    const p = u.pathname;
    const q = u.searchParams;
    let m;
    if (method === "GET" && p === "/api/v1/info") return [200, fixture("info.json")];
    if (method === "GET" && p === "/api/v1/machine/state") return typeof store.machine === "function" ? store.machine() : [200, store.machine];
    if (method === "GET" && p === "/api/v1/workflow") return [200, store.workflow];
    if (method === "PUT" && p === "/api/v1/workflow") {
      if (body.context) deepMerge(store.workflow.context, body.context);
      return [200, store.workflow];
    }
    if (method === "GET" && p === "/api/v1/shots/latest") return [200, meta(store.shots.get(store.order[0]))];
    if (method === "GET" && p === "/api/v1/shots") {
      let ids = store.order;
      if (q.get("beanBatchId")) ids = ids.filter((id) => store.shots.get(id).workflow?.context?.beanBatchId === q.get("beanBatchId"));
      const limit = Math.min(100, Number(q.get("limit") || 20));
      const offset = Number(q.get("offset") || 0);
      return [200, { items: ids.slice(offset, offset + limit).map((id) => meta(store.shots.get(id))), total: ids.length, limit, offset }];
    }
    if ((m = /^\/api\/v1\/shots\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      if (method === "PUT" && id === "decaid-mcp-scale-probe") return [store.scaleProbe.status, store.scaleProbe.body];
      const shot = store.shots.get(id);
      if (!shot) return [404, { error: "Shot not found" }];
      if (method === "GET") return [200, shot];
      if (method === "PUT") { deepMerge(shot, body); return [200, shot]; }
    }
    if (method === "GET" && p === "/api/v1/beans") return [200, [...store.beans.values()]];
    if (method === "POST" && p === "/api/v1/beans") {
      const bean = { id: newId(), ...body, decaf: body.decaf || false, archived: false };
      store.beans.set(bean.id, bean);
      return [201, bean];
    }
    if ((m = /^\/api\/v1\/beans\/([^/]+)$/.exec(p))) {
      const bean = store.beans.get(decodeURIComponent(m[1]));
      if (!bean) return [404, { error: "Bean not found" }];
      if (method === "GET") return [200, bean];
      if (method === "PUT") { Object.assign(bean, body); return [200, bean]; }
    }
    if ((m = /^\/api\/v1\/beans\/([^/]+)\/batches$/.exec(p)) && method === "POST") {
      const batch = { id: newId(), beanId: decodeURIComponent(m[1]), frozen: false, archived: false, ...body };
      store.batches.set(batch.id, batch);
      return [201, batch];
    }
    if (method === "GET" && p === "/api/v1/bean-batches") return [200, [...store.batches.values()]];
    if ((m = /^\/api\/v1\/bean-batches\/([^/]+)$/.exec(p))) {
      const batch = store.batches.get(decodeURIComponent(m[1]));
      if (!batch) return [404, { error: "Batch not found" }];
      if (method === "GET") return [200, batch];
      if (method === "PUT") {
        // Top-level fields patch-merge; `extras` is replaced whole; null clears (F1).
        for (const [k, v] of Object.entries(body)) { if (v === null) delete batch[k]; else batch[k] = clone(v); }
        return [200, batch];
      }
    }
    return [404, { error: `no route ${method} ${p}` }];
  }

  async function fetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.replace(/^https?:\/\/[^/]+/, ""), body });
    if (options.failFetch) throw new Error("connection refused");
    const [status, json] = route(method, url, body);
    const text = json === undefined ? "" : JSON.stringify(json);
    return { status, text: async () => text };
  }

  return { store, calls, fetch };
}

// deps for createTools/createMcp: fake Decaid, counted pauses, a clock.
export function makeDeps(decaid, opts = {}) {
  const pauses = [];
  const logs = [];
  let clock = opts.now || Date.parse("2026-09-30T12:00:00"); // local time, after every fixture
  return {
    pauses,
    logs,
    deps: {
      base: "http://localhost:8080",
      fetch: decaid.fetch,
      setTimeout: (fn, ms) => { pauses.push(ms); setImmediate(fn); },
      now: () => (opts.tick ? (clock += opts.tick) : clock),
      log: (m) => logs.push(m),
    },
  };
}

// Calls a tool through the MCP layer and returns {isError, data|text}.
export async function callTool(mcp, name, args) {
  const res = await mcp.handle({ method: "POST", endpoint: "mcp", headers: {}, query: {}, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args || {} } } });
  const body = JSON.parse(res.body);
  if (body.error) return { rpcError: body.error };
  const r = body.result;
  return r.isError ? { isError: true, text: r.content[0].text } : { isError: false, data: r.structuredContent };
}

export function setup(options = {}, depOpts = {}) {
  const decaid = fakeDecaid(options);
  const { deps, pauses, logs } = makeDeps(decaid, depOpts);
  const state = { scale: null, lastHeavy: null };
  const mcp = I.createMcp(deps, state);
  return { decaid, deps, pauses, logs, state, mcp, call: (n, a) => callTool(mcp, n, a) };
}

// Removes the sign of zero so Python's -0.0 and JS's 0 compare equal.
export function normalize(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (Object.is(v, -0) ? 0 : v)));
}
