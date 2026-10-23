"""出片后的"跳变体检"：这段视频拿去当桌宠会不会跳。

三个指标，对应三种肉眼可见的跳：

  1. 接缝      末帧 vs 首帧的差      —— 循环播放时每圈跳一次
  2. 片中跳变  相邻帧差的最大值      —— 生成时角色被"重画"，一圈跳好几次
  3. 冻结      整段是否为静止图      —— 不动（另一个方向的问题）

合格线（经验值，来自与官方素材的对照）：
   接缝 < 12      官方 idle 是 23.80（它跳，但落在呼吸回位处）
   片中最大 < 12  超过就看得见；30 以上是"整片重绘"
   冻结      帧间中位 > 0.3，否则换

用法：
  python video-jitter.py 待机呼吸.mp4
  python video-jitter.py 待机呼吸.mp4 --thr 12 --json out.json
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

FFDIR = Path(r"D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin")


def probe(p):
    out = subprocess.run(
        [str(FFDIR / "ffprobe.exe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
         "-of", "json", str(p)], capture_output=True, text=True, check=True).stdout
    st = json.loads(out)["streams"][0]
    num, _, den = st["r_frame_rate"].partition("/")
    return (int(st["width"]), int(st["height"]), float(num) / float(den or 1),
            int(st.get("nb_frames") or 0))


def frames(p, w, h):
    # webm 必须显式指定 libvpx-vp9，否则 alpha 解不出来（颜色也会错）
    args = [str(FFDIR / "ffmpeg.exe"), "-v", "error"]
    if p.suffix.lower() in (".webm", ".mov"):
        args += ["-c:v", "libvpx-vp9"]
    args += ["-i", str(p), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
    pr = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n = w * h * 4
    while True:
        b = pr.stdout.read(n)
        if len(b) < n:
            break
        yield np.frombuffer(b, dtype=np.uint8).reshape(h, w, 4)
    pr.stdout.close()
    pr.wait()


def char_mask(f):
    """角色区：有真 alpha 就用 alpha；纯 RGB（比如 mp4）就按绿背景反着取。"""
    a = f[..., 3]
    if a.min() < 250:                     # 存在半透明像素 → 素材自带 alpha
        return a > 8
    rgb = f[..., :3].astype(np.float32) / 255.0
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.zeros_like(mx)
    m = d > 1e-6
    i = m & (mx == r); h[i] = ((g - b)[i] / d[i]) % 6
    i = m & (mx == g); h[i] = ((b - r)[i] / d[i]) + 2
    i = m & (mx == b); h[i] = ((r - g)[i] / d[i]) + 4
    h *= 60.0
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    green = (h >= 70) & (h <= 170) & (s >= 0.15) & (mx >= 0.15)
    return ~green


def diff(a, b, ma, mb):
    """只比角色区（任一方是角色的像素），避免大片绿背景把指标稀释。"""
    m = ma | mb
    if not m.any():
        return 0.0, 0.0
    dd = np.abs(a[..., :3].astype(np.int16) - b[..., :3].astype(np.int16)).mean(-1)
    sel = dd[m]
    return float(sel.mean()), float((sel > 20).mean() * 100)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--thr", type=float, default=12.0)
    ap.add_argument("--json")
    args = ap.parse_args()

    p = Path(args.video)
    w, h, fps, nb = probe(p)
    counts = {"frames": 0}
    prev = None
    prev_mask = None
    first = None
    first_mask = None
    diffs, hot = [], []
    for f in frames(p, w, h):
        mask = char_mask(f)
        if first is None:
            first, first_mask = f, mask
        if prev is not None:
            m, pct = diff(f, prev, mask, prev_mask)
            diffs.append(m)
            if m > args.thr:
                hot.append({"frame": counts["frames"], "t": round(counts["frames"] / fps, 2),
                            "mean": round(m, 2), "pct": round(pct, 1)})
        prev, prev_mask = f, mask
        counts["frames"] += 1

    if not diffs:
        print("解不出帧，检查文件/解码器"); return 2
    seam, seam_pct = diff(prev, first, prev_mask, first_mask)
    d = np.array(diffs)

    print(f"{p.name}: {w}×{h} @{fps:g}fps  {counts['frames']} 帧  {p.stat().st_size / 1024:.0f} KB")
    print(f"  接缝      {seam:6.2f}   明显变化 {seam_pct:5.1f}%   {'✔' if seam <= args.thr else '✘ 循环会跳'}")
    print(f"  片中最大  {d.max():6.2f}   中位 {np.median(d):5.2f}          "
          f"{'✔' if d.max() <= args.thr else '✘ 角色被重画'}")
    print(f"  运动量    帧间中位 {np.median(d):5.2f}                     "
          f"{'✔' if np.median(d) > 0.3 else '✘ 几乎是静止图'}")
    if hot:
        print(f"  跳变帧 {len(hot)} 个（>{args.thr}）：")
        for x in hot[:12]:
            print(f"    #{x['frame']:3d}  {x['t']:5.2f}s   {x['mean']:5.2f}  明显变化 {x['pct']:4.1f}%")
        if len(hot) > 12:
            print(f"    … 另 {len(hot) - 12} 个")
    ok = bool(seam <= args.thr and d.max() <= args.thr)
    print()
    print("结论：" + ("✔ 可以直接用" if ok else "✘ 建议重新生成（或跑 loopify/despike 后处理）"))

    if args.json:
        Path(args.json).write_text(json.dumps({
            "file": p.name, "w": w, "h": h, "fps": fps, "frames": counts["frames"],
            "seam": round(seam, 2), "seam_pct": round(seam_pct, 1),
            "max_diff": round(float(d.max()), 2), "median_diff": round(float(np.median(d)), 2),
            "hot": hot, "ok": ok}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已写 {args.json}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())