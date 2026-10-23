"""检查一张「绿幕图」能不能直接进 chroma_step02 —— 用仓库同一套判据，30 秒出结论。

为什么要单独检：绿幕不是"看着绿"就行。宿主脚本 chroma_step02.py 的判据是
    GREEN_HUE_MIN=70 / GREEN_HUE_MAX=170 / SATURATION_MIN=0.15 / VALUE_MIN=0.15 / HUE_FEATHER=6.0
（hue 0~360，纯绿 #00FF00 = 120°）。所以偏黄绿、偏青绿都还能救，但**渐变、阴影、地板、
角色边缘被绿光污染**这四样会让它抠出毛边或吃掉裙子。

用法：
    python check-green.py 候选图.png
    python check-green.py 候选图.png --size 1920x1080    # 顺带查构图（头顶/脚底比例）

退出码：0=能过，1=能用但有瑕疵，2=不是绿幕图
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from scipy import ndimage as ndi
except Exception:  # noqa: BLE001
    ndi = None

# 与 dsh-pet/scripts/chroma_step02.py 对齐（hue 0~360，纯绿 = 120°）
GREEN_HUE_MIN, GREEN_HUE_MAX = 70.0, 170.0
SATURATION_MIN, VALUE_MIN = 0.15, 0.15
HUE_FEATHER = 6.0


def rgb_to_hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """rgb int16 (H,W,3) → (hue 0~360, sat 0~1, val 0~1)，与 chroma_step02.py 同口径。"""
    r, g, b = [rgb[..., i].astype(np.float32) / 255.0 for i in range(3)]
    mx = np.max(rgb, axis=-1).astype(np.float32) / 255.0
    mn = np.min(rgb, axis=-1).astype(np.float32) / 255.0
    diff = mx - mn
    nz = diff > 1e-6
    hue = np.zeros_like(mx)

    rm = nz & (mx == r)
    gm = nz & (mx == g) & ~rm
    bm = nz & (mx == b) & ~rm & ~gm
    hue[rm] = (60.0 * ((g[rm] - b[rm]) / diff[rm])) % 360.0
    hue[gm] = 60.0 * ((b[gm] - r[gm]) / diff[gm]) + 120.0
    hue[bm] = 60.0 * ((r[bm] - g[bm]) / diff[bm]) + 240.0

    sat = np.where(mx > 1e-6, diff / np.maximum(mx, 1e-6), 0.0)
    return hue, sat, mx


def border_ring(rgb: np.ndarray, ring: int = 3) -> np.ndarray:
    return np.concatenate([
        rgb[:ring, :, :].reshape(-1, 3), rgb[-ring:, :, :].reshape(-1, 3),
        rgb[:, :ring, :].reshape(-1, 3), rgb[:, -ring:, :].reshape(-1, 3),
    ])


def biggest(mask: np.ndarray) -> np.ndarray:
    """只留最大连通块（去掉零散脏点），没有 scipy 就原样返回。"""
    if ndi is None or not mask.any():
        return mask
    lab, n = ndi.label(mask)
    if n <= 1:
        return mask
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def main() -> int:
    ap = argparse.ArgumentParser(description="绿幕图合格性检查（判据对齐 chroma_step02.py）")
    ap.add_argument("src", type=Path)
    ap.add_argument("--size", help="期望画布，例如 1920x1080：给了就顺带查画布尺寸")
    ap.add_argument("--tol", type=float, default=40.0, help="判「纯背景色」的 RGB 距离容差，默认 40")
    ap.add_argument("--spill", type=float, default=3.5, help="过渡带宽度阈值（px），默认 3.5")
    args = ap.parse_args()

    if not args.src.exists():
        raise SystemExit(f"找不到 {args.src}")
    rgb = np.asarray(Image.open(args.src).convert("RGB")).astype(np.int16)
    h, w = rgb.shape[:2]
    ok = True
    print(f"· {args.src.name}  {w}x{h}")

    # ── 1) 背景色是否单一 ──────────────────────────────────────────────
    ring = border_ring(rgb).astype(np.float64)
    bg_color = np.median(ring, axis=0)
    spread = float(ring.std(axis=0).max())
    print(f"· 边框色中位数 RGB {tuple(int(c) for c in bg_color)}   离散度 {spread:.1f}")
    if spread > 12:
        print("  ! 边框颜色不统一：背景可能有渐变/暗角/物体入画")
        ok = False

    # ── 2) 背景色是否落在 chroma 的绿色区间 ────────────────────────────
    bh, bs, bv = rgb_to_hsv(np.array([[bg_color]], dtype=np.int16))
    bh, bs, bv = float(bh[0, 0]), float(bs[0, 0]), float(bv[0, 0])
    in_range = (GREEN_HUE_MIN <= bh <= GREEN_HUE_MAX) and bs >= SATURATION_MIN and bv >= VALUE_MIN
    print(f"· 背景 HSV：H={bh:.1f}°(0~360, 纯绿=120)  S={bs:.2f}  V={bv:.2f}"
          f"   → {'落在 70~170 绿色区间' if in_range else '不在绿色区间'}")
    if not in_range:
        print("  × 背景不是可键的绿色（偏黄/偏青/太暗都算）：换 #00FF00 生成")
        return 2

    # ── 3) 逐像素分类 ────────────────────────────────────────────────
    hue, sat, val = rgb_to_hsv(rgb)
    keyable = (hue >= GREEN_HUE_MIN) & (hue <= GREEN_HUE_MAX) & (sat >= SATURATION_MIN) & (val >= VALUE_MIN)
    dist = np.sqrt(((rgb - bg_color) ** 2).sum(axis=2))
    pure_bg = dist <= args.tol
    print(f"· 可被键掉的像素 {keyable.mean() * 100:.1f}%（剩下的会被当成角色保留）")
    if keyable.mean() < 0.35:
        print("  × 大部分区域键不掉：这不是绿幕图")
        return 2

    char = biggest(~keyable)
    if not char.any():
        print("  × 找不到角色（整张都是绿色）")
        return 2
    stray = ~keyable & ~char
    if stray.mean() > 0.005:
        print(f"  ! 背景里还有 {stray.sum()} 个不属于角色的非绿像素"
              f"（{stray.mean() * 100:.1f}%）：可能是有阴影/地板/杂物，键完会留残留")
        ok = False

    # ── 4) 上下亮度差：地板/阴影的典型特征（按"可键"统计，压暗的绿也还是绿）──────
    band_h = max(1, h // 5)
    top_sel, bot_sel = np.zeros_like(char), np.zeros_like(char)
    top_sel[:band_h] = True
    bot_sel[h - band_h:] = True
    t_px, b_px = keyable & top_sel, keyable & bot_sel
    if t_px.any() and b_px.any():
        v_top, v_bot = float(np.median(val[t_px])), float(np.median(val[b_px]))
        print(f"· 背景亮度：上 {v_top:.2f} / 下 {v_bot:.2f}（差 {abs(v_top - v_bot):.2f}）")
        if abs(v_top - v_bot) > 0.12:
            print("  ! 上下亮度差过大：疑似有阴影/渐变/地板，键完会留灰边")
            ok = False

    # ── 5) 过渡带宽度：绿光溢色的量化指标 ──────────────────────────────
    # 干净绿幕只有 1~2px 的抗锯齿过渡带；被绿光染色的图会有 6~10px。
    if ndi is not None:
        perimeter = int((char & ~ndi.binary_erosion(char, iterations=1)).sum())
        near = ndi.binary_dilation(char, iterations=12)
        trans = keyable & ~pure_bg & near
        ratio = trans.sum() / max(perimeter, 1)
        print(f"· 过渡带宽度 ≈ {ratio:.1f}px（干净绿幕 1~3px；>3.5 说明角色被绿光染了）")
        if ratio > args.spill:
            print("  ! 绿光溢色：抠完裙子/头发边缘会发绿、起毛刺 —— 重新生成时要求"
                  "「角色不要被绿色环境光照亮，边缘不要有绿色反射」")
            ok = False

        # 5b) 轮廓内 1~4px 的绿色偏移：比"过渡带宽"更灵 —— 边缘被绿光染过时这里会明显发绿
        # 轮廓用"离纯背景色最远的连通块"（~pure_bg）：char 由"不可键"得出，被绿染的边已被排除，
        # 拿它当基准会正好跳过污染带。
        sil = biggest(~pure_bg)
        ring = ndi.binary_erosion(sil, iterations=1) & ~ndi.binary_erosion(sil, iterations=4)
        if ring.sum() > 200:
            gg = rgb[..., 1][ring].astype(np.float32)
            lim = np.maximum(rgb[..., 0][ring], rgb[..., 2][ring]).astype(np.float32)
            bias = float(np.mean(gg - lim))
            hot = float(np.mean((gg - lim) > 25) * 100)
            print(f"· 轮廓内 1~4px 绿色偏移 {bias:+.1f}（>15 或超标像素 >15% 说明边缘被绿光染了；{hot:.1f}% 偏高）")
            if bias > 15 or hot > 15:
                print("  ! 边缘溢色：这张图拿去重新抠一次会明显泛绿。"
                      "要么直接当首帧用（不再重抠），要么用 sticker-to-green.py --despill 6 再走一遍")
                ok = False
    else:
        print("· （没装 scipy，跳过溢色与连通域检查）")

    # ── 6) 构图 ─────────────────────────────────────────────────────
    ys, xs = np.where(char)
    x1, x2, y1, y2 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    top_pct, bot_pct = y1 / h * 100, (y2 + 1) / h * 100
    print(f"· 角色 x[{x1}..{x2}] y[{y1}..{y2}]  {x2 - x1 + 1}x{y2 - y1 + 1}  "
          f"头顶 {top_pct:.1f}%  脚底 {bot_pct:.1f}%  左 {x1 / w * 100:.1f}%  右 {(x2 + 1) / w * 100:.1f}%")
    if not (15 <= top_pct <= 30):
        print(f"  ! 头顶 {top_pct:.1f}% 不在 15%~30%：可灵一推镜头就裁头发")
        ok = False
    if not (75 <= bot_pct <= 92):
        print(f"  ! 脚底 {bot_pct:.1f}% 不在 75%~92%：脚可能被裁，或脚下留太多绿（会显得悬空）")
        ok = False
    if x1 < w * 0.08 or x2 > w * 0.92:
        print("  ! 角色贴左右边：手部动作会出画")
        ok = False

    if args.size:
        try:
            ew, eh = (int(v) for v in args.size.lower().split("x"))
        except ValueError:
            raise SystemExit(f"--size 格式应为 宽x高（收到 {args.size}）")
        if (w, h) != (ew, eh):
            print(f"  ! 画布 {w}x{h} ≠ 期望 {ew}x{eh}：可灵按首帧比例出片，比例不一致会加黑边")
            ok = False

    print()
    print("结论：" + ("✔ 可以直接进可灵（出了 mp4 交给 build.cmd，chroma 会抠干净）" if ok else
                    "△ 能用但有瑕疵，见上面 ! 行 —— 抠像阶段会放大这些问题"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())