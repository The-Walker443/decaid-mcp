// Tablet acceptance of the main-thread budget (ARCHITECTURE §6.1, §9.4).
// Polls GET /api/v1/machine/state every 50 ms while MCP tool calls run, and
// reports the longest stall (gap between two answers beyond the poll
// interval) together with the plugin's own slice log from `status`.
//
//   node tools/load-probe.mjs [http://tablet:8080]

const HOST = process.argv[2] || "http://10.100.100.171:8080";
const MCP = `${HOST}/api/v1/plugins/decaid-mcp.reaplugin/mcp`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 0;
async function tool(name, args) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args || {} } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  if (body.result.isError) throw new Error(`${name}: ${body.result.content[0].text}`);
  return body.result.structuredContent;
}

async function measure(label, work) {
  const answers = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const s = Date.now();
      try { await fetch(`${HOST}/api/v1/machine/state`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()); } catch {}
      answers.push([s, Date.now()]);
      await sleep(Math.max(0, 50 - (Date.now() - s)));
    }
  })();
  await sleep(500);
  const started = Date.now();
  const result = await work();
  const ended = Date.now();
  await sleep(300);
  polling = false;
  await poller;
  const during = answers.filter(([s]) => s >= started && s <= ended);
  const latency = during.map(([s, e]) => e - s).sort((a, b) => a - b);
  const baseline = answers.filter(([s]) => s < started).map(([s, e]) => e - s).sort((a, b) => a - b);
  const status = await tool("status");
  return {
    label,
    call_ms: ended - started,
    polls: during.length,
    baseline_p50_ms: baseline[baseline.length >> 1] ?? null,
    during_p50_ms: latency[latency.length >> 1] ?? null,
    during_max_ms: latency[latency.length - 1] ?? null,
    plugin_max_slice_ms: status.last_heavy_call ? status.last_heavy_call.max_slice_ms : null,
    plugin_max_slice_stage: status.last_heavy_call ? status.last_heavy_call.max_slice_stage : null,
    plugin_slices: status.last_heavy_call ? status.last_heavy_call.slices : null,
    result,
  };
}

const list = await tool("list_shots", { limit: 4 });
const ids = list.shots.map((s) => s.id);
const runs = [
  await measure("get_shot latest + full curve", async () => (await tool("get_shot", { id: ids[0], include_curve: true, max_points: 0 })).shot.id),
  await measure("compare_shots x4", async () => (await tool("compare_shots", { ids })).shots.length),
  await measure("stats 90d", async () => (await tool("stats", { period: "90d" })).shots),
  await measure("stats 1y + previous", async () => { const r = await tool("stats", { period: "1y", compare_previous: true }); return { shots: r.shots, truncated: !!r.truncated }; }),
];
for (const r of runs) console.log(JSON.stringify(r));
