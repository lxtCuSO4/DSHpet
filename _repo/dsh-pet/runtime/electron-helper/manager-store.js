'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MODES, displayWithDesktop } = require('./manager-policy.js');

// Strip comments without changing strings such as URLs. Trailing commas are permitted in JSONC.
function parseJsonc(input) {
  const source = String(input).replace(/^\uFEFF/, '');
  let result = '',
    quoted = false,
    escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i],
      n = source[i + 1];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      result += c;
    } else if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      result += '\n';
    } else if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw Error('配置中的注释未结束，未保存。');
      i = end + 1;
      result += ' ';
    } else result += c;
  }
  let clean = '';
  quoted = false;
  escaped = false;
  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (!quoted && c === ',' && /^[\s]*[}\]]/.test(result.slice(i + 1))) continue;
    clean += c;
    if (escaped) escaped = false;
    else if (quoted && c === '\\') escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  const value = JSON.parse(clean);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('配置必须是对象，未保存。');
  return value;
}
function atomicWrite(file, value, backupRoot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let original;
  try {
    original = fs.readFileSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (original && backupRoot) {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.writeFileSync(path.join(backupRoot, `${path.basename(file)}.${Date.now()}.${randomUUID()}.bak`), original, {
      flag: 'wx',
    });
  }
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Refuse an external edit between read and replace.
    if (original && !original.equals(fs.readFileSync(file))) throw Error('配置刚被其它程序修改，请刷新后重试。');
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function validatePreferences(prefs) {
  if (!MODES.has(prefs.mode) || typeof prefs.hotkey !== 'boolean') throw Error('显示模式或快捷键设置无效。');
  if (!prefs.positions || typeof prefs.positions !== 'object' || Array.isArray(prefs.positions))
    throw Error('位置设置无效。');
  const positions = {};
  for (const [id, p] of Object.entries(prefs.positions)) {
    if (!p || ![p.rx, p.ry].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))
      throw Error('位置设置无效。');
    Object.defineProperty(positions, id, {
      value: { rx: p.rx, ry: p.ry },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { version: 1, mode: prefs.mode, hotkey: prefs.hotkey, positions };
}
function createStore(meta) {
  if (!meta || !path.isAbsolute(meta.user)) throw Error('无法定位用户配置目录。');
  const root = path.dirname(meta.user),
    prefsFile = path.join(root, 'desktop-manager.json');
  function safeFile(file) {
    const resolvedRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    const relative = path.relative(resolvedRoot, real);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
      throw Error('配置文件指向用户目录之外，未保存。');
    return file;
  }
  function readPreferences() {
    if (!fs.existsSync(prefsFile)) return { version: 1, mode: 'smart', hotkey: true, positions: {} };
    return validatePreferences(parseJsonc(fs.readFileSync(safeFile(prefsFile), 'utf8')));
  }
  return {
    root,
    prefsFile,
    readPreferences,
    savePreferences(patch) {
      if (!patch || Object.keys(patch).some((k) => !['mode', 'hotkey', 'positions'].includes(k)))
        throw Error('不支持的管理设置。');
      const next = validatePreferences({ ...readPreferences(), ...patch });
      atomicWrite(prefsFile, next);
      return next;
    },
    updatePet(merged, id, patch) {
      if (
        typeof id !== 'string' ||
        !patch ||
        Array.isArray(patch) ||
        !Object.keys(patch).length ||
        Object.keys(patch).some((k) => !['enabled', 'size'].includes(k))
      )
        throw Error('不支持的桌宠设置。');
      if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw Error('开关必须是布尔值。');
      if ('size' in patch && (!Number.isInteger(patch.size) || patch.size < 120 || patch.size > 900))
        throw Error('大小必须是 120–900 的整数。');
      const hits = Object.entries(merged).flatMap(([entry, conf]) =>
        (Array.isArray(conf?.pets) ? conf.pets : []).filter((p) => p.id === id).map((p) => ({ entry, pet: p })),
      );
      if (hits.length !== 1) throw Error('桌宠不存在或 ID 不唯一，请刷新列表。');
      const { entry } = hits[0];
      if (!/^[^<>:"/\\|?*\x00-\x1f]+$/.test(entry) || entry === '.' || entry === '..')
        throw Error('素材条目标识无效。');
      let file;
      if (entry === 'main') file = meta.user;
      else
        file = ['json', 'jsonc']
          .map((ext) => path.join(root, 'pet', entry + '-config.' + ext))
          .find((p) => fs.existsSync(p));
      if (!file) throw Error('找不到这只桌宠的配置文件。');
      const exists = fs.existsSync(file);
      const raw = exists ? parseJsonc(fs.readFileSync(safeFile(file), 'utf8')) : { pets: merged.main.pets };
      if (entry === 'main' && raw.pets === undefined) raw.pets = merged.main.pets;
      if (!Array.isArray(raw.pets) || raw.pets.filter((p) => p.id === id).length !== 1)
        throw Error('原配置缺少唯一宠物，未保存。');
      const next = {
        ...raw,
        pets: raw.pets.map((p) =>
          p.id !== id
            ? p
            : {
                ...p,
                ...('enabled' in patch ? { display: displayWithDesktop(hits[0].pet.display, patch.enabled) } : {}),
                ...('size' in patch ? { size: patch.size } : {}),
              },
        ),
      };
      atomicWrite(file, next, path.join(root, 'manager-backups'));
      return next;
    },
  };
}
module.exports = { createStore, parseJsonc, atomicWrite };
