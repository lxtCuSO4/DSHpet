"""Correlate numeric desktop outliers with live-helper events; never copy configuration/images.

FFmpeg clock entries are stderr receipt times, not exact monitor presentation times.
Nearest PTS matching can differ by one capture sample. Use this to identify the
same ten-second boundary, not to assert millisecond ordering across processes.
"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=Path)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


result = {"clock_limit": "Desktop clocks are stderr receipt times; matching can differ by one sample.",
          "live": {}, "controls": {}}
for name, suffix in (("live-observed-1", "-alignment.json"),
                     ("live-observed-no-readback", "-opaque-alignment.json")):
    directory = args.root / name
    if not (directory / "live-probe.json").exists():
        continue
    probe = read(directory / "live-probe.json")
    renderer = probe["renderer"]
    switches = [e for e in renderer["events"] if e["kind"] == "switchTo"]
    captures = probe["captureFrames"]
    item = {"cleanup": probe["cleanup"], "total_switches": len(switches),
            "compositor_frames": len(captures),
            "minimum_alpha": min((r["alpha"] for r in captures), default=None), "desktop": {}}
    for kind in ("gdi", "dda"):
        alignment = read(directory / "desktop" / (kind + suffix))["summary"]
        clocks = [json.loads(line) for line in
                  (directory / "desktop" / (kind + "-clock.ndjson")).read_text(encoding="utf-8").splitlines()]
        candidates = []
        for candidate in alignment["candidate_outliers_for_visual_review"]:
            clock = min((c for c in clocks if "pts" in c), key=lambda c: abs(c["pts"] - candidate["pts_seconds"]))
            wall = clock["receivedAt"]
            switch = min(switches, key=lambda e: abs(e["wallMs"] - wall))
            neighborhood = [r for r in captures if abs(r["at"] - wall) <= 100]
            changes = [r for r in renderer["events"] if r["kind"] == "attribute"
                       and abs(r["wallMs"] - wall) <= 100]
            first_video_frames = [r for r in renderer["videoFrames"]
                                  if r["mediaTime"] == 0 and abs(r["wallMs"] - wall) <= 100]
            candidates.append({**candidate, "estimated_wall_ms": wall,
                "closest_switch_wall_ms": switch["wallMs"],
                "switch_delta_ms_approx": wall - switch["wallMs"],
                "animation": switch["animation"], "dragging": switch["dragging"],
                "nearby_alpha": [r["alpha"] for r in neighborhood],
                "nearby_visibility": [{"relative_ms_approx": r["wallMs"] - wall,
                                       "A": r["A"]["opacity"], "B": r["B"]["opacity"]} for r in changes],
                "first_video_frame_relative_ms_approx": [r["wallMs"] - wall for r in first_video_frames],
                "native_changes_within_150ms": [r["kind"] for r in probe["nativeEvents"] if abs(r["at"] - wall) < 150]})
        item["desktop"][kind] = {"analyzed_seconds": alignment["segment_seconds"],
            "decoded_frames": alignment["decoded_frames"], "candidates": candidates}
    result["live"][name] = item

for name in ("screen-original", "screen-native", "screen-visibility", "screen-original-repeat"):
    directory = args.root / name
    if not (directory / "desktop/dda-alignment.json").exists():
        continue
    alignment = read(directory / "desktop/dda-alignment.json")["summary"]
    probe = read(directory / "probe.json")
    result["controls"][name] = {"scenario": probe["scenario"],
        "switches": sum(e["kind"] == "switchTo" for e in probe["events"]),
        "capture_frames": len(probe["captureFrames"]),
        "zero_alpha_frames": sum(r["alpha"] == 0 for r in probe["captureFrames"]),
        "analysis": alignment}

args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
for name, item in result["live"].items():
    print(name, {kind: len(capture["candidates"]) for kind, capture in item["desktop"].items()})
for name, item in result["controls"].items():
    print(name, "switches", item["switches"], "candidate samples", len(item["analysis"]["candidate_outliers_for_visual_review"]))
