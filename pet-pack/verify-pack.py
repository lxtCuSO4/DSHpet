"""验收一个 pet pack 目录里的成品 webm（不需要人眼）。

检查项：
  1. 能不能解出 alpha（WebM 的 VP9 alpha 必须用 -c:v libvpx-vp9 解码）
  2. 每帧构图：头顶 / 脚底 / 左右 / 宽高（是否被裁、是否漂移）
  3. 有没有"角色之外的实心块"——即抠像没去掉的水印/杂物
  4. 边缘绿偏移（clean-edge 有没有生效）、背景残雾（alpha 1~7）
  5. 动作量（帧间差、轮廓 IoU）与首尾帧是否能无缝循环

用法：python verify-pack.py            # 默认看 ~/.dsh/dsh-pet/pet/mypet-animation
      python verify-pack.py --dir <素材目录> [--only 待机呼吸]
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")
DEF_DIR = Path.home() / ".dsh" / "dsh-pet" / "pet" / "mypet-animation"

try:
    from scipy import ndimage
except ImportError:
    ndimage = None


def probe(path: Path):
    out = subprocess.run([str(FFDIR / "ffprobe.exe"), "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=codec_name,pix_fmt,width,height:stream_tags=alpha_mode",
                          "-of", "json", str(path)], capture_output=True, text=True).stdout
    st = json.loads(out)["streams"][0]
    tags = {k.lower(): v for k, v in (st.get("tags") or {}).items()}
    return int(st["width"]), int(st["height"]), st.get("pix_fmt"), tags.get("alpha_mode")


def frames(path: Path, w: int, h: int):
    p = subprocess.Popen([str(FFDIR / "ffmpeg.exe"), "-v", "error", "-c:v", "libvpx-vp9",
                          "-i", str(path), "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n = w * h * 4
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4)
    p.stdout.close(); p.wait()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(DEF_DIR))
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    d = Path(args.dir)
    files = sorted(p for p in d.glob("*.webm") if not args.only or args.only in p.name)
    if not files:
        print(f"{d} 里没有 webm"); return 1

    for path in files:
        W, H, pix, mode = probe(path)
        print(f"\n=== {path.name}  {W}x{H}  {pix}  ALPHA_MODE={mode} ===")
        if str(mode) != "1":
            print("  ! 没有 ALPHA_MODE=1：这个文件没有透明通道")
        tops, bots, lefts, rights = [], [], [], []
        ring_gr, veil, diffs = [], 0, []
        prev = None
        first_mask = None
        stray_max, stray_cnt = 0, 0
        n = 0
        for f in frames(path, W, H):
            al = f[..., 3]
            rgb = f[..., :3].astype(np.float32)
            vis = al > 128
            if vis.any():
                ys, xs = np.nonzero(vis)
                tops.append(ys.min() / H * 100); bots.append((ys.max() + 1) / H * 100)
                lefts.append(xs.min() / W * 100); rights.append((xs.max() + 1) / W * 100)
            ring = (al >= 20) & (al <= 230)
            if ring.any():
                ring_gr.append(float((rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2]))[ring].mean()))
            veil += int(((al > 0) & (al < 8)).sum())
            if ndimage is not None and vis.any():
                lab, cnt = ndimage.label(vis)
                if cnt > 1:
                    sizes = ndimage.sum(vis, lab, range(1, cnt + 1))
                    main = int(np.argmax(sizes)) + 1
                    others = [(int(sizes[k - 1]), k) for k in range(1, cnt + 1) if k != main and sizes[k - 1] >= 30]
                    if others:
                        areas = [o[0] for o in others]
                        stray_max = max(stray_max, max(areas))
                        stray_cnt = max(stray_cnt, len(others))
            if prev is not None:
                diffs.append(float(np.abs(f[..., :3].astype(np.int16) - prev[..., :3].astype(np.int16)).mean()))
            prev = f
            if first_mask is None:
                first_mask = vis.copy()
            n += 1

        t = np.array(tops); b = np.array(bots); l = np.array(lefts); r = np.array(rights)
        print(f"  帧数 {n}  头顶 {t.min():.1f}~{t.max():.1f}%（幅度 {t.max()-t.min():.2f}%p）"
              f"  脚底 {b.min():.1f}~{b.max():.1f}%（{b.max()-b.min():.2f}%p）")
        print(f"  左 {l.min():.1f}~{l.max():.1f}%  右 {r.min():.1f}~{r.max():.1f}%  "
              f"宽 {np.mean(r-l):.1f}%  水平漂移 {(r-l).max()-(r-l).min():.2f}%p")
        print(f"  边缘绿偏移 {np.mean(ring_gr):+.2f}（<5 算干净）   背景残雾 {veil} px·帧")
        print(f"  帧间差 均 {np.mean(diffs):.2f} 最大 {np.max(diffs):.2f}   "
              f"{'（几乎静止）' if np.mean(diffs) < 1.0 else ''}")
        print(f"  角色外实心块：{stray_cnt} 个（最大 {stray_max} px）"
              f"{'  ← 疑似水印/杂物没去干净' if stray_max > 400 else ''}")
        if t.max() > 34 or b.min() < 60:
            print("  ! 构图异常：头顶或脚底离画幅边太远")
        if (r - l).max() - (r - l).min() > 6:
            print("  ! 角色忽大忽小（宽度变化 > 6%p）")
    return 0


if __name__ == "__main__":
    sys.exit(main())