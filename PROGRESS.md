# 进度快照（路线 A：做一只自己的桌宠）

> 随时可以停下，这份文件记录「已完成 / 卡在哪 / 下一步」。下次说一句「继续」就从这个状态接上。

## 已完成

| 事项 | 位置 | 状态 |
|---|---|---|
| 配置骨架 | `~/.dsh/dsh-pet/pet/mypet-config.json` + `mypet-animation/` | 宿主 `readAllConfig()` 校验通过，`display: both` |
| 校验器 | `pet-pack\check-config.mjs` | 直接 import 宿主合并逻辑，能报"缺哪几段素材 / 配置是否被回退 / 孤儿素材" |
| 形象图 → 绿幕首帧 | `pet-pack\_art\green-frame.png` | 1920×1080，头顶 20.0% / 脚底 85.0%，边缘绿偏移 −4.8 |
| 程序化动效 | `pet-pack\make-motion.py` | 一张图合成三段（待机 10s / 点击 5s / 拖拽 5s），刚体变换、角色像素原样 |
| 数值验收 | `pet-pack\check-motion.py` | 顶/底余量、中心漂移、帧间跳变、首尾帧相同度 98.57% |
| 流水线 | `pet-pack\build.cmd` | 端到端跑通，产物 640×360 `ALPHA_MODE=1`，alpha 0~255 ✔ |
| **去白边/绿边** | `pet-pack\clean-edge.py`（build 自动调用） | 边缘绿偏移 +21.8 → **+0.3**，背景残雾 204335 → **670** px，羽化带 1.52 → 1.48px 不变 |
| 可灵/万相/即梦提示词 | `pet-pack\kling-prompts.md` | 三段可直接粘；第 6 节是国内平台设置，**6.4 是阿里万相的实测记录** |
| ffmpeg / ffprobe | `_repo\.tools\ffmpeg-9.0.1-essentials_build\bin\` | 7.1 gyan essentials（有 `libvpx-vp9`）/ 4.0.2 |

## 现在的状态：三条素材已上线（960×540，马赛克/水印/闪烁都已修）

用户用**阿里万相**（通义万相，不是即梦）生成了 1920×1080@30fps 的三条绿幕视频（原件在 `D:\browser\`，副本在 `_repo\video\`），已走完整条流水线；**待机后来换回了程序化版**（因为 AI 那条自带跳变，见下）：

| 素材 | 来源 | 成品 |
|---|---|---|
| 待机呼吸.webm | `make-motion.py --only idle`（程序化，同图刚体呼吸） | 859 KB，960×540，239 帧，帧间差最大 **1.40** |
| 点击回应.webm | 万相 5.00s / 150 帧 | 887 KB，跳跃时头顶最低 4.7%（未出画） |
| 被抓起悬空.webm | 万相 5.04s / 150 帧 | 806 KB，悬空抬升 10.3%p |

- **马赛克台阶已修**（用户 2026-10-22 03:4x 反馈"轮廓上有马赛克/锯齿"）：根因是 VP9 的 alpha 按 8×8 块量化，而 640×360 成品在 150% 缩放的屏上正好 1:1 显示。改了三处——`chroma_step02.py` 的 crf 30→5（`build.cmd` 里 `Ensure-VendorQuality` 自动改，幂等）、step04 换成 `pet-pack\encode-final.py`（960×540 crf24）、`clean-edge.py` 默认 crf 34→26。8 网格偏置 **1.32 → 0.87/0.87/1.18**（官方 0.97），逐帧背景残雾 205023 → **1440** px。
- **水印已去掉**：**阿里万相**的水印固定在 `x[1545..1872] y[911..1032]`（328×122，纯白 255,255,255，六帧坐标完全一致），用 `-MaskBox auto` 在 Normalize-Step01 里 `drawbox` 涂绿 → 成品"角色外实心块"0 个。
- 边缘绿偏移 +21.8 → **−1.76 / −0.53 / −2.26**（`clean-edge.py` 生效）。
- **闪烁已修**（用户 2026-10-22 04:0x 反馈"时不时闪一下"）：逐帧量出待机每 10s 固定 3 处角色区帧间差 2.2→25~30，相位相关显示 **2.5~2.8px 亚像素横移 + 局部重绘**，且**源 mp4 里就有**（4.3/6.8/9.4s，×1.25 对上）；不是编码、不是关键帧（全片仅 2 个 I 帧）、不是循环接缝、不是 5s 置顶重钉。`smooth.py`（时域去尖峰）与 `stabilize.py`（亚像素稳定）实测都救不了 → 用户选 A，待机改用 `make-motion.py` 生成，最大帧间差 **26.4 → 1.40**。AI 版待机备份在 `D:\harnessTest\DSHpet\_backup\ai-clips\待机呼吸-万相.mp4`，程序化旧版在 `_backup\programmatic-webm\`。

## 桌面小窗怎么开

`D:\harnessTest\DSHpet\启动桌宠.cmd`（= 在 `~/.dsh/profiles/desktop/node_modules/dsh-pet` 里跑 `node lib\standalone.js`，服务在 `http://127.0.0.1:3080/`，关窗口即收起）。
`~/.dsh/dsh-pet/main-config.jsonc` 里把主宠物 `display` 设成 `none`，所以只会出现自己那只（想恢复就改回 `both`）。

