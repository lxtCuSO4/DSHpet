'use strict';
const path = require('node:path');
const { createStore } = require('./manager-store.js');
const { desktopEnabled, visibilityFor } = require('./manager-policy.js');
const { startObserver } = require('./fullscreen-observer.js');
const SHORTCUT = 'CommandOrControl+Alt+P';
const signature = (p) => JSON.stringify([p.id, p.size, p.index, p.name]);

// All renderer snippets are fixed application code; user strings enter only through JSON.stringify.
function restorePose(saved, recover) {
  if (!window.__dshPetDebug?.configOk || typeof sprites === 'undefined' || !sprites[0]) return false;
  const s = sprites[0];
  if (s.dragState.active) return true;
  let x, y;
  if (recover) {
    const a = PRIMARY_AREA || AREAS[0];
    x = a.x + a.width / 2;
    y = a.y + a.height - s.halfH - 40;
    s.stopMove();
    s.stopThrow();
  } else if (saved) {
    x = saved.rx * VIEW.w;
    y = saved.ry * VIEW.h;
  } else return true;
  const areas = (typeof WORK_AREAS !== 'undefined' ? WORK_AREAS : AREAS).map((a) => ({
    x: a.x + Math.min(s.halfW, a.width / 2),
    y: a.y + Math.min(s.halfH, a.height / 2),
    width: Math.max(1, a.width - s.size),
    height: Math.max(1, a.height - s.height),
  }));
  const p = S.clampPointToRegion(areas, x, y);
  s.customPos = { rx: p.x / VIEW.w, ry: p.y / VIEW.h };
  s.position();
  return true;
}

