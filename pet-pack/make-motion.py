#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一张绿幕形象图，程序化合成为三段桌宠动作视频（零成本、零 AI）。

不调用任何生成模型：只对整张图做**刚体变换**（上下位移 / 挤压拉伸 / 轻微旋转），
再把变换后的角色合成回纯绿背景。所以：

  ✅ 角色像素 100% 来自你的原图 —— 不会变形、不会换脸、不会漂移
  ✅ 无水印、无额度限制、可无限重跑
  ❌ 手脚不会真的动（是"贴纸宠物"级别的动效），要真动作还是得用 AI 视频服务

产物（默认写进 _repo\\video\\，可直接喂给 build.cmd）：

    待机呼吸.mp4    10s  循环呼吸起伏           → animations.idle
    点击回应.mp4     5s  蓄力 → 蹦一下 → 落地   → animations.clicks
    被抓起悬空.mp4   5s  被拎起来 → 悬空晃 → 落回 → animations.drag

用法：
    python pet-pack\\make-motion.py                        # 默认读 _art\\green-frame.png
    python pet-pack\\make-motion.py --input 我的绿幕图.png
    python pet-pack\\make-motion.py --build -Name mypet      # 顺手跑流水线 + 校验
    python pet-pack\\make-motion.py --only idle --preview

退出码：0 成功；1 输入有问题；2 环境缺 ffmpeg。
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_REPO = HERE.parent / "_repo"
DEFAULT_INPUT = HERE / "_art" / "green-frame.png"

GREEN = (0, 255, 0)

# 每段视频：(文件名, 目标动画槽位, 时长秒, 说明)
CLIPS = [
    ("待机呼吸", "idle", 10.0, "循环呼吸起伏"),
    ("点击回应", "clicks", 5.0, "蓄力 → 蹦一下 → 落地"),
    ("被抓起悬空", "drag", 5.0, "被拎起来 → 悬空晃 → 落回"),
]


# ── ffmpeg 定位 ──────────────────────────────────────────────────────────────

def find_ffmpeg(repo: Path, explicit: str | None) -> str | None:
    if explicit:
        return explicit if Path(explicit).exists() else None
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    cand = repo / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / exe
    if cand.exists():
        return str(cand)
    found = shutil.which("ffmpeg")
    return found


# ── 动作曲线 ────────────────────────────────────────────────────────────────
# 每个函数返回 (dx, dy, sx, sy, deg)：位移(px, 向下为正)、非等比缩放、旋转角度。
# t 为 0..1 的归一化时间。

