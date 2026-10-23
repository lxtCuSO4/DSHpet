# 桌宠项目交接说明（给接手的人/AI 看）

> 一句话：给 **dsh-pet** 插件做了一只「用自己画的角色 + AI 生成绿幕视频」的桌宠，现在已经在 **DSH 桌面小窗**里正常跑。
> 只剩一个已知小瑕疵（待机每 10 秒循环时闪 1~2 帧），方案已定、代码未改。
>
> 读完这一份就能接着干。所有路径都是这台机器上的**绝对路径**（Windows）。

---

## 1. 环境事实（不要猜，照这个来）

| 项 | 值 |
|---|---|
| 工作目录 | `D:\harnessTest\DSHpet` |
| 仓库源码（只读参考，别改） | `D:\harnessTest\DSHpet\_repo`（dsh-pet 源码 + 素材链脚本） |
| DSH 数据目录 | `C:\Users\27913\.dsh` |
| 当前生效的 profile | `C:\Users\27913\.dsh\profiles\desktop`（插件装在这里） |
| 插件包 | `C:\Users\27913\.dsh\profiles\desktop\node_modules\dsh-pet`（v0.3.7） |
| 插件启用开关 | `C:\Users\27913\.dsh\profiles\desktop\cordis.patch.yml` → `- id: dsh-pet` + `disabled: false` |
| 桌面小窗渲染器 | `.../dsh-pet/runtime/electron-helper/`（`main.js` / `index.html` / `sprite.js` / `renderer.js`） |
| Electron 可执行 | `C:\Users\27913\.dsh\electron\electron.exe`（插件自动拉起，**不用手动开**） |
| 宠物配置（我们这只） | `C:\Users\27913\.dsh\dsh-pet\pet\mypet-config.json` |
| 宠物素材目录 | `C:\Users\27913\.dsh\dsh-pet\pet\mypet-animation\*.webm` |
| 主宠物配置（别删） | `C:\Users\27913\.dsh\dsh-pet\main-config.jsonc`（把官方主宠物 `main` 设成 `display:none`，否则会出现第二只） |
| ffmpeg / ffprobe | `D:\harnessTest\DSHpet\_repo\.tools\ffmpeg-9.0.1-essentials_build\bin\`（ffmpeg 7.1 essentials + ffprobe 4.0.2） |
| Python | 3.13.5，已装 numpy / scipy / pillow |

**系统工具链的坑（都踩过）**

- 机器上**只有 Windows PowerShell 5.1**，没有 pwsh7；`.ps1` 必须存成 **UTF-8 with BOM**，否则中文注释按 GBK 解码直接语法错误（`Unexpected attribute 'CmdletBinding'`）。
- PowerShell 变量名大小写不敏感，**别用 `$home`**（只读自动变量），本仓库统一用 `$dshRoot`。
- 执行策略禁止直接跑 `.ps1` → 一律通过 `.cmd` 包装器（内部 `-ExecutionPolicy Bypass -File`）。
- **ffmpeg 写不进 `C:\Users\27913\.dsh\**`**（`Permission denied`），但 PowerShell / python 能写。→ 所有 ffmpeg 产物先编码到工作区（`pet-pack\_tmp`），再用 python `shutil.move` 搬过去（`os.replace` 跨盘会 WinError 17）。
- `%TEMP%` 同理写不进去，中间文件放工作区。

---

## 2. 现在装的是什么

配置 `mypet-config.json` 的关键部分：

```jsonc
"pets": [{
  "id": "mypet-1", "name": "我的桌宠", "size": 420,
  "display": "desktop",        // 只在桌面小窗显示（页面浮层不显示，避免两只）
  "position": { "corner": "top-right", "marginX": 24, "marginY": 100 }
}],
"animations": {
  "idle":   ["待机呼吸"],
  "clicks": ["点击回应", "点击回应-害羞", "点击回应-挥手"],   // 点一下随机抽一条
  "drag":   ["被抓起悬空"],
  "turn": [], "moves": { "default": {...}, "actions": [] }, "categories": [],
  "events": { "balance": ["待机呼吸"] }        // 占位，pet pack 不会真播余额动画
},
"animationWeights": { "idle": 100, "turn": 0, "move": 0 }
```

素材（全在 `mypet-animation\`，960×540 / 24fps / VP9+alpha / `ALPHA_MODE=1`）：

| 文件 | 帧数 | 大小 | 用途 | 来源 |
|---|---|---|---|---|
| `待机呼吸.webm` | 240 | ~1.2 MB | 空闲循环 | 可灵 AI 绿幕片 |
| `点击回应.webm` | 120 | ~1.0 MB | 点击（跳跃欢呼） | 可灵 |
| `点击回应-害羞.webm` | 120 | ~1.06 MB | 点击变体 | 可灵 |
| `点击回应-挥手.webm` | 120 | ~1.14 MB | 点击变体 | 可灵 |
| `被抓起悬空.webm` | 120 | ~1.19 MB | 拖动时 | 可灵 |

角色形象源图：`D:\harnessTest\DSHpet\pet-pack\_art\green-frame.png`（1672×941 绿幕图）。
构图重排版：`green-frame-framed.png`（1920×1080，头顶 23.1% / 脚底 84.7%）。

---

## 3. 素材流水线（改素材只用这几个命令）

```bat
:: ① 换某一条素材：把新 mp4 放进 _repo\video\ 并命名为目标名（如 待机呼吸.mp4）
::    然后把其余 4 条在 video\ step01\ step02\ step03\ step04\ 的同名文件临时挪走
::    （否则它们会被无谓重编码一代，掉画质），再跑：
pet-pack\build.cmd -Name mypet -Force -MaskBox auto

