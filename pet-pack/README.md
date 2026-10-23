# 路线 A 工具包：零代码做一只自己的桌宠

这个目录是给 **dsh-pet** 插件做「文件宠物」（pet pack）用的脚手架。
你不需要改插件任何代码——素材按规范放对位置，配置写对名字，桌宠就出来了。

```
pet-pack/
├─ install.cmd              ① 建骨架（生成配置 + 素材目录，并自动校验）
├─ build.cmd                ② 跑素材链（绿幕视频 → .webm，直接进素材目录）
├─ check-config.mjs         ③ 配置校验器（宿主同一份合并逻辑，查配置是否被回退、素材缺哪几段）
├─ sticker-to-green.py      形象图 → 绿幕首帧 PNG（给可灵图生视频用）
├─ check-green.py           绿幕图体检（判据同 chroma_step02.py，先判再喂可灵）
├─ make-motion.py           没有 AI 视频时的兜底：一张图合成三段动作
├─ clean-edge.py            去白边/绿边（重写 alpha 过渡带的 RGB；build.cmd 会自动调用）
├─ find-watermark.py        找画面里静止的叠加物（水印/logo），输出可直接涂绿的矩形
├─ encode-final.py          最后一公里编码（默认 960×540，替代宿主写死的 640×360）
├─ video-audit.py           出片体检：构图/背景/溢色（能不能喂流水线）
├─ video-motion.py          出片体检：到底动没动、右下角有没有水印
├─ verify-pack.py           成品验收：解 alpha、构图、边缘绿偏移、角色外实心块
└─ template/mypet-config.json   配置模板（带中文注释）
```

> Windows 默认禁止运行 `.ps1`，所以入口用 `.cmd`（内部带 `-ExecutionPolicy Bypass`）。
> 想直接用 ps1：`powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Name cat`

---

## 三步走

### ① 建骨架

```bat
install.cmd -Name cat -PetName 我的猫 -Size 420
```

生成（`$DSH_HOME` 默认 `C:\Users\<你>\.dsh`）：

```
~/.dsh/dsh-pet/pet/cat-config.json      ← 配置，可直接改
~/.dsh/dsh-pet/pet/cat-animation/       ← 素材目录，.webm 丢这里
```

末尾会自动跑一次校验，此时应该看到：

```
结论：△ 配置合法，但还缺 3/3 段素材 —— 补齐后刷新页面即出现
```

**这时宠物还看不见**（模板里 `display: "none"`）——故意如此，避免素材没齐时在界面上留一块空白。

### ② 做素材

最少 3 段，名字必须和配置里逐字一致：

| 文件名 | 对应配置字段 | 作用 |
|---|---|---|
| `待机呼吸.webm` | `animations.idle` | 待机循环，播完接着播它自己 |
| `点击回应.webm` | `animations.clicks` | 点它一下播的回应 |
| `被抓起悬空.webm` | `animations.drag` | 被鼠标拖起来时的姿势 |

**规格（照抄，别自己发挥）**

| 项 | 值 | 原因 |
|---|---|---|
| 画布 | 640×360 | 播放器固定 360 高 |
| 编码 | VP9 + alpha（`yuva420p`） | 透明；漏了 pix_fmt 就是黑底 |
| 帧率 | 24 fps | 与母版一致 |
| 构图 | 头顶约 20%、脚底约 85%、左右不出 10% 边 | 对齐 `FEET_Y=330` / 命中框 |
| 首尾帧 | 同一正面站姿 | 交叉淡入不穿帮 |
| 位移 | 不要左右走（原地踮脚/跳可以） | 位置由代码算，动画带位移会"滑步" |
| 时长 | 10s 左右 | 节奏均匀 |

**生成源视频**：用 AI 视频工具（豆包/可灵/Runway）按仓库 `prompts/桌面宠物 10 秒动作提示词.md` 的规范生成绿幕视频（纯绿 `#00FF00` 背景），然后：

