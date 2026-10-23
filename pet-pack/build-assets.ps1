# 把绿幕视频跑成桌宠素材（.webm），直接放进 pet pack 的素材目录。
#
# 兼容 Windows PowerShell 5.1 / PowerShell 7。执行策略受限时用同目录的 build.cmd。
#
# 走仓库自带的四步流水线（scripts/ 下的 Python 脚本，路径硬编码，必须在仓库根跑）：
#     video\  --watermark_step01-->  step01\        （源视频已去过水印可跳过）
#     step01\ --chroma_step02----->  step02\        （自动绿幕抠像 -> 透明视频）
#      pr\    --pr_import_step02--->  step02\        （改用 PR 手工抠好的透明 mov，-Pr 开关）
#     step02\ --normalize_step03-->  step03\        （2160x1215 归一化 + 脚底对齐）
#     step03\ --encode_thumbs----->  step04\        （640x360 VP9-alpha）
#     step04\ --------------------->  $DSH_HOME\dsh-pet\pet\<Name>-animation\
#
# 脚本要求 ffmpeg 在 <仓库>\.tools\ffmpeg-9.0.1-essentials_build\bin\（硬编码）。
# 缺失时加 -InstallFfmpeg 自动下载解压到该位置。

[CmdletBinding()]
param(
  [string]$Name = 'mypet',
  [string]$Repo,
  [string]$DshHome,
  [switch]$Pr,             # 用 pr\ 里的透明 mov 代替自动抠像
  [switch]$Watermark,      # 先跑 watermark_step01（video\ -> step01\）
  [switch]$InstallFfmpeg,  # 缺 ffmpeg 时自动下载解压
  [switch]$Force,          # 覆盖已存在的同名 webm
  [switch]$NoClean,        # 跳过"去白边/绿边"后处理
  [string]$MaskBox = ''    # 涂绿矩形 x,y,w,h（多个用分号分隔；auto = 自动探测右下角水印）
)

$ErrorActionPreference = 'Stop'
# 让所有 python 子进程按 UTF-8 输出：控制台是 GBK 时，脚本里的 ✔ 之类会直接崩
$env:PYTHONIOENCODING = 'utf-8'

if (-not $Repo) { $Repo = Join-Path (Split-Path -Parent $PSScriptRoot) '_repo' }
if (-not (Test-Path (Join-Path $Repo 'scripts'))) { throw "仓库不存在或结构不对：$Repo（用 -Repo 指定）" }

if ($DshHome) { $dshRoot = $DshHome }
elseif ($env:DSH_HOME) { $dshRoot = $env:DSH_HOME }
else { $dshRoot = Join-Path $env:USERPROFILE '.dsh' }

$animDir = Join-Path $dshRoot "dsh-pet\pet\$Name-animation"
if (-not (Test-Path $animDir)) {
  Write-Host "· 素材目录不存在，先建骨架" -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot 'install.ps1') -Name $Name -DshHome $dshRoot -SkipCheck
}

$toolsDir   = Join-Path $Repo '.tools'
$ffmpegBin  = Join-Path $toolsDir 'ffmpeg-9.0.1-essentials_build\bin'
$ffmpegExe  = Join-Path $ffmpegBin 'ffmpeg.exe'
$ffprobeExe = Join-Path $ffmpegBin 'ffprobe.exe'

