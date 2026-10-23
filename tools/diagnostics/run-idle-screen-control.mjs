// Run the existing isolated probe and record the final desktop using Desktop Duplication.
import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2]);
const seconds = Number(process.argv[3] || 85);
const scenario = process.argv[4] || 'original';
if (!['original', 'native', 'fade', 'visibility'].includes(scenario) || !Number.isFinite(seconds) || seconds < 10)
  throw new Error('Usage: node run-idle-screen-control.mjs _art/OUTPUT SECONDS original|native|fade|visibility');
const probe = spawn(process.execPath, ['--experimental-strip-types',
  join(root, 'tools/diagnostics/idle-loop-probe.mjs'), output, String(seconds), 'bridge', scenario],
{ env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
let buffer = '', capture, captureDone;
probe.stdout.setEncoding('utf8');
probe.stdout.on('data', chunk => {
  process.stdout.write(chunk); buffer += chunk;
  const lines = buffer.split(/\r?\n/); buffer = lines.pop();
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row.observing || capture) continue;
    const { bounds, rect } = row.capture;
    const x = bounds.x + rect.x, y = bounds.y + rect.y;
    // Record the whole stage. It must remain on output_idx=0 for this local experiment.
    capture = spawn(process.execPath, [join(root, 'tools/diagnostics/capture-idle-desktop.mjs'),
      String(seconds - 3), join(output, 'desktop'), String(x), String(y), String(rect.width),
      String(rect.height), '--dda-only'], { windowsHide: true, stdio: 'inherit' });
    captureDone = new Promise((yes, no) => {
      capture.on('error', no);
      capture.on('close', code => code === 0 ? yes() : no(new Error('Capture exited ' + code)));
    });
    // Keep early capture failures handled until the probe exits.
    captureDone.catch(error => console.error(error.message));
  }
});
try {
  await new Promise((yes, no) => {
    probe.on('error', no);
    probe.on('close', code => code === 0 ? yes() : no(new Error('Probe exited ' + code)));
  });
  if (!captureDone) throw new Error('Probe never announced readiness');
  await captureDone;
} catch (error) {
  if (capture && capture.exitCode === null) capture.kill();
  if (probe.exitCode === null) probe.kill();
  throw error;
}
