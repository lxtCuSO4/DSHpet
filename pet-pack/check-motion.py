#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数值化验收 make-motion.py 的输出：不开眼睛也能判断动作对不对。

检查项：
  1. 每帧角色 bbox（按"非绿"判像素）→ 位移曲线是否落在预期范围、有没有出画
  2. 帧间最大跳变（>40px 说明抽帧/插值坏了）
  3. 背景是否仍是纯绿（采样四角与边框中位色）
  4. idle 段首尾帧是否完全一致（循环不跳）
  5. 角色边缘有没有黑边/白边（轮廓内 2px 的 RGB 亮度 vs 角色平均亮度）

用法：python pet-pack\\check-motion.py [--dir _repo\\video] [--fps 24]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PETPACK = HERE.parent
REPO = HERE.parent / "_repo"
FFMPEG = REPO / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe"

GREEN_LO, GREEN_HI, GREEN_FEATHER = 70.0, 170.0, 6.0


def read_frames(mp4: Path, w: int = 1280, h: int = 720) -> np.ndarray:
    cmd = [str(FFMPEG), "-v", "error", "-i", str(mp4),
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(out) // (w * h * 3)
    return np.frombuffer(out[: n * w * h * 3], dtype=np.uint8).reshape(n, h, w, 3)


def char_mask(rgb: np.ndarray) -> np.ndarray:
    """非绿即角色（与 chroma_step02 同一套色相判据）。"""
    f = rgb.astype(np.float32) / 255.0
    mx = f.max(-1)
    mn = f.min(-1)
    v = mx
    s = np.divide(mx - mn, np.maximum(mx, 1e-6))
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    d = np.maximum(mx - mn, 1e-6)
    hh = np.zeros_like(mx)
    m = (mx == r)
    hh[m] = ((g - b)[m] / d[m]) % 6.0
    m = (mx == g) & ~(mx == r)
    hh[m] = ((b - r)[m] / d[m]) + 2.0
    m = (mx == b) & ~(mx == r) & ~(mx == g)
    hh[m] = ((r - g)[m] / d[m]) + 4.0
    hh *= 60.0
    bg = (s >= 0.15) & (v >= 0.15) & (hh >= GREEN_LO) & (hh <= GREEN_HI)
    return ~bg


def bbox_of(mask: np.ndarray):
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def check(mp4: Path, expect_loop: bool):
    frames = read_frames(mp4)
    n, h, w = frames.shape[0], frames.shape[1], frames.shape[2]
    print(f"\n=== {mp4.name}  {n} 帧  {w}x{h} ===")

    boxes, cxs, cy_bottom, cy_top = [], [], [], []
    for i in range(n):
        m = char_mask(frames[i])
        bb = bbox_of(m)
        if bb is None:
            print(f"  [x] 第 {i} 帧找不到角色（整帧都是绿）")
            return False
        boxes.append(bb)
        cxs.append((bb[0] + bb[2]) / 2)
        cy_top.append(bb[1])
        cy_bottom.append(bb[3])

    top_pct = np.array(cy_top) / h * 100
    bot_pct = np.array(cy_bottom) / h * 100
    dy = np.diff(np.array(cy_bottom))
    dx = np.diff(np.array(cxs))

    print(f"  头顶 y%       min {top_pct.min():.1f}%  max {top_pct.max():.1f}%")
    print(f"  脚底 y%       min {bot_pct.min():.1f}%  max {bot_pct.max():.1f}%")
    print(f"  水平中心 x    {min(cxs):.0f} .. {max(cxs):.0f}  (画幅中心 {w/2:.0f})")
    print(f"  帧间位移      向下最大 {dy.max():+.1f}px  向上最大 {dy.min():+.1f}px")
    print(f"  帧间横移      最大 {np.abs(dx).max():.1f}px")
    print(f"  位移总幅度    脚底轨迹跨度 {cy_bottom and (max(cy_bottom)-min(cy_bottom))}px")

    ok = True
    if top_pct.min() < 1.5:
        print(f"  [x] 角色顶到画幅顶边（头顶 {top_pct.min():.1f}%）→ 会裁头发")
        ok = False
    if bot_pct.max() > 99.5:
        print(f"  [x] 角色脚底贴/出画幅底边（{bot_pct.max():.1f}%）")
        ok = False
    if boxes[0][0] < 3 or boxes[-1][2] > w - 3:
        print("  [x] 角色横向贴边")
        ok = False
    if np.abs(dy).max() > 40:
        print(f"  [x] 帧间纵向跳变 {np.abs(dy).max():.1f}px > 40 → 运动不连续")
        ok = False
    if np.abs(dx).max() > 6:
        print(f"  ! 帧间横向漂移 {np.abs(dx).max():.1f}px（应该几乎没有）")

    # 背景纯净度：四角 + 四边中位色
    corners = np.concatenate([frames[0, 0, 0], frames[0, 0, -1], frames[0, -1, 0], frames[0, -1, -1]])
    print(f"  四角颜色      {corners.reshape(4,3).tolist()}")
    edges = np.concatenate([frames[0, 0, :, :], frames[0, -1, :, :]])
    med = np.median(edges, axis=0).astype(int)
    print(f"  上下边框中位色 {med.tolist()}")

    # 黑边/白边：轮廓内 2px 环的亮度 vs 角色整体亮度
    m0 = char_mask(frames[0])
    from scipy import ndimage
    inner = ndimage.binary_erosion(m0, iterations=1) & ~ndimage.binary_erosion(m0, iterations=3)
    ring = frames[0][inner].astype(np.float32)
    body = frames[0][ndimage.binary_erosion(m0, iterations=8)].astype(np.float32)
    if len(ring) and len(body):
        ring_l = ring.mean()
        body_l = body.mean()
        print(f"  内缘亮度      {ring_l:.1f}  角色体内亮度 {body_l:.1f}  差 {body_l - ring_l:+.1f}")
        if ring_l < 60 and body_l > 120:
            print("  [x] 边缘发黑 → 透明区分辨率混合成了黑边")
            ok = False
        if body_l - ring_l > 45:
            print("  ! 内缘明显偏暗，可能有一圈黑/深色描边")

    if expect_loop:
        d = np.abs(frames[0].astype(np.int16) - frames[-1].astype(np.int16))
        same = float((d.max(axis=-1) <= 6).mean()) * 100
        print(f"  首尾帧相同度  {same:.2f}%  （像素级几乎一致 = 循环不跳）")
        if same < 97:
            print(f"  [x] 首尾帧差异过大（{100-same:.2f}% 像素不同）→ 循环会跳")
            ok = False

    print(f"  结论：{'✔ 通过' if ok else '✘ 有问题'}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(REPO / "video"))
    ap.add_argument("--only", default=None)
    args = ap.parse_args()
    d = Path(args.dir)
    clips = sorted(p for p in d.glob("*.mp4") if not p.name.startswith("_"))
    if not clips:
        print(f"[x] {d} 里没有 mp4")
        return 1
    allok = True
    for p in clips:
        if args.only and args.only not in p.stem:
            continue
        allok &= check(p, expect_loop=("待机" in p.stem))
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())