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

参数依次为：输出目录、观测秒数、传输路径 `http|bridge`、场景 `original|native|fade`。

- `original`：使用安装 helper 的原播放逻辑，普通待机实际为 `loop=false`。
- `native`：仅在诊断实例中改为原生循环，用于检验交接中的假设。
- `fade`：仅在诊断实例中恢复旧 CSS 淡入淡出，作为透明度下降的阳性对照。

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