def ease_in_out(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def kf(t: float, keys: list[tuple[float, float]]) -> float:
    """关键帧插值：(时间 0~1, 值) 列表，段内 ease-in-out。"""
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t <= t1:
            if t1 - t0 <= 1e-9:
                return v1
            return v0 + (v1 - v0) * ease_in_out((t - t0) / (t1 - t0))
    return keys[-1][1]


def kf3(t: float, keys: list[tuple[float, float, float]]) -> tuple[float, float, float]:
    return (kf(t, [(k[0], k[1]) for k in keys]),
            kf(t, [(k[0], k[2]) for k in keys]),
            kf(t, [(k[0], k[3]) for k in keys]))


def motion_idle(t: float, seconds: float) -> tuple[float, float, float, float, float]:
    """呼吸：整体上下起伏。周期 2.5s，10s 正好 4 个整周期 → 首尾帧重合、循环不跳。"""
    ph = 2 * math.pi * (t * seconds) / 2.5
    dy = 3.2 * math.sin(ph)
    sy = 1.0 + 0.0050 * math.sin(ph + math.pi)   # 落下去时躯干微缩，像吸气的反相
    sx = 1.0 + 0.0022 * math.sin(ph + math.pi)
    deg = 0.5 * math.sin(2 * math.pi * (t * seconds) / 5.0)   # 5s 一个来回，10s 两整圈
    return 0.0, dy, sx, sy, deg


def motion_clicks(t: float, seconds: float) -> tuple[float, float, float, float, float]:
    """蓄力蹲 → 起跳拉伸 → 抛物线 → 落地挤压 → 回弹站稳。

    dy 最高 -58px：720 高下头顶从 20%（144px）抬到 86px，仍是 12% 安全边，不出画。
    """
    dy = kf(t, [(0.00, 0.0), (0.26, 7.0), (0.34, -18.0), (0.46, -50.0),
                (0.53, -58.0), (0.62, -34.0), (0.70, 0.0), (0.76, 6.5),
                (0.86, -1.5), (1.00, 0.0)])
    sx, sy, deg = kf3(t, [(0.00, 1.000, 1.000, 0.0),
                          (0.26, 1.022, 0.953, 0.0),   # 蹲下：横向略宽、纵向压扁
                          (0.34, 0.982, 1.036, 0.0),   # 起跳：拉长
                          (0.53, 0.994, 1.014, 0.6),   # 空中：轻微拉伸 + 一点抬头
                          (0.70, 1.000, 1.000, 0.0),   # 触地
                          (0.76, 1.032, 0.948, 0.0),   # 落地挤压
                          (0.86, 0.996, 1.004, 0.0),   # 回弹
                          (1.00, 1.000, 1.000, 0.0)])
    return 0.0, dy, sx, sy, deg


def motion_drag(t: float, seconds: float) -> tuple[float, float, float, float, float]:
    """被无形的手拎起来 → 悬空惯性摆 → 缓缓落回。"""
    dy = kf(t, [(0.00, 0.0), (0.14, -34.0), (0.24, -70.0), (0.30, -64.0),
                (0.36, -72.0), (0.72, -72.0), (0.86, -6.0), (0.94, 2.0),
                (1.00, 0.0)])
    if 0.36 <= t < 0.72:                      # 悬空段叠加左右摇摆
        u = (t - 0.36) / 0.36
        deg = 2.6 * math.sin(2 * math.pi * u * 1.5)
        dy += 3.5 * math.sin(2 * math.pi * u * 1.5 + math.pi / 2)
    else:
        deg = 2.6 * math.sin(math.pi * min(1.0, t / 0.36)) if t < 0.36 else 0.0
    sx, sy = (1.010, 0.982) if 0.24 <= t < 0.72 else (1.0, 1.0)
    return 0.0, dy, sx, sy, deg


MOTIONS = {
    "idle": motion_idle,
    "clicks": motion_clicks,
    "drag": motion_drag,
}


# ── 渲染 ────────────────────────────────────────────────────────────────────

GREEN_LO, GREEN_HI, GREEN_FEATHER = 70.0, 170.0, 6.0   # 与 chroma_step02.py 一致的色相区间


def key_green(rgb: "np.ndarray") -> "np.ndarray":
    """按色相把纯绿背景键掉，返回 alpha(0~255)。与 chroma_step02.py 的判据一致：
    hue∈[70,170] & sat≥0.15 & val≥0.15；区间边界做 feather，让边缘有 1px 过渡。"""
    import numpy as np
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    v = mx
    s = np.divide(mx - mn, np.maximum(mx, 1e-6))
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    d = np.maximum(mx - mn, 1e-6)
    h = np.zeros_like(mx)
    m = (mx == r)
    h[m] = ((g - b)[m] / d[m]) % 6.0
    m = (mx == g) & ~(mx == r)
    h[m] = ((b - r)[m] / d[m]) + 2.0
    m = (mx == b) & ~(mx == r) & ~(mx == g)
    h[m] = ((r - g)[m] / d[m]) + 4.0
    h = h * 60.0
    bg = (s >= 0.15) & (v >= 0.15) & (h >= GREEN_LO) & (h <= GREEN_HI)
    lo = np.clip((h - GREEN_LO) / GREEN_FEATHER, 0, 1)
    hi = np.clip((GREEN_HI - h) / GREEN_FEATHER, 0, 1)
    in_hue = lo * hi
    alpha = np.where(bg, (1.0 - in_hue) * 255.0, 255.0)
    return alpha


def load_base(path: Path, size: tuple[int, int]):
    """读图 → 拆成"只有角色、其余全透明"的 RGBA。两种来源都支持：
    ① 绿幕合成图（RGB，背景纯绿）→ 按色相键掉背景
    ② 带真 alpha 的透明图 → 直接用 alpha
    返回 (char_rgba, anchor(脚底中心), bbox)。"""
    import numpy as np
    from PIL import Image
    im = Image.open(path)
    im = im.convert("RGBA").resize(size, Image.LANCZOS)
    arr = np.asarray(im, dtype=np.float32)
    rgb = arr[..., :3] / 255.0
    a = arr[..., 3]
    if a.min() < 250:                 # 本身就有 alpha
        alpha = a.copy()
    else:                             # 绿幕合成图
        alpha = key_green(rgb)
        if (alpha > 8).sum() > 0.98 * alpha.size:
            raise SystemExit(
                f"[x] {path.name} 既没有真 alpha，背景也不是纯绿（几乎全被当成角色）。\n"
                f"    先跑 sticker-to-green.py 把它做成绿幕首帧。")
    char = im.copy()
    char.putalpha(Image.fromarray(alpha.astype(np.uint8)))
    bbox = char.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bbox:
        raise SystemExit("[x] 图里找不到角色像素（全透明或全绿？）")
    x0, y0, x1, y1 = bbox
    return char, ((x0 + x1) / 2.0, float(y1)), bbox


def transform_frame(base, anchor, dx, dy, sx, sy, deg, size):
    """把角色按 位移/缩放/旋转 变换后合成到纯绿底上。"""
    from PIL import Image
    ax, ay = anchor
    th = math.radians(deg)
    cos_t, sin_t = math.cos(th), math.sin(th)
    # 正向：p_out = R * S * (p_in - a) + a + d
    # PIL 需要逆向：p_in = S^-1 * R^-1 * (p_out - a - d) + a
    inv_sx, inv_sy = 1.0 / sx, 1.0 / sy
    # M = S^-1 * R^-1
    m00 = inv_sx * cos_t
    m01 = inv_sx * sin_t
    m10 = -inv_sy * sin_t
    m11 = inv_sy * cos_t
    tx = ax - (m00 * (ax + dx) + m01 * (ay + dy))
    ty = ay - (m10 * (ax + dx) + m11 * (ay + dy))
    warped = base.transform(size, Image.AFFINE, (m00, m01, tx, m10, m11, ty),
                            resample=Image.BICUBIC)
    bg = Image.new("RGBA", size, GREEN + (255,))
    return Image.alpha_composite(bg, warped).convert("RGB")


def render_clip(base, anchor, size, fps, seconds, motion, out_path, ffmpeg, preview_dir=None):
    w, h = size
    n = max(1, int(round(seconds * fps)))
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "-",
        "-c:v", "libx264", "-preset", "slow", "-crf", "14",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for i in range(n):
            t = i / float(n - 1) if n > 1 else 0.0
            dx, dy, sx, sy, deg = motion(t, seconds)
            frame = transform_frame(base, anchor, dx, dy, sx, sy, deg, size)
            proc.stdin.write(frame.tobytes())
            if preview_dir and i in (0, n // 2, n - 1):
                frame.save(preview_dir / f"{out_path.stem}-{i:03d}.png")
    finally:
        if proc.stdin:
            proc.stdin.close()
    rc = proc.wait()
    if rc != 0:
        raise SystemExit(f"[x] ffmpeg 编码失败（exit {rc}）：{out_path}")
    return n


def first_frame_probe(ffmpeg: str, clip: Path, work: Path) -> Path:
    """抽第一帧，用于自检构图与绿幕质量。"""
    out = work / f"{clip.stem}-first.png"
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(clip), "-frames:v", "1", str(out)], check=True)
    return out


