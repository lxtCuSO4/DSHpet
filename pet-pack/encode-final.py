"""把 step03 母版编成最终 webm（VP9 + alpha）。

替代宿主的 `scripts/encode_thumbs.py`，只改一件事：**默认 960x540 而不是 640x360**。

原因（实测，见 `_art/final-matrix.py`）：VP9 在有 alpha 时会把 alpha 平面按 8x8 块量化。
在 640x360 输出、桌面上又按 ~630 设备像素 1:1 显示时，这些块就是肉眼可见的"马赛克台阶"
（8 网格梯度比值 1.32，官方素材 0.97）。同样的源编到 960x540 再被浏览器缩到 630 显示，
块被平均掉（0.89），轮廓反而更顺、更清晰。

用法：
    python encode-final.py [--repo DIR] [--width 960] [--height 540] [--crf 24]
"""
import argparse
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def resolve_ffmpeg(repo: Path, explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    cand = repo / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe"
    if cand.exists():
        return cand
    for p in (repo / ".tools").glob("*/bin/ffmpeg.exe"):
        return p
    raise SystemExit(f"找不到 ffmpeg（找过 {cand}），用 --ffmpeg 指定")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent / "_repo"))
    ap.add_argument("--src", default="step03")
    ap.add_argument("--dst", default="step04")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=540)
    ap.add_argument("--crf", type=int, default=24)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--ffmpeg", default=None)
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    src = repo / args.src
    dst = repo / args.dst
    ffmpeg = resolve_ffmpeg(repo, args.ffmpeg)
    dst.mkdir(parents=True, exist_ok=True)

    sources = sorted(src.glob("*.webm"))
    if not sources:
        raise SystemExit(f"{src} 里没有 webm（先跑 normalize_step03）")

    total_in = total_out = 0
    for i, s in enumerate(sources, 1):
        out = dst / s.name
        cmd = [
            str(ffmpeg), "-y", "-v", "error",
            "-c:v", "libvpx-vp9", "-i", str(s),
            "-vf", f"scale={args.width}:{args.height}:flags=lanczos,format=yuva420p",
            "-c:v", "libvpx-vp9", "-crf", str(args.crf), "-b:v", "0",
            "-row-mt", "1",
            # 同上：时间基直通，别让 ffmpeg 按 CFR 重排导致末帧丢失（否则循环会跳一下）
            "-fps_mode", "passthrough", str(out),
        ]
        subprocess.run(cmd, check=True)
        sin, sout = s.stat().st_size, out.stat().st_size
        total_in += sin
        total_out += sout
        print(f"[{i}/{len(sources)}] {s.name}  {sin/1048576:.1f}MB -> {sout/1024:.0f}KB "
              f"({args.width}x{args.height} crf{args.crf})")

    print(f"Done. {len(sources)} videos written to {dst}")
    print(f"masters: {len(sources)}\nsource total: {total_in/1048576:.1f}MB\nthumb total: {total_out/1048576:.1f}MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())