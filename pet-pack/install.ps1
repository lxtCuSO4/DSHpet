# 在 $DSH_HOME 下生成一只「文件宠物」（pet pack）的骨架：配置 + 素材目录。
#
# 兼容 Windows PowerShell 5.1 / PowerShell 7。
# 直接双击 .ps1 会被执行策略挡住，请用同目录的 install.cmd，或：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Name cat -PetName 我的猫
#
# 生成：
#   $DSH_HOME/dsh-pet/pet/<Name>-config.json        ← 配置（带注释，可直接改）
#   $DSH_HOME/dsh-pet/pet/<Name>-animation/         ← 把你的 .webm 丢这里
# 已存在的配置默认不覆盖（加 -Force 覆盖）。

[CmdletBinding()]
param(
  [string]$Name = 'mypet',
  [string]$PetId,
  [string]$PetName,
  [int]$Size = 420,
  [ValidateSet('none', 'web', 'desktop', 'both')][string]$Display = 'none',
  [string]$DshHome,
  [switch]$Force,
  [switch]$SkipCheck
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# ── 参数校验：Name 会成为目录名和 URL 段，不能带分隔符/保留字符 ──────────────
if ($Name -notmatch '^[^\\/:*?"<>|\x00-\x1f]{1,60}$') {
  throw "Name 非法：'$Name'（不能含路径分隔符 / : * ? `" < > | 或控制字符，≤60 字符）"
}
if (-not $PetId) { $PetId = "$Name-1" }
if (-not $PetName) { $PetName = '我的桌宠' }

# ── 定位 $DSH_HOME ────────────────────────────────────────────────────────
if ($DshHome) { $dshRoot = $DshHome }
elseif ($env:DSH_HOME) { $dshRoot = $env:DSH_HOME }
else { $dshRoot = Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $dshRoot)) { throw "找不到 DSH 数据目录：$dshRoot（用 -DshHome 指定）" }

$petDir  = Join-Path $dshRoot 'dsh-pet\pet'
$animDir = Join-Path $petDir "$Name-animation"
$cfgPath = Join-Path $petDir "$Name-config.json"

New-Item -ItemType Directory -Force -Path $petDir, $animDir | Out-Null

# ── 写配置 ────────────────────────────────────────────────────────────────
$tplPath = Join-Path $PSScriptRoot 'template\mypet-config.json'
if (-not (Test-Path $tplPath)) { throw "模板缺失：$tplPath" }

if ((Test-Path $cfgPath) -and -not $Force) {
  Write-Host "· 配置已存在，保留不动：$cfgPath（要重建加 -Force）" -ForegroundColor Yellow
} else {
  $text = Get-Content $tplPath -Raw -Encoding UTF8
  $text = $text.Replace('__PET_ID_FILE__', $Name)
  $text = $text.Replace('__PET_ID__', $PetId)
  $text = $text.Replace('__PET_NAME__', $PetName)
  $text = $text.Replace('__SIZE__', [string]$Size)
  $text = $text.Replace('__DISPLAY__', $Display)
  Write-Utf8NoBom $cfgPath $text
  Write-Host "✔ 已写配置：$cfgPath" -ForegroundColor Green
}

# ── 素材目录里放一份说明（只查 .webm/.mov，别的文件不会被当成素材）──────────
$notePath = Join-Path $animDir '!!把webm放这里.txt'
if (-not (Test-Path $notePath)) {
  $note = @"
把你的透明视频（.webm）直接放进这个目录，文件名（不含扩展名）= 配置里 animations 的某个名字。

最小可用 3 段：
  待机呼吸.webm        <- animations.idle
  点击回应.webm        <- animations.clicks
  被抓起悬空.webm      <- animations.drag

要求：640x360、VP9 + alpha（yuva420p）、24fps、首尾帧同一站姿。
生成方法：上层目录的 build.cmd（或仓库 scripts\ 四步流水线）。

放好后把 $(Split-Path -Leaf $cfgPath) 里的 display 改成 "both"，刷新 DSH 页面即出现。
"@
  Write-Utf8NoBom $notePath $note
}

Write-Host ""
Write-Host "素材目录：$animDir"
$existing = @(Get-ChildItem $animDir -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -ieq '.webm' -or $_.Extension -ieq '.mov' })
Write-Host ("现有素材：{0} 段" -f $existing.Count)

# ── 校验（用宿主同一份合并逻辑跑一遍，确认配置合法、素材不缺）─────────────
if (-not $SkipCheck) {
  $check = Join-Path $PSScriptRoot 'check-config.mjs'
  if (Test-Path $check) {
    Write-Host ""
    Write-Host "── 配置校验 ──────────────────────────────────────────────" -ForegroundColor Cyan
    & node --experimental-strip-types --no-warnings $check --entry $Name --home $dshRoot
    if ($LASTEXITCODE -ne 0) {
      Write-Host "校验未通过（退出码 $LASTEXITCODE）——上面的问题修好后重跑即可。" -ForegroundColor Yellow
    }
  } else {
    Write-Host "· 没找到 check-config.mjs，跳过校验" -ForegroundColor DarkGray
  }
}

Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1) 生成绿幕视频 -> build.cmd -Name $Name"
Write-Host "  2) 素材到位后：install.cmd -Name $Name -Display both -Force"
Write-Host "  3) 刷新 DSH 页面（或右键宠物「重载配置」）"