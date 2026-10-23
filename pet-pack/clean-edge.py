#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""去掉 webm 透明素材的"白边/绿边"——把 alpha 过渡带的颜色换成角色本体色。

问题：绿幕抠像（chroma_step02）只算 alpha、不动 RGB；再经过 h264/vp9 的 4:2:0
色度抽样，角色轮廓那 1~3px 的抗锯齿带里 RGB 是"角色色 + 绿幕色"的混合，
alpha 又是半透明。合成到浅色页面时这圈就变成一圈浅绿灰的边——肉眼就是"白边没抠干净"。

做法（逐帧，纯 numpy）：
  1. core = alpha >= --core-alpha（200）且向内腐蚀 1px：可信本体
  2. 对每个 alpha>0 的边缘像素，取**最近的 core 像素**的 RGB 顶替（距离变换带索引，
     一次 EDT 就够；比逐像素搜索快两个数量级）
  3. 离 core 超过 --px（3）px 的透明像素视为抠像噪点/绿幕残留 → alpha 归 0
  4. alpha < --crush（8）的碎屑同理归 0（编码器会把这些当噪声花）
  5. 残余的绿偏移再压一道（只压 G > max(R,B) 的像素）

alpha 本身不动（羽化宽度保留），所以边缘不会变硬、不会锯齿。

用法：
  python clean-edge.py --dir C:\\Users\\你\\.dsh\\dsh-pet\\pet\\mypet-animation
  python clean-edge.py --dir ... --preview out.png     # 只导一帧前后对比，不改文件
  python clean-edge.py --dir ... --dry-run             # 只报每题要改多少像素
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Windows 控制台默认 GBK：打印 ✔ 之类会 UnicodeEncodeError 直接崩（流水线里就变成"清理失败"）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np

FFMPEG_NAMES = ("ffmpeg.exe", "ffmpeg")


def find_ffmpeg(explicit: str | None) -> str:
    if explicit:
        p = Path(explicit)
        if p.exists():
            return str(p)
        alt = p.with_name(p.name.replace("ffmpeg", "ffprobe"))
        if alt.exists():
            return str(p)
    repo = Path(__file__).resolve().parent.parent
    cand = repo / "_repo" / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe"
    if cand.exists():
        return str(cand)
    probe = repo / "_repo" / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffprobe.exe"
    if probe.exists():
        return str(probe)
    for name in FFMPEG_NAMES:
        hit = shutil.which(name)
        if hit:
            return hit
    raise SystemExit("找不到 ffmpeg：用 --ffmpeg 指定，或先跑 build.cmd -InstallFfmpeg")


