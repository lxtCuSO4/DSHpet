import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let patchHelper;
try {
  ({ patchHelper } = await import("./desktop-manager-patch.mjs"));
} catch (e) {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
}
const root = new URL(
  "../_repo/dsh-pet/runtime/electron-helper/",
  import.meta.url,
);
test("integration patch is exact, repeat-safe and leaves video CSS untouched", () => {
  assert.equal(typeof patchHelper, "function");
  for (const name of ["main.js", "preload.js", "sprite.js"]) {
    const input = readFileSync(new URL(name, root), "utf8");
    const output = patchHelper(name, input);
    assert.equal(patchHelper(name, output), output);
    assert.ok(output.includes("pet-manager integration"));
    assert.ok(
      output.includes("desktopManager") ||
        output.includes("openManager") ||
        output.includes("open-manager"),
    );
  }
  assert.throws(
    () => patchHelper("main.js", "// different version"),
    /唯一|匹配|定位/,
  );
  assert.throws(() => patchHelper("index.html", "anything"));
});

test("legacy helper receives a shell, indexed reconciliation and persistent lifetime", () => {
  const original = `const windows = new Map();
function createPetWindows() {
  const pets = petsFromEnv();
  for (const pet of pets) {
    windows.set(pet.id, win);
  }
}
function watchdog() {
      if (!due) return;
}
app.whenReady().then(() => {
  createPetWindows();
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    if (petId) {
      const bx = Number(bounds?.boxX);
    }
  });
});
app.on('window-all-closed', () => {
  app.quit();
});`;
  const result = patchHelper("main.js", original);
  assert.equal(patchHelper("main.js", result), result);
  assert.match(result, /createHostRequest/);
  assert.match(result, /createShell\(electronApi, desktopManager\)/);
  assert.match(result, /if \(!desktopManager\) app.quit/);
  assert.match(result, /if \(!due \|\| desktopManager\) return/);
});
