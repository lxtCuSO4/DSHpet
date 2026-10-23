import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { patchHost } from '../../../../pet-pack/desktop-manager-patch.mjs';

// Execute the production startup closures, rather than repeating their gate conditions.
// The isolated host inputs avoid starting Electron or depending on built package assets.
const source = readFileSync(new URL('../../src/host/index.ts', import.meta.url), 'utf8');
const begin = source.indexOf('  let hasDesktopPet = false;');
const end = source.indexOf('  /** 停止桌面 Helper', begin);
assert.ok(begin >= 0 && end > begin, 'host startup section must remain locatable');
const startup = stripTypeScriptTypes(source.slice(begin, end));

function fixture(t, managed) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-manager-host-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userRoot = join(root, 'dsh-pet');
  mkdirSync(userRoot);
  if (managed)
    writeFileSync(
      join(userRoot, 'desktop-manager.json'),
      JSON.stringify({ version: 1, mode: 'smart', hotkey: true, positions: {} }),
    );
  return userRoot;
}

function boot(userRoot, entry = 'startHelper', display = 'none', program = startup) {
  const starts = [];
  let resolutions = 0;
  const pets = [
    { id: 'white', size: 420, display },
    { id: 'black', size: 420, display: 'web' },
  ];
  const sandbox = {
    userRoot,
    existsSync,
    join,
    effectivePetList: () => pets,
    isDesktopVisible: (value) => value === 'desktop' || value === 'both',
    resolveElectronPath: () => {
      resolutions++;
      return 'isolated-electron.exe';
    },
    hasGraphicalDisplay: () => true,
    isDesktopHost: () => true,
    ROUTE_PREFIX: '/dsh-pet-7340',
    HelperProcess: class {
      constructor(options) {
        this.options = options;
      }
      start() {
        starts.push(this.options);
      }
    },
    ctx: {
      webServer: { port: 3080 },
      connection: { authenticatedUrl: (origin) => origin },
      logger: { warn() {}, info() {} },
    },
    console: { warn: () => assert.fail('startup must not attempt an Electron download') },
    setTimeout: () => assert.fail('the fixture already has a listening host port'),
    ensureElectronDownload: () => assert.fail('startup must not download Electron'),
    defaultElectronExe: () => 'unused',
  };
  runInNewContext(program + '\n' + entry + '();', sandbox);
  return { starts, resolutions };
}

test('managed all-off pets still start an empty helper after a fresh host boot', (t) => {
  const root = fixture(t, true);
  for (let restart = 0; restart < 2; restart++) {
    const { starts, resolutions } = boot(root);
    assert.equal(resolutions, 1);
    assert.equal(starts.length, 1, 'saved management preferences retain the tray entry across host restarts');
    assert.deepEqual(JSON.parse(starts[0].env.DSH_PET_PETS), []);
  }
});

test('the launchHelper gate also permits saved management with zero desktop pets', (t) => {
  const { starts } = boot(fixture(t, true), 'launchHelper');
  assert.equal(starts.length, 1);
  assert.deepEqual(JSON.parse(starts[0].env.DSH_PET_PETS), []);
});

test('unmanaged web-only users do not resolve, download, or start Electron', (t) => {
  const root = fixture(t, false);
  for (const entry of ['startHelper', 'launchHelper']) {
    const { starts, resolutions } = boot(root, entry);
    assert.equal(starts.length, 0);
    assert.equal(resolutions, 0);
  }
});

test('visible desktop pets continue to start without existing manager preferences', (t) => {
  const { starts, resolutions } = boot(fixture(t, false), 'startHelper', 'desktop');
  assert.equal(resolutions, 1);
  assert.equal(starts.length, 1);
  assert.deepEqual(JSON.parse(starts[0].env.DSH_PET_PETS), [{ id: 'white', size: 420 }]);
});

// Optional real-installation contract: read and patch a supplied legacy lib/index.js in memory.
// No installed files or user preferences are changed by this test.
test(
  'legacy installed host patch retains all-off startup without enabling unmanaged web users',
  {
    skip: process.env.DSH_PET_TEST_LEGACY_HOST
      ? false
      : 'set DSH_PET_TEST_LEGACY_HOST to a legacy lib/index.js for this contract',
  },
  (t) => {
    const original = readFileSync(process.env.DSH_PET_TEST_LEGACY_HOST, 'utf8');
    const patched = patchHost(original);
    assert.equal(patchHost(patched), patched, 'host patch must be repeat-safe');
    const start = patched.indexOf('let hasDesktopPet = false;');
    const stop = patched.indexOf('/** 停止桌面 Helper', start);
    assert.ok(start >= 0 && stop > start, 'legacy startup closures must remain locatable');
    const program = patched.slice(start, stop);
    for (const entry of ['startHelper', 'launchHelper']) {
      const managed = boot(fixture(t, true), entry, 'none', program);
      assert.equal(managed.starts.length, 1, entry + ' must retain management access after restart');
      assert.deepEqual(JSON.parse(managed.starts[0].env.DSH_PET_PETS), []);
      const unmanaged = boot(fixture(t, false), entry, 'none', program);
      assert.equal(unmanaged.starts.length, 0);
      assert.equal(unmanaged.resolutions, 0);
    }
  },
);
