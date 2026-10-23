// Simultaneous GDI / Desktop Duplication recording; stderr receipt clocks aid alignment.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const seconds = Number(process.argv[2] || 120);
const output = resolve(process.argv[3] || join(root, '_art/idle-loop-diagnosis/dual-capture'));
const [x, y, width, height] = process.argv.slice(4, 8).map(Number);
if (![seconds, x, y, width, height].every(Number.isFinite) || seconds <= 0 || width <= 0 || height <= 0)
  throw new Error('Usage: node capture-idle-desktop.mjs SECONDS _art/OUTPUT X Y W H');
if (!output.startsWith(join(root, '_art') + sep)) throw new Error('Output must be below _art/');
mkdirSync(output, { recursive: true });
const ffmpeg = join(root, '_repo/.tools/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe');
const jobs = (process.argv.includes('--dda-only') ? ['dda'] : ['gdi', 'dda']).map(kind => {
  const input = kind === 'gdi'
    ? ['-f', 'gdigrab', '-framerate', '60', '-draw_mouse', '0', '-offset_x', String(x),
      '-offset_y', String(y), '-video_size', `${width}x${height}`, '-i', 'desktop']
    : ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=60:draw_mouse=0:offset_x=${x}:offset_y=${y}:video_size=${width}x${height}`];
  const args = ['-hide_banner', '-nostdin', '-nostats', ...input, '-t', String(seconds), '-vf',
    (kind === 'dda' ? 'hwdownload,format=bgra,' : '') + 'showinfo', '-an', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-y', join(output, kind + '.mp4')];
  const log = createWriteStream(join(output, kind + '-clock.ndjson'));
  const start = Date.now();
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let buffer = '', frames = 0, firstFrame = null, lastFrame = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop();
    const at = Date.now();
    for (const line of lines) {
      const match = line.match(/Parsed_showinfo.*\bn:\s*(\d+)\s+pts:.*?pts_time:([^\s]+)/);
      if (match) {
        const row = { receivedAt: at, n: Number(match[1]), pts: Number(match[2]) };
        firstFrame ??= row; lastFrame = row; frames++;
        log.write(JSON.stringify(row) + '\n');
      } else if (/error|failed/i.test(line)) log.write(JSON.stringify({ receivedAt: at, line }) + '\n');
    }
  });
  console.log(JSON.stringify({ recording: kind, pid: child.pid, start, region: [x, y, width, height] }));
  return new Promise((yes, no) => {
    child.on('error', no);
    child.on('close', code => {
      log.end();
      const summary = { kind, code, start, end: Date.now(), region: [x, y, width, height], frames, firstFrame, lastFrame };
      writeFileSync(join(output, kind + '-capture.json'), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary));
      if (code !== 0) no(new Error(kind + ' capture exited ' + code)); else yes(summary);
    });
  });
});
await Promise.all(jobs);
