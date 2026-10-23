"""Summarize idle-loop probe output without copying user configuration or screenshots."""
import json
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "_art/idle-loop-diagnosis")
summary = {}
for name in ("probe-no-input", "probe-bridge", "probe-bridge-long", "probe-native", "probe-old-fade"):
    file = root / name / "probe.json"
    if not file.exists():
        continue
    probe = json.loads(file.read_text(encoding="utf-8"))
    origin = probe["timeOrigin"]
    frames = [r for r in probe["captureFrames"] if r["at"] - origin > 1500]
    switches = [r for r in probe["events"] if r["kind"] == "switchTo"]
    wraps = []
    last = None
    for frame in probe["videoFrames"]:
        front_slot = "A" if frame["front"] == 0 else "B"
        if frame["slot"] != front_slot:
            continue
        if last is not None and frame["mediaTime"] < last - 1:
            wraps.append(frame["at"])
        last = frame["mediaTime"]
    boundaries = [r["at"] for r in switches] or wraps
    measurements = []
    for boundary in boundaries:
        before = [r["alpha"] for r in frames if -200 <= r["at"] - origin - boundary <= -40]
        during = [r for r in frames if -30 <= r["at"] - origin - boundary <= 350]
        if not before or not during:
            continue
        baseline = statistics.median(before)
        new_slot = next(("A" if r["front"] == 1 else "B" for r in switches if r["at"] == boundary), None)
        loaded = next((r for r in probe["events"] if r["at"] >= boundary and r["kind"] == "loadeddata" and r["slot"] == new_slot), None)
        measurements.append({
            "boundary_ms": round(boundary, 3),
            "baseline_alpha": baseline,
            "min_alpha": min(r["alpha"] for r in during),
            "min_alpha_ratio": round(min(r["alpha"] for r in during) / baseline, 6),
            "loadeddata_delay_ms": round(loaded["at"] - boundary, 3) if loaded else None,
        })
    summary[name] = {
        "transport": probe.get("transport", "http"),
        "scenario": probe.get("scenario", "original"),
        "initial_loop": probe["setup"]["initial"]["loop"],
        "captured_frames_after_startup": len(frames),
        "zero_alpha_frames": sum(r["alpha"] == 0 for r in frames),
        "switches": len(switches),
        "observed_video_time_wraps": len(wraps),
        "alpha_range": [min(r["alpha"] for r in frames), max(r["alpha"] for r in frames)],
        "boundaries": measurements,
    }
file = root / "probe-summary.json"
file.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(summary, ensure_ascii=False, indent=2))
