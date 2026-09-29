"""Golden files from the Python server's metrics, for the JS parity tests.

    <decentespresso-mcp venv>/python tools/python-reference.py <decentespresso-mcp repo>

Reads test/fixtures/shots/shot-*.json, runs the reference implementation of
decentespresso-mcp on each (read-only import, nothing in that repo changes)
and writes test/golden/shot-*.json. The JS tests compare against these field
by field, so CI needs no Python.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test" / "fixtures" / "shots"
GOLDEN = ROOT / "test" / "golden"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.path.insert(0, str(Path(sys.argv[1]) / "src"))
    from decentespresso_mcp.decaid_mapping import annotation_fields, series_rows_from_decaid
    from decentespresso_mcp.metrics import compute_metrics, curve_shape, downsample_curve

    GOLDEN.mkdir(parents=True, exist_ok=True)
    for path in sorted(FIXTURES.glob("shot-*.json")):
        detail = json.loads(path.read_text(encoding="utf-8"))
        rows = series_rows_from_decaid(detail)
        basics = annotation_fields(detail)
        metrics = compute_metrics(rows, dose_g=basics["dose_g"], yield_g=basics["yield_g"])
        keep = (metrics.get("t_peak"), metrics.get("t_max_pressure_global"))
        golden = {
            "rows": [{k: v for k, v in r.items() if k != "shot_id"} for r in rows],
            "metrics": metrics,
            "curve_shape": curve_shape(rows, metrics),
            "curve_60": downsample_curve(rows, max_points=60, keep_times=keep),
            "curve_400": downsample_curve(rows, max_points=400, keep_times=keep),
        }
        (GOLDEN / path.name).write_text(json.dumps(golden, indent=1) + "\n", encoding="utf-8")
        print("wrote", path.name, len(rows), "rows")


if __name__ == "__main__":
    main()
