"""亚像素稳定器：把素材里"整体一跳一跳"的抖动抹掉，保留缓慢的摆动。

做法：
 1. 用**相位相关**（alpha 通道的轮廓做 FFT 互相关）逐帧估出相邻帧之间的 (dx,dy)，带抛物线亚像素细化；
 2. 累积成整条轨迹 pos[i]，再用滑动平均（窗口 ~0.5s）得到"该有的平滑轨迹" smooth[i]；
 3. 每帧按 smooth[i]-pos[i] 做双线性平移 —— 高频抖动被压掉，几秒周期的真实摆动保留；
 4. 重新编码（VP9 + alpha）。

用法：python stabilize.py 输入.webm [-o 输出.webm] [--window 11] [--gain 1.0] [--dry-run]
--gain <1 时只补一部分（0.5 = 抖动削一半），默认 1.0 全补。
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")


def ffexe(n):
    p = FFDIR / f"{n}.exe"
    return str(p if p.exists() else n)


def probe(path):
    st = json.loads(subprocess.run([ffexe("ffprobe"), "-v", "error", "-select_streams", "v:0",
                                    "-show_entries", "stream=width,height,r_frame_rate",
                                    "-of", "json", str(path)],
                                   capture_output=True, text=True, check=True).stdout)["streams"][0]
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


def phase_shift(a, b):
    """返回把 b 对齐到 a 所需的平移 (dy, dx)，亚像素。"""
    fa = np.fft.rfft2(a - a.mean())
    fb = np.fft.rfft2(b - b.mean())
    R = fa * np.conj(fb)
    R /= np.abs(R) + 1e-9
    cc = np.fft.irfft2(R, s=a.shape)
    k = np.unravel_index(np.argmax(cc), cc.shape)
    dy, dx = k
    def refine(c0, cm, cp):
        d = cm - 2 * c0 + cp
        return 0.0 if abs(d) < 1e-9 else float(np.clip(0.5 * (cm - cp) / d, -0.5, 0.5))
    h, w = cc.shape
    y0 = cc[(dy - 1) % h, dx]; y1 = cc[dy, dx]; y2 = cc[(dy + 1) % h, dx]
    x0 = cc[dy, (dx - 1) % w]; x2 = cc[dy, (dx + 1) % w]
    fy = refine(y1, y0, y2); fx = refine(y1, x0, x2)
    sh_y = dy - h if dy > h // 2 else dy
    sh_x = dx - w if dx > w // 2 else dx
    return sh_y + fy, sh_x + fx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("-o", "--out")
    ap.add_argument("--window", type=int, default=11, help="轨迹平滑窗口（帧）；越大抑制越强")
    ap.add_argument("--gain", type=float, default=1.0)
    ap.add_argument("--crf", type=int, default=24)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = Path(args.video)
    w, h, fps = probe(src)
    frames = list(read_frames(src, w, h))
    n = len(frames)
    print(f"{src.name}: {w}x{h} @{fps:g}  {n} 帧")

    alphas = [f[..., 3].astype(np.float32) for f in frames]
    steps = [(0.0, 0.0)]
    for i in range(1, n):
        steps.append(phase_shift(alphas[i - 1], alphas[i]))
    steps = np.array(steps)          # (n,2) 相邻帧位移
    pos = np.cumsum(steps, axis=0)   # 累积轨迹

    k = max(3, args.window | 1)
    pad = k // 2
    padpos = np.pad(pos, ((pad, pad), (0, 0)), mode="edge")
    kernel = np.ones(k) / k
    smooth = np.stack([np.convolve(padpos[:, d], kernel, mode="valid") for d in range(2)], axis=1)
    delta = (smooth - pos) * args.gain

    print(f"相邻帧位移：|dy| 中位 {np.median(np.abs(steps[:,0])):.3f} 最大 {np.abs(steps[:,0]).max():.2f}"
          f"   |dx| 中位 {np.median(np.abs(steps[:,1])):.3f} 最大 {np.abs(steps[:,1]).max():.2f}")
    print(f"需要补的位移：|dy| 最大 {np.abs(delta[:,0]).max():.2f}  |dx| 最大 {np.abs(delta[:,1]).max():.2f}")
    big = np.nonzero((np.abs(delta[:, 0]) > 0.25) | (np.abs(delta[:, 1]) > 0.25))[0]
    print(f"位移超过 0.25px 的帧：{len(big)}  {[int(x) for x in big[:20]]}")

    before = [float(np.abs(frames[i].astype(np.int16) - frames[i-1].astype(np.int16)).mean(-1)[
        (alphas[i] > 8) | (alphas[i-1] > 8)].mean()) for i in range(1, n)]
    if args.dry_run:
        print(f"修补前：角色区帧间差 中位 {np.median(before):.2f} 最大 {max(before):.2f}")
        print("--dry-run：不写文件"); return 0

    out = []
    for i, f in enumerate(frames):
        dy, dx = -delta[i, 0], -delta[i, 1]
        if abs(dy) < 0.01 and abs(dx) < 0.01:
            out.append(f); continue
        sh = np.stack([ndimage.shift(f[..., c].astype(np.float32), (dy, dx), order=1, mode="nearest")
                       for c in range(4)], axis=-1)
        out.append(np.clip(sh, 0, 255).astype(np.uint8))

    after = [float(np.abs(out[i].astype(np.int16) - out[i-1].astype(np.int16)).mean(-1)[
        (out[i][...,3] > 8) | (out[i-1][...,3] > 8)].mean()) for i in range(1, n)]
    print(f"修补前：角色区帧间差 中位 {np.median(before):.2f} 最大 {max(before):.2f}")
    print(f"修补后：角色区帧间差 中位 {np.median(after):.2f} 最大 {max(after):.2f}")

    dst = Path(args.out) if args.out else src.with_suffix(".stab.webm")
    enc = subprocess.Popen([ffexe("ffmpeg"), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                            "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-",
                            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", str(args.crf),
                            "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "3", str(dst)],
                           stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    for g in out:
        enc.stdin.write(g.tobytes())
    enc.stdin.close()
    err = enc.stderr.read().decode("utf-8", "replace")
    if enc.wait() != 0:
        print("编码失败：", err[-800:]); return 1
    print(f"✔ 写出 {dst}（{dst.stat().st_size//1024} KB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())