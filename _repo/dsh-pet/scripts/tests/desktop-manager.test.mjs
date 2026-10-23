import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let storeModule = {},
  policy = {};
try {
  storeModule = require('../../runtime/electron-helper/manager-store.js');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
}
try {
  policy = require('../../runtime/electron-helper/manager-policy.js');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manager-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'pet'));
  const white = { id: 'white', name: 'Akashi Myu·白', display: 'desktop', size: 420 };
  const black = { id: 'black', name: 'Akashi Myu·黑', display: 'both', size: 420 };
  const main = { id: 'main', name: '原宠物', display: 'none', size: 462 };
  const merged = { main: { pets: [main] }, white: { pets: [white] }, black: { pets: [black] } };
  writeFileSync(join(root, 'main-config.jsonc'), JSON.stringify({ pets: [main], future: { keep: true } }));
  writeFileSync(
    join(root, 'pet/white-config.json'),
    '// keep semantic values\n' +
      JSON.stringify({ pets: [white], animations: { idle: ['呼吸'] }, future: 'https://x.test//ok' }),
  );
  writeFileSync(join(root, 'pet/black-config.jsonc'), JSON.stringify({ pets: [black] }));
  return { root, merged, store: storeModule.createStore?.({ user: join(root, 'main-config.jsonc') }) };
}

test('configuration service exists', () => assert.equal(typeof storeModule.createStore, 'function'));
test('edits only requested fields and keeps unrelated configuration, with backup', (t) => {
  const { store, root, merged } = fixture(t);
  store.updatePet(merged, 'white', { enabled: false, size: 300 });
  const doc = storeModule.parseJsonc(readFileSync(join(root, 'pet/white-config.json'), 'utf8'));
  assert.equal(doc.pets[0].display, 'none');
  assert.equal(doc.pets[0].size, 300);
  assert.equal(doc.future, 'https://x.test//ok');
  assert.deepEqual(doc.animations, { idle: ['呼吸'] });
  assert.equal(readdirSync(join(root, 'manager-backups')).length, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'main-config.jsonc'), 'utf8')).pets[0].display, 'none');
});
test('desktop switch preserves browser visibility in both directions', (t) => {
  const { store, root, merged } = fixture(t);
  store.updatePet(merged, 'black', { enabled: false });
  assert.equal(JSON.parse(readFileSync(join(root, 'pet/black-config.jsonc'))).pets[0].display, 'web');
  store.updatePet(merged, 'black', { enabled: true });
  assert.equal(JSON.parse(readFileSync(join(root, 'pet/black-config.jsonc'))).pets[0].display, 'both');
});
test('invalid sizes, arbitrary fields, unknown and ambiguous IDs cannot write', (t) => {
  const { store, root, merged } = fixture(t);
  const before = readFileSync(join(root, 'pet/white-config.json'), 'utf8');
  for (const patch of [
    { size: 0 },
    { size: 901 },
    { size: '300' },
    { enabled: 'yes' },
    { display: 'desktop' },
    { name: 'changed' },
    {},
  ]) {
    assert.throws(() => store.updatePet(merged, 'white', patch));
  }
  assert.throws(() => store.updatePet(merged, '../white', { enabled: true }));
  assert.throws(() => store.updatePet({ ...merged, other: merged.white }, 'white', { enabled: true }));
  assert.equal(readFileSync(join(root, 'pet/white-config.json'), 'utf8'), before);
});

test('sparse display inherits browser bit and a global-only main override remains editable', (t) => {
  const { store, root, merged } = fixture(t);
  writeFileSync(join(root, 'pet/black-config.jsonc'), JSON.stringify({ pets: [{ id: 'black' }] }));
  store.updatePet(merged, 'black', { enabled: false });
  assert.equal(JSON.parse(readFileSync(join(root, 'pet/black-config.jsonc'))).pets[0].display, 'web');
  writeFileSync(join(root, 'main-config.jsonc'), JSON.stringify({ future: { keep: true } }));
  store.updatePet(merged, 'main', { enabled: true });
  const main = JSON.parse(readFileSync(join(root, 'main-config.jsonc')));
  assert.equal(main.pets[0].display, 'desktop');
  assert.deepEqual(main.future, { keep: true });
});
test('corrupt files are refused and preserved; no fallback overwrites personal config', (t) => {
  const { store, root, merged } = fixture(t);
  writeFileSync(join(root, 'pet/white-config.json'), '{ broken');
  assert.throws(() => store.updatePet(merged, 'white', { enabled: false }));
  assert.equal(readFileSync(join(root, 'pet/white-config.json'), 'utf8'), '{ broken');
});
test('preferences persist mode, hotkey and finite normalized positions across store recreation', (t) => {
  const { store, root } = fixture(t);
  assert.equal(store.readPreferences().mode, 'smart');
  store.savePreferences({ mode: 'normal', hotkey: false, positions: { white: { rx: 0.3, ry: 0.7 } } });
  assert.deepEqual(storeModule.createStore({ user: join(root, 'main-config.jsonc') }).readPreferences(), {
    version: 1,
    mode: 'normal',
    hotkey: false,
    positions: { white: { rx: 0.3, ry: 0.7 } },
  });
  assert.throws(() => store.savePreferences({ mode: 'invalid' }));
  assert.throws(() => store.savePreferences({ positions: { white: { rx: NaN, ry: 1 } } }));
});
test('JSONC parser preserves string literals and rejects unterminated comments', () => {
  assert.deepEqual(storeModule.parseJsonc('\ufeff{/*x*/"url":"https://a//b", "pets":[], // hi\n}'), {
    url: 'https://a//b',
    pets: [],
  });
  assert.throws(() => storeModule.parseJsonc('{/*broken'));
});
test('fullscreen suppression and temporary hide never change persistent enablement', () => {
  assert.equal(typeof policy.visibilityFor, 'function');
  const pet = { display: 'desktop' },
    box = { x: 20, y: 20, width: 200, height: 200 };
  const full = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.equal(policy.visibilityFor(pet, 'smart', false, box, full), 'fullscreen');
  assert.equal(policy.visibilityFor(pet, 'smart', false, box, []), 'visible');
  assert.equal(policy.visibilityFor({ display: 'none' }, 'smart', false, box, []), 'disabled');
  assert.equal(policy.visibilityFor(pet, 'normal', false, box, full), 'visible');
  assert.equal(policy.visibilityFor(pet, 'topmost', false, box, full), 'visible');
  assert.equal(policy.visibilityFor(pet, 'smart', true, box, []), 'hidden-all');
  assert.equal(policy.visibilityFor(pet, 'smart', false, { ...box, x: 2000 }, full), 'visible');
  assert.equal(pet.display, 'desktop');
});
test('fullscreen means all monitor edges are covered, not a normal maximized work area', () => {
  const monitor = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.equal(policy.coversMonitor(monitor, monitor), true);
  assert.equal(policy.coversMonitor({ ...monitor, height: 1040 }, monitor), false);
  assert.equal(policy.coversMonitor({ ...monitor, x: -1917, width: 1914 }, monitor), true);
});
