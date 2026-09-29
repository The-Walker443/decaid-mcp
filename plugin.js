// Throwaway spike plugin: measures whether an MCP server can live inside Decaid.
// Every endpoint exists to answer one question of docs/plugin-spike/REPORT.md.
// Not product code - no validation beyond what a measurement needs.

function createPlugin(host) {
  "use strict";

  const PLUGIN_ID = "decaid-mcp-spike.reaplugin";
  const DEFAULT_BASE = "http://localhost:8080";

  // Test 7: survives between calls? Reset on every load.
  const life = {
    loadedAt: new Date().toISOString(),
    loadCount: 0,
    calls: 0,
  };

  function log(msg) {
    host.log(`[${PLUGIN_ID}] ${msg}`);
  }

  function json(status, body, headers) {
    return {
      status,
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(body),
    };
  }

  // ------------------------------------------------------------ Test 1: MCP

  const PROTOCOL_VERSION = "2025-06-18";
  const sessions = {};

  const TOOLS = [
    {
      name: "ping",
      description: "Spike test tool. Answers pong with the Decaid version it can see.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  function rpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
  }

  function header(request, name) {
    const headers = request.headers || {};
    const wanted = name.toLowerCase();
    for (const key in headers) {
      if (key.toLowerCase() === wanted) return headers[key];
    }
    return undefined;
  }

  function newSessionId() {
    let out = "";
    for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }

  async function handleMcp(request) {
    if (request.method === "GET") {
      // No server-initiated SSE stream.
      return { status: 405, headers: { Allow: "POST, DELETE" }, body: "" };
    }
    if (request.method === "DELETE") {
      const sid = header(request, "mcp-session-id");
      if (sid) delete sessions[sid];
      return { status: 200, headers: {}, body: "" };
    }
    if (request.method !== "POST") {
      return { status: 405, headers: { Allow: "POST, DELETE" }, body: "" };
    }

    const msg = request.body;
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
      return json(400, rpcError(null, -32600, "Invalid Request"));
    }

    const isNotification = msg.id === undefined;
    const sid = header(request, "mcp-session-id");

    if (msg.method === "initialize") {
      const id = newSessionId();
      sessions[id] = { createdAt: Date.now() };
      const requested = msg.params && msg.params.protocolVersion;
      return json(200, rpcResult(msg.id, {
        protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "decaid-mcp-spike", version: "0.0.2" },
      }), { "Mcp-Session-Id": id });
    }

    // Spec: requests after initialize must carry the session id; 400 without it,
    // 404 for an unknown one.
    if (!sid) return json(400, rpcError(msg.id, -32600, "Missing Mcp-Session-Id"));
    if (!sessions[sid]) return json(404, rpcError(msg.id, -32600, "Unknown session"));

    if (isNotification) {
      return { status: 202, headers: {}, body: "" };
    }

    if (msg.method === "ping") return json(200, rpcResult(msg.id, {}));
    if (msg.method === "tools/list") return json(200, rpcResult(msg.id, { tools: TOOLS }));
    if (msg.method === "tools/call") {
      const name = msg.params && msg.params.name;
      if (name !== "ping") return json(200, rpcError(msg.id, -32602, `Unknown tool: ${name}`));
      const started = Date.now();
      const info = await (await fetch(`${DEFAULT_BASE}/api/v1/info`)).json();
      return json(200, rpcResult(msg.id, {
        content: [{
          type: "text",
          text: `pong - Decaid ${info.fullVersion}, fetched in ${Date.now() - started} ms`,
        }],
        isError: false,
      }));
    }
    return json(200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
  }

  // ------------------------------------------- Test 1 (raw): echo request

  function handleEcho(request) {
    const q = request.query || {};
    const status = q.status ? parseInt(q.status, 10) : 200;
    const extra = {};
    if (q.hdr) extra[q.hdr] = q.hdrval || "x";
    if (q.ct) extra["Content-Type"] = q.ct;
    if (q.empty) return { status, headers: extra, body: "" };
    return json(status, {
      method: request.method,
      endpoint: request.endpoint,
      requestId: request.requestId,
      headers: request.headers,
      query: request.query,
      body: request.body,
      bodyType: request.body === null ? "null" : typeof request.body,
    }, extra);
  }

  // ------------------------------------------- Test 2: call Decaid's own API

  async function handleCall(request) {
    // Body: {base?, path, method?, body?}  or a list of these, run in order.
    const input = request.body;
    const list = Array.isArray(input) ? input : [input];
    const out = [];
    for (const c of list) {
      const url = (c.base || DEFAULT_BASE) + c.path;
      const init = { method: c.method || "GET", headers: {} };
      if (c.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(c.body);
      }
      const started = Date.now();
      try {
        const res = await fetch(url, init);
        const text = await res.text();
        const entry = {
          url, method: init.method, status: res.status, ms: Date.now() - started,
          bytes: text.length, contentType: res.headers.get("content-type"),
        };
        if (c.keep !== false) {
          try { entry.json = JSON.parse(text); } catch (e) { entry.text = text.slice(0, 500); }
        }
        out.push(entry);
      } catch (e) {
        out.push({ url, method: init.method, error: String(e), ms: Date.now() - started });
      }
    }
    return json(200, out);
  }

  // ------------------------------------------- Test 3: synchronous CPU load

  function handleBurn(request) {
    const ms = parseInt((request.query || {}).ms || "2000", 10);
    const started = Date.now();
    let n = 0;
    let x = 0;
    while (Date.now() - started < ms) {
      for (let i = 0; i < 10000; i++) x += Math.sqrt(i * n);
      n++;
    }
    return json(200, { burnedMs: Date.now() - started, loops: n, x: x > 0 });
  }

  // ---------------------------------------- Test 4: timeout, without blocking

  function handleSleep(request) {
    const ms = parseInt((request.query || {}).ms || "1000", 10);
    const started = Date.now();
    return new Promise((resolve) => {
      setTimeout(() => resolve(json(200, { sleptMs: Date.now() - started })), ms);
    });
  }

  // ------------------------------------------------- Test 6: response size

  function handleSize(request) {
    const kb = parseInt((request.query || {}).kb || "50", 10);
    const chunk = "0123456789abcdef".repeat(64); // 1 KiB
    const parts = [];
    for (let i = 0; i < kb; i++) parts.push(chunk);
    const payload = parts.join("");
    const received = request.body ? JSON.stringify(request.body).length : 0;
    return json(200, { kb, receivedBytes: received, payload, end: "END" });
  }

  // ---------------------------------------------- Test 7: lifecycle, errors

  function handleLife() {
    life.calls++;
    return json(200, Object.assign({ now: new Date().toISOString() }, life));
  }

  function handleFail(request) {
    const mode = (request.query || {}).mode || "throw";
    if (mode === "throw") throw new Error("spike: synchronous throw");
    if (mode === "reject") return Promise.reject(new Error("spike: rejected promise"));
    if (mode === "null") return null;                       // no response at all
    if (mode === "badstatus") return { status: "abc", body: "x" };
    if (mode === "objbody") return { status: 200, headers: {}, body: { not: "a string" } };
    if (mode === "nobody") return { status: 200 };
    if (mode === "hang") return new Promise(() => {});
    return json(400, { error: `unknown mode ${mode}` });
  }

  // ------------------------------------------------- Test 10: host.storage

  const pendingReads = {};
  const pendingWrites = [];

  function storageRead(key) {
    return new Promise((resolve) => {
      (pendingReads[key] = pendingReads[key] || []).push(resolve);
      host.storage({ type: "read", key, namespace: PLUGIN_ID });
    });
  }

  function storageWrite(key, data) {
    return new Promise((resolve) => {
      pendingWrites.push(resolve);
      host.storage({ type: "write", key, namespace: PLUGIN_ID, data });
    });
  }

  async function handleStore(request) {
    const q = request.query || {};
    const key = q.key || "probe";
    if (request.method === "POST") {
      const kb = parseInt(q.kb || "1", 10);
      const data = { kb, payload: "x".repeat(kb * 1024), writtenAt: new Date().toISOString() };
      const started = Date.now();
      await storageWrite(key, data);
      return json(200, { key, kb, writeMs: Date.now() - started });
    }
    const started = Date.now();
    const value = await storageRead(key);
    return json(200, {
      key,
      readMs: Date.now() - started,
      found: value !== null && value !== undefined,
      kb: value && value.kb,
      bytes: value && value.payload ? value.payload.length : 0,
      writtenAt: value && value.writtenAt,
    });
  }

  // ------------------------------------------- Test 4: metrics port (two)

  // Thresholds copied unchanged from decentespresso-mcp metrics.py.
  const SETTLE_TOLERANCE_BAR = 0.6;
  const SETTLE_DELAY_S = 4.0;
  const MIN_SETTLED_POINTS = 8;
  const MIN_RESISTANCE_FLOW = 0.4;
  const RESISTANCE_BANDS = [[1.0, "very_low"], [2.5, "low"], [5.0, "moderate"], [9.0, "high"]];
  const TREND_STEEP_DECLINE = -0.45;
  const TREND_FLAT = 0.15;
  const COMPLIANCE_PRESSURE_GOOD = 0.25;
  const COMPLIANCE_PRESSURE_NOTABLE = 0.50;
  const COMPLIANCE_FLOW_GOOD = 0.30;
  const COMPLIANCE_FLOW_NOTABLE = 0.70;
  const TEMP_OFF_TARGET_C = 1.0;
  const TEMP_NOTABLE_C = 2.0;
  const START_MARKER_MAX_S = 0.5;

  // Decaid timestamps carry microseconds and no zone; only differences matter.
  function tsSeconds(value) {
    if (typeof value !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(value);
    if (!m) return null;
    const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
    return base + (m[7] ? parseFloat("0." + m[7]) : 0);
  }

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function rowsFromShot(shot) {
    const ms = shot.measurements || [];
    const stamps = ms.map((p) => tsSeconds(p.machine && p.machine.timestamp));
    const base = stamps.find((s) => s !== null);
    const seen = {};
    const rows = [];
    for (let i = 0; i < ms.length; i++) {
      const elapsed = base === undefined || stamps[i] === null ? 0 : Math.round((stamps[i] - base) * 1000) / 1000;
      if (seen[elapsed]) continue;
      seen[elapsed] = true;
      const m = ms[i].machine || {};
      const s = ms[i].scale || {};
      const st = m.state || {};
      rows.push({
        elapsed,
        pressure: num(m.pressure),
        flow_in: num(m.flow),
        temp_mix: num(m.mixTemperature),
        temp_basket: num(m.groupTemperature),
        target_pressure: num(m.targetPressure),
        target_flow: num(m.targetFlow),
        target_temp_basket: num(m.targetGroupTemperature),
        profile_frame: m.profileFrame === undefined ? null : m.profileFrame,
        weight: num(s.weight),
        flow_out: num(s.weightFlow),
        state: st.state || null,
        substate: st.substate || null,
      });
    }
    return rows;
  }

  function mean(v) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
  function median(v) {
    if (!v.length) return null;
    const s = v.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function round(v, d) { return v === null ? null : Math.round(v * 10 ** d) / 10 ** d; }
  function band(value, edges, above) {
    for (const [edge, name] of edges) if (value < edge) return name;
    return above;
  }

  function controlMode(r) {
    const hp = r.target_pressure !== null && r.target_pressure > 0.5;
    const hf = r.target_flow !== null && r.target_flow > 0.1;
    if (hp && !hf) return "pressure";
    if (hf && !hp) return "flow";
    return null;
  }

  function settledWindow(rows) {
    let start = null;
    for (const r of rows) {
      if (r.pressure === null || r.target_pressure === null || r.target_pressure <= 1.0) continue;
      if (Math.abs(r.pressure - r.target_pressure) <= SETTLE_TOLERANCE_BAR) { start = r.elapsed; break; }
    }
    if (start === null) return [];
    const w = rows.filter((r) => (r.elapsed || 0) >= start + SETTLE_DELAY_S);
    return w.length >= MIN_SETTLED_POINTS ? w : [];
  }

  function theilSen(points) {
    const n = points.length;
    if (n < 4) return null;
    const step = Math.max(1, Math.floor(n / 40));
    const slopes = [];
    for (let i = 0; i < n; i += step) {
      for (let j = i + step; j < n; j += step) {
        const dt = points[j][0] - points[i][0];
        if (dt > 0.5) slopes.push((points[j][1] - points[i][1]) / dt);
      }
    }
    return slopes.length ? median(slopes) : null;
  }

  function trendBand(t) {
    if (t === null) return null;
    if (t <= TREND_STEEP_DECLINE) return "steep_decline";
    if (t < -TREND_FLAT) return "declining";
    if (t > TREND_FLAT) return "rising";
    return "steady";
  }

  function puckResistance(rows) {
    const w = settledWindow(rows);
    if (!w.length) return null;
    const points = [];
    for (const r of w) {
      if (r.pressure === null || r.flow_in === null || r.elapsed === null) continue;
      if (r.flow_in < MIN_RESISTANCE_FLOW || r.pressure <= 0) continue;
      points.push([r.elapsed, r.pressure / (r.flow_in * r.flow_in)]);
    }
    if (points.length < MIN_SETTLED_POINTS) return null;
    const med = median(points.map((p) => p[1]));
    const trend = theilSen(points);
    return {
      median: round(med, 2),
      band: band(med, RESISTANCE_BANDS, "very_high"),
      trend_per_s: trend === null ? null : round(trend, 3),
      trend: trendBand(trend),
      from_s: round(points[0][0], 1),
      to_s: round(points[points.length - 1][0], 1),
      n_points: points.length,
    };
  }

  function phaseCompliance(rows) {
    const groups = [];
    let current = [];
    let frame = {};
    for (const r of rows) {
      if (r.profile_frame !== frame) {
        if (current.length) groups.push(current);
        current = [];
        frame = r.profile_frame;
      }
      current.push(r);
    }
    if (current.length) groups.push(current);

    const out = [];
    for (const g of groups) {
      const times = g.map((r) => r.elapsed || 0);
      if (g.length < 2 || times[times.length - 1] < START_MARKER_MAX_S) continue;
      const subs = Array.from(new Set(g.map((r) => r.substate).filter(Boolean))).sort();
      const modes = Array.from(new Set(g.map(controlMode).filter(Boolean))).sort();
      const e = {
        frame: g[0].profile_frame,
        from_s: round(times[0], 1),
        to_s: round(times[times.length - 1], 1),
        duration_s: round(times[times.length - 1] - times[0], 1),
        substates: subs.length ? subs : null,
        n_points: g.length,
        holds: modes.length ? modes : null,
      };
      for (const [channel, key, tkey, d] of [["pressure", "pressure", "target_pressure", 1], ["flow", "flow_in", "target_flow", 2]]) {
        const values = g.map((r) => r[key]).filter((v) => v !== null);
        const devs = g.filter((r) => controlMode(r) === channel && r[key] !== null && r[tkey] !== null)
          .map((r) => Math.abs(r[key] - r[tkey]));
        if (values.length) e[`${channel}_mean`] = round(mean(values), d);
        if (devs.length) e[`${channel}_deviation`] = round(mean(devs), 3);
      }
      const temps = g.map((r) => r.temp_basket).filter((v) => v !== null);
      if (temps.length) e.temp_basket_mean = round(mean(temps), 1);
      out.push(e);
    }
    return out;
  }

  function profileCompliance(rows) {
    const w = settledWindow(rows);
    if (!w.length) return null;
    const pd = w.filter((r) => controlMode(r) === "pressure" && r.pressure !== null && r.target_pressure !== null)
      .map((r) => Math.abs(r.pressure - r.target_pressure));
    const fd = w.filter((r) => controlMode(r) === "flow" && r.flow_in !== null && r.target_flow !== null)
      .map((r) => Math.abs(r.flow_in - r.target_flow));
    const td = w.filter((r) => r.temp_basket !== null && r.target_temp_basket !== null)
      .map((r) => r.temp_basket - r.target_temp_basket);
    const res = { phases: phaseCompliance(rows) };
    if (pd.length) {
      const mad = mean(pd);
      res.pressure = { mean_abs_deviation: round(mad, 3), band: band(mad, [[COMPLIANCE_PRESSURE_GOOD, "close"], [COMPLIANCE_PRESSURE_NOTABLE, "loose"]], "off"), n_points: pd.length };
    }
    if (fd.length) {
      const mad = mean(fd);
      res.flow = { mean_abs_deviation: round(mad, 3), band: band(mad, [[COMPLIANCE_FLOW_GOOD, "close"], [COMPLIANCE_FLOW_NOTABLE, "loose"]], "off"), n_points: fd.length };
    }
    if (td.length) {
      const md = mean(td);
      const worst = td.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
      res.temperature = {
        mean_deviation: round(md, 2), max_deviation: round(worst, 2),
        band: Math.abs(md) < TEMP_OFF_TARGET_C ? "on_target" : (Math.abs(md) < TEMP_NOTABLE_C ? "off_target" : "notable"),
        direction: md < 0 ? "below" : "above", n_points: td.length,
      };
    }
    return res;
  }

  async function handleMetrics(request) {
    const q = request.query || {};
    const ids = (q.ids || "").split(",").filter(Boolean);
    const repeat = parseInt(q.repeat || "1", 10);
    const parallel = q.parallel === "1";
    const t0 = Date.now();
    const load = async (id) => {
      const s = Date.now();
      const res = await fetch(`${DEFAULT_BASE}/api/v1/shots/${encodeURIComponent(id)}`);
      const text = await res.text();
      const f = Date.now();
      const shot = JSON.parse(text);
      return { id, shot, bytes: text.length, fetchMs: f - s, parseMs: Date.now() - f };
    };
    const loaded = parallel ? await Promise.all(ids.map(load)) : [];
    if (!parallel) for (const id of ids) loaded.push(await load(id));
    const t1 = Date.now();
    const results = loaded.map((l) => {
      const s = Date.now();
      let rows, pr, pc;
      for (let i = 0; i < repeat; i++) {
        rows = rowsFromShot(l.shot);
        pr = puckResistance(rows);
        pc = profileCompliance(rows);
      }
      return {
        id: l.id, bytes: l.bytes, points: rows.length, fetchMs: l.fetchMs, parseMs: l.parseMs,
        computeMs: Date.now() - s, repeat,
        puck_resistance: pr, profile_compliance: q.full ? pc : (pc && { pressure: pc.pressure, flow: pc.flow, temperature: pc.temperature, n_phases: pc.phases.length }),
      };
    });
    return json(200, { totalMs: Date.now() - t0, loadMs: t1 - t0, computeMs: Date.now() - t1, parallel, results });
  }

  // ------------------------------------------------------------- dispatch

  const ROUTES = {
    mcp: handleMcp, echo: handleEcho, call: handleCall, burn: handleBurn, sleep: handleSleep,
    size: handleSize, life: handleLife, fail: handleFail, metrics: handleMetrics, store: handleStore,
  };

  return {
    id: PLUGIN_ID,
    version: "0.0.2",

    onLoad() {
      life.loadCount++;
      log(`loaded at ${life.loadedAt}`);
    },

    onUnload() {
      log("unloaded");
    },

    onEvent(event) {
      if (event.name === "storageRead") {
        const waiting = pendingReads[event.payload.key] || [];
        const resolve = waiting.shift();
        if (resolve) resolve(event.payload.value);
      } else if (event.name === "storageWrite") {
        const resolve = pendingWrites.shift();
        if (resolve) resolve();
      }
    },

    __httpRequestHandler(request) {
      const route = ROUTES[request.endpoint];
      if (!route) return json(404, { error: `no route ${request.endpoint}` });
      return route(request);
    },
  };
}
