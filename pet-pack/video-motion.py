"""看一段视频"到底动没动"、水里有没有水印。

与 video-audit.py 的分工：audit 看构图/背景/溢色（能不能喂流水线），
这个看运动量与画面里除角色外还有没有别的东西（会不会看起来像张静止图）。

用法：python video-motion.py 视频.mp4 [--scale 480]
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")
HUE_LO, HUE_HI, SAT_MIN, VAL_MIN = 70.0, 170.0, 0.15, 0.15


def probe(path: Path):
    out = subprocess.run(
        [str(FFDIR / "ffprobe.exe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
         "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    st = json.loads(out)["streams"][0]
    num, _, den = st["r_frame_rate"].partition("/")
    return int(st["width"]), int(st["height"]), float(num) / float(den or 1), int(st.get("nb_frames") or 0)


def frames(path: Path, w: int, h: int):
    p = subprocess.Popen(
        [str(FFDIR / "ffmpeg.exe"), "-v", "error", "-i", str(path),
         "-vf", f"scale={w}:{h}:flags=area", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    n = w * h * 3
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
    p.stdout.close(); p.stderr.close(); p.wait()


def green_mask(rgb):
    a = rgb.astype(np.float32) / 255.0
    mx = a.max(-1); mn = a.min(-1); d = mx - mn
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.zeros_like(mx); m = d > 1e-6
    i = m & (mx == r); h[i] = ((g - b)[i] / d[i]) % 6
    i = m & (mx == g); h[i] = ((b - r)[i] / d[i]) + 2
    i = m & (mx == b); h[i] = ((r - g)[i] / d[i]) + 4
    h *= 60.0
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    return (h >= HUE_LO) & (h <= HUE_HI) & (s >= SAT_MIN) & (mx >= VAL_MIN)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--scale", type=int, default=480, help="分析宽度")
    args = ap.parse_args()
    path = Path(args.video)
    W, H, fps, nb = probe(path)
    aw, ah = args.scale, round(args.scale * H / W)

    boxes, diffs, prev, first_frame = [], [], None, None
    comp_stats = None
    idx = 0
    for f in frames(path, aw, ah):
        gm = green_mask(f)
        char = ~gm
        ys, xs = np.nonzero(char)
        if len(ys):
            boxes.append((idx, ys.min(), ys.max(), xs.min(), xs.max(), char.sum()))
        if first_frame is None:
            first_frame = f
            try:
                from scipy import ndimage
                lab, n = ndimage.label(char)
                sizes = ndimage.sum(char, lab, range(1, n + 1))
                order = np.argsort(sizes)[::-1]
                comp_stats = [(int(sizes[k]), lab == k + 1) for k in order[:5]]
            except ImportError:
                comp_stats = None
        if prev is not None:
            diffs.append((idx, float(np.abs(f.astype(np.int16) - prev.astype(np.int16)).mean())))
        prev = f
        idx += 1

    print(f"{path.name}: {W}x{H} @{fps:g}fps  解出 {idx} 帧（探测 {nb}）")
    if not boxes:
        print("没有检测到角色（全绿？）"); return 1

    b = np.array([(x[1], x[2], x[3], x[4]) for x in boxes], dtype=float)
    tops, bots, lefts, rights = b[:, 0] / ah * 100, (b[:, 1] + 1) / ah * 100, b[:, 2] / aw * 100, (b[:, 3] + 1) / aw * 100
    cxs = (lefts + rights) / 2
    heights = bots - tops
    print(f"· 头顶 {tops.min():.1f}~{tops.max():.1f}%（幅度 {tops.max()-tops.min():.2f}%p）")
    print(f"· 脚底 {bots.min():.1f}~{bots.max():.1f}%（幅度 {bots.max()-bots.min():.2f}%p）")
    print(f"· 高度 {heights.min():.1f}~{heights.max():.1f}%（幅度 {heights.max()-heights.min():.2f}%p）")
    print(f"· 中心x {cxs.min():.1f}~{cxs.max():.1f}%（漂移 {cxs.max()-cxs.min():.2f}%p）")

    d = np.array([x[1] for x in diffs])
    print(f"· 帧间像素差：均 {d.mean():.2f}  中位 {np.median(d):.2f}  最大 {d.max():.2f}"
          f"  >1 的帧 {int((d > 1).sum())}/{len(d)}")
    # 连续帧完全相同（冻结）
    frozen = int((d == 0).sum())
    print(f"· 逐帧几乎不变（差=0）的帧：{frozen}")

    if comp_stats:
        print("· 首帧连通块（面积, 是否主角色）：")
        for k, (sz, m) in enumerate(comp_stats):
            ysb, xsb = np.nonzero(m)
            print(f"    #{k} 面积 {sz:6d}px  位置 x[{xsb.min()}-{xsb.max()}] y[{ysb.min()}-{ysb.max()}]")

    # 四角：水印常压在角落
    print("· 四角 12% 区域内的非绿像素占比：")
    cw, ch = int(aw * 0.12), int(ah * 0.12)
    gm_first = green_mask(first_frame)
    for name, sl in (("左上", (slice(0, ch), slice(0, cw))), ("右上", (slice(0, ch), slice(aw - cw, aw))),
                     ("左下", (slice(ah - ch, ah), slice(0, cw))), ("右下", (slice(ah - ch, ah), slice(aw - cw, aw)))):
        sub = ~gm_first[sl]
        print(f"    {name} {100 * sub.mean():5.2f}%")

    print()
    if d.mean() < 0.5:
        print("判定：几乎静止。整段视频的帧间平均差异 < 0.5/255，桌宠会看起来像一张不能动的图片。")
    elif d.max() < 2:
        print("判定：动得非常少。可能只有极轻微的呼吸感。")
    else:
        print("判定：有动作。")
    return 0


if __name__ == "__main__":
    sys.exit(main())