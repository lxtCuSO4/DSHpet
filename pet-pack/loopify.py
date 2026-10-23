"""把一段动画 webm 修成"看不出接缝、也不留残影"的循环片。

三件事，按需组合：

  --cut N     在末尾 N 帧里找最像首帧的一帧当结尾（纯裁剪，零混合、零残影）。
              适合"内容其实回到了起点，只是尾巴多播了几帧"的情况。
  --fade K    尾部 K 帧与开头 K 帧交叉淡化（能吃掉接缝，但混合区间内会有短暂叠影）。
              默认 0；只有 --cut 压不下来才用，且建议 2~4 帧。
  --smooth S  时域高斯平滑。会摊平单帧跳变，但**运动中的边缘会拖影**，
              只适合几乎静止的素材，默认 0。

用法：
  python loopify.py 待机呼吸.webm --cut 60
  python loopify.py 待机呼吸.webm --fade 3

注意：本机 ffmpeg 写不进 %USERPROFILE%\\.dsh（Permission denied），
所以统一先编码到 pet-pack\\_tmp，再用 python 搬过去。
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


def diff(a, b):
    """只比角色区（任一帧 alpha>8），绿底会把差异稀释掉。"""
    m = (a[..., 3] > 8) | (b[..., 3] > 8)
    if not m.any():
        return 0.0
    return float(np.abs(a[..., :3].astype(np.int16) - b[..., :3].astype(np.int16)).mean(-1)[m].mean())


def temporal_smooth(frames, size):
    n = len(frames)
    half = size // 2
    sigma = size / 3.0
    wts = np.array([np.exp(-0.5 * ((j - half) / sigma) ** 2) for j in range(size)])
    wts = wts / wts.sum()
    padded = [frames[0].astype(np.float32)] * half + [f.astype(np.float32) for f in frames] \
        + [frames[-1].astype(np.float32)] * half
    out = []
    for i in range(n):
        acc = np.zeros_like(padded[i])
        for j in range(size):
            acc += wts[j] * padded[i + j]
        out.append(np.clip(acc, 0, 255).astype(np.uint8))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", default="", help="不给就原地重写")
    ap.add_argument("--cut", type=int, default=0, help="末尾 N 帧内找最像首帧的一帧当结尾")
    ap.add_argument("--fade", type=int, default=0, help="尾部 K 帧与开头 K 帧交叉淡化")
    ap.add_argument("--smooth", type=int, default=0, help="时域高斯平滑窗口（奇数）")
    ap.add_argument("--crf", type=int, default=24)
    args = ap.parse_args()

    src = Path(args.video)
    w, h, fps = probe(src)
    frames = list(read_frames(src, w, h))
    n0 = len(frames)
    print(f"{src.name}: {w}x{h} @{fps:g}  {n0} 帧  接缝 {diff(frames[-1], frames[0]):.2f}")

    if args.cut > 0 and n0 - args.cut >= 2:
        lo = max(2, n0 - args.cut)
        best_i, best = lo, None
        for i in range(lo, n0):
            d = diff(frames[i], frames[0])
            if best is None or d < best:
                best_i, best = i, d
        dropped = n0 - best_i - 1
        frames = frames[: best_i + 1]
        print(f"裁剪：结尾取第 {best_i} 帧（与首帧差 {best:.2f}），丢掉末尾 {dropped} 帧 → {len(frames)} 帧")

    if args.smooth >= 3:
        size = args.smooth if args.smooth % 2 == 1 else args.smooth + 1
        frames = temporal_smooth(frames, size)
        print(f"时域平滑 {size} 帧（会拖影，仅适合近静止素材）")

    n = len(frames)
    k = max(0, min(args.fade, n // 3))
    if k >= 2:
        out = frames[: n - k]
        for e in range(k):
            a = frames[n - k + e].astype(np.float32)
            b = frames[e].astype(np.float32)
            t = (e + 1) / k
            out.append(np.clip(a * (1 - t) + b * t, 0, 255).astype(np.uint8))
        frames = out
        print(f"交叉淡化 {k} 帧（混合区间内会有短暂叠影）")

    print(f"输出 {len(frames)} 帧，接缝 {diff(frames[-1], frames[0]):.2f}")

    dst = Path(args.out) if args.out else src.with_suffix(".loop.webm")
    TMPDIR.mkdir(parents=True, exist_ok=True)
    tmp_enc = TMPDIR / (dst.stem + ".enc.webm")
    enc = subprocess.Popen(
        [str(FFDIR / "ffmpeg.exe"), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
         "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-", "-c:v", "libvpx-vp9",
         "-pix_fmt", "yuva420p", "-crf", str(args.crf), "-b:v", "0", "-row-mt", "1",
         "-r", f"{fps:g}", str(tmp_enc)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for f in frames:
            enc.stdin.write(f.tobytes())
        enc.stdin.close()
    except BrokenPipeError:
        print("编码器提前退出：", enc.stderr.read().decode("utf-8", "replace")[-800:])
        return 1
    if enc.wait() != 0:
        print("编码失败：", enc.stderr.read().decode("utf-8", "replace")[-800:])
        return 1

    import shutil
    if args.out:
        shutil.move(str(tmp_enc), str(dst))
        print(f"✔ 写出 {dst}（{dst.stat().st_size // 1024} KB）")
    else:
        shutil.move(str(tmp_enc), str(src))
        print(f"✔ 已就地重写 {src.name}（{src.stat().st_size // 1024} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())