```bat
rem 把 mp4 放进 _repo\video\ 后：
build.cmd -Name cat -InstallFfmpeg
```

它会依次跑 `去水印 → 抠像 → 归一化 → 转码`，把产物直接拷进 `cat-animation\`，再自动校验一遍。

**源视频规格不用自己适配**：1080p、30fps、甚至 .mov 都能直接丢进去——脚本会先统一成 `1280×720 @24`（等比缩放 + 绿边补边）。这一步是必须的，因为 `chroma_step02.py` 里 `W,H,FPS = 1280,720,24` 是硬编码，它按固定字节数从管道读帧，尺寸不对会直接花屏。

已经有 PR 抠好的带 alpha `.mov`？放进 `_repo\pr\`，用 `build.cmd -Name cat -Pr`。

#### 用可灵（Kling）出片

提示词、负向词、参数设置、逐段按秒描述都写在 **[`kling-prompts.md`](kling-prompts.md)**，直接用。

三个要点：

- **16:9 + 纯绿 `#00FF00` + 固定运镜（无推拉摇移）+ 首尾帧同一张站立图**。这四条任缺一条，产物就废。
- 待机要 **10s**（会被反复循环），点击/拖拽 **5s** 就够。
- **没有水印就别加 `-Watermark`**：那个开关是给带固定位置水印的源视频用的，用在干净画面上会挖出一块补丁。

有心仪的形象图？**可以复用**，但不能直接丢给"图生视频"——抠像脚本只认绿色，所以先把图压成绿幕首帧：

```bat
python pet-pack\sticker-to-green.py 我的角色.png -o 绿幕首帧.png
```

- 透明 PNG → 直接用 alpha；纯白/纯灰/纯色底 → 自动取边框色做色键；复杂背景 → 先 `rembg` / remove.bg 抠成透明 PNG
- 输出 1920×1080、纯 `#00FF00`、立高 65%、脚底 85%、水平居中（正好对上仓库规范，`normalize` 不用再纠偏）
- `--erode 2` 收紧白边、`--feather` 调边缘柔化、`--static-webm 待机呼吸.webm` 生成 1 秒静止循环（AI 动作崩了时的兜底静态桌宠）
- 同一张 `绿幕首帧.png` 当**三段视频的首帧**（能设尾帧就设成同一张）——角色一致靠它，不靠提示词

### ③ 让它出现

```bat
install.cmd -Name cat -Display both -Force
```

`-Force` 会用模板重写配置——**如果你已经手动改过 `animations`，先备份**，或者直接编辑 `cat-config.json` 里那一行：

```jsonc
"display": "none"   →   "display": "both"
```

然后刷新 DSH 页面（或右键宠物「重载配置」）。

---

## 目录与命名的两条铁律

1. **配置文件名前缀 = 素材目录名 = URL 里的素材根**
   `cat-config.json` ↔ `cat-animation/` ↔ `/dsh-pet-7340/thumb/cat/待机呼吸.webm`

2. **pet pack 的素材目录是平铺的，没有 `webm` 子目录**
   ```
   ✅ ~/.dsh/dsh-pet/pet/cat-animation/待机呼吸.webm
   ❌ ~/.dsh/dsh-pet/pet/cat-animation/webm/待机呼吸.webm
   ```
   注意主宠物不一样：它是 `~/.dsh/dsh-pet/main-animation/webm/`。这是全项目最容易踩的坑——放错时右键菜单还能列出动画名（菜单来自配置），但点了没反应（素材 404）。

另外：**pet pack 的素材只查自己的目录，永不回落到主宠物或包内素材**。没有就是空白，不会串到蓝毛小女仆身上。

---

## 校验器在查什么

`check-config.mjs` 不重复实现规则，而是直接 `import` 仓库里宿主的 `readAllConfig()`——插件怎么判，它就怎么判：