## 待机呼吸：已从 AI 版换成程序化版（2026-10-22 04:30）

AI 版待机（万相）构图/抠像/循环都没问题，但**帧间差只有 0.59、且每 10s 有 3 处跳到 25~30 的抖动**，放在桌面上就是"像静止贴图 + 时不时闪一下"。用户先选 A（就这样用），后因闪烁改为换程序化待机：`python pet-pack\make-motion.py --only idle` → 最大帧间差 **1.40**，是真的在呼吸。

想换回 AI 版：`copy D:\harnessTest\DSHpet\_backup\ai-clips\待机呼吸-万相.mp4 D:\harnessTest\DSHpet\_repo\video\` 再 `build.cmd -Name mypet -Force`（闪烁会一起回来）。

## 下一步（等用户决定）

**A. 用阿里万相出真 AI 动作替换程序化版**：已完成（见上）。
**B. 继续打磨程序化版**（不需要任何付费/AI 服务）

## 四个坑（已踩过，别再踩）

1. **验证 alpha 必须带 `-c:v libvpx-vp9`**。VP9 透明度在 WebM 里旁路存，`ffprobe` 只显示 `pix_fmt=yuv420p` + `TAG:ALPHA_MODE=1`；默认解码器取帧 alpha 全 255（假阴性）。
   ```bat
   ffmpeg -c:v libvpx-vp9 -i x.webm -frames:v 1 -pix_fmt rgba x.png
   ```
2. **不要往 `%TEMP%` 写东西**（本机 Permission denied），中间文件放工作区（`clean-edge.py` 用 `pet-pack\_tmp`）。
3. **改完 `.ps1` 要补回 BOM**。丢了 UTF-8 BOM → PowerShell 5.1 按 GBK 解码 → 中文乱码 + `Unexpected attribute 'CmdletBinding'`。补法：以 `utf-8-sig` 写回。
4. **`build.cmd` 拷素材默认跳过同名文件**，换素材必须加 `-Force`。

## 已知但没做的

- 头发外缘 1px 白色高光碎点（源图镜面高光），640×360 下看不见，故意没处理。
- 素材目录里若残留旧动画，不会自动清理（`check-config.mjs` 会报"孤儿素材"）。

## 关键路径

- 工作区：`D:\harnessTest\DSHpet`　仓库副本：`_repo`（depth 1）
- 用户素材根：`~/.dsh/dsh-pet/pet/mypet-animation/`（**平铺，没有 webm 子目录**）
- 首帧：`pet-pack\_art\green-frame.png`
- 提示词：`pet-pack\kling-prompts.md`　工具说明：`pet-pack\README.md`