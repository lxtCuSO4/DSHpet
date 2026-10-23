<#
.SYNOPSIS
    调用阿里百炼「万相3.0-视频生成」(wan3.0-video) 异步接口：提交任务 -> 轮询 -> 下载成片。

.DESCRIPTION
    纯 HTTP 实现，不依赖 DashScope SDK。接口协议：
      POST {base}/services/aigc/video-generation/video-synthesis   (需 X-DashScope-Async: enable)
      GET  {base}/tasks/{task_id}                                   (轮询到 SUCCEEDED 拿 video_url)

    注意：模型 / Endpoint / API Key 必须属于同一地域。task_id 与结果 URL 均只保留 24 小时。

.PARAMETER Prompt
    提示词，支持中英文，最长 20000 字符。

.PARAMETER Duration
    视频时长（秒）。纯文生视频时取值范围 [2, 30]，-1 表示智能时长。

.PARAMETER OutFile
    下载保存路径。默认保存到当前目录，文件名为 wan3-<时间戳>.mp4。

.EXAMPLE
    $env:DASHSCOPE_API_KEY = 'sk-xxxx'
    .\wan3-video.ps1 -Prompt '一只小猫在月光下的屋顶上奔跑，城市的霓虹灯在远处闪烁，电影级画质，流畅运镜。' -Duration 5

.EXAMPLE
    .\wan3-video.ps1 -Prompt '赛博朋克风格的城市夜景，镜头缓慢推进' -Resolution 720P -Ratio 16:9 -Duration 10 -OutFile .\out\city.mp4
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Prompt,

    [string]$Model = 'wan3.0-video',            # 也可用 wan3.0-video-prime（高速版）

    [ValidateSet('480P', '720P', '1080P')]
    [string]$Resolution = '480P',

    [ValidateSet('adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16')]
    [string]$Ratio = 'adaptive',

    [int]$Duration = 5,

    [string]$WorkspaceId = 'ws-9w7qnudmxyu53gk0',
    [string]$Region = 'cn-beijing',

    [string]$ApiKey = $env:DASHSCOPE_API_KEY,

    [string]$OutFile = "wan3-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss')).mp4",

    [int]$PollSeconds = 15,
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw '缺少 API Key：请先设置环境变量 DASHSCOPE_API_KEY，或通过 -ApiKey 传入。'
}

$base = "https://$WorkspaceId.$Region.maas.aliyuncs.com/api/v1"
$auth = @{ Authorization = "Bearer $ApiKey" }

function Invoke-Wan3Api {
    param([string]$Method, [string]$Uri, [hashtable]$Headers, $Body)

    try {
        if ($null -ne $Body) {
            $json = $Body | ConvertTo-Json -Depth 8 -Compress
            return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers `
                -ContentType 'application/json; charset=utf-8' `
                -Body ([Text.Encoding]::UTF8.GetBytes($json))
        }
        return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers
    }
    catch {
        $detail = $_.ErrorDetails.Message
        if ($detail) {
            throw "HTTP 调用失败: $($_.Exception.Message)`n响应体: $detail"
        }
        throw
    }
}

# ---------- 1. 提交任务 ----------
$submitHeaders = @{} + $auth
$submitHeaders['X-DashScope-Async'] = 'enable'

$payload = @{
    model      = $Model
    input      = @{ prompt = $Prompt }
    parameters = @{ resolution = $Resolution; ratio = $Ratio; duration = $Duration }
}

Write-Host "[1/3] 提交任务..." -ForegroundColor Cyan
$submit = Invoke-Wan3Api -Method Post `
    -Uri "$base/services/aigc/video-generation/video-synthesis" `
    -Headers $submitHeaders -Body $payload

$taskId = $submit.output.task_id
if (-not $taskId) {
    throw "未拿到 task_id，接口返回：$($submit | ConvertTo-Json -Depth 8)"
}
Write-Host "      task_id = $taskId" -ForegroundColor DarkGray

# ---------- 2. 轮询 ----------
Write-Host "[2/3] 轮询任务状态（每 $PollSeconds 秒，最多 $TimeoutSeconds 秒）..." -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$videoUrl = $null

while ((Get-Date) -lt $deadline) {
    $task = Invoke-Wan3Api -Method Get -Uri "$base/tasks/$taskId" -Headers $auth
    $status = $task.output.task_status
    Write-Host "      $(Get-Date -Format 'HH:mm:ss')  status=$status"

    switch ($status) {
        'SUCCEEDED' {
            $videoUrl = $task.output.video_url
            break
        }
        'FAILED' {
            throw "任务失败: code=$($task.output.code) message=$($task.output.message)"
        }
        'CANCELED' { throw '任务已被取消。' }
        'UNKNOWN' { throw '任务不存在或已过期（task_id 有效期 24 小时）。' }
    }

    if ($videoUrl) { break }
    Start-Sleep -Seconds $PollSeconds
}

if (-not $videoUrl) {
    throw "等待超时（$TimeoutSeconds 秒）。可稍后用 task_id 手动查询：GET $base/tasks/$taskId"
}

Write-Host "      video_url = $videoUrl" -ForegroundColor DarkGray

# ---------- 3. 下载 ----------
Write-Host "[3/3] 下载视频..." -ForegroundColor Cyan
$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

Invoke-WebRequest -Uri $videoUrl -OutFile $OutFile -UseBasicParsing
$sizeMB = [math]::Round((Get-Item $OutFile).Length / 1MB, 2)

Write-Host "完成：$((Resolve-Path $OutFile).Path)  ($sizeMB MB)" -ForegroundColor Green
Write-Host "提示：云端结果链接仅保留 24 小时，本地文件已保存。" -ForegroundColor Yellow