:: ② 只给待机做「循环首尾交叉淡化」（点击/拖拽不需要，它们不循环）
python pet-pack\loopify.py "C:\Users\27913\.dsh\dsh-pet\pet\mypet-animation\待机呼吸.webm" --fade 3

:: ③ 校验配置
node --experimental-strip-types pet-pack\check-config.mjs --entry mypet

:: ④ 装好后重启小窗（插件会自动拉起新实例）
```

`build.cmd` 做的事（都在 `pet-pack\build-assets.ps1`）：

1. `Normalize-Step01`：`drawbox` 涂绿水印（`-MaskBox auto` 会自己找水印位置）+ 统一成 1280×720@24fps（`fps=24:eof_action=pass`，**这个参数是修 bug 加的，删了会丢末帧**）
2. `chroma_step02.py`（自动把仓库里的 `-crf 30` 改成 `-crf 5`，alpha 块效应才不出现）
3. `normalize_step03.py`（已改 `overlay=...:eof_action=pass`，同样为防丢帧）
4. `encode-final.py` → 960×540 crf24（**不是**仓库自带的 `encode_thumbs.py`，那个出 640×360 会有 8×8 马赛克）
5. `clean-edge.py`：边缘去绿染 + 补色
6. 拷进 `mypet-animation\`

**素材出片硬约束（拿给 AI 视频工具用）**

- 1920×1080、24~30fps、10s（待机）/ 5s（一次性动作）、纯绿 `#00FF00`、无阴影无地面
- 角色头顶离画面顶边 **≥10%**、脚底离底边 **≥8%**、双脚钉在原地不左右位移
- 待机/转向类必须**首尾帧闭合**（末秒回到与首帧完全一致的姿势）
- 自查：`python pet-pack\video-jitter.py <文件>`（接缝<12、片中最大<12、帧间中位>0.3）

---

## 4. 待办：唯一的已知瑕疵

### 现象

**待机每 10 秒循环重播时"灰一下"**（1~2 帧），点击/拖拽播放不灰。切换动作的灰已经修好了（见第 5 节）。

### 原因（已定位，不是素材问题）

- 待机走浏览器**原生循环**：`sprite.js:383` `el.loop = !nextOnce;`、`:387` `el.onended = nextOnce ? ... : null`
- 点击/拖拽走**换层**：`el.loop=false`，播完 `ended` → 客户端 `switchTo('待机呼吸')`，新 `<video>` 元素 `loadeddata` 后才 `classList.add('is-front')`，旧元素同时 `remove` + `pause()`（`sprite.js:408-412`、`:417`）
- 原生循环绕回第 0 帧时，Chromium 对 **VP9+alpha 的 blob** 会漏 1~2 帧；窗口 `transparent:true`、`body{background:transparent}`，所以看到的是**桌面透出来**（浅色桌面 → 看着像"灰"）

### 三个方案（A 已否，剩下 B/C）

- **B（推荐，治本，约 30 行）**：给循环动画加预滚——播到剩 ~0.2s 时让另一个 `<video>` 用**同一个 blob** 从 0 开播，到边界瞬间换 `is-front`，与点击切回待机的机制完全一致。
  改动只在 `C:\Users\27913\.dsh\profiles\desktop\node_modules\dsh-pet\runtime\electron-helper\sprite.js`。
  **必须**：先 `Copy-Item sprite.js sprite.js.orig` 备份；改完用 UTF-8 **无 BOM** 写回（`.js` 不要 BOM）；重启 helper 验证。
  注意 `sprite.js:934` 有一句注释说明"旧实现 `switchTo(idle,false)` 导致随机链永远回不来"，改预滚后要确认随机链（`pickNext`）仍然正常。
