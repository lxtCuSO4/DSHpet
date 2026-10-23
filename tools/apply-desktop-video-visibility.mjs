// Narrow, repeatable patch for installed helpers that differ from this checkout.
// Usage: node tools/apply-desktop-video-visibility.mjs INDEX_HTML BACKUP_FILE
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchVideoVisibility(html) {
  const selectors = ['video.pet-video', 'video.pet-video.is-front'];
  const rules = selectors.map(selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...html.matchAll(new RegExp(`(^[ \\t]*)${escaped} \\{([^}]+)\\}`, 'gm'))]
      .filter(match => /\b(?:opacity|visibility)\s*:/.test(match[2]));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${selector} rule; refusing to patch`);
    return matches[0];
  });
  const newline = html.includes('\r\n') ? '\r\n' : '\n';
  return rules.reduce((text, match, i) => {
    const indent = match[1] + '  ';
    // Preserve layout and all unrelated styles. Reject unexpected visual effects.
    let body = match[2];
    if (/\b(?:display|filter|animation)\s*:/.test(body)) throw new Error('Unexpected video effects; review before patching');
    body = body.replace(/^[ \t]*(?:opacity|visibility|transition)\s*:[^;]+;[^\r\n]*(?:\r?\n)?/gm, '');
    const properties = i === 0
      ? ['/* Keep full opacity: opacity handoffs can drop a transparent desktop video layer. */', 'opacity: 1;', 'visibility: hidden;', 'transition: none;']
      : ['visibility: visible;'];
    const comment = /^[ \t]*\/\* Keep full opacity:[^\r\n]+\*\/[ \t]*(?:\r?\n)?/gm;
    body = body.replace(comment, '').replace(/\s+$/, '');
    const replacement = `${match[1]}${selectors[i]} {${body}${newline}${properties.map(p => indent + p).join(newline)}${newline}${match[1]}}`;
    return text.replace(match[0], replacement);
  }, html);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , targetArg, backupArg] = process.argv;
  if (!targetArg || !backupArg) throw new Error('Usage: node tools/apply-desktop-video-visibility.mjs INDEX_HTML BACKUP_FILE');
  const target = resolve(targetArg), backup = resolve(backupArg);
  if (target === backup) throw new Error('Backup must differ from target');
  const before = readFileSync(target);
  const after = Buffer.from(patchVideoVisibility(before.toString('utf8')));
  const hash = data => createHash('sha256').update(data).digest('hex');
  if (!before.equals(after)) {
    writeFileSync(backup, before, { flag: 'wx' });
    writeFileSync(target, after);
  }
  console.log(JSON.stringify({ target, backup, changed: !before.equals(after), before: hash(before), after: hash(after) }));
}
