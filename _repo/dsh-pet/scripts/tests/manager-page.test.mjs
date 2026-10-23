import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../runtime/electron-helper/', import.meta.url));
let server, browser, url;
before(async () => {
  assert.ok(existsSync(join(root, 'manager.html')), 'management page must exist');
  server = createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'manager.html';
    if (!['manager.html', 'manager.css', 'manager-page.js'].includes(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      'content-type',
      name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html',
    );
    res.end(readFileSync(join(root, name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.DSH_PET_TEST_BROWSER || undefined });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
});
async function open(t, width = 1120) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  await page.addInitScript(() => {
    const state = {
      pets: [
        { id: 'white', name: 'Akashi Myu·白', size: 420, enabled: true, state: 'visible', preview: '' },
        { id: 'black', name: 'Akashi Myu·黑', size: 420, enabled: true, state: 'visible', preview: '' },
      ],
      mode: 'smart',
      hotkey: true,
      hotkeyLabel: 'Ctrl + Alt + P',
      hiddenAll: false,
      probe: { status: 'ready', error: '' },
      error: '',
      hotkeyError: '',
    };
    window.fixture = { state, fail: false, writes: [] };
    const copy = () => JSON.parse(JSON.stringify(state));
    window.desktopManager = {
      get: async () => copy(),
      refresh: async () => copy(),
      update: async (id, patch) => {
        if (window.fixture.fail) throw Error('配置不可写');
        window.fixture.writes.push({ id, patch });
        Object.assign(
          state.pets.find((p) => p.id === id),
          patch,
        );
        return copy();
      },
      preferences: async (patch) => {
        Object.assign(state, patch);
        return copy();
      },
      recover: async () => copy(),
      hide: async () => {
        state.hiddenAll = !state.hiddenAll;
        return copy();
      },
    };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(url);
  await page.getByRole('switch', { name: 'Akashi Myu·白 的桌面显示' }).waitFor();
  page.setDefaultTimeout(5000);
  return page;
}
test('lists named pets and saves per-pet switch and size; temporary hide preserves switches', async (t) => {
  const page = await open(t);
  const white = page.getByRole('switch', { name: 'Akashi Myu·白 的桌面显示' });
  await white.uncheck();
  await page.waitForFunction(() => window.fixture.writes.length === 1);
  assert.equal(await white.isChecked(), false);
  const range = page.getByLabel('Akashi Myu·黑 的大小');
  await range.evaluate((e) => {
    e.value = '300';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => window.fixture.writes.length === 2);
  await page.getByRole('button', { name: '全部隐藏', exact: true }).click();
  await page.getByRole('button', { name: '恢复显示', exact: true }).waitFor();
  assert.equal(await white.isChecked(), false);
  await page.getByLabel('普通窗口', { exact: false }).check();
  await page.waitForFunction(() => window.fixture.state.mode === 'normal');
});
test('failed writes restore switch and show an actionable error', async (t) => {
  const page = await open(t);
  await page.evaluate(() => (window.fixture.fail = true));
  const toggle = page.getByRole('switch', { name: 'Akashi Myu·白 的桌面显示' });
  await toggle.click();
  await page.getByRole('status').filter({ hasText: '配置不可写' }).waitFor();
  assert.equal(await toggle.isChecked(), true);
});
test('narrow layout has no horizontal overflow and controls can receive keyboard focus', async (t) => {
  const page = await open(t, 620);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('switch', { name: 'Akashi Myu·白 的桌面显示' }).focus();
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'switch');
  if (process.env.DSH_PET_SCREENSHOTS) {
    mkdirSync(process.env.DSH_PET_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.DSH_PET_SCREENSHOTS, 'manager-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1120, height: 980 });
    await page.screenshot({ path: join(process.env.DSH_PET_SCREENSHOTS, 'manager-wide.png'), fullPage: true });
  }
});
