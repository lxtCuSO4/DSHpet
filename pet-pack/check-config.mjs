#!/usr/bin/env node
/**
 * 校验一只「文件宠物」（pet pack）的配置与素材是否自洽。
 *
 * 用法：
 *   node --experimental-strip-types check-config.mjs --entry <素材根> [--home <DSH_HOME>]
 *
 * 做的事：
 *   1) 直接调用 dsh-pet **宿主自己的** readAllConfig()（仓库源码），走同一套合并/校验规则——
 *      不自己复刻规则，规则改了这里自动跟着变。
 *   2) 把「文件里写的」和「合并后的」逐段对比：不一致 = 该段非法被静默回退成内置默认。
 *   3) 收集 animations 里引用到的所有动画名，逐个查素材目录，报缺失。
 *   4) 报宠物 id 冲突（跨条目、含主宠物）。
 *
 * 退出码：0 = 全部通过；1 = 有错误；2 = 环境问题（找不到仓库/源码）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoPkg = resolve(here, '..', '_repo', 'dsh-pet');
const cfgTs = join(repoPkg, 'src', 'host', 'config.ts');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const entry = arg('entry');
const home = arg('home') || process.env.DSH_HOME || join(homedir(), '.dsh');

if (!existsSync(cfgTs)) {
  console.error(`✖ 找不到宿主源码：${cfgTs}\n  请把 dsh-pet 仓库 clone 到 ${resolve(here, '..', '_repo')}`);
  process.exit(2);
}

// ── 调宿主合并逻辑 ──────────────────────────────────────────────────────────
if (!entry) {
  console.error('✖ 缺少 --entry <素材根>（= pet/<名>-config.json 的文件名前缀）');
  process.exit(2);
}

const petDir = join(home, 'dsh-pet', 'pet');
const paths = {
  defaultFile: join(repoPkg, 'assets', 'config.jsonc'),
  userFile: join(home, 'dsh-pet', 'main-config.jsonc'),
  legacyUserFile: join(home, 'dsh-pet', 'main-config.json'),
  petDir,
};

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));

const { readAllConfig } = await import(pathToFileURL(cfgTs).href);
let merged;
try {
  merged = readAllConfig(paths);
} finally {
  console.warn = realWarn;
}

const errors = [];
const notes = [];

// ── 条目是否存在 ────────────────────────────────────────────────────────────
const conf = merged[entry];
const cfgFile = ['json', 'jsonc']
  .map((ext) => join(petDir, `${entry}-config.${ext}`))
  .find((p) => existsSync(p));

if (!conf) {
  console.error(`✖ 没有条目「${entry}」——配置没被读到。\n  期望文件：${join(petDir, entry + '-config.json')}`);
  process.exit(1);
}

// ── 文件原文（剥注释，用于"写了 vs 生效"对比）──────────────────────────────
const stripJsonc = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\:])\/\/.*$/gm, '$1').trim();
const raw = cfgFile ? JSON.parse(stripJsonc(readFileSync(cfgFile, 'utf8'))) : {};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── animations / animationWeights 是否被回退 ────────────────────────────────
for (const key of ['animations', 'animationWeights']) {
  if (raw[key] === undefined) continue;
  if (!same(raw[key], conf[key])) {
    errors.push(
      `「${key}」不合法 → 已被静默替换成内置默认（你写的那份没生效）。\n` +
        `    常见原因：animations 缺 idle/turn/drag/clicks 之一、moves.default 或 moves.actions 缺失、` +
        `events.balance 为空、events 里某个池是空数组；animationWeights 缺 idle/turn/move 之一。`,
    );
  }
}

// ── 宠物实例 ────────────────────────────────────────────────────────────────
const pets = Array.isArray(conf.pets) ? conf.pets : [];
if (!same(pets.map((p) => p.id ?? (p && p.id)), raw.pets?.map?.((p) => p.id) ?? pets.map((p) => p.id))) {
  if (JSON.stringify(raw.pets?.map((p) => p.id)) !== JSON.stringify(pets.map((p) => p.id))) {
    errors.push('pets 里的 id 与文件不一致（id 非法/重复/为空会被跳过，然后回落成默认宠物列表）');
  }
}

const idCount = new Map();
for (const p of pets) idCount.set(p.id, (idCount.get(p.id) ?? 0) + 1);

// 跨条目 id 冲突（主宠物也算）
for (const [k, c] of Object.entries(merged)) {
  for (const p of Array.isArray(c.pets) ? c.pets : []) {
    if (k === entry) continue;
    if (pets.some((mine) => mine.id === p.id)) {
      errors.push(`宠物 id「${p.id}」与条目「${k}」里的实例冲突（id 必须全局唯一）`);
    }
  }
}

// ── 收集动画引用 ────────────────────────────────────────────────────────────
const anims = conf.animations ?? {};
const refs = new Map(); // 名称 → 出现位置
const add = (name, where) => {
  if (typeof name !== 'string' || !name) return;
  if (!refs.has(name)) refs.set(name, []);
  refs.get(name).push(where);
};
for (const key of ['idle', 'turn', 'drag', 'clicks']) {
  for (const n of anims[key] ?? []) add(n, key);
}
for (const cat of anims.categories ?? []) {
  for (const n of cat.actions ?? []) add(n, `categories/${cat.id}`);
}
for (const [evName, pool] of Object.entries(anims.events ?? {})) {
  for (const slot of pool ?? []) {
    if (typeof slot === 'string') add(slot, `events/${evName}`);
    else for (const n of slot) add(n, `events/${evName}`);
  }
}

// ── 素材存在性（pet pack 只查自己的目录，不回落 main）──────────────────────
const ext = process.env.DSH_PET_ANIMATION_EXT || '.webm';
const animDir = join(petDir, `${entry}-animation`);
const existing = existsSync(animDir)
  ? new Set(readdirSync(animDir).filter((f) => f.toLowerCase().endsWith(ext.toLowerCase())).map((f) => f.slice(0, -ext.length)))
  : new Set();

const missing = [];
for (const [name, wheres] of refs) {
  if (!existing.has(name)) missing.push({ name, wheres });
}
const unused = [...existing].filter((f) => !refs.has(f));

// ── 权重可达性检查 ──────────────────────────────────────────────────────────
const w = conf.animationWeights ?? {};
const total = Number(w.idle ?? 0) + Number(w.turn ?? 0) + Number(w.move ?? 0);
const hasCat = (anims.categories ?? []).some((c) => (c.actions ?? []).length > 0);
if (Number(w.turn) > 0 && (anims.turn ?? []).length === 0) {
  errors.push('animationWeights.turn > 0 但 animations.turn 为空 → 转向时抽不到动画');
}
if (Number(w.move) > 0 && total + (hasCat ? 0 : 0) > 100) {
  errors.push(`权重和 ${total} 超过 100`);
}
if (!hasCat && total < 100) {
  notes.push(`权重和只有 ${total}：剩下的 ${100 - total}% 会落进 categories，但 categories 是空的 → 效果等同全待机`);
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const ok = (s) => console.log(`  ✔ ${s}`);
const bad = (s) => console.log(`  ✖ ${s}`);

console.log(`条目     ${entry}${cfgFile ? '' : '  （⚠ 配置文件未找到，以下来自内置默认）'}`);
console.log(`配置     ${cfgFile ?? '(无)'}`);
console.log(`素材目录 ${animDir}`);
console.log(`宠物     ${pets.map((p) => `${p.id} / ${p.name} / size=${p.size} / display=${p.display}`).join(' | ') || '(空)'}`);
console.log(`动画引用 ${refs.size} 个，磁盘上有 ${existing.size} 个 ${ext}`);

if (errors.length) {
  console.log('');
  for (const e of errors) bad(e);
}
if (missing.length) {
  console.log('');
  console.log('  还缺这些素材（名字逐字对齐，含扩展名之前的全部字符）：');
  for (const m of missing) console.log(`    · ${m.name}${ext}   ← ${m.wheres.join(', ')}`);
}
if (unused.length) {
  console.log('');
  console.log('  目录里有、但配置没引用的素材（不会播）：');
  for (const u of unused) console.log(`    · ${u}${ext}`);
}
if (warnings.length) {
  // 「main-config.jsonc 的 pets 缺失」是没建用户主配置时的正常提示：主宠物走内置默认，与本宠物无关
  const own = [...new Set(warnings)].filter((w) => !w.includes('main-config'));
  if (own.length) {
    console.log('');
    console.log('  宿主告警（说明有字段非法被回退）：');
    for (const wmsg of own) console.log(`    ! ${wmsg}`);
  }
}
if (notes.length) {
  console.log('');
  for (const n of notes) console.log(`  … ${n}`);
}

console.log('');
if (errors.length) {
  console.log(`结论：✖ ${errors.length} 个错误（配置会被部分回退成内置默认）`);
  process.exit(1);
}
if (missing.length) {
  console.log(`结论：△ 配置合法，但还缺 ${missing.length}/${refs.size} 段素材 —— 补齐后刷新页面即出现`);
  process.exit(0);
}
console.log('结论：✔ 配置合法，素材齐全');