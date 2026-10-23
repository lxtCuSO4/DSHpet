"""Compare a stationary white-background recording ROI with all idle source frames.

This measures RGB residuals, not display-panel behavior. Restrict --seconds to a
segment with unchanged position/scale/background; review outliers before drawing
conclusions. Outputs only numeric measurements, never screenshots/configuration.
"""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("recording", type=Path)
parser.add_argument("source", type=Path)
parser.add_argument("--ffmpeg", type=Path, required=True)
parser.add_argument("--seconds", type=float, required=True)
parser.add_argument("--stage", type=int, nargs=4, required=True, metavar=("X", "Y", "W", "H"))
parser.add_argument("--roi", type=int, nargs=4, required=True, metavar=("X", "Y", "W", "H"))
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
sx, sy, sw, sh = args.stage
rx, ry, rw, rh = args.roi
if min(sw, sh, rw, rh, args.seconds) <= 0:
    parser.error("Dimensions and duration must be positive")
if rx < sx or ry < sy or rx + rw > sx + sw or ry + rh > sy + sh:
    parser.error("ROI must lie within the stage")


def decode(path, filters, source=False):
    command = [str(args.ffmpeg), "-hide_banner", "-loglevel", "error"]
    if source:
        command += ["-c:v", "libvpx-vp9"]
    command += ["-i", str(path)]
    if not source:
        command += ["-t", str(args.seconds)]
    channels = 4 if source else 3
    # Crop RGB(A), so odd ROI coordinates are not rounded by chroma subsampling.
    filters = ("format=rgba," if source else "format=rgb24,") + filters
    command += ["-vf", filters, "-fps_mode", "passthrough", "-pix_fmt",
                "rgba" if source else "rgb24", "-f", "rawvideo", "-"]
    raw = subprocess.check_output(command)
    return np.frombuffer(raw, np.uint8).reshape(-1, 60, 24, channels).astype(np.float32)


reference = decode(args.source,
                   f"scale={sw}:{sh},crop={rw}:{rh}:{rx-sx}:{ry-sy},scale=24:60", True)
alpha = reference[..., 3:] / 255
reference = reference[..., :3] * alpha + 255 * (1 - alpha)
live = decode(args.recording, f"crop={rw}:{rh}:{rx}:{ry},scale=24:60")
reference = reference.reshape(len(reference), -1)
live = live.reshape(len(live), -1)
if not len(reference) or not len(live):
    raise RuntimeError("No decoded frames")
ref_energy = np.square(reference).sum(axis=1)
errors, phases = [], []
for start in range(0, len(live), 128):
    block = live[start:start+128]
    distance = (np.square(block).sum(axis=1)[:, None] + ref_energy[None, :]
                - 2 * block @ reference.T) / reference.shape[1]
    indices = distance.argmin(axis=1)
    errors.extend(np.sqrt(np.maximum(distance[np.arange(len(block)), indices], 0)).tolist())
    phases.extend(indices.tolist())
probe = args.ffmpeg.with_name("ffprobe.exe" if args.ffmpeg.suffix == ".exe" else "ffprobe")
timing = json.loads(subprocess.check_output([
    str(probe), "-v", "error", "-select_streams", "v:0", "-show_frames",
    "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(args.recording),
]))
timestamps = [float(frame["best_effort_timestamp_time"]) for frame in timing["frames"]][:len(live)]
if len(timestamps) != len(live):
    raise RuntimeError("Decoded frame/timestamp counts differ")
threshold = max(float(np.median(errors)) * 3, 10)
candidates = [{"decoded_frame": i, "pts_seconds": timestamps[i], "rmse_255": error}
              for i, error in enumerate(errors) if error > threshold]
largest = np.argsort(errors)[-12:][::-1]
summary = {
    "recording": args.recording.name,
    "segment_seconds": args.seconds,
    "decoded_frames": len(live),
    "source_frames": len(reference),
    "stage_xywh": args.stage,
    "roi_xywh": args.roi,
    "comparison_rgb_size": [24, 60],
    "background_assumption": "white; stationary position and scale",
    "mean_best_rmse_255": float(np.mean(errors)),
    "max_best_rmse_255": float(max(errors)),
    "candidate_threshold_rmse_255": threshold,
    "candidate_outliers_for_visual_review": candidates,
    "largest_residuals": [{"decoded_frame": int(i), "source_frame": phases[i],
                           "pts_seconds": timestamps[i], "rmse_255": errors[i]} for i in largest],
    "limitations": "ROI only; timestamps come from the recording, not an assumed 60fps cadence. "
                   "Does not establish absence of intermittent or panel-only artifacts.",
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps({"summary": summary, "rmse": errors,
                                   "pts_seconds": timestamps, "source_frame": phases}, indent=2), encoding="utf-8")
print(json.dumps(summary, indent=2))
