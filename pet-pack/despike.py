"""只修"跳变"那一小段，别的地方一帧都不动。

背景：AI 出片的源里会有几处整片重绘（我们这条是 5.6s 附近，单帧差异 30+/255）。
全局时域平滑能压住它，但会让所有运动边缘拖影；这里改成**局部**处理：

  1. 先算出每帧与前一帧的差（只比角色区）；
  2. 超过阈值的帧标成"跳变"，向两边各扩 padding 帧，形成若干窗口；
  3. 只在这些窗口内做 3 抽头时域滤波 [0.25, 0.5, 0.25]，重复几遍把台阶摊平；
  4. 窗口外的帧原样输出（含首尾，所以接缝不受影响）。

用法：
  python despike.py 待机呼吸.webm --thr 12 --pad 2 --passes 2
"""
import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")
TMPDIR = Path(r"D:\harnessTest\DSHpet\pet-pack\_tmp")


def probe(p):
    out = subprocess.run(
        [str(FFDIR / "ffprobe.exe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", str(p)],
        capture_output=True, text=True, check=True).stdout.strip()
    w, h, rate = [x for x in out.split(",") if x][:3]
    num, _, den = rate.partition("/")
    return int(w), int(h), float(num) / float(den or 1)


def read_frames(p, w, h):
    pr = subprocess.Popen([str(FFDIR / "ffmpeg.exe"), "-v", "error", "-c:v", "libvpx-vp9",
                           "-i", str(p), "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n = w * h * 4
    while True:
        b = pr.stdout.read(n)
        if len(b) < n:
            break
        yield np.frombuffer(b, dtype=np.uint8).reshape(h, w, 4)
    pr.stdout.close()
    pr.wait()


def frame_diff(a, b):
    m = (a[..., 3] > 8) | (b[..., 3] > 8)
    if not m.any():
        return 0.0
    return float(np.abs(a[..., :3].astype(np.int16) - b[..., :3].astype(np.int16)).mean(-1)[m].mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--thr", type=float, default=12.0, help="单帧差异超过它就算跳变")
    ap.add_argument("--pad", type=int, default=2, help="向两边各扩几帧")
    ap.add_argument("--passes", type=int, default=2, help="smooth 模式下的滤波遍数")
    ap.add_argument("--mode", choices=["ramp", "smooth"], default="ramp",
                    help="ramp=窗口内线性插值（推荐，不糊）；smooth=反复 3 抽头滤波")
    ap.add_argument("--crf", type=int, default=24)
    args = ap.parse_args()

    src = Path(args.video)
    w, h, fps = probe(src)
    frames = list(read_frames(src, w, h))
    n = len(frames)
    d = [frame_diff(frames[i], frames[i - 1]) for i in range(1, n)]
    seam_before = frame_diff(frames[-1], frames[0])

    hot = [i + 1 for i, v in enumerate(d) if v > args.thr]
    if not hot:
        print(f"没有超过 {args.thr} 的帧（最大 {max(d):.2f}），不用修")
        return 0

    mask = np.zeros(n, bool)
    for i in hot:
        mask[max(1, i - args.pad): min(n - 1, i + args.pad + 1)] = True
    runs = []
    start = None
    for i in range(n):
        if mask[i] and start is None:
            start = i
        elif not mask[i] and start is not None:
            runs.append((start, i - 1)); start = None
    if start is not None:
        runs.append((start, n - 1))

    print(f"检测到 {len(hot)} 个跳变帧，合并成 {len(runs)} 段窗口：{runs}")
    print(f"  原始：最大帧间差 {max(d):.2f}，接缝 {seam_before:.2f}")

    cur = [f.astype(np.float32) for f in frames]
    if args.mode == "ramp":
        # 用窗口两端的稳定帧做线性插值，把台阶均摊到整段窗口里。
        # 比反复 3 抽头滤波更干净：窗口内不会出现"中间态"的糊影，只是一条直过渡。
        for a, b in runs:
            A, B = max(0, a - 1), min(n - 1, b + 1)
            if B <= A:
                continue
            for i in range(a, b + 1):
                t = (i - A) / (B - A)
                cur[i] = (1 - t) * cur[A] + t * cur[B]
    else:
        for _ in range(args.passes):
            nxt = [f.copy() for f in cur]
            for a, b in runs:
                for i in range(a, b + 1):
                    lo, hi = max(0, i - 1), min(n - 1, i + 1)
                    nxt[i] = 0.25 * cur[lo] + 0.5 * cur[i] + 0.25 * cur[hi]
            cur = nxt
    out = [np.clip(f, 0, 255).astype(np.uint8) for f in cur]

    d2 = [frame_diff(out[i], out[i - 1]) for i in range(1, n)]
    print(f"  处理后：最大帧间差 {max(d2):.2f}，接缝 {frame_diff(out[-1], out[0]):.2f}")

    TMPDIR.mkdir(parents=True, exist_ok=True)
    tmp_enc = TMPDIR / (src.stem + ".despike.webm")
    enc = subprocess.Popen(
        [str(FFDIR / "ffmpeg.exe"), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
         "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-", "-c:v", "libvpx-vp9",
         "-pix_fmt", "yuva420p", "-crf", str(args.crf), "-b:v", "0", "-row-mt", "1",
         "-r", f"{fps:g}", str(tmp_enc)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for f in out:
            enc.stdin.write(f.tobytes())
        enc.stdin.close()
    except BrokenPipeError:
        print("编码器提前退出：", enc.stderr.read().decode("utf-8", "replace")[-800:])
        return 1
    if enc.wait() != 0:
        print("编码失败：", enc.stderr.read().decode("utf-8", "replace")[-800:])
        return 1

    import shutil
    shutil.move(str(tmp_enc), str(src))
    print(f"✔ 已就地重写 {src.name}（{src.stat().st_size // 1024} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())