# ── main ────────────────────────────────────────────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description="把一张绿幕形象图程序化合成为桌宠动作视频")
    ap.add_argument("--input", default=str(DEFAULT_INPUT), help="绿幕形象图（1920x1080 最佳）")
    ap.add_argument("--out-dir", default=None, help="输出目录，默认 <repo>/video")
    ap.add_argument("--repo", default=str(DEFAULT_REPO), help="仓库根目录（含 scripts/）")
    ap.add_argument("--ffmpeg", default=None, help="ffmpeg 路径")
    ap.add_argument("--size", default="1280x720", help="输出分辨率，默认 1280x720（流水线要求）")
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--only", default=None, choices=["idle", "clicks", "drag"],
                    help="只生成某一段")
    ap.add_argument("--preview", action="store_true", help="额外保存首/中/末帧 PNG 供检查")
    ap.add_argument("--build", action="store_true", help="生成后自动跑 build.cmd")
    ap.add_argument("-Name", dest="pet_name", default=None, help="配合 --build，宠物名")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不渲染")
    args = ap.parse_args(argv)

    inp = Path(args.input).resolve()
    if not inp.exists():
        raise SystemExit(f"[x] 找不到输入图：{inp}\n    （先跑 sticker-to-green.py 生成绿幕首帧）")
    repo = Path(args.repo).resolve()
    out_dir = Path(args.out_dir).resolve() if args.out_dir else repo / "video"
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        w, h = (int(x) for x in args.size.lower().split("x"))
    except Exception:
        raise SystemExit(f"[x] --size 要写成 1280x720，收到 {args.size!r}")

    ffmpeg = find_ffmpeg(repo, args.ffmpeg)
    if not ffmpeg:
        raise SystemExit(
            "[x] 找不到 ffmpeg。三种解法：\n"
            "    1) python -m pip install imageio-ffmpeg -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
            "       把 imageio_ffmpeg/binaries/ffmpeg*.exe 复制成\n"
            f"       {repo}\\.tools\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe\n"
            "    2) 用 pet-pack\\build.cmd -InstallFfmpeg 下载\n"
            "    3) --ffmpeg <你已有的 ffmpeg 路径>")

    todo = [c for c in CLIPS if (args.only is None or c[1] == args.only)]
    if not todo:
        raise SystemExit(f"[x] --only {args.only} 没有匹配的片段")

    print(f"输入    {inp}")
    print(f"分辨率  {w}x{h} @{args.fps}fps")
    print(f"输出    {out_dir}")
    print(f"ffmpeg  {ffmpeg}")
    print()

    if args.dry_run:
        for name, slot, secs, desc in todo:
            print(f"  · {name}.mp4  {secs:g}s  → {slot}  ({desc})")
        return 0

    base, anchor, bbox = load_base(inp, (w, h))
    top_pct = bbox[1] / h * 100
    feet_pct = bbox[3] / h * 100
    print(f"角色    bbox={bbox}  头顶 {top_pct:.1f}% / 脚底 {feet_pct:.1f}%  轴心=({anchor[0]:.0f},{anchor[1]:.0f})")
    if top_pct < 12:
        print("  ! 头顶留白偏少，跳跃动作可能顶出画幅（可对源图加大上边距）")
    if feet_pct > 92:
        print("  ! 脚底太贴底边，拖拽动作的下沉可能出画")
    print()

    preview_dir = (HERE / "_art" / "motion-preview") if args.preview else None
    if preview_dir:
        preview_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    for name, slot, secs, desc in todo:
        out_path = out_dir / f"{name}.mp4"
        n = render_clip(base, anchor, (w, h), args.fps, secs,
                        MOTIONS[slot], out_path, ffmpeg, preview_dir)
        total += n
        size_kb = out_path.stat().st_size / 1024
        print(f"  ✔ {name}.mp4  {secs:g}s / {n} 帧 / {size_kb:.0f} KB  → {slot}  ({desc})")
        if preview_dir:
            print(f"     首帧预览：{preview_dir / (name + '-000.png')}")
    print(f"\n共 {len(todo)} 段、{total} 帧。下一步：")
    print(f"  pet-pack\\build.cmd -Name {args.pet_name or 'mypet'}")

    if args.build:
        name = args.pet_name or "mypet"
        cmd_path = HERE / "build.cmd"
        print(f"\n▶ 跑流水线：build.cmd -Name {name}")
        rc = subprocess.call(["cmd", "/c", str(cmd_path), "-Name", name])
        if rc != 0:
            print(f"[x] build.cmd 失败（exit {rc}）——看上面的报错")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())