- `animations` / `animationWeights` 是否**非法被静默回退**成内置默认（最常见的"我明明改了没生效"）
- 引用了哪些动画名、磁盘上缺哪几段（列出 `名字 ← 来自哪个池`）
- 目录里有但配置没引用的孤儿素材（永远播不到）
- 宠物 id 是否与主宠物/别的种类冲突
- `turn` 权重 > 0 但转向池为空之类的死配置

单独跑：

```bat
node --experimental-strip-types check-config.mjs --entry cat
```

（`--home` 可指定别的 DSH 目录；`DSH_PET_ANIMATION_EXT=.mov` 切 macOS 的 mov 素材。）

---

## 绿幕图体检：`check-green.py`

`build.cmd` 里的 `chroma_step02.py` 只认一种输入：**能干净键掉的绿幕**。所以拿到一张绿幕图（自己合成的、或让 GPT image 直接画绿底的）先跑这个，别等出了 mp4 才发现边缘是毛刺：

```bat
python check-green.py 候选.png --size 1920x1080
```

判据和 `chroma_step02.py` 完全一致：hue ∈ [70°,170°]（0~360 口径，纯绿 `#00FF00` = 120°）、S ≥ 0.15、V ≥ 0.15，另加 6° 羽化窗。逐项体检：

| 检查 | 判据 | 不过会怎样 |
|---|---|---|
| 边框色离散度 | < 12 | 背景有渐变/暗角/杂物 |
| 背景色相 | 落在绿色区间 | 不是绿幕（返回码 2） |
| 背景上下亮度差 | < 0.12 | 有阴影/地板 → 抠完留灰边 |
| 过渡带宽度 | < 3.5 px | 角色被绿光染了 → 抠完裙边发绿起毛刺 |
| 构图 | 头顶 15~30%、脚底 75~92%、左右不贴边 | 可灵推镜头裁头发/出画 |
| 画布 | 与 `--size` 一致 | 可灵会加黑边 |

实测三档（同一张图人为加缺陷验证过）：干净绿幕 `1.1px` ✔；内缘染绿 35% → `8.4px` ✘；底部压暗 → 亮度差 `0.30` ✘；透明底图 → 返回码 2「不是绿幕图」。

退出码：`0` 能过 / `1` 能用但有瑕疵（看 `!` 行）/ `2` 不是绿幕。

> 只有"过渡带宽度"这项需要 scipy（`pip install scipy`）；没装时自动跳过并提示，其余检查照跑。

---

## 边缘不干净：`clean-edge.py`

症状：桌宠边缘有一圈**白边 / 绿边**，或者整个矩形框像蒙了一层极淡的绿雾。

两个原因，都是抠像链路的固有产物：

1. **过渡带 RGB 没清**：`chroma_step02.py` 只算 alpha，不动颜色。角色轮廓那 1~2px（`640×360` 下）抗锯齿像素的 RGB 是"角色色 + 绿幕色"的混合，alpha 又是半透明（中位 122/255）。合成到浅色页面上，深色头发周围就显出一圈浅绿灰 —— 肉眼即"白边"。
2. **背景 alpha 不是 0**：`1~7` 的残值占 88% 的画幅（VP9 alpha 量化误差），等于给整块方框蒙了层 2% 的绿。

`clean-edge.py` 逐帧修这两件事：

- `core` = alpha ≥ 200 向内腐蚀 1px（可信本体）
- 边缘像素的 RGB ← **最近 core 像素的颜色**（距离变换带索引，一次 EDT）
- 离 core 超过 3px 的透明像素、以及 alpha < 8 的碎屑 → alpha 归 0
- 残余绿偏移再压一道（只压 `G > max(R,B)`）

**alpha 本身不动**（羽化宽度保留），所以边缘不会变硬、不会锯齿。单文件 10s / 640×360 约 10 秒。

```bat
rem 手动跑（就地重写，--preview 只导前后对比图）
python clean-edge.py --dir %USERPROFILE%\.dsh\dsh-pet\pet\cat-animation
python clean-edge.py --dir ... --preview 对比.png
```

`build.cmd` 每次拷完素材会**自动**调用它（不想跑就加 `-NoClean`）。实测收益：

