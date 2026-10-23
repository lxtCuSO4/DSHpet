// Observe the installed desktop renderer in an isolated helper and mock host.
// NODE_PATH must point to a runtime containing playwright. Existing pet files are not modified.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const output = resolve(process.argv[2] || join(root, '_art/idle-loop-diagnosis'));
const seconds = Number(process.argv[3] || 35);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Duration must be positive');
const transport = process.argv[4] || 'http';
const scenario = process.argv[5] || 'original';
if (!['http','bridge'].includes(transport) || !['original','native','fade','visibility'].includes(scenario)) throw new Error('Invalid diagnostic scenario');
const home = join(homedir(), '.dsh');
const installed = join(home, 'profiles/desktop/node_modules/dsh-pet');
const assetDir = join(home, 'dsh-pet/pet/mypet-animation');
mkdirSync(output, { recursive: true });
const { readAllConfig } = await import(pathToFileURL(join(root, '_repo/dsh-pet/src/host/config.ts')));
const config = readAllConfig({
  defaultFile: join(installed, 'assets/config.jsonc'),
  userFile: join(home, 'dsh-pet/main-config.jsonc'),
  legacyUserFile: join(home, 'dsh-pet/main-config.json'),
  petDir: join(home, 'dsh-pet/pet'),
});
const requests = [];
writeFileSync(join(output,'merged-config.json'),JSON.stringify(config));
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname.endsWith('/config')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(config));
  } else if (pathname.includes('/thumb/mypet/')) {
    const name = basename(pathname);
    const file = join(assetDir, name);
    requests.push({ at: Date.now(), name, range: req.headers.range || null });
    if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'video/webm');
    createReadStream(file).pipe(res);
  } else {
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let app;
try {
  const env = { ...process.env,
    DSH_DIAG_OUTPUT: output, DSH_DIAG_INSTALLED: installed,
    DSH_DIAG_ASSETS:assetDir,
    DSH_PET_CONFIG_URL: `http://127.0.0.1:${server.address().port}/dsh-pet-7340/config`,
    DSH_PET_BRIDGE: transport === 'bridge' ? '1' : '0', DSH_PET_SMOKE: '0', DSH_PET_FORCE_DSF: '1',
    DSH_PET_HOST_PID: String(process.pid), DSH_PET_SCALE: '1',
    DSH_PET_PETS: JSON.stringify([{ id: 'mypet-1', size: 420 }]),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: join(home, 'electron/electron.exe'),
    args: [join(root, 'tools/diagnostics/idle-loop-bootstrap.cjs')], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.error('renderer:', error.message));
  await page.waitForFunction(() => window.__dshPetDebug?.configOk, null, { timeout: 20000 });
  await page.waitForFunction(() => {
    const s=sprites[0],v=s.front===0?s.videoA:s.videoB;
    return v.readyState>=2 && v.currentTime>0 && !s.pending;
  },null,{timeout:15000});
  // Keep the diagnostic window apart from the user's pet and make input pass through.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setPosition(0, 0);
    const ignore = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = () => ignore(true, { forward: false });
    win.setIgnoreMouseEvents();
  });
  if (scenario === 'native') await page.evaluate(() => {
    const s=sprites[0],v=s.front===0?s.videoA:s.videoB;
    v.loop=true; v.onended=null;
  });
  // Positive control: recreate the old CSS fade only in this temporary renderer.
  if (scenario === 'fade') await page.addStyleTag({ content:'video.pet-video { transition:opacity 0.18s ease !important; }' });
  // Single-variable diagnostic: keep media loading/handoff, change only the CSS visibility mechanism.
  if (scenario === 'visibility') await page.addStyleTag({ content:
    'video.pet-video { opacity:1 !important; visibility:hidden !important; } video.pet-video.is-front { visibility:visible !important; }' });
  const setup = await page.evaluate(() => {
    window.__idleProbe = { events: [], raf: [], videoFrames: [], start: performance.now(), timeOrigin:performance.timeOrigin };
    const p = window.__idleProbe;
    const sprite = sprites[0];
    const state = (kind, el) => ({ at: performance.now(), kind,
      front: sprite.front, anim: sprite.anim, once: sprite.once, gen: sprite.gen,
      pending: sprite.pending ? { ...sprite.pending } : null,
      slot: el === sprite.videoA ? 'A' : el === sprite.videoB ? 'B' : null,
      currentTime: el?.currentTime, loop: el?.loop, paused: el?.paused,
      readyState: el?.readyState, duration: el?.duration });
    for (const name of ['switchTo', 'playOnce', 'playIdle', 'handleEnded']) {
      const original = sprite[name];
      sprite[name] = function (...args) {
        p.events.push({ ...state(name, this.front === 0 ? this.videoA : this.videoB), args });
        return original.apply(this, args);
      };
    }
    for (const el of [sprite.videoA, sprite.videoB]) {
      for (const kind of ['ended','emptied','loadstart','loadedmetadata','loadeddata','playing','pause','waiting','seeking','seeked','error']) {
        el.addEventListener(kind, () => p.events.push(state(kind, el)));
      }
      const frame = (now, meta) => {
        p.videoFrames.push({ at: performance.now(), slot: el === sprite.videoA ? 'A' : 'B',
          front: sprite.front, mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames,
          expectedDisplayTime: meta.expectedDisplayTime, readyState: el.readyState });
        if (!p.stopped) el.requestVideoFrameCallback(frame);
      };
      if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(frame);
    }
    let last;
    const observe = () => {
      const front = sprite.front === 0 ? sprite.videoA : sprite.videoB;
      const row = { ...state('raf', front),
        A: getComputedStyle(sprite.videoA).opacity, B: getComputedStyle(sprite.videoB).opacity,
        visibilityA: getComputedStyle(sprite.videoA).visibility, visibilityB: getComputedStyle(sprite.videoB).visibility,
        pending: Boolean(sprite.pending), src: front.currentSrc.split('/').pop() };
      if (last !== row.front || row.currentTime < 0.35 || row.currentTime > row.duration - 0.35 || row.readyState < 2) p.raf.push(row);
      last = row.front;
      if (!p.stopped) requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
    const r = document.querySelector('.pet-stage').getBoundingClientRect();
    return { duration: (sprite.front === 0 ? sprite.videoA : sprite.videoB).duration,
      initial: state('initial', sprite.front === 0 ? sprite.videoA : sprite.videoB),
      stage: { x:r.x, y:r.y, width:r.width, height:r.height },
      version: navigator.userAgent, scale: CONFIG.scale, bridge: BRIDGE };
  });
  const capture = await app.evaluate(({ BrowserWindow }, { output, stage }) => {
    const { fs, path } = global.__idleDiagnostic;
    const win = BrowserWindow.getAllWindows()[0];
    const zoom = win.webContents.getZoomFactor();
    const rect = { x:Math.round(stage.x*zoom), y:Math.round(stage.y*zoom),
      width:Math.round(stage.width*zoom), height:Math.round(stage.height*zoom) };
    global.__idleCapture = { rows: [], saves: 0, last: null, start: Date.now() };
    win.webContents.beginFrameSubscription(false, (image) => {
      const state = global.__idleCapture;
      const size = image.getSize();
      if (rect.x+rect.width>size.width || rect.y+rect.height>size.height) return;
      const cropped = image.crop(rect);
      const raw = cropped.toBitmap();
      let alpha = 0, opaque = 0, luma = 0;
      for (let i=3; i<raw.length; i+=4) {
        alpha += raw[i];
        if (raw[i]>200) { opaque++; luma+=raw[i-3]*0.114+raw[i-2]*0.587+raw[i-1]*0.299; }
      }
      const row = { at:Date.now(), alpha, opaque, meanLuma:opaque?luma/opaque:0, width:rect.width, height:rect.height };
      state.rows.push(row);
      if (state.last !== null && alpha < state.last * 0.8 && state.saves < 20) {
        const name = `alpha-drop-${state.saves++}.png`;
        fs.writeFileSync(path.join(output,name),cropped.toPNG()); row.image=name;
      }
      state.last = alpha;
    });
    return { bounds:win.getBounds(), zoom, rect, started:Date.now() };
  }, { output, stage: setup.stage });
  console.log(JSON.stringify({ observing:true, seconds, transport, scenario, setup, capture }));
  await page.waitForTimeout(seconds*1000);
  const data = await page.evaluate(() => { window.__idleProbe.stopped = true; return window.__idleProbe; });
  const frames = await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.endFrameSubscription();
    return {...global.__idleCapture,requests:global.__idleDiagnostic.requests};
  });
  const report = { transport, scenario, setup, capture, requests:[...requests,...frames.requests], ...data, captureFrames:frames.rows };
  writeFileSync(join(output, 'probe.json'), JSON.stringify(report,null,2));
  await page.screenshot({ path:join(output,'diagnostic-window.png'), omitBackground:true });
  console.log(JSON.stringify({ events:data.events.length, videoFrames:data.videoFrames.length,
    captureFrames:frames.rows.length, alphaDrops:frames.saves,
    ended:data.events.filter(x=>x.kind==='ended').length,
    switchTo:data.events.filter(x=>x.kind==='switchTo').map(x=>({ at:x.at, args:x.args })) }));
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
}
