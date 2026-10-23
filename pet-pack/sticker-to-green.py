"""把一张角色形象图压成「绿幕首帧」——给可灵图生视频用的 16:9 纯绿底 PNG。

做的事（顺序固定）：
  1. 读出角色的「不透明区域」：原图有 alpha 就用 alpha；没有就从边框取背景色做色键
  2. 清掉背景 → 只留下角色 + 抗锯齿边缘
  3. 裁到角色外接框，等比缩放到「立高 = 画布高 × --height」
  4. 水平居中、脚底对齐到「画布高 × --feet」，贴到纯 #00FF00 画布上

为什么这么构图：与仓库 prompts 的强制规范一致（头顶 20% / 脚底 85% / 左右 25%~75%），
也恰好是 normalize_step03 的基准，所以你之后生成的动作视频不需要再手动对位。

用法：
    python sticker-to-green.py 我的角色.png                       # 自动判断抠法
    python sticker-to-green.py 我的角色.png -o 绿幕首帧.png --height 0.62
    python sticker-to-green.py 白底图.jpg --key auto --tolerance 34
    python sticker-to-green.py 我的角色.png --erode 1 --feather 1  # 白边/毛边微调
    python sticker-to-green.py 我的角色.png --static-webm 待机呼吸.webm  # 兜底：静止桌宠

依赖：Pillow + numpy（本机已装）。--static-webm 需要 ffmpeg（用仓库 .tools 里那份）。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

try:                                    # 填洞 + 最近色回填要用形态学；没装 scipy 就退化成"只补 alpha"
    from scipy import ndimage as ndi
except Exception:                       # noqa: BLE001
    ndi = None

GREEN = (0, 255, 0, 255)
REPO_FFMPEG = Path(__file__).resolve().parent.parent / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe"


def load_rgba(path: Path) -> Image.Image:
    if not path.exists():
        raise SystemExit(f"找不到输入图：{path}")
    img = Image.open(path)
    # 保留原始 alpha（若有）；GIF 等调色板图先转 RGBA
    return img.convert("RGBA")


def border_color(rgb: np.ndarray, ring: int = 2) -> tuple[np.ndarray, float]:
    """取四周 ring 像素的中位色，返回 (颜色, 该色占全图的比例估计)。"""
    h, w, _ = rgb.shape
    px = np.concatenate([
        rgb[:ring, :, :].reshape(-1, 3),
        rgb[-ring:, :, :].reshape(-1, 3),
        rgb[:, :ring, :].reshape(-1, 3),
        rgb[:, -ring:, :].reshape(-1, 3),
    ]).astype(np.int16)
    color = np.median(px, axis=0)
    return color, float(np.std(px, axis=0).max())


def build_mask(img: Image.Image, key: str, tolerance: float) -> tuple[np.ndarray, str]:
    """返回 (alpha 蒙版 uint8 HxW, 说明文字)。"""
    arr = np.asarray(img).astype(np.int16)
    rgb, a = arr[..., :3], arr[..., 3]
    transparent_ratio = float((a < 250).mean())

    if key == "alpha":
        return a.astype(np.uint8), "使用原图 alpha 通道"
    if key == "auto" and transparent_ratio > 0.02:
        return a.astype(np.uint8), f"使用原图 alpha 通道（{transparent_ratio:.0%} 透明）"
    if key == "none":
        return np.full(a.shape, 255, np.uint8), "不抠背景（--key none）"

    color, spread = border_color(rgb)
    dist = np.sqrt(((rgb - color) ** 2).sum(axis=2))
    mask = np.where(dist > tolerance, 255, 0).astype(np.uint8)
    note = f"色键抠除 {tuple(int(c) for c in color)}（边框离散度 {spread:.1f}, 容差 {tolerance:g}）"
    if float((mask > 0).mean()) > 0.92:
        note += "\n  ! 几乎整张图都被当成角色：背景不是单一纯色。建议先 rembg / remove.bg 抠成透明 PNG 再来。"
    if spread > 24:
        note += f"\n  ! 边框颜色不统一（{spread:.0f}）：可能是渐变/场景背景，抠不干净。"
    return mask, note


def refine(mask: np.ndarray, erode: int, feather: float) -> np.ndarray:
    m = Image.fromarray(mask, "L")
    if erode > 0:
        m = m.filter(ImageFilter.MinFilter(erode * 2 + 1))
    if feather > 0:
        m = m.filter(ImageFilter.GaussianBlur(feather))
    return np.asarray(m)


def solidify(rgba: np.ndarray, px: int, color_thr: int = 200, feather: float = 1.0) -> tuple[np.ndarray, int]:
    """把「软 alpha 贴纸」修成硬边贴纸，解决生成式工具的两个通病：

      1. 角色内部残留半透明斑块（鞋面、裙摆、发缝）——合成到绿底上直接泛绿；
      2. 轮廓外一圈 alpha≈1 的虚边——RGB 是透明区的垃圾色，抬成不透明就成了彩色毛刺。

    做法：**轮廓按"看得见"取（alpha>8，开运算去噪点）**，不按"很实"取——否则鞋面这种
    整体偏软的部位会被判成背景而整块消失；然后把轮廓填洞、外扩 px 吃掉虚边、抹 feather 羽化。
    颜色只信 alpha≥color_thr 的像素，其余用最近可信像素色回填（这些 RGB 不可信，不能反预乘）。
    """
    a = rgba[..., 3]
    vis = a > 8
    if not vis.any():
        return rgba, 0
    good = a >= color_thr
    if ndi is not None:
        solid = ndi.binary_opening(vis, iterations=1)
        solid = ndi.binary_fill_holes(solid)
        if px > 0:
            solid = ndi.binary_dilation(solid, iterations=px)
    else:
        solid = vis

    out = rgba.copy()
    need = solid & ~good                      # 轮廓内所有"颜色不可信"的像素都要回填
    if need.any() and good.any() and ndi is not None:
        idx = ndi.distance_transform_edt(~good, return_distances=False, return_indices=True)
        out[..., :3][need] = rgba[..., :3][idx[0][need], idx[1][need]]

    if feather > 0:
        soft = np.asarray(Image.fromarray((solid * 255).astype(np.uint8), "L")
                          .filter(ImageFilter.GaussianBlur(feather)))
        new_a = np.where(solid, 255, soft).astype(np.uint8)
    else:
        new_a = (solid * 255).astype(np.uint8)
    out[..., 3] = new_a
    return out, int(need.sum())


def despill(arr: np.ndarray, px: int, strength: float = 0.8) -> tuple[np.ndarray, int]:
    """压掉「边缘一圈被绿色环境光染上去的绿」（despill）。

    只处理距轮廓 px 以内、且 G 明显高于 max(R,B) 的像素：把 G 拉回到 lim=G+(lim-G)*(1-s)，
    s=1 时正好压到 lim。角色内部不动，所以头发/裙子的正常颜色不会被改。"""
    if px <= 0 or ndi is None:
        return arr, 0
    m = arr[..., 3] > 8
    band = m & ~ndi.binary_erosion(m, iterations=px)
    g = arr[..., 1].astype(np.float32)
    lim = np.maximum(arr[..., 0], arr[..., 2]).astype(np.float32)
    hit = band & (g > lim + 2)
    if not hit.any():
        return arr, 0
    out = arr.copy()
    out[..., 1][hit] = (lim[hit] + (g[hit] - lim[hit]) * (1.0 - strength)).astype(np.uint8)
    return out, int(hit.sum())


def compose(img: Image.Image, mask: np.ndarray, w: int, h: int, height_ratio: float, feet_ratio: float,
            solidify_px: int = 0, despill_px: int = 0, despill_strength: float = 0.8) -> tuple[Image.Image, dict]:
    arr = np.asarray(img).astype(np.uint8).copy()
    arr[..., 3] = mask
    filled = 0
    despilled = 0
    if despill_px > 0:
        arr, despilled = despill(arr, despill_px, despill_strength)
    if solidify_px > 0:
        arr, filled = solidify(arr, solidify_px)
        mask = arr[..., 3]

    ys, xs = np.where(mask > 8)
    if len(xs) == 0:
        raise SystemExit("抠完什么都不剩：背景色可能把角色也键掉了，试试更大的 --tolerance 或 --key none")
    x1, x2, y1, y2 = xs.min(), xs.max(), ys.min(), ys.max()
    char = Image.fromarray(arr[y1:y2 + 1, x1:x2 + 1], "RGBA")

    bottom = int(round(h * feet_ratio))
    top_min = int(round(h * 0.04))          # 头顶至少留 4% 绿边（永远不进画面外）
    max_h = max(1, bottom - top_min)
    scale = min(
        (h * height_ratio) / char.height,   # 立高约束
        (w * 0.8) / char.width,             # 太宽（大张手/披风）按宽度反压
        max_h / char.height,                # 不许顶出画幅
    )
    target_h = max(1, int(round(char.height * scale)))
    target_w = max(1, int(round(char.width * scale)))
    char = char.resize((target_w, target_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (w, h), GREEN)
    left = (w - target_w) // 2
    top = bottom - target_h
    canvas.alpha_composite(char, (left, top))

    stats = {
        "scale": scale,
        "char": (target_w, target_h),
        "top_pct": top / h * 100,
        "bottom_pct": bottom / h * 100,
        "left_pct": left / w * 100,
        "right_pct": (left + target_w) / w * 100,
        "solidified": filled,
        "despilled": despilled,
    }
    return canvas, stats


def make_static_webm(png: Path, out: Path) -> None:
    ffmpeg = REPO_FFMPEG if REPO_FFMPEG.exists() else (shutil.which("ffmpeg") and Path(shutil.which("ffmpeg")))
    if not ffmpeg:
        print("  ! 找不到 ffmpeg，跳过 --static-webm（先跑 build.cmd -InstallFfmpeg）", file=sys.stderr)
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error",
        "-loop", "1", "-i", str(png),
        "-t", "1", "-r", "24", "-frames:v", "24",
        "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x00FF00",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "40", "-b:v", "0",
        "-auto-alt-ref", "0",
        str(out),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(f"  ! 静止 webm 生成失败：{r.stderr.strip()[:300]}", file=sys.stderr)
        return
    print(f"  静止 webm：{out}  ({out.stat().st_size / 1024:.0f} KB)")


def main() -> int:
    ap = argparse.ArgumentParser(description="形象图 -> 绿幕首帧 PNG（16:9，纯 #00FF00）")
    ap.add_argument("src", type=Path, help="角色形象图")
    ap.add_argument("-o", "--out", type=Path, help="输出 PNG（默认 <src 名>-green.png）")
    ap.add_argument("--size", default="1920x1080", help="画布尺寸，默认 1920x1080（16:9）")
    ap.add_argument("--height", type=float, default=0.65, help="立高 = 画布高 × 该值，默认 0.65（≈头顶 20%%、脚底 85%%）")
    ap.add_argument("--feet", type=float, default=0.85, help="脚底所在高度比例，默认 0.85")
    ap.add_argument("--key", choices=["auto", "alpha", "none"], default="auto", help="抠图方式，默认 auto")
    ap.add_argument("--tolerance", type=float, default=30.0, help="色键容差（RGB 欧氏距离），默认 30")
    ap.add_argument("--erode", type=int, default=0, help="内缩 N 像素，去白边/毛边")
    ap.add_argument("--feather", type=float, default=1.0, help="边缘羽化半径，默认 1.0")
    ap.add_argument("--solidify", type=int, default=2, help="把软 alpha 修成硬边：可信区外扩 N 像素、填洞、回填最近色，0=关闭，默认 2")
    ap.add_argument("--despill", type=int, default=0, help="压掉轮廓内 N 像素范围内的绿色溢色（绿幕图被绿光照过时用），0=关闭")
    ap.add_argument("--despill-strength", type=float, default=0.8, help="溢色压制强度 0~1，默认 0.8")
    ap.add_argument("--static-webm", type=Path, help="顺带生成 1 秒静止 webm（兜底静态桌宠）")
    args = ap.parse_args()

    try:
        w, h = (int(v) for v in args.size.lower().split("x"))
    except ValueError:
        raise SystemExit(f"--size 格式应为 宽x高，例如 1920x1080（收到 {args.size}）")

    img = load_rgba(args.src)
    print(f"· 读入 {args.src.name}  {img.width}x{img.height}  模式={Image.open(args.src).mode}")

    mask, note = build_mask(img, args.key, args.tolerance)
    print(f"· 抠图：{note}")
    mask = refine(mask, args.erode, args.feather)

    canvas, st = compose(img, mask, w, h, args.height, args.feet, args.solidify, args.despill, args.despill_strength)
    out = args.out or args.src.with_name(args.src.stem + "-green.png")
    canvas.save(out)
    print(f"· 输出 {out}  {w}x{h}  角色 {st['char'][0]}x{st['char'][1]}（缩放 {st['scale']:.3f}）")
    print(f"  头顶 {st['top_pct']:.1f}%  脚底 {st['bottom_pct']:.1f}%  左 {st['left_pct']:.1f}%  右 {st['right_pct']:.1f}%")
    if st.get("despilled"):
        print(f"  去溢色：压掉 {st['despilled']} px 的绿色偏移（强度 {args.despill_strength:g}）")
    if st.get("solidified"):
        print(f"  硬边化：可信区外补 {st['solidified']} px（RGB 取最近可信像素色）")
    if not ndi:
        print("  ! 没装 scipy：只能做 alpha 硬边，填洞/配色跳过（pip install scipy）")
    if not (15 <= st["top_pct"] <= 30):
        print("  ! 头顶不在 15%~30% 区间，推镜头时容易顶到边：调 --height 或 --feet")
    if st["right_pct"] > 90 or st["left_pct"] < 10:
        print("  ! 角色太宽，接近左右安全边距：调小 --height")

    if args.static_webm:
        make_static_webm(out, args.static_webm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())