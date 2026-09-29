# decaid-mcp spike plugin (throwaway)

A probe, not a product. It answers the questions in
[docs/plugin-spike/REPORT.md](../../docs/plugin-spike/REPORT.md) and must be
uninstalled afterwards: Decaid's API has no authentication, so every endpoint
below is open to the whole LAN while the plugin is loaded.

## Endpoints

All under `http://<tablet>:8080/api/v1/plugins/decaid-mcp-spike.reaplugin/`.

| Endpoint | Test | What it does |
|----------|------|--------------|
| `mcp` | 1 | Minimal MCP 2025-06-18 Streamable HTTP server (JSON only, no SSE): `initialize`, notifications, `ping`, `tools/list`, `tools/call ping` |
| `echo` | 1 | Returns the request object; `?status=`, `?hdr=&hdrval=`, `?ct=`, `?empty=1` shape the response |
| `call` | 2, 5, 9 | POST `{base?, path, method?, body?, keep?}` or a list of them; the plugin runs each with `fetch` and reports status, time and size |
| `burn` | 3 | Synchronous CPU loop for `?ms=` |
| `sleep` | 4 | Answers after `?ms=` without blocking (`setTimeout`) |
| `metrics` | 4, 5 | `?ids=a,b,...` loads shots and runs the ported puck resistance and profile compliance; `&repeat=`, `&parallel=1`, `&full=1` |
| `size` | 6 | Responds with `?kb=` KiB of JSON and reports the size of the request body |
| `life` | 7 | Load time and a call counter kept in a global |
| `fail` | 7 | `?mode=throw|reject|null|badstatus|objbody|nobody|hang` |
| `store` | 10 | `host.storage` write (POST `?kb=`) and read timing (not needed, see report) |

## Install

Fastest while iterating: upload the two files directly.

```bash
bash spike/tools/deploy.sh                       # PUT /api/v1/plugins/:id/source
curl -X POST http://<tablet>:8080/api/v1/plugins/decaid-mcp-spike.reaplugin/enable
```

From GitHub: Decaid expects `manifest.json` and `plugin.js` at the root of the
branch archive (or one directory below it), so the files live on their own
orphan branch `spike-plugin`:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-branch \
  -H 'content-type: application/json' \
  -d '{"repo": "The-Walker443/decaid-mcp", "branch": "spike-plugin"}'
curl -X POST http://<tablet>:8080/api/v1/plugins/decaid-mcp-spike.reaplugin/enable
```

Both install paths leave the plugin unloaded; `enable` is required.

Connect Claude Code:

```bash
claude mcp add --transport http decaid-spike \
  http://<tablet>:8080/api/v1/plugins/decaid-mcp-spike.reaplugin/mcp
```

## Uninstall

```bash
curl -X DELETE http://<tablet>:8080/api/v1/plugins/decaid-mcp-spike.reaplugin
claude mcp remove decaid-spike
```

## Measurement tools

- `spike/tools/deploy.sh` - upload manifest and source.
- `spike/tools/load-probe.mjs` - Test 3: polls `/machine/state`, listens on
  `/ws/v1/machine/snapshot` and fires parallel calls while `burn` runs.
  `node spike/tools/load-probe.mjs 2000 5000 10000`