| 指标 | 清理前 | 清理后 |
|---|---|---|
| 边缘绿偏移（G − max(R,B)） | +21.8 | **+0.3** |
| 背景 alpha 1~7 残雾 | 204,335 px | **670 px** |
| alpha 羽化带宽度 | 1.52 px | 1.48 px（不变 ✔） |
| 文件大小（10s / 640×360） | 266 KB | 406 KB（crf 34 重编码，`--crf` 可调） |

---

## 轮廓有马赛克/台阶：VP9 alpha 的 8×8 块

症状：**贴着头发和衣服边**有一圈方块感/锯齿，放大看是 8px 一格的台阶；浅色页面上尤其明显。

这不是抠像没抠干净，也不是分辨率不够——是 **VP9 在有 alpha 时把 alpha 平面按 8×8 块量化**。
量化误差本身看不出来，问题在**尺寸**：素材 640×360、桌面上那只 `size: 420` 在 150% 缩放的屏上
正好占 ~630 设备像素，等于**1:1 显示**，每一个块的台阶都原样落在屏幕上。

实测（8 网格梯度比值，越接近 1 越干净；官方素材 0.97）：

| 阶段 | 8 网格偏置 |
|---|---|
| `chroma_step02.py` 默认 `-crf 30` | **1.66**（块在这里产生） |
| `chroma` 改 `-crf 5` | **0.31** ✔ |
| `encode_thumbs.py` 640×360（任何 crf 都一样） | **1.32** ✘ |
| 同一源编到 **960×540** | **0.87** ✔ |
| 最终成品（960×540 + 清边） | **0.87 / 0.87 / 1.18** |

两个结论：

1. **中间产物不能省码率**。中间稿的 alpha 一旦压出块，后面放大再缩小也擦不掉——`build.cmd` 会自动
   把 `chroma_step02.py` 的 `-crf 30` 改成 `5`（见 `Ensure-VendorQuality`，幂等，改的是仓库里那份脚本）。
2. **最终成品用 960×540，不用 640×360**。浏览器把 960 缩到 ~630 显示，8px 块被平均掉反而更顺、更清晰。
   这就是 `encode-final.py` 存在的原因（`build.cmd` 的 step04 用它替代 `encode_thumbs.py`）。

代价是文件变大：三条素材从 1.2 MB → 2.9 MB（`--width 1280` 更清晰，~1.7 MB/条）。

```bat
rem 想再清晰一点（或反过来压小），手动重编：
python encode-final.py --repo _repo --width 1280 --height 720 --crf 24
```

> 另外别忘了 `clean-edge.py`：它负责颜色，`encode-final.py` 负责 alpha 的量化。两个一起才干净。

---

## 水印：`find-watermark.py` + `-MaskBox`

免费额度的出片基本都带角标（阿里万相、即梦、可灵、通义都会加）。只要它压在**绿幕**上就能无损去掉——抠像只认绿色，把水印那块涂成绿，等于它不存在。

> 已实测：**阿里万相** 1920×1080 出片的水印恒定在 `x[1545..1872] y[911..1032]`（328×122，纯白），
> 多条视频、跨帧坐标一字不差 → 同尺寸再出片可以直接 `-MaskBox 1545,911,328,122`。

先确认它是"静止的叠加物"：

```bat
python pet-pack\find-watermark.py 待机呼吸.mp4
:: 待机呼吸.mp4: 疑似水印 x[1545..1872] y[911..1032]  328x122  占画幅 x 80.5%~97.6%  y 84.4%~95.6%
::   -MaskBox 1545,911,328,122
```

判据三条：多帧之间坐标完全不变、面积不大、**与角色包围盒在水平方向完全分开**。最后一条是关键——压在人身上的水印涂不了，只能重生成。

然后交给流水线，它会先涂绿再统一规格：

```bat
pet-pack\build.cmd -Name mypet -MaskBox 1545,911,328,122
pet-pack\build.cmd -Name mypet -MaskBox auto          :: 现场探测，多个矩形用分号隔开
```