function createManager(options) {
  const {
    electron,
    windows,
    hostRequest,
    createWindows,
    onChanged = () => {},
    previewBase = '',
    deskGeometry,
  } = options;
  const { BrowserWindow, ipcMain, globalShortcut, screen, app } = electron;
  let store,
    prefs = { version: 1, mode: 'smart', hotkey: true, positions: {} },
    merged = {},
    pets = [];
  let panel = null,
    hiddenAll = false,
    error = '',
    hotkeyError = '',
    dirty = false,
    stopped = false,
    started = false;
  let observer,
    pollTimer,
    visibilityTimer,
    retryTimer,
    starting,
    refreshAt = 0,
    queue = Promise.resolve();
  let probe = { status: process.platform === 'win32' ? 'starting' : 'unsupported', screens: [], error: '' };
  const bodies = new Map(),
    statuses = new Map(),
    attachTimers = new Set();

  async function request(url) {
    const r = await hostRequest('GET', '/dsh-pet-7340/' + url);
    if (r.status !== 200) throw Error('读取桌宠配置失败（' + r.status + '）');
    const data = JSON.parse(r.body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('桌宠配置返回格式无效。');
    return data;
  }
  function flatten(data) {
    return Object.entries(data).flatMap(([entry, conf]) =>
      (Array.isArray(conf?.pets) ? conf.pets : []).map((p) => ({
        ...p,
        entry,
        idle: conf.animations?.idle?.[0] || '',
        preview: conf.animations?.idle?.[0]
          ? previewBase +
            '/dsh-pet-7340/thumb/' +
            encodeURIComponent(entry) +
            '/' +
            encodeURIComponent(conf.animations.idle[0]) +
            '.webm'
          : '',
      })),
    );
  }
  function serialize(fn) {
    const next = queue.then(() => {
      if (stopped) throw Error('管理服务已关闭。');
      return fn();
    });
    queue = next.catch(() => {});
    return next;
  }
  function flushPositions() {
    if (!store || !dirty) return;
    prefs = store.savePreferences({ positions: prefs.positions });
    dirty = false;
  }
  function noteBounds(id, bounds) {
    const size = Number(bounds?.size),
      x = Number(bounds?.boxX),
      y = Number(bounds?.boxY);
    if (![size, x, y].every(Number.isFinite) || size <= 0) return;
    const geo = deskGeometry?.()?.hull || { x: 0, y: 0, width: 1920, height: 1080 };
    bodies.set(id, { x: x + geo.x, y: y + geo.y, width: size, height: (size * 9) / 16 });
    if (windows.get(id)?.__managerReady) {
      const value = {
        rx: Math.max(0, Math.min(1, (x + size / 2) / geo.width)),
        ry: Math.max(0, Math.min(1, (y + (size * 9) / 32) / geo.height)),
      };
      const old = prefs.positions[id];
      if (!old || Math.abs(value.rx - old.rx) > 0.0001 || Math.abs(value.ry - old.ry) > 0.0001) {
        Object.defineProperty(prefs.positions, id, { value, enumerable: true, configurable: true, writable: true });
        dirty = true;
      }
    }
  }
  function applyVisibility() {
    for (const [id, win] of windows) {
      if (win.isDestroyed()) continue;
      const pet = pets.find((p) => p.id === id);
      if (!pet) continue;
      const box = bodies.get(id) || win.getBounds?.() || { x: 0, y: 0, width: 1, height: 1 };
      const reason = visibilityFor(pet, prefs.mode, hiddenAll, box, probe.status === 'ready' ? probe.screens : []);
      const top = prefs.mode === 'topmost' || (prefs.mode === 'smart' && probe.status === 'ready');
      if (win.__managerTop !== top) {
        win.__managerTop = top;
        win.setAlwaysOnTop(top, process.platform === 'darwin' ? 'floating' : 'normal');
      }
      const last = statuses.get(id);
      statuses.set(id, reason);
      if (reason !== 'visible') {
        if (win.isVisible()) win.hide();
      } else if (win.__managerReady && !win.isVisible()) win.showInactive();
      if (last !== reason || !win.__managerMediaSet) {
        win.__managerMediaSet = true;
        const visible = reason === 'visible';
        win.webContents
          .executeJavaScript(
            `(()=>{window.__petManagerHidden=${!visible};for(const v of document.querySelectorAll('video.pet-video')){if(window.__petManagerHidden)v.pause();else if(v.classList.contains('is-front'))v.play().catch(()=>{});}})()`,
          )
          .catch(() => {});
      }
    }
  }
  function attach(pet, win) {
    win.__managerSpec = { ...pet };
    win.__managerReady = false;
    // Prevent a newly created high-layer pet from covering fullscreen content during probe startup.
    win.setAlwaysOnTop(false);
    win.__managerTop = false;
    win.on('show', applyVisibility);
    let tries = 0;
    const attempt = async () => {
      if (stopped || win.isDestroyed()) return;
      try {
        const ready = await win.webContents.executeJavaScript(
          '(' + restorePose.toString() + ')(' + JSON.stringify(prefs.positions[pet.id] || null) + ',false)',
        );
        if (ready) {
          win.__managerReady = true;
          applyVisibility();
          return;
        }
      } catch {
        /* The renderer may still be navigating during the first attempt. */
      }
      if (++tries >= 100) {
        error = '有桌宠未能加载，请检查素材或重载配置。';
        return;
      }
      const timer = setTimeout(() => {
        attachTimers.delete(timer);
        void attempt();
      }, 100);
      timer.unref?.();
      attachTimers.add(timer);
    };
    win.webContents.on('did-finish-load', () => {
      win.__managerMediaSet = false;
      void attempt();
    });
    void attempt();
    applyVisibility();
  }
  async function refresh() {
    const data = await request('config'),
      nextPets = flatten(data);
    const ids = new Set(nextPets.map((p) => p.id));
    if (ids.size !== nextPets.length) throw Error('配置中的桌宠 ID 重复。');
    merged = data;
    pets = nextPets;
    const desired = pets
      .filter((p) => desktopEnabled(p.display))
      .map((p, index) => ({ id: p.id, size: p.size, name: p.name, index }));
    for (const [id, win] of [...windows]) {
      const spec = desired.find((p) => p.id === id);
      if (!spec || signature(spec) !== signature(win.__managerSpec || {})) {
        // Destroy synchronously so an old window's closed handler cannot remove its replacement.
        if (!win.isDestroyed()) win.destroy();
        windows.delete(id);
        bodies.delete(id);
        statuses.delete(id);
      }
    }
    createWindows(desired);
    error = '';
    refreshAt = Date.now();
    applyVisibility();
  }
  function snapshot() {
    return {
      pets: pets.map((p) => ({
        id: p.id,
        name: p.name,
        size: p.size,
        enabled: desktopEnabled(p.display),
        preview: p.preview,
        state: statuses.get(p.id) || (desktopEnabled(p.display) ? 'loading' : 'disabled'),
      })),
      mode: prefs.mode,
      hotkey: prefs.hotkey,
      hotkeyLabel: process.platform === 'darwin' ? '⌘ Alt P' : 'Ctrl + Alt + P',
      hiddenAll,
      probe: { status: probe.status, error: probe.error },
      error,
      hotkeyError,
    };
  }
  function registerShortcut() {
    globalShortcut.unregister(SHORTCUT);
    hotkeyError = '';
    if (prefs.hotkey && !globalShortcut.register(SHORTCUT, toggleHidden))
      hotkeyError = '快捷键已被其它应用占用，可在托盘操作或关闭快捷键。';
  }
  function toggleHidden() {
    hiddenAll = !hiddenAll;
    applyVisibility();
    onChanged();
    return snapshot();
  }
  async function update(id, patch) {
    return serialize(async () => {
      await refresh();
      flushPositions();
      store.updatePet(merged, id, patch);
      await refresh();
      onChanged();
      return snapshot();
    });
  }
  async function preferences(patch) {
    return serialize(async () => {
      if (!patch || Object.keys(patch).some((k) => !['mode', 'hotkey'].includes(k))) throw Error('不支持的管理设置。');
      flushPositions();
      prefs = store.savePreferences(patch);
      registerShortcut();
      applyVisibility();
      onChanged();
      return snapshot();
    });
  }
  async function recover(id) {
    return serialize(async () => {
      if (!pets.some((p) => p.id === id)) throw Error('找不到这只桌宠。');
      const win = windows.get(id);
      if (!win) throw Error('请先开启这只桌宠，再找回位置。');
      const ready = await win.webContents.executeJavaScript('(' + restorePose.toString() + ')(null,true)');
      if (!ready) throw Error('桌宠正在加载，请稍后重试。');
      // sendBounds synchronously reports the recovered normalized position through noteBounds.
      await new Promise((r) => setTimeout(r, 100));
      flushPositions();
      return snapshot();
    });
  }
  function open() {
    if (panel && !panel.isDestroyed()) {
      panel.show();
      panel.focus();
      return;
    }
    const a = screen.getPrimaryDisplay().workArea,
      scale = options.scale?.() || 1;
    panel = new BrowserWindow({
      title: '桌宠管理',
      width: Math.min(a.width - 40, Math.round(1060 * scale)),
      height: Math.min(a.height - 40, Math.round(780 * scale)),
      minWidth: Math.min(a.width - 40, 600 * scale),
      minHeight: Math.min(a.height - 40, 520 * scale),
      backgroundColor: '#f5f4ef',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'manager-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    panel.webContents.setZoomFactor(scale);
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', (e) => e.preventDefault());
    panel.on('closed', () => {
      panel = null;
    });
    panel.loadFile(path.join(__dirname, 'manager.html')).catch((e) => {
      error = '设置页加载失败：' + e.message;
    });
  }
  const openFromPet = (event) => {
    if ([...windows.values()].some((w) => w.webContents === event.sender)) open();
  };
  ipcMain.on('pet:open-manager', openFromPet);
  ipcMain.handle('pet-manager:call', async (event, action, payload = {}) => {
    if (
      !panel ||
      panel.isDestroyed() ||
      event.sender !== panel.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw Error('只能从桌宠设置窗口执行此操作。');
    if (!started && action !== 'get') throw Error('设置尚未加载，请稍后重试。');
    if (action === 'get') return snapshot();
    if (action === 'update') return update(payload.id, payload.patch);
    if (action === 'preferences') return preferences(payload);
    if (action === 'recover') return recover(payload.id);
    if (action === 'hide') return toggleHidden();
    if (action === 'refresh')
      return serialize(async () => {
        await refresh();
        return snapshot();
      });
    throw Error('不支持的管理操作。');
  });
  const beforeQuit = () => {
    try {
      flushPositions();
    } catch (e) {
      console.error('[pet-manager] save positions:', e.message);
    }
    stop();
  };
  app.on('before-quit', beforeQuit);
  async function initialize() {
    try {
      store = createStore(await request('config/meta'));
      prefs = store.readPreferences();
      // This file also keeps the desktop management entry available after an all-off host restart.
      prefs = store.savePreferences({});
      if (stopped) return snapshot();
      observer ||= (options.observerFactory || startObserver)((state) => {
        probe = state;
        applyVisibility();
      });
      registerShortcut();
      await refresh();
      started = true;
      onChanged();
      visibilityTimer = setInterval(applyVisibility, 150);
      visibilityTimer.unref?.();
      pollTimer = setInterval(() => {
        serialize(async () => {
          flushPositions();
          if (Date.now() - refreshAt >= 2500) await refresh();
        }).catch((e) => {
          error = e.message;
        });
      }, 1500);
      pollTimer.unref?.();
    } catch (e) {
      error = e.message;
      console.error('[pet-manager] initialization:', e.message);
      if (!stopped) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void start();
        }, options.retryMs || 1500);
        retryTimer.unref?.();
      }
    }
    return snapshot();
  }
  function start() {
    if (stopped || started) return Promise.resolve(snapshot());
    if (!starting)
      starting = initialize().finally(() => {
        starting = null;
      });
    return starting;
  }
  function stop() {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(pollTimer);
    clearInterval(visibilityTimer);
    observer?.stop();
    for (const timer of attachTimers) clearTimeout(timer);
    attachTimers.clear();
    globalShortcut.unregister(SHORTCUT);
    ipcMain.removeHandler('pet-manager:call');
    ipcMain.removeListener('pet:open-manager', openFromPet);
    app.removeListener('before-quit', beforeQuit);
  }
  return {
    start,
    stop,
    open,
    attach,
    noteBounds,
    snapshot,
    update,
    preferences,
    recover,
    toggleHidden,
    refresh: () => serialize(refresh),
  };
}
module.exports = { createManager };