function Resolve-Ffmpeg {
  if (Test-Path $ffmpegExe) { return }

  # .tools 里已有别的解压目录（手工放的）-> 建 junction 指向它，免重复下载
  $cand = $null
  if (Test-Path $toolsDir) {
    $cand = Get-ChildItem $toolsDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'bin\ffmpeg.exe') } |
      Select-Object -First 1
  }
  if ($cand) {
    $linkPath = Split-Path -Parent $ffmpegBin
    if (Test-Path $linkPath) { Remove-Item $linkPath -Force -Recurse -ErrorAction SilentlyContinue }
    New-Item -ItemType Junction -Path $linkPath -Target $cand.FullName -ErrorAction SilentlyContinue | Out-Null
    if (Test-Path $ffmpegExe) { Write-Host "· 已把 $($cand.Name) 链接为 ffmpeg-9.0.1-essentials_build" -ForegroundColor DarkGray; return }
  }

  if (-not $InstallFfmpeg) {
    Write-Host ""
    Write-Host "x 缺 ffmpeg。脚本硬编码路径：" -ForegroundColor Red
    Write-Host "    $ffmpegExe"
    Write-Host ""
    Write-Host "  三个选择："
    Write-Host "    1) 加 -InstallFfmpeg 自动下载（gyan.dev essentials，约 100MB）"
    Write-Host "    2) 手工下载解压到 $toolsDir\ffmpeg-9.0.1-essentials_build\"
    Write-Host "    3) 已有 ffmpeg：把它的 bin 目录整个复制成上面的路径"
    throw "ffmpeg 未就绪"
  }

  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $zip = Join-Path $toolsDir 'ffmpeg-release-essentials.zip'
  Write-Host "· 下载 ffmpeg essentials ..." -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip
  Write-Host "· 解压 ..." -ForegroundColor Cyan
  $tmp = Join-Path $toolsDir '_unzip'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  $dest = Join-Path $toolsDir 'ffmpeg-9.0.1-essentials_build'
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item $inner.FullName $dest
  Remove-Item $tmp, $zip -Recurse -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path $ffmpegExe)) { throw "解压后仍找不到 ffmpeg.exe：$ffmpegExe" }
  Write-Host "ok ffmpeg 就绪" -ForegroundColor Green
}

Resolve-Ffmpeg

# numpy 是 chroma_step02 / normalize_step03 的硬依赖
$np = & python -c "import numpy; print(numpy.__version__)" 2>&1
if ($LASTEXITCODE -ne 0) { throw "python 缺 numpy：pip install numpy" }
Write-Host "· python numpy $np"

function Invoke-Step([string]$script, [string]$label) {
  $path = Join-Path $Repo "scripts\$script"
  if (-not (Test-Path $path)) { throw "脚本缺失：$path" }
  Write-Host ""
  Write-Host "== $label ==" -ForegroundColor Cyan
  Push-Location $Repo
  try {
    & python -u $path
    if ($LASTEXITCODE -ne 0) { throw "$script 失败（退出码 $LASTEXITCODE）" }
  } finally { Pop-Location }
}

# 宿主的 scripts\ 把码率写死了。VP9 的 alpha 在低码率下会被压出 8x8 方块——
# 素材按 1:1 显示在桌面上时，那就是肉眼可见的"马赛克台阶"。这里把两处质量调高，幂等。
function Ensure-VendorQuality {
  $targets = @(
    @{ Rel = 'scripts\chroma_step02.py'; From = '"-crf", "30"'; To = '"-crf", "5"' }
  )
  foreach ($t in $targets) {
    $p = Join-Path $Repo $t.Rel
    if (-not (Test-Path $p)) { continue }
    $text = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
    if ($text.Contains($t.From)) {
      $text = $text.Replace($t.From, $t.To)
      [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host ("· 提高 alpha 码率：{0}  {1} -> {2}" -f (Split-Path $p -Leaf), $t.From, $t.To) -ForegroundColor Cyan
    }
  }
}

function Get-MediaFiles([string]$dir) {
  if (-not (Test-Path $dir)) { return @() }
  @(Get-ChildItem $dir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -ieq '.mp4' -or $_.Extension -ieq '.mov' })
}

