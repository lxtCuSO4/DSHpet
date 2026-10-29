// Patch only the desktop squash method; installed helpers can differ elsewhere.
// Usage: node tools/apply-desktop-aspect-ratio.mjs SPRITE_JS BACKUP_FILE
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const marker = '    // pet-original-aspect v1';
const replacement = `  /** 保持原素材比例：点击与落地不再额外压扁或拉伸视频。 */
  startSquash(el) {
${marker}
    this.stopSquash();
    this.pendingSquash = false;
    el.style.transformOrigin = 'center';
    el.style.transform = this.facing === 'right' ? 'scaleX(-1)' : '';
  }

`;

export function patchPetAspectRatio(text) {
  if ([...text.matchAll(/^  startSquash\(/gm)].length !== 1 ||
      [...text.matchAll(/^  stopSquash\(\) \{/gm)].length !== 1) {
    throw new Error('Expected unique squash methods; refusing to patch');
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const next = replacement.replaceAll('\n', newline);
  if (text.includes('pet-original-aspect')) {
    if (text.split('pet-original-aspect').length !== 2 || !text.includes(next)) {
      throw new Error('Unexpected original-aspect patch; refusing to patch');
    }
    return text;
  }
  const start = text.indexOf('  /** Q 弹挤压：');
  const end = text.indexOf('  stopSquash() {');
  const block = text.slice(start, end);
  if (start < 0 || end <= start ||
      !block.includes('  startSquash(el, depth = S.SQ_SQUASH) {') ||
      !block.includes('const scale = S.squashScale(u, depth);') ||
      !block.includes("'scaleY(' + scale + ')'") ||
      !block.trimEnd().endsWith('this.squashRef = requestAnimationFrame(step);\n  }'.replaceAll('\n', newline))) {
    throw new Error('Unrecognized legacy squash block; refusing to patch');
  }
  return text.slice(0, start) + next + text.slice(end);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , targetArg, backupArg] = process.argv;
  if (!targetArg || !backupArg) throw new Error('Usage: node tools/apply-desktop-aspect-ratio.mjs SPRITE_JS BACKUP_FILE');
  const target = resolve(targetArg), backup = resolve(backupArg);
  if (target === backup) throw new Error('Backup must differ from target');
  const before = readFileSync(target);
  const after = Buffer.from(patchPetAspectRatio(before.toString('utf8')));
  new Script(after.toString('utf8'), { filename: target });
  const hash = data => createHash('sha256').update(data).digest('hex');
  if (!before.equals(after)) {
    writeFileSync(backup, before, { flag: 'wx' });
    const temporary = target + '.aspect-' + process.pid + '.tmp';
    writeFileSync(temporary, after, { flag: 'wx' });
    if (!readFileSync(target).equals(before)) throw new Error('Target changed during patch; backup and candidate retained');
    renameSync(temporary, target);
    if (!readFileSync(target).equals(after)) throw new Error('Patch verification failed');
  }
  console.log(JSON.stringify({ target, backup, changed: !before.equals(after), before: hash(before), after: hash(after) }));
}
