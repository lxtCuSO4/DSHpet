# 待机闪帧诊断

用于观察本机已安装的 Electron helper。不会修改安装目录、宠物配置或素材；
会启动独立诊断窗口并在输出目录写入配置副本、日志和截图，结束后关闭该窗口。
原桌宠保持运行。诊断窗口位于屏幕左上角，始终点击穿透。

输出含本机配置，务必放在已忽略的 `_art/` 下；不要提交原始配置、桌面录屏或截图。
脚本目前针对 Windows、本机 `mypet-1`、size 420、五条自定义素材的环境，
不是通用宠物测试工具。bridge 模式模拟宿主应答，保留安装 helper 的协议及读盘路径，
不覆盖真实宿主调度、用户输入、长期运行状态与 Windows 桌面抓屏路径。

## 运行隔离探针

依赖 Node 的 TypeScript strip 支持、Playwright、本机 `.dsh/electron/electron.exe`
与 `.dsh/profiles/desktop/node_modules/dsh-pet`。当前环境可用：

```powershell
$env:NODE_PATH = 'C:\Users\27913\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node --experimental-strip-types tools/diagnostics/idle-loop-probe.mjs _art/idle-loop-diagnosis/probe-bridge 65 bridge original
```

参数依次为：输出目录、观测秒数、传输路径 `http|bridge`、场景 `original|native|fade|visibility`。

- `original`：使用安装 helper 的原播放逻辑，普通待机实际为 `loop=false`。
- `native`：仅在诊断实例中改为原生循环，用于检验交接中的假设。
- `fade`：仅在诊断实例中恢复旧 CSS 淡入淡出，作为透明度下降的阳性对照。
- `visibility`：保留原双视频加载和换层逻辑，仅将 CSS 显隐从 opacity 改成 visibility，用于区分显示方式。

`probe.json` 记录媒体事件、方法调用、视频帧回调与近循环点的 RAF 状态。
`captureFrames` 为 `beginFrameSubscription` 获取的合成帧透明度总和与亮度。
透明度突降超过 20% 时另存局部截图。采样只覆盖订阅期间上报的帧，不能证明显示器从未闪烁。

```powershell
$env:PYTHONIOENCODING = 'utf-8'
python tools/diagnostics/summarize-idle-probes.py _art/idle-loop-diagnosis
```

汇总固定实验目录，生成不含配置和截图的 `probe-summary.json`。
`probe-original` 是早期收到鼠标输入的探索记录，不纳入干净待机证据。

## 原桌宠桌面录屏

先用 `GetWindowRect` 确认当前窗口位置与实际缩放，选择覆盖宠物的屏幕区域。
下面坐标只适用于本轮长录屏当时的位置，后续必须重新测量：

```powershell
& '_repo/.tools/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe' -hide_banner -loglevel warning -f gdigrab -framerate 60 -draw_mouse 0 -offset_x 2100 -offset_y 250 -video_size 460x500 -i desktop -t 125 -an -c:v libx264 -preset ultrafast -crf 12 -pix_fmt yuv420p -y _art/idle-loop-diagnosis/live-extended-60fps.mp4
```

`-framerate 60` 是请求采样率，实际时间须读媒体 PTS，不能把解码帧序号直接除以 60。

## 素材逐帧比对

需要 Python、NumPy、FFmpeg/FFprobe。VP9 alpha 使用 `libvpx-vp9` 解码。
脚本将固定 ROI 与素材各帧在白底上的 RGB 渲染比较，输出候选异常及实际 PTS。
位置、缩放、遮挡、底色改变均可能造成高残差，候选异常必须回看原图。

```powershell
python tools/diagnostics/compare-idle-recording.py _art/idle-loop-diagnosis/live-extended-60fps.mp4 'C:/Users/27913/.dsh/dsh-pet/pet/mypet-animation/待机呼吸.webm' --ffmpeg _repo/.tools/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe --seconds 75 --stage -109 113 630 354 --roi 165 190 95 240 --output _art/idle-loop-diagnosis/extended-source-alignment.json
```

`--stage X Y W H` 是视频舞台相对录屏的像素矩形，可部分位于画面外；
`--roi X Y W H` 必须位于舞台与录屏内，选取固定白底上的角色主体。
本例只分析长录屏前 75 秒；后段桌宠位置与背景变化，未作为固定 ROI 待机证据。

## 原进程临时观测与桌面双路抓取

Windows 上已用一次性 Electron 进程验证 Node 内部 `_debugProcess` 可以打开本运行时的
本机 inspector。`observe-live-idle.mjs` 要求明确传入 PID，核对进程身份后，
临时记录媒体事件、class/style 变化、RAF、视频帧回调、窗口方法及合成图像 alpha。
不重启原桌宠；结束时恢复方法、取消回调、移除监听器、结束帧订阅并关闭本次开启的 inspector。
使用的是 Node 内部接口，仅在本轮 Windows/Electron 环境验证，不承诺其他版本兼容。

```powershell
node tools/diagnostics/observe-live-idle.mjs 27980 180 _art/idle-loop-diagnosis/live-observed-1
node tools/diagnostics/capture-idle-desktop.mjs 150 _art/idle-loop-diagnosis/live-observed-1/desktop 1920 130 640 600
```

两条命令应在不同终端运行；窗口 PID、屏幕矩形应重新测量。DDA 固定 output_idx=0，
当前仅有一块 2560×1440 显示器。使用 `--no-compositor` 可关闭 helper 帧订阅，检验读回采样的干扰；
捕获器支持 `--dda-only`。两路输出保持在忽略目录。

`*-clock.ndjson` 记录 FFmpeg showinfo 原始 PTS 与 stderr 行到达时间。
编码可能丢帧或取整，最近 PTS 对齐可差一个采样；到达时间也不是显示器精确呈现时间，
适合对齐同一个十秒边界，不能据此精确计算跨进程的毫秒级因果顺序。

## 独立实例的屏幕对照

```powershell
node tools/diagnostics/run-idle-screen-control.mjs _art/idle-loop-diagnosis/screen-original 85 original
node tools/diagnostics/run-idle-screen-control.mjs _art/idle-loop-diagnosis/screen-native 85 native
node tools/diagnostics/run-idle-screen-control.mjs _art/idle-loop-diagnosis/screen-visibility 85 visibility
```

此命令在现有隔离探针宣布就绪后，自动用 Desktop Duplication 抓取舞台区域，
持续时间比探针少三秒，避免关窗时误计空帧。诊断窗在左上角且点击穿透。
外部显示桌面、截图遮罩等操作会改变最终桌面图像，必须回看并单独归类。

非白底使用比对工具的 `--opaque-only`：只比较素材所有帧中 alpha 均至少为 254 的像素，
忽略透明边缘后的桌面背景。本轮主体 ROI 降采样后有 965 个这样的像素。
不适用于位置、缩放或镜像方向变化；不能把白底模式的高基线残差直接解释成动画异常。

```powershell
python tools/diagnostics/compare-idle-recording.py _art/idle-loop-diagnosis/screen-original/desktop/dda.mp4 'C:/Users/27913/.dsh/dsh-pet/pet/mypet-animation/待机呼吸.webm' --ffmpeg _repo/.tools/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe --seconds 82 --stage 0 0 630 354 --roi 274 77 95 180 --opaque-only --output _art/idle-loop-diagnosis/screen-original/desktop/dda-alignment.json
python tools/diagnostics/summarize-live-idle.py _art/idle-loop-diagnosis --output _art/idle-loop-diagnosis/live-correlation-summary.json
```
