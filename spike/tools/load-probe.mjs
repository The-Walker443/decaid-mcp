// Test 3: does a synchronous CPU loop inside a plugin block Decaid?
// While /burn?ms=N runs, measure from outside:
//   - GET /api/v1/machine/state every 200 ms (latency, stalls)
//   - /ws/v1/machine/snapshot frames (arrival delay relative to frame timestamp)
//   - a second call to this plugin, to another plugin, and to plain REST
// Usage: node load-probe.mjs [burnMs ...]   (default 2000 5000 10000)

const HOST = process.env.DECAID || "http://10.100.100.171:8080";
const PLUGIN = `${HOST}/api/v1/plugins/decaid-mcp-spike.reaplugin`;
const burns = process.argv.slice(2).map(Number).filter(Boolean);
if (!burns.length) burns.push(2000, 5000, 10000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timed(url, init) {
  const s = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(40000), ...init });
    await res.text();
    return { ms: Date.now() - s, status: res.status, at: s };
  } catch (e) {
    return { ms: Date.now() - s, status: "ERR " + e.name, at: s };
  }
}

// Tablet timestamps are local time without a zone: parse as UTC and let the
// constant clock offset fall out by subtracting the baseline minimum.
function tabletMs(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?/.exec(ts);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + (m[7] ? parseFloat(m[7]) * 1000 : 0);
}

function stats(values) {
  if (!values.length) return { n: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

async function run(burnMs) {
  const wsFrames = [];
  const ws = new WebSocket(`${HOST.replace("http", "ws")}/ws/v1/machine/snapshot`);
  ws.onmessage = (e) => {
    try { wsFrames.push({ arrived: Date.now(), offset: Date.now() - tabletMs(JSON.parse(e.data).timestamp) }); } catch {}
  };
  await sleep(1500);

  const polls = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const started = Date.now();
      polls.push(await timed(`${HOST}/api/v1/machine/state`));
      await sleep(Math.max(0, 200 - (Date.now() - started)));
    }
  })();

  await sleep(2000); // baseline
  const burnStart = Date.now();
  const burn = timed(`${PLUGIN}/burn?ms=${burnMs}`);
  await sleep(300);
  const [second, otherPlugin, rest] = await Promise.all([
    timed(`${PLUGIN}/life`),
    timed(`${HOST}/api/v1/plugins/settings.reaplugin/ui`),
    timed(`${HOST}/api/v1/info`),
  ]);
  const burnResult = await burn;
  const burnEnd = Date.now();
  await sleep(2000); // recovery
  polling = false;
  await poller;
  ws.close();

  const inBurn = (t) => t >= burnStart && t <= burnEnd;
  const base = Math.min(...wsFrames.filter((f) => !inBurn(f.arrived)).map((f) => f.offset));
  const gaps = [];
  for (let i = 1; i < polls.length; i++) {
    const prevEnd = polls[i - 1].at + polls[i - 1].ms;
    if (inBurn(polls[i].at)) gaps.push(polls[i].at + polls[i].ms - prevEnd);
  }
  // Frame timestamps may be stamped when Dart processes them, which would hide
  // a stall; the gap between arrivals cannot hide it.
  const arrivals = wsFrames.map((f) => f.arrived);
  const wsGaps = [];
  for (let i = 1; i < arrivals.length; i++) {
    if (arrivals[i] >= burnStart && arrivals[i - 1] <= burnEnd) wsGaps.push(arrivals[i] - arrivals[i - 1]);
  }
  const frameTs = wsFrames.map((f) => f.arrived - f.offset);
  const tsGaps = [];
  for (let i = 1; i < frameTs.length; i++) {
    if (wsFrames[i].arrived >= burnStart && wsFrames[i - 1].arrived <= burnEnd) tsGaps.push(Math.round(frameTs[i] - frameTs[i - 1]));
  }
  return {
    burnMs,
    wsMaxArrivalGapDuringBurnMs: wsGaps.length ? Math.max(...wsGaps) : null,
    wsMaxTimestampGapDuringBurnMs: tsGaps.length ? Math.max(...tsGaps) : null,
    wsFramesArrivedDuringBurn: wsGaps.length,
    burnCall: burnResult,
    parallelCallsFiredAt300ms: {
      sameplugin_life: second, otherplugin_settings_ui: otherPlugin, rest_info: rest,
    },
    machineStatePoll: {
      baseline: stats(polls.filter((p) => !inBurn(p.at)).map((p) => p.ms)),
      duringBurn: stats(polls.filter((p) => inBurn(p.at)).map((p) => p.ms)),
      longestStallDuringBurnMs: gaps.length ? Math.max(...gaps) : null,
    },
    wsSnapshotDelayMs: {
      outsideBurn: stats(wsFrames.filter((f) => !inBurn(f.arrived)).map((f) => f.offset - base)),
      duringBurn: stats(wsFrames.filter((f) => inBurn(f.arrived)).map((f) => f.offset - base)),
    },
  };
}

for (const b of burns) {
  console.log(JSON.stringify(await run(b), null, 1));
}
