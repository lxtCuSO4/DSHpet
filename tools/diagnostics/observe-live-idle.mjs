// Attach to an existing helper without restarting it; restore all observers on exit.
// Outputs are restricted to the ignored _art directory because they may include screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLiveIdleObserver } from './live-idle-renderer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pid = Number(process.argv[2]);
const seconds = Number(process.argv[3] || 125);
const output = resolve(process.argv[4] || join(root, '_art/idle-loop-diagnosis/live-observed'));
const compositor = !process.argv.includes('--no-compositor');
if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(seconds) || seconds <= 0)
  throw new Error('Usage: node observe-live-idle.mjs PID SECONDS _art/OUTPUT [--no-compositor]');
if (!output.startsWith(join(root, '_art') + sep)) throw new Error('Output must be below _art/');
mkdirSync(output, { recursive: true });
let targets, startedInspector = false;
try {
  targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
} catch {
  // Validated first against an expendable Electron process on this Windows runtime.
  process._debugProcess(pid);
  startedInspector = true;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { targets = await (await fetch('http://127.0.0.1:9229/json/list')).json(); break; } catch {}
  }
}
if (!targets?.[0]?.webSocketDebuggerUrl) throw new Error('No inspector target');
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no; });
let nextId = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
};
const evaluate = async (expression) => {
  const id = ++nextId;
  const response = await new Promise((yes, no) => {
    const timer = setTimeout(() => { pending.delete(id); no(new Error('Inspector timed out')); }, 30000);
    pending.set(id, { resolve: yes, reject: no, timer });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params:
      { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
let installed = false, verifiedIdentity = false;
let finishWait;
const finishEarly = () => finishWait?.();
process.on('SIGINT', finishEarly);
process.on('SIGTERM', finishEarly);
try {
  const identity = await evaluate(`({ pid:process.pid, executable:process.execPath })`);
  if (identity.pid !== pid || !identity.executable.toLowerCase().endsWith('\\.dsh\\electron\\electron.exe'))
    throw new Error('Inspector does not belong to the requested desktop helper');
  verifiedIdentity = true;
  const setup = await evaluate(`(async () => {
    const electron = process.mainModule.require('electron');
    const win = electron.BrowserWindow.getAllWindows().find(w =>
      w.webContents.getURL().replaceAll('\\\\','/').includes('/dsh-pet/runtime/electron-helper/index.html'));
    if (!win || global.__liveIdleMain) throw new Error('Expected idle helper not found or already observed');
    const renderer = await win.webContents.executeJavaScript(${JSON.stringify(`(${installLiveIdleObserver.toString()})(${seconds})`)});
    const probe = global.__liveIdleMain = { win, rows:[], nativeEvents:[], restores:[], output:${JSON.stringify(output)}, renderer };
    const fs = process.mainModule.require('node:fs'), path = process.mainModule.require('node:path');
    const zoom = win.webContents.getZoomFactor();
    const rect = {x:Math.round(renderer.stage.x*zoom),y:Math.round(renderer.stage.y*zoom),
      width:Math.round(renderer.stage.width*zoom),height:Math.round(renderer.stage.height*zoom)};
    for (const name of ['setContentBounds','setIgnoreMouseEvents','setAlwaysOnTop']) {
      const original = win[name];
      const wrapper = function(...args) { probe.nativeEvents.push({at:Date.now(),kind:name,args});return original.apply(this,args); };
      win[name]=wrapper;probe.restores.push(()=>{if(win[name]===wrapper)win[name]=original;});
    }
    for(const kind of ['move','resize','show','hide','focus','blur']) {
      const listener=()=>probe.nativeEvents.push({at:Date.now(),kind,bounds:win.getBounds(),visible:win.isVisible()});
      win.on(kind,listener);probe.restores.push(()=>win.removeListener(kind,listener));
    }
    probe.cleanup=()=>{if(probe.timer)clearTimeout(probe.timer);if(probe.capturing){win.webContents.endFrameSubscription();probe.capturing=false;}
      for(const restore of probe.restores.splice(0))restore();};
    probe.timer=setTimeout(probe.cleanup,(${seconds}+15)*1000);
    if (${compositor}) {
      let saves=0;
      win.webContents.beginFrameSubscription(false,image=>{
        const at=Date.now(),size=image.getSize();
        if(rect.x+rect.width>size.width||rect.y+rect.height>size.height)return;
        const cropped=image.crop(rect),raw=cropped.toBitmap();let alpha=0,opaque=0,luma=0;
        for(let i=3;i<raw.length;i+=4){alpha+=raw[i];if(raw[i]>200){opaque++;luma+=raw[i-3]*.114+raw[i-2]*.587+raw[i-1]*.299;}}
        const row={at,alpha,opaque,meanLuma:opaque?luma/opaque:0};probe.rows.push(row);
        if(alpha<1000000&&saves<10){row.image='live-alpha-drop-'+saves+++'.png';fs.writeFileSync(path.join(probe.output,row.image),cropped.toPNG());}
      });probe.capturing=true;
    }
    return { identity:{pid:process.pid,executable:process.execPath},renderer,bounds:win.getBounds(),zoom,rect,
      handle:win.getNativeWindowHandle().readUInt32LE(),started:Date.now(),compositor:${compositor} };
  })()`);
  installed = true;
  writeFileSync(join(output, 'setup.json'), JSON.stringify(setup, null, 2));
  console.log(JSON.stringify({ observing: true, seconds, ...setup }));
  await new Promise(r => {
    const timer = setTimeout(r, seconds * 1000);
    finishWait = () => { clearTimeout(timer); r(); };
  });
} finally {
  if (installed) {
    const data = await evaluate(`(async()=>{const p=global.__liveIdleMain;p.cleanup();
      const renderer=await p.win.webContents.executeJavaScript('(()=>{const p=window.__liveIdleObserver;const d=p.stop();delete window.__liveIdleObserver;return d;})()');
      const result={renderer,captureFrames:p.rows,nativeEvents:p.nativeEvents,ended:Date.now(),cleanup:true};
      delete global.__liveIdleMain;return result;})()`);
    writeFileSync(join(output, 'live-probe.json'), JSON.stringify(data, null, 2));
    console.log(JSON.stringify({ cleanup: true, events: data.renderer.events.length,
      captureFrames: data.captureFrames.length, zeroAlphaFrames: data.captureFrames.filter(r => r.alpha === 0).length }));
  }
  if (startedInspector && verifiedIdentity) await evaluate("setTimeout(()=>process.mainModule.require('node:inspector').close(),150);true");
  ws.close();
  process.removeListener('SIGINT', finishEarly);
  process.removeListener('SIGTERM', finishEarly);
}
