'use strict';
const path = require('node:path');
function createHostRequest({ bridge, ready, request, origin, timeout = 10000 }) {
  return async (method, url, body) => {
    if (bridge) {
      const end = Date.now() + timeout;
      while (!ready()) {
        if (Date.now() >= end) throw Error('桌宠通信服务尚未就绪，请稍后重试。');
        await new Promise((r) => setTimeout(r, 20));
      }
      return request(method, url, body);
    }
    const response = await fetch(origin + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body,
    });
    return { status: response.status, body: await response.text() };
  };
}
// The tray remains accessible before config loads and after every pet is disabled.
function createShell(electron, manager) {
  const { Tray, Menu, nativeImage, app } = electron;
  let icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/logo.png'));
  if (icon.isEmpty()) throw Error('无法读取桌宠托盘图标。');
  icon = icon.resize({ width: 16, height: 16 });
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
    app.dock?.hide();
  }
  const tray = new Tray(icon);
  tray.setToolTip('Akashi Myu · 桌宠管理');
  const logError = (e) => console.error('[pet-manager] tray:', e.message);
  const refresh = () => {
    const state = manager.snapshot();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '桌宠管理…', click: () => manager.open() },
        { label: state.hiddenAll ? '恢复显示' : '全部隐藏', click: () => manager.toggleHidden() },
        { type: 'separator' },
        ...state.pets.map((p) => ({
          label: p.name || p.id,
          type: 'checkbox',
          checked: p.enabled,
          click: () => {
            void manager.update(p.id, { enabled: !p.enabled }).catch(logError);
          },
        })),
      ]),
    );
  };
  tray.on('double-click', () => manager.open());
  if (process.platform !== 'darwin') tray.on('click', () => tray.popUpContextMenu());
  const stop = () => {
    if (!tray.isDestroyed()) tray.destroy();
    app.removeListener('before-quit', stop);
  };
  app.on('before-quit', stop);
  refresh();
  return { refresh, stop, tray };
}
module.exports = { createHostRequest, createShell };
