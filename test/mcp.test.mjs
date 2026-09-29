// MCP protocol layer and the plugin entry point (__httpRequestHandler).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlugin, setup } from "./load.mjs";

const rpc = (body) => ({ method: "POST", endpoint: "mcp", headers: { "content-type": "application/json" }, query: {}, body });

test("initialize negotiates the version, is stateless and carries instructions", async () => {
  const s = setup();
  for (const [asked, expected] of [["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"], ["2099-01-01", "2025-06-18"], [undefined, "2025-06-18"]]) {
    const res = await s.mcp.handle(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "application/json");
    assert.equal(res.headers["Mcp-Session-Id"], undefined);
    const r = JSON.parse(res.body).result;
    assert.equal(r.protocolVersion, expected);
    assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
    assert.match(r.instructions, /UNITS/);
  }
});

test("notifications and client responses get 202 with an empty body", async () => {
  const s = setup();
  for (const body of [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 7, result: {} }]) {
    const res = await s.mcp.handle(rpc(body));
    assert.equal(res.status, 202);
    assert.equal(res.body, "");
  }
});

test("GET and DELETE get 405, batches and junk get 400, unknown methods -32601", async () => {
  const s = setup();
  for (const method of ["GET", "DELETE"]) {
    const res = await s.mcp.handle({ method, endpoint: "mcp", headers: {}, query: {}, body: null });
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, "POST");
  }
  for (const body of [[{ jsonrpc: "2.0", id: 1, method: "ping" }], null, { id: 1, method: "ping" }, "text"]) {
    const res = await s.mcp.handle(rpc(body));
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.code, -32600);
  }
  const unknown = JSON.parse((await s.mcp.handle(rpc({ jsonrpc: "2.0", id: 2, method: "resources/list" }))).body);
  assert.equal(unknown.error.code, -32601);
  const ping = JSON.parse((await s.mcp.handle(rpc({ jsonrpc: "2.0", id: 3, method: "ping" }))).body);
  assert.deepEqual(ping.result, {});
  const tool = JSON.parse((await s.mcp.handle(rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }))).body);
  assert.equal(tool.error.code, -32602);
});

test("tool results carry structuredContent and the same JSON as text; errors are isError", async () => {
  const s = setup();
  const ok = JSON.parse((await s.mcp.handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } }))).body).result;
  assert.equal(ok.isError, false);
  assert.deepEqual(JSON.parse(ok.content[0].text), ok.structuredContent);
  const bad = JSON.parse((await s.mcp.handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_batch", arguments: {} } }))).body).result;
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].type, "text");
});

test("tools/list carries schemas and annotations", async () => {
  const s = setup();
  const tools = JSON.parse((await s.mcp.handle(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).body).result.tools;
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    assert.ok(t.description.length > 20, t.name);
  }
  const writes = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
  assert.deepEqual(writes, ["update_shot", "set_workflow", "create_bean", "update_bean", "create_batch", "update_batch"]);
});

test("the plugin entry point always answers with a string body", async () => {
  const logs = [];
  const plugin = createPlugin({ log: (m) => logs.push(m) });
  assert.equal(plugin.id, "decaid-mcp.reaplugin");
  plugin.onLoad({});
  assert.match(logs[0], /loaded/);

  const other = await plugin.__httpRequestHandler({ endpoint: "other", method: "GET" });
  assert.equal(other.status, 404);
  assert.equal(typeof other.body, "string");

  const init = await plugin.__httpRequestHandler(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  assert.equal(init.status, 200);
  assert.equal(typeof init.body, "string");

  // A broken request object must not throw out of the handler.
  const broken = await plugin.__httpRequestHandler(null);
  assert.equal(typeof broken.body, "string");
});

test("manifest and plugin agree on id and version", async () => {
  const fs = await import("node:fs");
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const plugin = createPlugin({ log() {} });
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.version, plugin.version);
  assert.deepEqual(manifest.permissions, ["log", "api"]);
  assert.deepEqual(manifest.api, [{ id: "mcp", type: "http", data: {} }]);
});
