// Diagnostic launcher: run the installed helper without editing its files.
const { app } = require('electron');
const path = require('node:path');
global.__idleDiagnostic = { fs: require('node:fs'), path };
global.__idleDiagnostic.requests = [];
const helper = process.env.DSH_DIAG_HELPER || path.join(process.env.DSH_DIAG_INSTALLED, 'runtime/electron-helper');
require('node:fs').mkdirSync(path.join(process.env.DSH_DIAG_OUTPUT, 'electron-profile'), { recursive: true });
app.setPath('userData', path.join(process.env.DSH_DIAG_OUTPUT, 'electron-profile'));
app.setAppPath(helper);
if (process.env.DSH_PET_BRIDGE === '1') {
  const fs = global.__idleDiagnostic.fs;
  const config = JSON.parse(fs.readFileSync(path.join(process.env.DSH_DIAG_OUTPUT, 'merged-config.json'), 'utf8'));
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, ...args) {
    const text = String(chunk);
    if (!text.startsWith('dsh-pet-bridge:')) return write(chunk, ...args);
    const req = JSON.parse(text.slice('dsh-pet-bridge:'.length));
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let response = { id:req.id, status:200, contentType:'application/json', body:'{}' };
    if (pathname.endsWith('/config')) response.body = JSON.stringify(config);
    if (pathname.includes('/thumb/mypet/')) {
      const name = path.basename(pathname);
      // Regression-only fault injection: leave one media request unresolved for the 10s guard.
      if (name === process.env.DSH_DIAG_STALL_ASSET) return true;
      response = { id:req.id, status:200, contentType:'video/webm',
        file:path.join(process.env.DSH_DIAG_ASSETS,name) };
      global.__idleDiagnostic.requests.push({ at:Date.now(),name,transport:'bridge' });
    }
    // Loopback reply preserves the installed helper's actual protocol/file-read path.
    fetch(req.cb,{ method:'POST',body:JSON.stringify(response) }).catch(error=>console.error(error.message));
    return true;
  };
}
require(path.join(helper, 'main.js'));
