# Decaid MCP

An [MCP](https://modelcontextprotocol.io) server that runs **inside Decaid**, the
tablet app for the Decent Espresso DE1, as a plugin. Claude (Claude Code, Claude
Desktop or any MCP client) can then read your shots, diagnose them, compare
them and summarise periods. It can also rate shots, keep notes, adjust the
workflow and manage beans and batches.

You need no server, no Docker and no database. Decaid is the only store, and
every answer is read live from it.

## What it can do

| Tool | What it answers |
|------|-----------------|
| `status` | Plugin and Decaid version, machine state, the tablet's rating scale |
| `list_shots` | Your shots, newest first, as compact metadata; filters by bean, batch, profile, text |
| `get_shot` | One shot with full diagnostics (see below), curve shape, profile summary; the raw curve on request |
| `compare_shots` | 2-4 shots side by side, with deltas and a notice when the profiles differ |
| `stats` | A period (for example `30d`, `4w`, or since a date): counts, dose, yield, ratio, grind settings per bean, ratings, top beans and profiles, batch usage |
| `list_beans` | Beans with their batches, roast age and active age (freezer time subtracted) |
| `get_batch` | One batch with its frost history and latest shots |
| `get_workflow` | What is set up right now: dose, yield, grind, batch, profile summary |
| `update_shot` | Rating (0-100 or 0-10, detected automatically) and notes |
| `set_workflow` | Grind setting, target dose, target yield, batch |
| `create_bean`, `update_bean` | Beans |
| `create_batch`, `update_batch` | Batches, including freezing and thawing |

**Diagnostics per shot:**

- the machine's own phase markers (end of preinfusion and its source);
- the two pressure maxima;
- pour flow and its stability;
- temperature;
- first drops, checked against an untared scale;
- puck resistance (pressure / flow²) with its trend;
- five channeling indicators: pressure dip, flow instability, pump/scale flow
  divergence, early drops, resistance trend;
- profile compliance per control mode and per profile step.

The thresholds come from
[decentespresso-mcp](https://github.com/The-Walker443/decentespresso-mcp),
and this plugin computes the same numbers (checked by the test suite).

**Not included, by design:**

- selecting or editing profiles;
- recipes (use your skin);
- notifications;
- an archive outside Decaid;
- shot time in `stats` (the shot list has no duration; `get_shot` and
  `compare_shots` have it);
- shots imported from the de1app (ids `de1app-...`), which are not shown.

## Install

The plugin installs from the `stable` branch. Replace `<tablet>` with your
tablet's address:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-branch \
  -H 'content-type: application/json' \
  -d '{"repo": "The-Walker443/decaid-mcp", "branch": "stable"}'

# Installing does not start it. Enable it once:
curl -X POST http://<tablet>:8080/api/v1/plugins/decaid-mcp.reaplugin/enable
```

Updates arrive through Decaid's normal plugin update check whenever `stable`
moves. To remove the plugin:

```bash
curl -X DELETE http://<tablet>:8080/api/v1/plugins/decaid-mcp.reaplugin
```

## Connect

The endpoint is
`http://<tablet>:8080/api/v1/plugins/decaid-mcp.reaplugin/mcp`: Streamable
HTTP, plain JSON, no sessions.

**Claude Code**, in your local network:

```bash
claude mcp add --transport http decaid http://<tablet>:8080/api/v1/plugins/decaid-mcp.reaplugin/mcp
```

**Claude Desktop** and **claude.ai** add remote servers as custom connectors.
They need an HTTPS address that is reachable from Anthropic's side, so they
need the publishing setup below.

**Test** with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli http://<tablet>:8080/api/v1/plugins/decaid-mcp.reaplugin/mcp --transport http --method tools/list
```

## Publishing outside your network: read this first

> **Port 8080 is Decaid's whole API, and it has no authentication.** The same
> port that serves this plugin also answers `PUT /api/v1/plugins/:id/source`,
> which installs and runs arbitrary code, and every read and write of your
> data. The plugin does not protect itself: neither Decaid nor MCP give it a
> way to do so on this port.

If you publish the endpoint (a tunnel or a reverse proxy):

1. **Pass only the path** `/api/v1/plugins/decaid-mcp.reaplugin/mcp`. Block
   everything else on that host.
2. **Enforce access in front of it**, for example with Cloudflare Access, proxy
   authentication, or an allowlist.

Examples:

- **Cloudflare Tunnel:** an ingress rule for the host with
  `path: ^/api/v1/plugins/decaid-mcp\.reaplugin/mcp$` to
  `http://<tablet>:8080`, a catch-all `http_status:404`, and a Cloudflare Access
  application on the host.
- **Caddy:** `handle /api/v1/plugins/decaid-mcp.reaplugin/mcp {
  reverse_proxy <tablet>:8080 }` inside a site that authenticates first, with
  `respond 404` for everything else.

The plugin does not check the `Origin` header, which the MCP specification asks
for as a guard against DNS rebinding. On this port it would protect nothing:
Decaid's unauthenticated API answers next to it anyway.

## Behaviour and limits

- **Busy machine.** While the machine brews, steams, pours hot water, rinses or
  runs maintenance, the following are refused with "ask again after the shot":
  `get_shot`, `compare_shots`, `stats` and every write tool. `status`,
  `list_shots`, `list_beans`, `get_batch` and `get_workflow` keep working.
  Plugins run on Decaid's main thread, and Decaid itself pauses about 200 ms
  for every page of shots it serves.
- **Main thread.** The plugin computes in slices of a few milliseconds and
  hands control back to Decaid in between. Measured on a tablet: at most
  6 ms per slice. A shot's full diagnostics take about 0.2 s, and four shots
  about 0.4 s.
- **`stats`** reads at most 500 shots per period (about 100 days at 5 shots a
  day) and says `truncated` when it stops there. With `compare_previous` it
  also reads the period before.
- **Ratings** are shown and written on the tablet's own scale. Decaid 0.8.6
  uses 0-100, and later versions use 0-10. The plugin finds out with a harmless
  probe request. On a 0-100 tablet, values 1-10 are refused when writing,
  because after Decaid's move to 0-10 they would read ten times too high.
- **Freezer data.** Beanie keeps freeze and thaw events in the batch's
  `extras.storageEvents`. DYE2 keeps `freezeDate`/`unfreezeDate`. The plugin
  reads the events first and writes both formats, so every app sees the same
  thing. A contradiction between them is shown, not hidden. Older freeze cycles
  are corrected in Beanie.
- **Batch writes** keep other apps' keys in `extras`. Decaid replaces `extras`
  as a whole, so the plugin merges first.
- **Workflow batch.** Setting a batch also writes the coffee name and roaster.
  Decaid does not check that a batch exists, so the plugin does.
- **Limits of Decaid 0.8.6:**
  - requests up to 1 MiB;
  - every call must finish within 30 s (the plugin stops itself at 25 s);
  - a request body that is not JSON is answered by Decaid with HTTP 500 before
    it reaches the plugin.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `plugin with decaid-mcp.reaplugin not loaded` | Not enabled yet (see Install), or Decaid disabled it after three failed loads. Enable it again with `POST .../enable` or in Decaid's plugin settings |
| "The machine is busy" | Intended during shots and maintenance. Ask again afterwards |
| `truncated: true` in `stats` | More than 500 shots in the period. Ask for a shorter one |
| No answer at all | The tablet is off, Decaid is not running, or the network path is down. Decaid does not start by itself after a tablet reboot |

**Decaid after a tablet reboot:** start Decaid again. An autostart option on
the tablet (manufacturer setting, launcher or kiosk app) avoids this. The
plugin keeps no state that would need restoring.

## Development

```bash
node --test --test-concurrency=1 "test/*.test.mjs"
```

- `plugin.js` is hand-written and shipped as is, with no build step. Its
  sections are listed at the top of the file.
- Tests run against fixtures that are real, anonymised Decaid responses
  (`tools/capture-fixtures.mjs`).
- Parity with the Python reference comes from golden files
  (`tools/python-reference.py`).
- The main-thread budget test is anchored on timings measured on a tablet.
- `tools/load-probe.mjs` re-measures Decaid's responsiveness while the heavy
  tools run.

Design and measurements:

- [docs/plugin/ARCHITECTURE.md](docs/plugin/ARCHITECTURE.md)
- [docs/plugin-spike/REPORT.md](docs/plugin-spike/REPORT.md)
- [docs/plugin/TASK3-REPORT.md](docs/plugin/TASK3-REPORT.md)

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