# chroma_step02.py 里 W,H,FPS = 1280,720,24 是硬编码的（它按固定字节数从管道读帧），
# 所以 1080p / 30fps 的源视频必须在这里先统一规格，否则读帧错位、输出是花屏。
# 顺便把 .mov 转成 .mp4 —— chroma 只扫 *.mp4，留着 mov 会被静默忽略。
function Resolve-MaskBoxes([string]$file) {
  # 返回待涂绿的 "x,y,w,h" 列表（源视频坐标系）；-MaskBox auto 时现场探测
  $list = @()
  if (-not $MaskBox) { return $list }
  if ($MaskBox -eq 'auto') {
    $finder = Join-Path $PSScriptRoot 'find-watermark.py'
    if (-not (Test-Path $finder)) {
      Write-Host "  ! 找不到 find-watermark.py，跳过自动涂绿" -ForegroundColor Yellow
      return $list
    }
    # 只要"x,y,w,h"这一行：python 的其它输出在 PS 5.1 里会变成 NativeCommandError，
    # 所以统一收进来再按格式挑（新手 <&2 重定向在 Stop 模式下会抛错）
    $lines = @(& python $finder $file --box 2>&1 | ForEach-Object { "$_" })
    $got = ($lines | Where-Object { $_ -match '^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$' } | Select-Object -Last 1)
    if ("$got".Trim()) {
      $list += "$got".Trim()
      Write-Host ("  · 探测到静止叠加物，涂绿：{0}" -f "$got".Trim()) -ForegroundColor DarkGray
    } else {
      Write-Host "  · 没探测到静止叠加物（水印可能压在角色上，无法自动处理）" -ForegroundColor DarkGray
    }
    return $list
  }
  foreach ($b in ($MaskBox -split ';')) {
    $t = "$b".Trim()
    if ($t) { $list += $t }
  }
  return $list
}

function Normalize-Step01([string]$dir) {
  foreach ($f in (Get-MediaFiles $dir)) {
    $boxes = Resolve-MaskBoxes $f.FullName
    $vf = ''
    foreach ($box in $boxes) {
      $pb = ("$box" -split ',')
      if ($pb.Count -ne 4) { throw "-MaskBox 格式不对：$box（要 x,y,w,h）" }
      $vf += ("drawbox=x={0}:y={1}:w={2}:h={3}:color=0x00FF00:t=fill," -f $pb[0].Trim(), $pb[1].Trim(), $pb[2].Trim(), $pb[3].Trim())
    }
    $vf += "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x00FF00,fps=24:eof_action=pass"

    $probe = (& $ffprobeExe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 $f.FullName 2>$null | Select-Object -First 1)
    $p = "$probe".Trim() -split ','
    $w = 0; $h = 0; $fps = ''
    if ($p.Count -ge 3) { $w = [int]$p[0]; $h = [int]$p[1]; $fps = $p[2] }
    if ((-not $boxes.Count) -and $f.Extension -ieq '.mp4' -and $w -eq 1280 -and $h -eq 720 -and $fps -eq '24/1') { continue }

    $out = Join-Path $dir ($f.BaseName + '.mp4')
    $tmp = Join-Path $dir ($f.BaseName + '.norm.mp4')
    $why = '统一规格'
    if ($boxes.Count) { $why = "涂绿 $($boxes.Count) 处 + 统一规格" }
    Write-Host ("  · {0} {1}: {2}x{3} @{4} -> 1280x720 @24" -f $why, $f.Name, $w, $h, $fps) -ForegroundColor DarkGray
    & $ffmpegExe -y -loglevel error -i $f.FullName -vf $vf -c:v libx264 -crf 16 -pix_fmt yuv420p $tmp
    if ($LASTEXITCODE -ne 0) { throw "规格统一失败：$($f.Name)（源文件可能是变帧率或损坏）" }
    if ($out -ieq $f.FullName) { Move-Item -Force $tmp $f.FullName }
    else { Move-Item -Force $tmp $out; Remove-Item $f.FullName -Force }
  }
}

# ── 1) 源视频进 step01（或先去过水印）────────────────────────────────────────
if ($Pr) {
  $prDir = Join-Path $Repo 'pr'
  $movs = Get-MediaFiles $prDir
  if (-not $movs.Count) { throw "pr\ 里没有透明 mov：$prDir" }
  Write-Host "· PR 路线：$($movs.Count) 个文件" -ForegroundColor Cyan
  Invoke-Step 'pr_import_step02.py' 'step02 抠像（PR 导入）'
} else {
  $step01 = Join-Path $Repo 'step01'
  New-Item -ItemType Directory -Force -Path $step01 | Out-Null
  if ($Watermark) { Invoke-Step 'watermark_step01.py' 'step01 去水印' }
  $srcs = Get-MediaFiles (Join-Path $Repo 'video')
  if ($srcs.Count) {
    foreach ($s in $srcs) {
      $dst = Join-Path $step01 $s.Name
      if ((Test-Path $dst) -and (-not $Force)) { continue }
      Copy-Item $s.FullName $dst -Force
    }
    Write-Host "· 已把 $($srcs.Count) 个源视频放进 step01\" -ForegroundColor Cyan
  }
  if (-not (Get-MediaFiles $step01).Count) {
    throw "step01\ 是空的：把绿幕视频放进 $(Join-Path $Repo 'video')\ 或直接放 step01\"
  }
  Normalize-Step01 $step01
  Ensure-VendorQuality
Invoke-Step 'chroma_step02.py' 'step02 绿幕抠像（自动）'
}

