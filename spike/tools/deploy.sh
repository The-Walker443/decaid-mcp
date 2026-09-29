#!/usr/bin/env bash
# Upload manifest.json + plugin.js to the tablet via PUT /api/v1/plugins/:id/source.
set -euo pipefail
DECAID="${DECAID:-http://10.100.100.171:8080}"
DIR="$(cd "$(dirname "$0")/../decaid-plugin" && pwd)"
ID=$(jq -r .id "$DIR/manifest.json")
jq -n --slurpfile m "$DIR/manifest.json" --rawfile p "$DIR/plugin.js" '{manifest: $m[0], plugin: $p}' \
  | curl -s -m 30 -w "\nPUT source: HTTP %{http_code} %{time_total}s\n" -X PUT \
      -H 'content-type: application/json' --data-binary @- "$DECAID/api/v1/plugins/$ID/source"
