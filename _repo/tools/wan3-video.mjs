#!/usr/bin/env node
/**
 * 万相3.0 视频生成 CLI（零依赖，Node 18+）
 *
 * 用法：
 *   set DASHSCOPE_API_KEY=sk-xxxx            # Windows
 *   export DASHSCOPE_API_KEY=sk-xxxx         # macOS / Linux
 *
 *   node wan3-video.mjs --prompt "一只小猫在月光下奔跑" --duration 5
 *   node wan3-video.mjs --prompt "..." --resolution 720P --ratio 16:9 --duration 10 --out out/city.mp4
 *
 * 协议：POST .../services/aigc/video-generation/video-synthesis（异步）→ GET .../tasks/{id} 轮询 → 下载 video_url
 * 注意：模型 / Endpoint / API Key 必须同地域；task_id 与结果 URL 均只保留 24 小时。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  model: 'wan3.0-video',        // 高速版：wan3.0-video-prime
  resolution: '480P',
  ratio: 'adaptive',
  duration: 5,
  workspace: 'ws-9w7qnudmxyu53gk0',
  region: 'cn-beijing',
  poll: 15,
  timeout: 900,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const flagToKey = {
    '--prompt': 'prompt',
    '--model': 'model',
    '--resolution': 'resolution',
    '--ratio': 'ratio',
    '--duration': 'duration',
    '--workspace': 'workspace',
    '--region': 'region',
    '--out': 'out',
    '--poll': 'poll',
    '--timeout': 'timeout',
    '--key': 'key',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    const key = flagToKey[arg];
    if (!key) throw new Error(`未知参数：${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`参数 ${arg} 缺少值`);
    opts[key] = value;
  }
  for (const k of ['duration', 'poll', 'timeout']) opts[k] = Number(opts[k]);
  return opts;
}

function usage() {
  console.log(`万相3.0 视频生成 CLI

  node wan3-video.mjs --prompt <文本> [选项]

选项：
  --prompt <text>        提示词（必填）
  --model <name>         默认 wan3.0-video；高速版 wan3.0-video-prime
  --resolution <P>       480P | 720P | 1080P（默认 480P）
  --ratio <r>            adaptive | 21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16（默认 adaptive）
  --duration <sec>       视频时长，2-30，-1 为智能时长（默认 5）
  --out <path>           保存路径（默认 wan3-<时间戳>.mp4）
  --workspace <id>       业务空间 ID（默认 ${DEFAULTS.workspace}）
  --region <region>      地域（默认 ${DEFAULTS.region}）
  --key <sk-...>         API Key（默认读环境变量 DASHSCOPE_API_KEY）
  --poll <sec>           轮询间隔（默认 15）
  --timeout <sec>        最长等待（默认 900）`);
}

async function readErrorBody(res) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return json.message || json.code || text;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  if (!opts.prompt) {
    usage();
    throw new Error('缺少 --prompt');
  }

  const apiKey = opts.key || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('缺少 API Key：请设置环境变量 DASHSCOPE_API_KEY，或传 --key');

  const base = `https://${opts.workspace}.${opts.region}.maas.aliyuncs.com/api/v1`;
  const auth = { Authorization: `Bearer ${apiKey}` };

  // ---------- 1. 提交任务 ----------
  console.log('[1/3] 提交任务…');
  const submitRes = await fetch(`${base}/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers: { ...auth, 'X-DashScope-Async': 'enable', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      input: { prompt: opts.prompt },
      parameters: { resolution: opts.resolution, ratio: opts.ratio, duration: opts.duration },
    }),
  });

  if (!submitRes.ok) {
    throw new Error(`提交失败 HTTP ${submitRes.status}: ${await readErrorBody(submitRes)}`);
  }
  const submit = await submitRes.json();
  const taskId = submit?.output?.task_id;
  if (!taskId) throw new Error(`未拿到 task_id：${JSON.stringify(submit)}`);
  console.log(`      task_id = ${taskId}`);

  // ---------- 2. 轮询 ----------
  console.log(`[2/3] 轮询状态（每 ${opts.poll}s，上限 ${opts.timeout}s）…`);
  const deadline = Date.now() + opts.timeout * 1000;
  let videoUrl = null;
  let lastStatus = '';

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.poll * 1000));
    const res = await fetch(`${base}/tasks/${taskId}`, { headers: auth });
    if (!res.ok) throw new Error(`查询失败 HTTP ${res.status}: ${await readErrorBody(res)}`);
    const task = await res.json();
    const status = task?.output?.task_status;
    if (status !== lastStatus) {
      console.log(`      ${new Date().toLocaleTimeString()}  status=${status}`);
      lastStatus = status;
    }
    if (status === 'SUCCEEDED') { videoUrl = task.output.video_url; break; }
    if (status === 'FAILED') {
      throw new Error(`任务失败 code=${task.output.code} message=${task.output.message}`);
    }
    if (status === 'CANCELED') throw new Error('任务已被取消');
    if (status === 'UNKNOWN') throw new Error('任务不存在或已过期（task_id 有效期 24 小时）');
  }

  if (!videoUrl) throw new Error(`等待超时。可手动查询：GET ${base}/tasks/${taskId}`);

  // ---------- 3. 下载 ----------
  console.log('[3/3] 下载视频…');
  const outPath = resolve(opts.out || `wan3-${Date.now()}.mp4`);
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`下载失败 HTTP ${videoRes.status}`);
  const buf = Buffer.from(await videoRes.arrayBuffer());
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
  console.log(`完成：${outPath}  (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log('提示：云端链接仅保留 24 小时，本地已保存。');
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  process.exit(1);
});