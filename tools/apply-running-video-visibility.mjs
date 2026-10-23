// Apply the already patched disk rules to the running helper without restarting it.
// Usage: node tools/apply-running-video-visibility.mjs PID [--reload]
const pid = Number(process.argv[2]);
if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Provide the running helper PID');
let targets, startedInspector = false;
try { targets = await (await fetch('http://127.0.0.1:9229/json/list')).json(); }
catch {
  process._debugProcess(pid); startedInspector = true;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { targets = await (await fetch('http://127.0.0.1:9229/json/list')).json(); break; } catch {}
  }
}
if (!targets?.[0]?.webSocketDebuggerUrl) throw new Error('No inspector target');
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no; });
let nextId = 0, identityVerified = false;
const requests = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data), pending = requests.get(message.id);
  if (!pending) return;
  requests.delete(message.id); clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
  else pending.resolve(message.result);
};
async function evaluate(expression) {
  const id = ++nextId;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('Inspector timeout')); }, 15000);
    requests.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  const identity = await evaluate('({pid:process.pid,executable:process.execPath})');
  if (identity.pid !== pid || !identity.executable.toLowerCase().endsWith('\\.dsh\\electron\\electron.exe'))
    throw new Error('Inspector identity differs from requested helper');
  identityVerified = true;
  const result = await evaluate(`(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const win = req('electron').BrowserWindow.getAllWindows().find(w =>
      w.webContents.getURL().replaceAll('\\\\','/').includes('/dsh-pet/runtime/electron-helper/index.html'));
    if (!win) throw new Error('Installed pet window not found');
    if (${process.argv.includes('--reload')}) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Renderer reload timed out')), 12000);
        win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
        win.webContents.reload();
      });
      await win.webContents.executeJavaScript('new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(window.__dshPetDebug?.configOk && document.querySelector("video.pet-video.is-front")){clearInterval(timer);resolve(true);}else if(Date.now()-start>10000){clearInterval(timer);reject(new Error("Pet did not load"));}},50);})');
    }
    const path = req('node:url').fileURLToPath(win.webContents.getURL());
    const html = req('node:fs').readFileSync(path, 'utf8');
    const selectors = ['video.pet-video', 'video.pet-video.is-front'];
    const rules = selectors.map(selector => {
      const escaped = selector.replaceAll('.', '[.]');
      const matches = [...html.matchAll(new RegExp(escaped + ' \\{([^}]+)\\}', 'g'))]
        .filter(m => /visibility\\s*:/.test(m[1]));
      if (matches.length !== 1) throw new Error('Disk visibility patch missing or ambiguous');
      return { selector, body: matches[0][1] };
    });
    const styles = await win.webContents.executeJavaScript('(' + (${function applyRules(rules) {
      const sheetRules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
      const changes = rules.map(({ selector, body }) => {
        const matches = sheetRules.filter(rule => rule.selectorText === selector);
        if (matches.length !== 1) throw new Error('Running video rule missing or ambiguous');
        return { rule: matches[0], before: matches[0].style.cssText, body };
      });
      try {
        for (const change of changes) change.rule.style.cssText = change.body;
        return [...document.querySelectorAll('video.pet-video')].map(video => {
          const style = getComputedStyle(video);
          const state = { active: video.classList.contains('is-front'), opacity: style.opacity,
            visibility: style.visibility, transition: style.transitionDuration };
          if (state.opacity !== '1' || state.transition !== '0s' ||
            state.visibility !== (state.active ? 'visible' : 'hidden')) throw new Error('Running styles failed validation');
          return state;
        });
      } catch (error) {
        for (const change of changes) change.rule.style.cssText = change.before;
        throw error;
      }
    }.toString()}) + ')(' + JSON.stringify(rules) + ')');
    if (styles.length < 2) throw new Error('Expected two running videos');
    return { pid:process.pid, path, styles, reloaded:${process.argv.includes('--reload')}, bounds:win.getBounds(),
      diskSha256:req('node:crypto').createHash('sha256').update(html).digest('hex') };
  })()`);
  console.log(JSON.stringify(result));
} finally {
  if (startedInspector && identityVerified) await evaluate("setTimeout(()=>process.mainModule.require('node:inspector').close(),150);true");
  ws.close();
}
