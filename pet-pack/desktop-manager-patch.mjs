// Version-checked, scoped integration edits; no whole installed source files are replaced.
function once(text, before, after) {
  const count = text.split(before).length - 1;
  if (count !== 1)
    throw Error(
      "无法唯一定位补丁位置（匹配 " + count + " 次）：" + before.slice(0, 90),
    );
  return text.replace(before, after);
}
export function patchHost(input) {
  if (input.includes("// pet-manager host integration v1")) return input;
  let count = 0;
  const result = input.replace(/if \(!hasDesktopPet\) return;/g, () => {
    count++;
    return 'if (!hasDesktopPet && !existsSync(join(userRoot, "desktop-manager.json"))) return; // pet-manager host integration v1';
  });
  if (count !== 2) throw Error("无法定位旧版宿主的两处桌面启动条件：" + count);
  return result;
}
export function patchHelper(name, input) {
  if (!["main.js", "sprite.js", "preload.js"].includes(name))
    throw Error("不支持的补丁文件：" + name);
  if (
    input.includes("// pet-manager integration v2") ||
    (name !== "main.js" && input.includes("// pet-manager integration v1"))
  )
    return input;
  if (input.includes("// pet-manager integration v1"))
    throw Error("请从原始备份升级 main.js 的旧实验补丁。");
  const eol = input.includes("\r\n") ? "\r\n" : "\n";
  let text = input.replace(/\r\n/g, "\n");
  if (name === "main.js") {
    const modern = text.includes(
      "const TRAY_PLATFORM = trayPlatform(process.platform);",
    );
    text = once(
      text,
      "const windows = new Map();",
      "const windows = new Map();\n// pet-manager integration v2\nlet desktopManager = null, desktopShell = null;",
    );
    text = once(
      text,
      "function createPetWindows() {",
      "function createPetWindows(petList) {",
    );
    text = once(
      text,
      "  const pets = petsFromEnv();",
      "  const pets = petList || petsFromEnv();",
    );
    text = once(
      text,
      "  for (const pet of pets) {",
      "  for (const pet of pets) {\n    if (windows.has(pet.id)) continue;",
    );
    text = once(
      text,
      "    windows.set(pet.id, win);",
      "    windows.set(pet.id, win);\n    desktopManager?.attach(pet, win);",
    );
    text = once(
      text,
      "    if (petId) {\n      const bx = Number(bounds?.boxX);",
      "    if (petId) {\n      desktopManager?.noteBounds(petId, bounds);\n      const bx = Number(bounds?.boxX);",
    );
    text = once(
      text,
      "      if (!due) return;",
      "      if (!due || desktopManager) return;",
    );
    if (modern) {
      const begin = text.indexOf("// ---------- 系统托盘："),
        end = text.indexOf("app.whenReady().then(() => {", begin);
      if (begin < 0 || end < 0) throw Error("无法定位新版托盘块。");
      text = text.slice(0, begin) + text.slice(end);
      text = once(
        text,
        "// 托盘的平台差异（模板图 / 左键是否自动弹菜单 / Dock）：规则住在模块里，main.js 只接线\nconst { trayPlatform } = require('./tray-platform.js');",
        "",
      );
      text = once(
        text,
        "const { app, BrowserWindow, ipcMain, screen, shell, protocol, Tray, Menu, nativeImage } = electronApi;",
        "const { app, BrowserWindow, ipcMain, screen, shell, protocol } = electronApi;",
      );
      text = once(
        text,
        "  // macOS：桌面宠物不该占 Dock——托盘才是桌面端的常驻入口，Dock 里多一个图标只会碍事\n  if (TRAY_PLATFORM.hideDock && app.dock) app.dock.hide();",
        "  // 托盘先常驻，管理器等待 bridge 就绪后加载配置与创建桌宠。",
      );
      text = once(
        text,
        "  // 托盘：不 await（建窗与建托盘互不依赖），内部自己等 bridge 回调服务就绪\n  void startTray();\n",
        "",
      );
      const tail = text.indexOf("// 退出时销毁托盘图标：");
      if (tail < 0) throw Error("无法定位新版托盘退出块。");
      text =
        text.slice(0, tail) +
        "app.on('window-all-closed', () => { if (!desktopManager) app.quit(); });\n";
    } else {
      text = once(
        text,
        "app.on('window-all-closed', () => {\n  app.quit();\n});",
        "app.on('window-all-closed', () => { if (!desktopManager) app.quit(); });",
      );
    }
    text = once(
      text,
      "app.whenReady().then(() => {",
      `const ORIGIN = new URL(process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config').origin;
const { createHostRequest, createShell } = require('./manager-shell.js');
const hostRequest = createHostRequest({ bridge: BRIDGE, ready: () => !!bridgeCallbackUrl, request: bridgeRequest, origin: ORIGIN });

app.whenReady().then(() => {`,
    );
    text = once(
      text,
      "  createPetWindows();",
      `  desktopManager = require('./manager-controller.js').createManager({
    electron: electronApi, windows, hostRequest, createWindows: createPetWindows,
    onChanged: () => desktopShell?.refresh(), deskGeometry, scale: petScale,
    previewBase: BRIDGE ? 'dsh-pet-bridge://dsh-pet' : ORIGIN,
  });
  desktopShell = createShell(electronApi, desktopManager);
  void desktopManager.start();`,
    );
  } else if (name === "preload.js") {
    text = once(
      text,
      "contextBridge.exposeInMainWorld('petBridge', {",
      "contextBridge.exposeInMainWorld('petBridge', {\n  // pet-manager integration v2\n  openManager() { ipcRenderer.send('pet:open-manager'); },",
    );
  } else {
    const anchor =
      "    const tools = [{ label: OPEN_TARGET === 'desktop' ? '打开 DeepSeek Harness' : '打开网站', action: 'open-site' }];";
    text = once(
      text,
      anchor,
      anchor +
        "\n    // pet-manager integration v2\n    tools.unshift({ label: '桌宠管理…', action: 'open-manager' });",
    );
    text = once(
      text,
      "    if (leaf.action === 'open-site') {",
      "    if (leaf.action === 'open-manager') {\n      window.petBridge?.openManager?.();\n      return;\n    }\n    if (leaf.action === 'open-site') {",
    );
  }
  return text.replace(/\n/g, eol);
}
