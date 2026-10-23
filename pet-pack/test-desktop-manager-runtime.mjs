#!/usr/bin/env node
// Opt-in, real Electron/Win32 integration against a disposable copy, never the installed package.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { patchHelper } from "./desktop-manager-patch.mjs";
const require = createRequire(import.meta.url),
  { _electron } = require("playwright");
const {
  parseJsonc,
} = require("../_repo/dsh-pet/runtime/electron-helper/manager-store.js");
const { readAllConfig } = await import("../_repo/dsh-pet/src/host/config.ts");
const argv = process.argv.slice(2),
  arg = (k) => argv[argv.indexOf("--" + k) + 1];
const packageRoot = resolve(arg("package")),
  executablePath = resolve(arg("electron")),
  output = resolve(arg("output"));
const sourceHelper = fileURLToPath(
  new URL("../_repo/dsh-pet/runtime/electron-helper/", import.meta.url),
);
const inputData = argv.includes("--data") ? resolve(arg("data")) : null;
const root = mkdtempSync(join(tmpdir(), "dsh-manager-electron-")),
  helper = join(root, "runtime/electron-helper"),
  data = join(root, "data");
let instance, fullscreen, server;
const report = { checks: [], screenshots: [], logs: [], root };
try {
  mkdirSync(output, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(data, "pet"));
  cpSync(join(packageRoot, "runtime/electron-helper"), helper, {
    recursive: true,
  });
  mkdirSync(join(root, "assets"));
  copyFileSync(
    join(packageRoot, "assets/logo.png"),
    join(root, "assets/logo.png"),
  );
  for (const name of ["main.js", "preload.js", "sprite.js"])
    writeFileSync(
      join(helper, name),
      patchHelper(name, readFileSync(join(helper, name), "utf8")),
    );
  for (const name of [
    "manager-policy.js",
    "manager-store.js",
    "manager-controller.js",
    "manager-shell.js",
    "manager-preload.js",
    "manager.html",
    "manager.css",
    "manager-page.js",
    "fullscreen-observer.js",
    "fullscreen-probe.ps1",
  ])
    copyFileSync(join(sourceHelper, name), join(helper, name));
  writeFileSync(
    join(helper, "main.js"),
    readFileSync(join(helper, "main.js"), "utf8") +
      "\nglobalThis.__petManagerTest={get manager(){return desktopManager;},windows,deskGeometry};\n",
  );
  const defaultFile = join(packageRoot, "assets/config.jsonc"),
    defaults = parseJsonc(readFileSync(defaultFile, "utf8"));
  writeFileSync(
    join(data, "main-config.jsonc"),
    JSON.stringify({
      pets: defaults.pets.map((p) => ({
        ...p,
        display: "none",
        whisperEnabled: false,
        workStatusEnabled: false,
        balanceEnabled: false,
      })),
    }),
  );
  for (const [entry, original, color] of [
    ["white", "mypet", "白"],
    ["black", "secondpet", "黑"],
  ]) {
    const base = inputData
      ? parseJsonc(
          readFileSync(
            join(inputData, "pet", original + "-config.json"),
            "utf8",
          ),
        )
      : {
          pets: [defaults.pets[0]],
          animations: defaults.animations,
          animationWeights: { idle: 100, turn: 0, move: 0 },
        };
    base.pets = [
      {
        ...base.pets[0],
        id: entry,
        name: "Akashi Myu·" + color,
        size: 420,
        display: "desktop",
        whisperEnabled: false,
        workStatusEnabled: false,
        balanceEnabled: false,
      },
    ];
    writeFileSync(
      join(data, "pet", entry + "-config.json"),
      JSON.stringify(base),
    );
  }
  const paths = {
    defaultFile,
    userFile: join(data, "main-config.jsonc"),
    legacyUserFile: join(data, "main-config.json"),
    petDir: join(data, "pet"),
  };
  server = createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://localhost"),
        rest = url.pathname.replace("/dsh-pet-7340/", "");
      res.setHeader("access-control-allow-origin", "*");
      if (rest === "config" || rest === "config/meta" || rest === "state") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            rest === "config"
              ? readAllConfig(paths)
              : rest === "config/meta"
                ? { user: paths.userFile }
                : { sections: {}, pets: {} },
          ),
        );
        return;
      }
      if (rest.startsWith("thumb/")) {
        const [, entry, name] = rest.split("/").map(decodeURIComponent);
        const original = entry === "white" ? "mypet" : "secondpet";
        const file =
          inputData && entry !== "main"
            ? join(inputData, "pet", original + "-animation", name)
            : join(packageRoot, "assets/webm", name);
        res.setHeader("content-type", "video/webm");
        res.end(readFileSync(file));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, items: [] }));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const configUrl =
    "http://127.0.0.1:" + server.address().port + "/dsh-pet-7340/config";
  const fixture = join(root, "fullscreen.cjs");
  writeFileSync(
    fixture,
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, "fullscreen-profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({width:720,height:480,title:'DSHpet 全屏避让验证'});w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="background:#263d37;color:#eaf1e9;font:28px sans-serif;display:grid;place-items:center"><p>桌宠全屏避让 · 隔离验证</p>'));});app.on('window-all-closed',()=>app.quit());`,
  );
  const env = {
    ...process.env,
    DSH_PET_CONFIG_URL: configUrl,
    DSH_PET_BRIDGE: "0",
    DSH_PET_HOST_PID: String(process.pid),
    DSH_PET_PETS: JSON.stringify([
      { id: "white", size: 420 },
      { id: "black", size: 420 },
    ]),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, label, timeout = 20000) {
    const begin = Date.now();
    while (Date.now() - begin < timeout) {
      const value = await fn();
      if (value) return value;
      await sleep(150);
    }
    throw Error("Timed out: " + label);
  }
  async function snapshot() {
    return instance.evaluate(() =>
      globalThis.__petManagerTest.manager.snapshot(),
    );
  }
  async function start() {
    instance = await _electron.launch({
      executablePath,
      args: [
        join(helper, "main.js"),
        "--user-data-dir=" + join(root, "profile"),
      ],
      env,
      timeout: 30000,
    });
    instance.on("console", (msg) => report.logs.push(msg.text()));
    instance
      .process()
      .stderr.on("data", (text) => report.logs.push(String(text)));
    await until(async () => {
      const s = await snapshot();
      return s.pets.length === 3 && !s.error && s.probe.status === "ready";
    }, "manager+native probe ready");
    await until(
      () =>
        instance.evaluate(() => {
          const t = globalThis.__petManagerTest;
          return (
            t.windows.size ===
              t.manager.snapshot().pets.filter((p) => p.enabled).length &&
            [...t.windows.values()].every((w) => w.__managerReady)
          );
        }),
      "pet renderer ready",
    );
  }
  await start();
  report.checks.push("real two-window boot and Windows probe ready");
  await instance.evaluate(() => globalThis.__petManagerTest.manager.open());
  let panel = await until(async () => {
    for (const w of instance.windows())
      if (w.url().endsWith("manager.html")) return w;
  }, "settings page");
  await panel
    .getByRole("switch", { name: "Akashi Myu·白 的桌面显示" })
    .waitFor();
  await panel.screenshot({
    path: join(output, "manager-real.png"),
    fullPage: true,
  });
  report.screenshots.push("manager-real.png");
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.update("black", { enabled: false }),
  );
  await until(
    () =>
      instance.evaluate(
        () => globalThis.__petManagerTest.windows.get("white")?.__managerReady,
      ),
    "remaining renderer ready",
  );
  fullscreen = await _electron.launch({
    executablePath,
    args: [fixture],
    env: { ...env, DSH_PET_BRIDGE: "0" },
    timeout: 30000,
  });
  await fullscreen.firstWindow();
  await fullscreen.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setAlwaysOnTop(true);
    w.setFullScreen(true);
    w.show();
    w.focus();
  });
  await until(async () => {
    const s = await snapshot();
    return (
      s.pets.find((p) => p.id === "white").state === "fullscreen" &&
      s.pets.find((p) => p.id === "black").state === "disabled"
    );
  }, "real fullscreen hide");
  assert.equal(
    await instance.evaluate(() =>
      globalThis.__petManagerTest.windows.get("white").isVisible(),
    ),
    false,
  );
  report.checks.push(
    "native fullscreen hides enabled pet while manual-off pet stays off",
  );
  await fullscreen.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setFullScreen(false),
  );
  await until(async () => {
    const s = await snapshot();
    return s.pets.find((p) => p.id === "white").state === "visible";
  }, "exit fullscreen restore");
  assert.equal(
    await instance.evaluate(() =>
      globalThis.__petManagerTest.windows.get("white").isVisible(),
    ),
    true,
  );
  report.checks.push("exiting fullscreen restores only enabled pet");
  await fullscreen.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].maximize(),
  );
  await sleep(900);
  assert.equal(
    (await snapshot()).pets.find((p) => p.id === "white").state,
    "visible",
  );
  report.checks.push("ordinary maximized window does not trigger avoidance");
  await fullscreen.close();
  fullscreen = null;
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.preferences({ mode: "normal" }),
  );
  assert.equal(
    await instance.evaluate(() =>
      globalThis.__petManagerTest.windows.get("white").isAlwaysOnTop(),
    ),
    false,
  );
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.preferences({ mode: "topmost" }),
  );
  assert.equal(
    await instance.evaluate(() =>
      globalThis.__petManagerTest.windows.get("white").isAlwaysOnTop(),
    ),
    true,
  );
  report.checks.push("normal/topmost modes affect native window layer");
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.preferences({ mode: "smart" }),
  );
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.toggleHidden(),
  );
  assert.equal(
    await instance.evaluate(() =>
      globalThis.__petManagerTest.windows.get("white").isVisible(),
    ),
    false,
  );
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.toggleHidden(),
  );
  report.checks.push("temporary hide/restore preserves individual switches");
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.update("white", { enabled: false }),
  );
  await panel.close();
  assert.equal(
    await instance.evaluate(() => globalThis.__petManagerTest.windows.size),
    0,
  );
  await instance.evaluate(() => globalThis.__petManagerTest.manager.open());
  panel = await until(
    async () =>
      instance.windows().find((w) => w.url().endsWith("manager.html")),
    "all-off settings reopen",
  );
  report.checks.push(
    "all-off leaves process/tray alive and management window can reopen",
  );
  await instance.evaluate(() =>
    globalThis.__petManagerTest.manager.update("black", {
      enabled: true,
      size: 300,
    }),
  );
  await until(
    () =>
      instance.evaluate(
        () => globalThis.__petManagerTest.windows.get("black")?.__managerReady,
      ),
    "re-enabled black ready",
  );
  const blackPage = await until(
    async () =>
      instance
        .windows()
        .find(
          (w) =>
            w.url().includes("petIndex=0") && w.url().includes("index.html"),
        ),
    "black page",
  );
  assert.equal(await blackPage.evaluate(() => sprites[0].pet.id), "black");
  assert.equal(await blackPage.evaluate(() => sprites[0].size), 300);
  report.checks.push("compacted index retains black identity and changed size");
  await blackPage.evaluate(() => {
    sprites[0].customPos = { rx: 0.4, ry: 0.4 };
    sprites[0].position();
  });
  await sleep(1800);
  await instance.close();
  instance = null;
  await start();
  const restarted = await until(
    async () =>
      instance
        .windows()
        .find(
          (w) =>
            w.url().includes("petIndex=0") && w.url().includes("index.html"),
        ),
    "restarted black page",
  );
  const pose = await restarted.evaluate(() => ({
    id: sprites[0].pet.id,
    size: sprites[0].size,
    rx: (sprites[0].pos.x + sprites[0].halfW) / VIEW.w,
    ry: (sprites[0].pos.y + sprites[0].halfH) / VIEW.h,
    ok: window.__dshPetDebug.configOk,
    errors: window.__dshPetDebug.errors,
  }));
  assert.equal(pose.id, "black");
  assert.equal(pose.size, 300);
  assert.ok(
    Math.abs(pose.rx - 0.4) < 0.005 && Math.abs(pose.ry - 0.4) < 0.005,
    JSON.stringify(pose),
  );
  assert.deepEqual(pose.errors, []);
  report.checks.push(
    "restart preserves disabled white, black size and dragged position",
  );
  report.ok = true;
} catch (e) {
  report.error = e.stack;
  if (instance)
    report.debug = await instance
      .evaluate(async () => ({
        state: globalThis.__petManagerTest.manager.snapshot(),
        windows: await Promise.all(
          [...globalThis.__petManagerTest.windows].map(async ([id, w]) => ({
            id,
            ready: w.__managerReady,
            spec: w.__managerSpec,
            url: w.webContents.getURL(),
            debug: await w.webContents
              .executeJavaScript("window.__dshPetDebug")
              .catch((e) => String(e)),
          })),
        ),
      }))
      .catch((e) => String(e));
  throw e;
} finally {
  if (fullscreen) await fullscreen.close().catch(() => {});
  if (instance) await instance.close().catch(() => {});
  if (server?.listening) await new Promise((r) => server.close(r));
  writeFileSync(
    join(output, "runtime-report.json"),
    JSON.stringify(report, null, 2),
  );
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
console.log(JSON.stringify(report, null, 2));