正常会打印 `涂绿 1 处 + 统一规格 待机呼吸.mp4: 1920x1080 @30/1 -> 1280x720 @24`。

- `auto` 探测不到就**不涂**（宁可留水印，也不误伤发丝/配饰）
- 水印压在角色身上时脚本会说"与角色重叠，不能涂"——生成时让角色别占右下角
- 涂绿在重编码里做，输出仍是 1280×720 mp4，后面照原流程走

成品验一遍（解 alpha、构图、边缘绿偏移、角色外还有没有实心块）：

```bat
python pet-pack\verify-pack.py
```

---

## 让它"活"起来：加动画、加小动作

素材齐了以后，`cat-config.json` 的 `animations` 和 `animationWeights` 就是唯一的「行为剧本」：

```jsonc
"animations": {
  "idle":   ["待机呼吸", "待机打哈欠"],          // 待机池：多段轮播
  "clicks": ["点击回应-开心", "点击回应-害羞"],   // 点一下随机抽一段
  "drag":   ["被抓起悬空"],
  "categories": [                              // 原地小动作池（权重别超过 100 的余量）
    { "id": "小动作", "weight": 12, "actions": ["挠头", "伸懒腰", "打喷嚏"] },
    { "id": "玩耍",   "weight": 8,  "actions": ["玩毛线球", "转圈"] }
  ],
  "events": { "balance": ["待机呼吸"] }        // 事件档位：不进随机链
},
"animationWeights": { "idle": 70, "turn": 0, "move": 10 }   // 剩下 20% 走 categories
```

规则很简单：**`idle + turn + move` 之和 ≤ 100，剩下的百分比全归 `categories`**。
`idle=100` 就永远是待机；`idle=70 / move=10` → 70% 待机、10% 自己走两步、20% 原地做小动作。

想加第二只（同种类同一套素材）：

```jsonc
"pets": [
  { "id": "cat-1", "name": "我的猫", "size": 420, "display": "both", "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } },
  { "id": "cat-2", "name": "二猫",   "size": 300, "display": "both", "position": { "corner": "bottom-left", "marginX": 24, "marginY": 80 } }
]
```

id 全局唯一（含主宠物的 `main`），两个实例共用同一个 `cat-animation/`。

---

## 常见问题

