import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let createManager;
try {
  ({ createManager } = require('../../runtime/electron-helper/manager-controller.js'));
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
}
async function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manager-controller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'pet'));
  const windows = new Map(),
    handlers = new Map();
  let manager;
  const pets = [
    { id: 'white', name: '白', size: 420, display: 'desktop' },
    { id: 'black', name: '黑', size: 420, display: 'desktop' },
  ];
  for (const pet of pets)
    writeFileSync(
      join(root, 'pet', pet.id + '-config.json'),
      JSON.stringify({ pets: [pet], animations: { idle: ['呼吸'] } }),
    );
  const electron = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {}, removeHandler() {}, removeListener() {} },
    globalShortcut: { register: () => true, unregister() {} },
    app: { on() {}, removeListener() {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  let emitProbe,
    requests = 0;
  manager = createManager({
    electron,
    windows,
    retryMs: 30,
    hostRequest: async (method, url) => {
      if (options.failFirst && ++requests === 1) throw Error('bridge not ready');
      return {
        status: 200,
        body: JSON.stringify(
          url.endsWith('/meta')
            ? { user: join(root, 'main-config.jsonc') }
            : Object.fromEntries(
                pets.map((p) => [p.id, JSON.parse(readFileSync(join(root, 'pet', p.id + '-config.json')))]),
              ),
        ),
      };
    },
    createWindows: (list) => {
      for (const p of list)
        if (!windows.has(p.id)) {
          const w = {
            isDestroyed: () => false,
            isVisible: () => w.visible,
            visible: true,
            setAlwaysOnTop() {},
            showInactive() {
              w.visible = true;
            },
            hide() {
              w.visible = false;
            },
            on() {},
            webContents: { executeJavaScript: async () => true, on() {} },
            destroy() {
              windows.delete(p.id);
            },
          };
          windows.set(p.id, w);
          manager.attach(p, w);
        }
    },
    onChanged() {},
    previewBase: 'dsh-pet-bridge://dsh-pet',
    observerFactory: (on) => {
      emitProbe = on;
      on({ status: 'ready', screens: [], error: '' });
      return { stop() {} };
    },
  });
  t.after(() => manager.stop());
  await manager.start();
  return { manager, windows, handlers, emitProbe };
}
test('all-off retains manager operations and re-enable creates correct compacted index', async (t) => {
  assert.equal(typeof createManager, 'function');
  const { manager, windows } = await setup(t);
  assert.equal(windows.size, 2);
  await manager.update('white', { enabled: false });
  assert.equal(windows.size, 1);
  assert.equal(windows.get('black').__managerSpec.index, 0);
  await manager.update('black', { enabled: false });
  assert.equal(windows.size, 0);
  await manager.update('white', { enabled: true });
  assert.equal(windows.size, 1);
  assert.ok(windows.has('white'));
});
test('temporary hide restores only enabled pets and invalid updates surface errors', async (t) => {
  const { manager, windows } = await setup(t);
  await manager.update('black', { enabled: false });
  manager.toggleHidden();
  assert.equal(manager.snapshot().hiddenAll, true);
  assert.equal(windows.get('white').visible, false);
  manager.toggleHidden();
  assert.equal(windows.get('white').visible, true);
  assert.equal(windows.has('black'), false);
  await assert.rejects(manager.update('white', { size: -1 }));
  assert.equal(manager.snapshot().pets.find((p) => p.id === 'white').size, 420);
});
test('management IPC refuses an untrusted sender', async (t) => {
  const { handlers } = await setup(t);
  await assert.rejects(handlers.get('pet-manager:call')({ sender: {}, senderFrame: {} }, 'get', {}), /设置窗口/);
});

test('probe failure restores visibility even when last sample was fullscreen', async (t) => {
  const { manager, windows, emitProbe } = await setup(t);
  emitProbe({ status: 'ready', screens: [{ x: 0, y: 0, width: 1920, height: 1080 }], error: '' });
  assert.equal(windows.get('white').visible, false);
  emitProbe({ status: 'error', screens: [{ x: 0, y: 0, width: 1920, height: 1080 }], error: 'probe gone' });
  assert.equal(windows.get('white').visible, true);
  assert.equal(manager.snapshot().pets[0].state, 'visible');
});

test('transient startup failure retries initialization without restarting helper', async (t) => {
  const { manager, windows } = await setup(t, { failFirst: true });
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(manager.snapshot().error, '');
  assert.equal(windows.size, 2);
});