def probe(ffprobe: str, path: Path) -> tuple[int, int, float]:
    cmd = [
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate",
        "-of", "json", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    st = json.loads(out)["streams"][0]
    num, _, den = st.get("avg_frame_rate", "24/1").partition("/")
    fps = float(num) / float(den or 1) if float(num or 0) > 0 else 24.0
    return int(st["width"]), int(st["height"]), fps


def clean_frame(rgba: np.ndarray, core_alpha: int, px: int, crush: int, despill: float,
                dist_cache: dict | None = None):
    """返回 (处理后的帧, 统计)。rgba: HxWx4 uint8"""
    from scipy import ndimage  # 局部导入：没装 scipy 时只有这一条路径受影响

    al = rgba[..., 3]
    core = al >= core_alpha
    if core.sum() < 32:
        return rgba, {"edge": 0, "noise": 0}
    core = ndimage.binary_erosion(core, iterations=1) | (al >= 250)
    if core.sum() < 32:
        return rgba, {"edge": 0, "noise": 0}

    dist, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
    edge = (al > 0) & ~core
    near = edge & (dist <= px)
    far = edge & (dist > px) | ((al > 0) & (al < crush))

    out = rgba.copy()
    if near.any():
        out[near, :3] = rgba[iy[near], ix[near], :3]
    out[far, 3] = 0

    if despill > 0 and near.any():
        sel = near & (out[..., 3] > 0)
        r = out[..., 0].astype(np.int16)
        g = out[..., 1].astype(np.int16)
        b = out[..., 2].astype(np.int16)
        lim = np.maximum(r, b)
        hot = sel & (g > lim + 2)
        g2 = lim + ((g - lim) * (1.0 - despill)).astype(np.int16)
        ch = out[..., 1]
        ch[hot] = np.clip(g2[hot], 0, 255).astype(np.uint8)
        out[..., 1] = ch
    return out, {"edge": int(near.sum()), "noise": int(far.sum())}


def process(path: Path, ffmpeg: str, args) -> dict:
    w, h, fps = probe(str(Path(ffmpeg).with_name(Path(ffmpeg).name.replace("ffmpeg", "ffprobe"))),
                      path)
    dec = subprocess.Popen(
        [ffmpeg, "-v", "error", "-c:v", "libvpx-vp9", "-i", str(path),
         "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    frame_bytes = w * h * 4
    enc = None
    tmp = None
    stats = {"frames": 0, "edge": 0, "noise": 0}
    preview_done = False
    try:
        if not args.preview:
            # 注意：本机 %TEMP% 写不进（Permission denied），临时文件一律放工作区
            tmpdir = Path(__file__).resolve().parent / "_tmp"
            tmpdir.mkdir(exist_ok=True)
            tmp = tmpdir / (path.stem + ".clean.webm")
            enc = subprocess.Popen(
                [ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                 "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-",
                 "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
                 "-crf", str(args.crf), "-b:v", "0", "-row-mt", "1", str(tmp)],
                stdin=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        while True:
            buf = dec.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 4).copy()
            before = frame
            out, st = clean_frame(frame, args.core_alpha, args.px, args.crush, args.despill)
            stats["frames"] += 1
            stats["edge"] += st["edge"]
            stats["noise"] += st["noise"]
            if args.preview and not preview_done:
                from PIL import Image
                Image.fromarray(before, "RGBA").save(args.preview.replace(".png", "-before.png"))
                Image.fromarray(out, "RGBA").save(args.preview)
                preview_done = True
            if enc:
                try:
                    enc.stdin.write(out.tobytes())
                except OSError as exc:
                    enc.stdin.close()
                    err = enc.stderr.read().decode("utf-8", "replace")
                    raise SystemExit(f"写帧失败（{exc}）：{path.name} 第 {stats['frames']} 帧\n"
                                     f"编码器输出：{err[-1200:]}")
        if enc:
            enc.stdin.close()
            err = enc.stderr.read().decode("utf-8", "replace")
            if enc.wait() != 0:
                raise SystemExit(f"编码失败：{err[-800:]}")
    finally:
        if dec.stdout:
            dec.stdout.close()
        dec.stderr.close()
        dec.wait()

    if not args.preview and tmp:
        if stats["frames"] == 0:
            raise SystemExit(f"{path.name}：解不出任何帧（是不是索引损坏/不是 vp9-alpha？）")
        if args.dry_run:
            tmp.unlink(missing_ok=True)
        else:
            shutil.move(str(tmp), str(path))
    return {"file": path.name, "w": w, "h": h, "fps": round(fps, 2), **stats}


def main():
    ap = argparse.ArgumentParser(description="去掉透明 webm 的白边/绿边（重写 RGB 过渡带）")
    ap.add_argument("--dir", required=True, help="素材目录（如 ~/.dsh/dsh-pet/pet/mypet-animation）")
    ap.add_argument("--glob", default="*.webm", help="文件通配（默认 *.webm；macOS 用 *.mov，需另转）")
    ap.add_argument("--core-alpha", type=int, default=200, help="认定为本体实心的 alpha 阈值")
    ap.add_argument("--px", type=int, default=3, help="边缘向外最多替换几 px 的颜色；超出视为噪点清零")
    ap.add_argument("--crush", type=int, default=8, help="低于此 alpha 的碎屑直接清零")
    ap.add_argument("--despill", type=float, default=0.9, help="残余绿偏移压制强度，0 关闭")
    ap.add_argument("--crf", type=int, default=26, help="重编码质量（越小越清晰/越大文件越大）")
    ap.add_argument("--ffmpeg", default=None)
    ap.add_argument("--preview", default=None, help="只处理第一帧并存前后对比 PNG，不改文件")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写回")
    args = ap.parse_args()

    d = Path(args.dir).expanduser()
    if not d.is_dir():
        raise SystemExit(f"目录不存在：{d}")
    files = sorted(p for p in d.glob(args.glob) if not p.name.startswith("."))
    if not files:
        raise SystemExit(f"{d} 下没有 {args.glob}")

    try:
        import scipy  # noqa: F401
    except ImportError:
        raise SystemExit("需要 scipy：python -m pip install scipy -i https://pypi.tuna.tsinghua.edu.cn/simple")

    ffmpeg = find_ffmpeg(args.ffmpeg)
    print(f"ffmpeg: {ffmpeg}")
    print(f"目录  : {d}\n")
    rows = []
    for f in files:
        r = process(f, ffmpeg, args)
        rows.append(r)
        print(f"  {r['file']:<24} {r['w']}x{r['h']}@{r['fps']:g}fps  {r['frames']} 帧  "
              f"补色 {r['edge']:>6} px·帧  清噪 {r['noise']:>5} px·帧")
    if args.dry_run:
        print("\n（--dry-run：未写回文件）")
    elif not args.preview:
        print("\n✔ 已就地重写（原文件被替换）——刷新页面看效果")
    print()


if __name__ == "__main__":
    main()