- **C（治标）**：待机做成 20 秒素材，闪烁频率减半。

---

## 5. 已经打过的补丁（别覆盖回去）

| 文件 | 改动 | 备份 |
|---|---|---|
| `dsh-pet/runtime/electron-helper/index.html:51` | `transition: none;`（原来是 `transition: opacity 0.18s ease`，两层各半透明时整片发灰） | `D:\harnessTest\DSHpet\_backup\index.html.orig` |
| `dsh-pet/lib/client.js`（2 处 `transition:opacity .18s ease`） | 同样改 `none` | `D:\harnessTest\DSHpet\_backup\client.js.orig` |
| `dsh-pet/assets/...`（未改） | — | — |

> 回滚：把 `_backup\*.orig` 拷回原路径，然后重启小窗。
> **注意**：npm 重装/升级 dsh-pet 会覆盖这些补丁。

---

## 6. 重启与验证

```powershell
# 只看进程
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-pet*' } | Select ProcessId,CommandLine

# 重启小窗：杀掉 helper 主进程，插件会自动拉起（lib/index.js:2147 scheduleRestart）
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*electron-helper\main.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 4   # 3 秒内应出现新 PID
```

截图确认渲染（PowerShell + .NET）：

```powershell
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = New-Object Drawing.Bitmap 2560,1440
[Windows.Forms.Screen]::PrimaryScreen | Out-Null
$g = [Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0,0,0,0,$b.Size)
$b.Save('D:\harnessTest\DSHpet\_art\now.png')
```

桌宠窗口的 Win32 矩形可以用 `user32!GetWindowRect` 取；注意它的 `X` 可能是负值（有部分在屏幕外）。

---

## 7. 文件地图

```
D:\harnessTest\DSHpet\
├─ pet-pack\                      ← 全部自研工具
│  ├─ build.cmd / build-assets.ps1     绿幕视频 → webm（含 Normalize/MaskBox/clean-edge）
│  ├─ install.cmd / install.ps1        建 pet pack 骨架（本机已建好，改动用上面 ①）
│  ├─ check-config.mjs                 用宿主同一份 readAllConfig 校验配置
│  ├─ make-motion.py                   一张绿幕图 → 程序化动效（刚体）
│  ├─ clean-edge.py                    边缘去绿染
│  ├─ loopify.py                       循环首尾交叉淡化（--fade N / --cut N）
│  ├─ despike.py                       片中跳变修补（**用户明确不喜欢：会出残影，未接入**）
│  ├─ encode-final.py                  960×540 最终编码（替代仓库的 encode_thumbs）
│  ├─ video-audit.py                   构图/背景/溢色体检
│  ├─ video-jitter.py                  接缝/片中跳变体检
│  ├─ video-motion.py                  动没动 + 水印连通块
│  ├─ find-watermark.py                自动找水印矩形
│  ├─ verify-pack.py / green-check.py  成品整体验收
│  ├─ 动作清单.md                       还能加哪些动作、提示词骨架
│  ├─ kling-prompts.md                 可灵/万相/即梦出片手册
│  └─ _art\                           临时分析与中间图（可清）
├─ _repo\                         ← dsh-pet 源码 + 官方素材链（只读参考）
├─ _backup\                       ← 所有关键备份（webm / mp4 / .orig / green-frame 旧图）
└─ _hold / _hold2 / _tmpswap\     ← 换素材时的暂存目录（可清）
```

---

## 8. 用户偏好（很重要）

- 用户**讨厌**"混合/叠影"：任何时域平滑、半帧混合都会被要求撤掉（`despike.py` 就是这么被否的）。宁可留一次跳，也不要残影。
- 用户会自己用**可灵/阿里万相**出绿幕片，通常直接给 mp4 说"替换某个动作"。
- 出片前最好先跑 `video-audit.py`：**顶部出画**（头顶到 y=0）和**中心漂移**是两个最常被退回的问题。
- 提问要短、要有数（帧数 / 接缝值 / 百分比），不要长篇解释。

---

## 9. 下一步（接手时按这个顺序）

1. 读第 4 节，确认用户要 B 还是 C；**动 `sprite.js` 前先备份**。
2. 若做 B：实现「待机预滚换层」→ 重启 helper → 用 60fps 抓屏（`ffmpeg -f gdigrab -framerate 60 -offset_x <X> -offset_y <Y> -video_size <W>x<H>`）验证循环点没有空帧，且点击/拖拽仍正常、随机链（`categories`/`turn`/`move`）仍能抽到。
3. 若要加新动作：看 `pet-pack\动作清单.md`，`categories` 与 `events.workStatus` 性价比最高。