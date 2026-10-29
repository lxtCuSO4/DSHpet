import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchPetAspectRatio } from '../apply-desktop-aspect-ratio.mjs';

const legacy = `  /** Q 弹挤压：legacy desktop feedback */
  startSquash(el, depth = S.SQ_SQUASH) {
    const step = () => {
      const u = 0;
      const scale = S.squashScale(u, depth);
      el.style.transform = 'scaleY(' + scale + ')';
    };
    this.squashRef = requestAnimationFrame(step);
  }

`;
const tail = '  stopSquash() { this.squashRef = null; }\n}\n// unrelated manager integration\n';

test('narrow patch preserves unrelated content and is idempotent with LF and CRLF', () => {
  for (const newline of ['\n', '\r\n']) {
    const prefix = '// installed variant\nclass PetSprite {\n'.replaceAll('\n', newline);
    const suffix = tail.replaceAll('\n', newline);
    const text = prefix + legacy.replaceAll('\n', newline) + suffix;
    const patched = patchPetAspectRatio(text);
    assert.ok(patched.startsWith(prefix));
    assert.ok(patched.endsWith(suffix));
    assert.ok(!patched.includes('scaleY('));
    assert.equal(patchPetAspectRatio(patched), patched);
    if (newline === '\r\n') assert.ok(!/(?<!\r)\n/.test(patched));
  }
});

test('patch rejects missing, duplicate, unfamiliar and damaged blocks', () => {
  const valid = 'class PetSprite {\n' + legacy + tail;
  for (const text of [
    '', valid + legacy, valid.replace('S.squashScale', 'customScale'),
    valid.replace('  /** Q 弹挤压：', '  /** Changed:'),
    patchPetAspectRatio(valid).replace('this.stopSquash();', 'customEffect();'),
    patchPetAspectRatio(valid) + '// pet-original-aspect v1',
  ]) assert.throws(() => patchPetAspectRatio(text), /refusing to patch/);
});
