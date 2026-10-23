"""体检一段绿幕视频：能不能直接喂 pet-pack 的流水线。

输出：逐秒的构图/背景数值、帧间漂移、缩放变化、边缘溢色、首尾帧一致性、水印嫌疑。
用法：python video-audit.py 视频.mp4 [--every 10] [--sheet 输出.png]
"""
import argparse
import colorsys
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")
HUE_LO, HUE_HI, SAT_MIN, VAL_MIN = 70.0, 170.0, 0.15, 0.15
ANAL_W, ANAL_H = 640, 360


def probe(path: Path) -> dict:
    out = subprocess.run(
        [str(FFDIR / "ffprobe.exe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames,codec_name",
         "-show_entries", "format=duration",
         "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    st = d["streams"][0]
    num, _, den = st["r_frame_rate"].partition("/")
    return {
        "w": st["width"], "h": st["height"],
        "fps": float(num) / float(den or 1),
        "frames": int(st.get("nb_frames") or 0),
        "codec": st["codec_name"],
        "dur": float(d.get("format", {}).get("duration") or 0),
        "audio": any(s.get("codec_type") == "audio" for s in d.get("streams", [])),
    }


def read_frames(path: Path, w: int, h: int):
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
    p.stdout.close()
    p.stderr.close()
    p.wait()


def hsv(rgb: np.ndarray):
    a = rgb.astype(np.float32) / 255.0
    mx = a.max(axis=-1)
    mn = a.min(axis=-1)
    d = mx - mn
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.zeros_like(mx)
    m = d > 1e-6
    idx = m & (mx == r)
    h[idx] = ((g - b)[idx] / d[idx]) % 6
    idx = m & (mx == g)
    h[idx] = ((b - r)[idx] / d[idx]) + 2
    idx = m & (mx == b)
    h[idx] = ((r - g)[idx] / d[idx]) + 4
    h *= 60.0
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    return h, s, mx


def biggest(mask: np.ndarray) -> np.ndarray:
    try:
        from scipy import ndimage
    except ImportError:
        return mask
    lab, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def analyse_frame(rgb: np.ndarray):
    h, s, v = hsv(rgb)
    keyable = (h >= HUE_LO) & (h <= HUE_HI) & (s >= SAT_MIN) & (v >= VAL_MIN)
    char = biggest(~keyable)
    if char.sum() < 200:
        return None
    ys, xs = np.nonzero(char)
    H, W = rgb.shape[:2]
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()

    # 边框（外 8px）颜色离散度 = 背景是否单一纯色
    b = 8
    border = np.concatenate([
        rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3),
        rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)])
    border_med = np.median(border, axis=0)
    border_std = float(border.std(axis=0).mean())

    # 背景上下亮度差（有地面/阴影会明显）
    bg = keyable
    top_m = bg[: H // 3]
    bot_m = bg[2 * H // 3:]
    bt = float(np.median(v[: H // 3][top_m])) if top_m.any() else 1.0
    bb = float(np.median(v[2 * H // 3:][bot_m])) if bot_m.any() else 1.0

    # 角色内缘 1~4px 的绿偏移
    try:
        from scipy import ndimage
        er = ndimage.binary_erosion
        ring = er(char, iterations=1) & ~er(char, iterations=4)
        green_bias = float((rgb[..., 1].astype(np.int16) - np.maximum(
            rgb[..., 0], rgb[..., 2]).astype(np.int16))[ring].mean()) if ring.any() else 0.0
        gb_hot = float((((rgb[..., 1].astype(np.int16) - np.maximum(
            rgb[..., 0], rgb[..., 2]).astype(np.int16))[ring]) > 15).mean()) * 100 if ring.any() else 0.0
    except ImportError:
        green_bias, gb_hot = 0.0, 0.0

    return {
        "top%": 100 * y0 / H, "bot%": 100 * (y1 + 1) / H,
        "cx%": 100 * (x0 + x1) / 2 / W, "h%": 100 * (y1 - y0 + 1) / H,
        "w%": 100 * (x1 - x0 + 1) / W,
        "char_px": int(char.sum()),
        "border_rgb": border_med.astype(int).tolist(), "border_std": border_std,
        "bright_top": bt, "bright_bot": bb,
        "spill": green_bias, "spill_hot%": gb_hot,
        "keyable%": 100 * float(keyable.mean()),
        "mask": char, "rgb": rgb,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--every", type=int, default=10, help="每隔多少帧取一帧分析")
    ap.add_argument("--sheet", default=None)
    args = ap.parse_args()
    path = Path(args.video)
    meta = probe(path)
    print(f"文件：{path.name}  {path.stat().st_size / 1024 / 1024:.1f} MB")
    print(f"规格：{meta['w']}x{meta['h']} @{meta['fps']:g}fps  {meta['dur']:.2f}s  "
          f"{meta['frames'] or '?'} 帧  {meta['codec']}  音轨={'有' if meta['audio'] else '无'}")
    print()

    rows, first, last, prev = [], None, None, None
    jumps = []
    idx = 0
    for f in read_frames(path, ANAL_W, ANAL_H):
        if idx % args.every == 0:
            r = analyse_frame(f)
            if r:
                r["i"] = idx
                r["t"] = idx / meta["fps"]
                rows.append(r)
                if first is None:
                    first = r
                last = r
        if prev is not None:
            d = np.abs(f.astype(np.int16) - prev.astype(np.int16)).mean()
            jumps.append((idx, float(d)))
        prev = f
        idx += 1
    frames_total = idx
    if not rows:
        print("解不出有效帧"); return 1

    print(f"{'时间':>6} {'头顶%':>6} {'脚底%':>6} {'高度%':>6} {'中心x%':>7} {'边框RGB':>16} {'离散':>5} {'上/下亮度':>10} {'溢色':>6} {'超标%':>6}")
    for r in rows:
        print(f"{r['t']:6.1f} {r['top%']:6.1f} {r['bot%']:6.1f} {r['h%']:6.1f} {r['cx%']:7.1f} "
              f"{str(r['border_rgb']):>16} {r['border_std']:5.1f} {r['bright_top']:4.2f}/{r['bright_bot']:4.2f} "
              f"{r['spill']:+6.1f} {r['spill_hot%']:6.1f}")

    print()
    print("== 汇总 ==")
    tops = np.array([r["top%"] for r in rows])
    bots = np.array([r["bot%"] for r in rows])
    hs = np.array([r["h%"] for r in rows])
    cxs = np.array([r["cx%"] for r in rows])
    print(f"· 帧数 {frames_total}，采样 {len(rows)} 帧")
    print(f"· 头顶 {tops.min():.1f}~{tops.max():.1f}%   脚底 {bots.min():.1f}~{bots.max():.1f}%   高度 {hs.min():.1f}~{hs.max():.1f}%")
    print(f"· 中心 x 漂移 {cxs.min():.1f}~{cxs.max():.1f}%（跨度 {cxs.max()-cxs.min():.1f}%）")
    print(f"· 边框色 {rows[0]['border_rgb']}，离散度 {max(r['border_std'] for r in rows):.1f}")
    print(f"· 溢色均值 {np.mean([r['spill'] for r in rows]):+.1f}，超标像素 {np.mean([r['spill_hot%'] for r in rows]):.1f}%")
    print(f"· 背景可键像素 {np.mean([r['keyable%'] for r in rows]):.1f}%")

    # 首尾帧
    if first and last and first is not last:
        a, b = first["mask"], last["mask"]
        iou = float((a & b).sum() / max((a | b).sum(), 1))
        both = a & b
        diff = float(np.abs(first["rgb"][both].astype(np.int16) - last["rgb"][both].astype(np.int16)).mean()) if both.any() else -1
        print(f"· 首尾帧：轮廓 IoU {iou*100:.1f}%，重叠区像素差 {diff:.1f}")

    # 帧间跳变（相对总动态）
    if jumps:
        mx = max(jumps, key=lambda x: x[1])
        print(f"· 帧间最大变化 {mx[1]:.2f}（第 {mx[0]} 帧）")

    # 水印嫌疑：四角里出现非绿的大块
    print()
    print("== 判定 ==")
    warn = []
    if tops.min() < 10:
        warn.append(f"头顶最高到 {tops.min():.1f}%（<10%）：举手/跳跃会顶出画幅")
    if bots.max() > 88:
        warn.append(f"脚底最低到 {bots.max():.1f}%（>88%）：离底边太近")
    if hs.max() - hs.min() > 12:
        warn.append(f"高度变化 {hs.max()-hs.min():.1f}%（>12%）：镜头在推拉，换动画会忽大忽小")
    if cxs.max() - cxs.min() > 4:
        warn.append(f"中心漂移 {cxs.max()-cxs.min():.1f}%：角色在横向移动（应零位移）")
    if max(r["border_std"] for r in rows) > 12:
        warn.append(f"边框离散度 {max(r['border_std'] for r in rows):.1f}（>12）：背景不是单一纯色")
    worst_bt = min(r["bright_top"] / max(r["bright_bot"], 1e-6) for r in rows)
    if worst_bt < 0.88:
        warn.append(f"上下亮度比低到 {worst_bt:.2f}：有阴影/地面/暗角")
    if np.mean([r["spill_hot%"] for r in rows]) > 12:
        warn.append(f"边缘染绿 {np.mean([r['spill_hot%'] for r in rows]):.1f}%：抠像后会有绿边")
    print("\n".join("  ! " + w for w in warn) if warn else "  ✔ 没有发现结构性问题")
    return 0


if __name__ == "__main__":
    sys.exit(main())