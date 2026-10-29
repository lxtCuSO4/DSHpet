import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../_repo/dsh-pet/runtime/electron-helper/sprite.js', import.meta.url), 'utf8');
function spriteFixture() {
  const pending = new Map(); let token = 0;
  const scope = {
    window: { matchMedia: () => ({ matches: false }) },
    S: { SQ_SQUASH: .55, SQ_DURATION_MS: 500, squashScale: () => .55, pick: pool => pool[0] },
    performance: { now: () => 0 },
    requestAnimationFrame: fn => { pending.set(++token, fn); return token; },
    cancelAnimationFrame: id => pending.delete(id),
  };
  runInNewContext(source + '\nthis.TestSprite = PetSprite;', scope);
  const sprite = Object.create(scope.TestSprite.prototype);
  Object.assign(sprite, { _facing: 'left', squashRef: null, squashToken: 0, pendingSquash: false });
  return { sprite, pending };
}

test('desktop click and landing requests keep original video proportions in both directions', () => {
  for (const facing of ['left', 'right']) for (const depth of [.55, .8]) {
    const { sprite, pending } = spriteFixture(); sprite._facing = facing;
    const video = { style: { transform: 'scaleY(.55)', transformOrigin: 'bottom' } };
    sprite.startSquash(video, depth);
    assert.equal(pending.size, 0, 'no deforming animation may be scheduled');
    assert.equal(video.style.transform, facing === 'right' ? 'scaleX(-1)' : '');
  }
});

test('removing deformation preserves the configured click video and cancels a previous squash', () => {
  const { sprite, pending } = spriteFixture();
  const video = { style: {} }; let played;
  sprite.dragState = { active: false, dragging: false }; sprite.justDragged = false;
  sprite.animations = { clicks: ['点击回应'] };
  sprite.stopThrow = () => {}; sprite.stopMove = () => {};
  sprite.squashRef = 42; pending.set(42, () => assert.fail('previous squash must be cancelled'));
  sprite.playOnce = animation => { played = animation; sprite.startSquash(video); };
  sprite.onClick();
  assert.equal(played, '点击回应');
  assert.equal(pending.size, 0);
  assert.equal(video.style.transform, '');
});
