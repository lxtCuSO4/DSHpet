"""找出画面里"静止不动、不在角色身上"的叠加物（水印/logo），给出可涂绿的矩形。

只管右下这类：面积不大、位置在角色包围盒之外、多帧之间坐标完全不变。
识别不出来就什么都不输出（宁可不涂，也不能把发丝/配件涂掉）。

用法：
  python find-watermark.py 视频.mp4                 # 人看
  python find-watermark.py 视频.mp4 --box           # 只输出 x,y,w,h（给 build.cmd -MaskBox）
"""
import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")

try:
    from scipy import ndimage
except ImportError:
    ndimage = None


def green(rgb: np.ndarray) -> np.ndarray:
    """与 chroma_step02.py 完全一致的绿幕判据（hue 70~170, S/V >= 0.15）。"""
    a = rgb.astype(np.float32) / 255.0
    mx = a.max(-1); mn = a.min(-1); d = mx - mn
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.zeros_like(mx); m = d > 1e-6
    i = m & (mx == r); h[i] = ((g - b)[i] / d[i]) % 6
    i = m & (mx == g); h[i] = ((b - r)[i] / d[i]) + 2
    i = m & (mx == b); h[i] = ((r - g)[i] / d[i]) + 4
    h *= 60.0
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    return (h >= 70) & (h <= 170) & (s >= 0.15) & (mx >= 0.15)


def probe(path: Path):
    out = subprocess.run([str(FFDIR / "ffprobe.exe"), "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True).stdout.strip().split(",")
    return int(out[0]), int(out[1]), int(out[2] or 0)


def frame_at(path: Path, idx: int, tmp: Path) -> np.ndarray:
    dst = tmp / f"wm_{idx}.png"
    subprocess.run([str(FFDIR / "ffmpeg.exe"), "-y", "-v", "error", "-i", str(path),
                    "-vf", f"select=eq(n\\,{idx})", "-vsync", "0", "-frames:v", "1", str(dst)], check=True)
    return np.asarray(Image.open(dst).convert("RGB"))


def detect(path: Path, tmp: Path, samples=5, quiet=False):
    if ndimage is None:
        raise SystemExit("需要 scipy：pip install scipy")
    W, H, nb = probe(path)
    if nb <= 0:
        nb = 300
    rects, stray = [], []
    for k in range(samples):
        idx = min(int(round(k * (nb - 1) / max(samples - 1, 1))), nb - 1)
        f = frame_at(path, idx, tmp)
        ch = ~green(f)
        lab, n = ndimage.label(ndimage.binary_closing(ch, iterations=2))
        if n == 0:
            return None
        sizes = ndimage.sum(ch, lab, range(1, n + 1))
        main = int(np.argmax(sizes)) + 1
        ys, xs = np.nonzero(lab == main)
        mbox = (xs.min(), xs.max(), ys.min(), ys.max())
        cand = []
        for kk in range(1, n + 1):
            if kk == main:
                continue
            m = lab == kk
            if m.sum() < 20:                       # 噪点
                continue
            ys2, xs2 = np.nonzero(m)
            bb = (int(xs2.min()), int(xs2.max()), int(ys2.min()), int(ys2.max()))
            if bb[0] > mbox[1] or bb[1] < mbox[0]:  # 水平方向与角色完全分开
                cand.append((int(m.sum()), bb))
            else:
                stray.append((idx, int(m.sum()), bb))
        if not cand:
            return None
        rects.append((min(c[1][0] for c in cand), max(c[1][1] for c in cand),
                      min(c[1][2] for c in cand), max(c[1][3] for c in cand), len(cand)))
    # 各帧矩形必须一致（静止叠加物）；坑位：会动的道具
    base = rects[0]
    for r in rects[1:]:
        if max(abs(r[i] - base[i]) for i in range(4)) > 4:
            if not quiet:
                print(f"  ! 形状在各帧间不一致：{[r[:4] for r in rects]}，不确定是水印，不涂")
            return None
    if stray and not quiet:
        print(f"  · 另有 {len(stray)} 个与角色重叠的独立块（发丝/配饰），不动它们：{stray[:2]}")
    pad = max(6, int(0.004 * W))
    x0 = max(base[0] - pad, 0); y0 = max(base[2] - pad, 0)
    x1 = min(base[1] + pad, W - 1); y1 = min(base[3] + pad, H - 1)
    return dict(x=x0, y=y0, w=x1 - x0 + 1, h=y1 - y0 + 1, pieces=base[4], W=W, H=H)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--box", action="store_true", help="只打印 x,y,w,h")
    ap.add_argument("--samples", type=int, default=5)
    args = ap.parse_args()
    path = Path(args.video)
    tmp = Path(__file__).with_name("_tmp")
    tmp.mkdir(exist_ok=True)
    r = detect(path, tmp, args.samples, quiet=args.box)
    if not r:
        if args.box:
            print("")
        else:
            print(f"{path.name}: 没找到静止的叠加物（或与角色重叠，不能涂）")
        return 0
    if args.box:
        print(f"{r['x']},{r['y']},{r['w']},{r['h']}")
    else:
        print(f"{path.name}: 疑似水印 x[{r['x']}..{r['x']+r['w']-1}] y[{r['y']}..{r['y']+r['h']-1}]  "
              f"{r['w']}x{r['h']}  占画幅 x {100*r['x']/r['W']:.1f}%~{100*(r['x']+r['w'])/r['W']:.1f}%  "
              f"y {100*r['y']/r['H']:.1f}%~{100*(r['y']+r['h'])/r['H']:.1f}%")
        print(f"  -MaskBox {r['x']},{r['y']},{r['w']},{r['h']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())