# ── 2) 归一化 + 转码 ────────────────────────────────────────────────────────
Invoke-Step 'normalize_step03.py' 'step03 归一化（2160x1215，脚底对齐）'
# 最后一公里用自己的编码参数（960x540，而不是宿主写死的 640x360）：
# VP9 的 alpha 会被按 8x8 块量化，640 下桌面上 1:1 显示就是肉眼可见的马赛克台阶。
Write-Host ""
Write-Host "== step04 转码（960x540 VP9-alpha）==" -ForegroundColor Cyan
Push-Location $Repo
try {
  & python -u (Join-Path $PSScriptRoot 'encode-final.py') --repo $Repo
  if ($LASTEXITCODE -ne 0) { throw "encode-final.py 失败（退出码 $LASTEXITCODE）" }
} finally { Pop-Location }

# ── 3) 收进 pet pack ────────────────────────────────────────────────────────
$step04 = Join-Path $Repo 'step04'
$webms = @(Get-ChildItem $step04 -Filter *.webm -File -ErrorAction SilentlyContinue)
if (-not $webms.Count) { throw "step04\ 没有产物：$step04" }

Write-Host ""
Write-Host "== 收进素材目录 ==" -ForegroundColor Cyan
$copied = 0; $skipped = 0
foreach ($w in $webms) {
  $dst = Join-Path $animDir $w.Name
  if ((Test-Path $dst) -and (-not $Force)) { $skipped++; continue }
  Copy-Item $w.FullName $dst -Force
  $copied++
  Write-Host ("  ok {0}  ({1:N0} KB)" -f $w.Name, ($w.Length / 1KB))
}
Write-Host ("  新增 {0} 段，跳过已存在 {1} 段 -> {2}" -f $copied, $skipped, $animDir)

# ── 3.5) 去白边/绿边 ──────────────────────────────────────────────────────
# 绿幕抠像只算 alpha 不动 RGB，角色轮廓那圈抗锯齿像素是"角色色+绿幕色"的混合，
# 半透明合成到浅色页面上就是一圈浅绿灰的边。这里把过渡带的 RGB 换成最近的本体色。
$cleaner = Join-Path $PSScriptRoot 'clean-edge.py'
if ((Test-Path $cleaner) -and $copied -gt 0 -and (-not $NoClean)) {
  Write-Host ""
  Write-Host "== 去白边/绿边（重写 alpha 过渡带的 RGB）==" -ForegroundColor Cyan
  foreach ($w in $webms) {
    $dst = Join-Path $animDir $w.Name
    if (-not (Test-Path $dst)) { continue }
    & python $cleaner --dir $animDir --glob $w.Name --ffmpeg $ffmpegExe
    if ($LASTEXITCODE -ne 0) { Write-Host ("  ! {0} 清理失败（素材仍可用，只是边缘偏绿）" -f $w.Name) -ForegroundColor Yellow }
  }
}

# ── 4) 提醒改名 + 校验 ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "注意：webm 文件名（去扩展名）必须与配置里 animations 的某个名字逐字一致。" -ForegroundColor Yellow
Write-Host "      产物名来自源文件名，例如 待机呼吸.mp4 -> 待机呼吸.webm 可以；"
Write-Host "      源文件叫 001.mp4 就得手动改名，或把 001 写进配置。"
Write-Host ""

$check = Join-Path $PSScriptRoot 'check-config.mjs'
if (Test-Path $check) { & node --experimental-strip-types --no-warnings $check --entry $Name --home $dshRoot }