| 现象 | 原因 | 解 |
|---|---|---|
| 角色身上有一块模糊补丁 | 对无水印视频误加了 `-Watermark` | 去掉该开关，删掉 `_repo\step01\` 里被涂过的文件重跑 |
| 边缘一圈白边/绿边、方框像蒙了层绿雾 | 抠像过渡带 RGB 没清 + 背景 alpha 残留 1~7 | 跑 `clean-edge.py --dir <素材目录>`（`build.cmd` 已自动调用） |
| **轮廓上有 8px 一格的马赛克/台阶** | VP9 的 alpha 按 8×8 块量化；640×360 在 150% 屏上等于 1:1 显示 | 别用 640 成品：`encode-final.py`（默认 960×540）已替代 `encode_thumbs.py`；中间稿的 `chroma` crf 也由 `build.cmd` 自动降到 5 |
| 形象图本身带白描边 | 源图的描边被当角色保留 | `sticker-to-green.py --erode 1~2` 先收紧 |
| 三段动画换着播时"忽大忽小" | AI 生成的体型不一致 | 看流水线打印的 `scale`，差异 >20% 就重生成 |
| 刷新后什么都没有 | `display` 还是 `none` | 改 `both` |
| 界面上有名字、点了不播 | 素材目录/文件名不对 | 跑 `check-config.mjs`，看"还缺这些素材" |
| 透明区域是黑的 | 转码丢了 alpha | 必须 `-c:v libvpx-vp9` + `-pix_fmt yuva420p` 两个都写 |
| **想验证成品有没有 alpha，取出来却全不透明** | 用 ffmpeg 默认解码器取帧，VP9 的 alpha 是旁路存的，默认解码器直接丢掉 | 取帧时必须写 `-c:v libvpx-vp9`：`ffmpeg -c:v libvpx-vp9 -i x.webm -frames:v 1 -pix_fmt rgba x.png`；`ffprobe` 显示 `pix_fmt=yuv420p` + `TAG:ALPHA_MODE=1` 是正常的 |
| 流水线报 `ffprobe` 找不到 / 直接崩 | `.tools\...\bin\` 里只有 ffmpeg 没有 ffprobe | 两个都要放进同一目录（脚本里路径是硬编码的） |
| 抠像出来是花屏/错位条纹 | 源视频不是 1280×720（比如 1080p） | 新版 `build.cmd` 会自动统一规格；手工跑 `chroma_step02.py` 时得先自己缩到 1280×720 |
| 换动画时"跳一下" | 首尾帧不一致 | 重生成时强制首帧=末帧 |
| 宠物滑步/位置漂移 | 动画里带位移 | 位移交给代码，动画只做原地姿态 |
| 改了配置没生效 | 某段非法被静默回退 | 看校验器的"宿主告警"；或 `animations` 缺了 idle/turn/drag/clicks |
| 一直只播待机 | 权重 idle=100 | 调成 `idle:70, move:10` 并加 `categories` |
| Safari 上黑底 | Safari 不认 webm alpha | 换 HEVC `.mov`，设 `DSH_PET_ANIMATION_EXT=.mov` |
| `install.cmd` 一闪而过 | 参数错/路径错 | 在 cmd 里手动跑，看错误输出 |

---

## 桌宠"时不时闪一下"：多半是 AI 素材自带的跳变

真机复现过：待机看着像"每隔几秒抖一下/闪一下"。测下来不是编码、不是抠像、也不是播放器：

- 逐帧量角色区的帧间差，基线只有 **2.2/255**，但有 **3 处**（239 帧里的 80–92 / 128–146 / 179–194）骤升到 **25–30**；
- 相位相关能看到那几处角色**整体横移 2.5–2.8 px 后又重绘**，不是单纯的位移（平移对齐后差异几乎不变），也不是亮度抽动（≤1.7）、不是关键帧（全片只有 2 个 I 帧）、不是循环接缝（不在首尾）；
- 同样的三处跳变在**源 mp4 里就有**（30fps 的 4.3 / 6.8 / 9.4 s，×1.25 正好对上 24fps 的 3.5 / 5.5 / 7.6 s）—— AI 生成时就有的，流水线只是如实传下来。

所以"补救"只有三条路，实测结论：

| 办法 | 效果 |
|---|---|
| 时域去尖峰（[`smooth.py`](smooth.py)，逐像素中值替换离群帧） | **基本无效**：只有 0.06–0.3% 像素被判为离群，因为那是整片区域在变，不是孤立噪点 |
| 亚像素稳定器（[`stabilize.py`](stabilize.py)，相位相关 + 轨迹平滑） | 能测出 2.5 px 横移并补掉，但最大帧间差只从 26.4 降到 25.8 —— 因为跳变里夹着**重绘**，平移救不了 |
| **待机换成程序化**（`make-motion.py --only idle`） | ✔ 最大帧间差 **26.4 → 1.4**，且呼吸起伏是真的在动 |

推荐做法：待机用 `make-motion.py` 从同一张绿幕图生成（脸和衣服一模一样，只是动作换成刚体起伏），点击/拖拽仍用 AI 素材 —— 那两个本来就是大动作，偶尔的跳变看不出来。

```bat
:: 只重做待机，然后照常跑流水线
python pet-pack\make-motion.py --only idle
pet-pack\build.cmd -Name mypet -Force
```

---

## 授权

- 插件代码：MIT
- 官方素材、提示词、源视频：**禁止商用**；二次创作/换皮作品请在展示与分发处附上
  <https://github.com/PC2005-cloud/dsh-pet>
- 你自己生成的素材不受此限，但提示词配方是原作者成果，用了应署名。