"""时域去尖峰：把 AI 素材里 1~3 帧的"抖动/抽帧"磨平，保留真实动作。

原理：对每帧，取前后各 2 帧（共 5 帧）做一个逐像素的"参考帧"= 窗口内 RGB/A 的中位数。
只有当
  ① 本帧与中位参考差得明显（|Δ| > thr）
  ② 前后两帧彼此基本一致（|prev-next| < agree）
时，才认为"这一帧是孤立的抖动"，用参考替换；否则保留原帧（真实运动不会被抹平）。

用法：
  python smooth.py 输入.webm [-o 输出.webm] [--thr 12] [--agree 8] [--window 2] [--dry-run]
默认原地重写（先写到 .tmp.webm 再替换）。
"""
import argparse
import json
import subprocess
import sys
from collections import deque
from pathlib import Path

import numpy as np

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")


def ffexe(name):
    p = FFDIR / f"{name}.exe"
    return str(p if p.exists() else name)


def probe(path):
    out = subprocess.run([ffexe("ffprobe"), "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,r_frame_rate,codec_name",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    st = json.loads(out)["streams"][0]
    num, _, den = st["r_frame_rate"].partition("/")
    return int(st["width"]), int(st["height"]), float(num) / float(den or 1)


def read_frames(path, w, h):
    p = subprocess.Popen([ffexe("ffmpeg"), "-v", "error", "-c:v", "libvpx-vp9", "-i", str(path),
                          "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n = w * h * 4
    while True:
        b = p.stdout.read(n)
        if len(b) < n:
            break
        yield np.frombuffer(b, dtype=np.uint8).reshape(h, w, 4)
    p.stdout.close(); p.wait()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("-o", "--out")
    ap.add_argument("--thr", type=float, default=12.0, help="本帧与参考的中位差阈值")
    ap.add_argument("--agree", type=float, default=8.0, help="前后帧彼此差的上限（小于它才认为中间帧是孤儿）")
    ap.add_argument("--window", type=int, default=2, help="参考窗口半径")
    ap.add_argument("--crf", type=int, default=26)
    ap.add_argument("--dry-run", action="store_true", help="只报告会改多少帧，不写文件")
    args = ap.parse_args()

    src = Path(args.video)
    w, h, fps = probe(src)
    frames = list(read_frames(src, w, h))
    if not frames:
        print("解不出帧"); return 2
    print(f"{src.name}: {w}x{h} @{fps:g}  {len(frames)} 帧")

    R = args.window
    touched, report = 0, []
    out = []
    for i, f in enumerate(frames):
        lo, hi = max(0, i - R), min(len(frames) - 1, i + R)
        win = np.stack([frames[k] for k in range(lo, hi + 1)])
        med = np.median(win, axis=0)
        d = np.abs(f.astype(np.int16) - med.astype(np.int16)).max(-1)
        bad = d > args.thr
        if i - 1 >= 0 and i + 1 < len(frames):
            nb = np.abs(frames[i - 1].astype(np.int16) - frames[i + 1].astype(np.int16)).max(-1)
            bad &= nb < args.agree
        cover = float(bad.mean())
        if cover > 0.0005:
            touched += 1
            # 只替换"坏"的像素；其余保持原样（避免整帧被中值软化）
            g = np.where(bad[..., None], med, f)
            report.append((i, cover, float(d[bad].mean()) if bad.any() else 0.0))
        else:
            g = f
        out.append(g.astype(np.uint8))

    print(f"判定需要修补的帧：{touched}/{len(frames)}")
    for i, cover, mag in report[:15]:
        print(f"  帧#{i:4d}（{i/fps:5.2f}s）改动像素 {cover*100:5.2f}%  平均幅度 {mag:5.1f}")
    if args.dry_run:
        print("--dry-run：不写文件"); return 0
    if not report:
        print("没有需要修的帧，原样保留"); return 0

    dst = Path(args.out) if args.out else src.with_suffix(".tmp.webm")
    enc = subprocess.Popen([ffexe("ffmpeg"), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                            "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-",
                            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", str(args.crf),
                            "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "3", str(dst)],
                           stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    for g in out:
        enc.stdin.write(g.tobytes())
    enc.stdin.close()
    err = enc.stderr.read().decode("utf-8", "replace")
    rc = enc.wait()
    if rc != 0:
        print("编码失败：", err[-800:]); return 1
    if not args.out:
        src.unlink()
        dst.rename(src)
        print(f"✔ 已就地重写 {src.name}（{src.stat().st_size//1024} KB）")
    else:
        print(f"✔ 写出 {dst}（{dst.stat().st_size//1024} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())