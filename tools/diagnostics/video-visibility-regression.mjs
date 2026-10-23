// Exercise actual helper playback. Run only in the disposable diagnostic helper.
import assert from 'node:assert/strict';

export async function checkVideoVisibility(page) {
  const styles = await page.evaluate(() => {
    const s = sprites[0];
    return [s.videoA, s.videoB].map((v, i) => {
      const css = getComputedStyle(v);
      return { active: i === s.front, visibility: css.visibility,
        opacity: css.opacity, transition: css.transitionDuration };
    });
  });
  for (const css of styles) {
    assert.equal(css.visibility, css.active ? 'visible' : 'hidden', 'inactive video must be hidden with visibility');
    assert.equal(css.opacity, '1', 'video layers must retain full opacity');
    assert.equal(css.transition, '0s', 'video handoff must not fade');
  }
  return styles;
}

export async function runVideoRegression(page) {
  const checks = [];
  await checkVideoVisibility(page);
  checks.push('initial layer styles');
  const settle = async () => {
    await page.waitForFunction(() => {
      const s = sprites[0], v = s.front === 0 ? s.videoA : s.videoB;
      return !s.pending && v.readyState >= 2 && !v.paused && v.currentTime > 0;
    }, null, { timeout: 15000 });
    await checkVideoVisibility(page);
  };
  const idle = await page.evaluate(() => sprites[0].animations.idle[0]);
  // Use real media EOF rather than calling handleEnded directly.
  const finish = async () => {
    const gen = await page.evaluate(() => {
      const s = sprites[0], v = s.front === 0 ? s.videoA : s.videoB;
      v.currentTime = v.duration - 0.15;
      return s.gen;
    });
    try {
      await page.waitForFunction(g => sprites[0].gen > g && !sprites[0].pending, gen, { timeout: 15000 });
    } catch (error) {
      console.error('EOF state:', await page.evaluate(() => {
        const s = sprites[0], v = s.front === 0 ? s.videoA : s.videoB;
        return { gen: s.gen, anim: s.anim, pending: s.pending, dragging: s.dragState,
          time: v.currentTime, duration: v.duration, ended: v.ended, paused: v.paused, loop: v.loop,
          handler: Boolean(v.onended), error: v.error?.message };
      }));
      throw error;
    }
    await settle();
  };
  await page.evaluate(() => sprites[0].hit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
  assert.equal(await page.evaluate(() => sprites[0].animations.clicks.includes(sprites[0].anim)), true);
  await finish();
  checks.push('click animation and real EOF return');
  await page.evaluate(() => {
    const s = sprites[0];
    s.hit.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 71, screenX: 500, screenY: 500 }));
    s.hit.dispatchEvent(new PointerEvent('pointermove', { pointerId: 71, screenX: 540, screenY: 520 }));
  });
  assert.equal(await page.evaluate(() => sprites[0].dragState.dragging), true);
  await settle();
  assert.equal(await page.evaluate(() => sprites[0].animations.drag.includes(sprites[0].anim)), true);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 71, screenX: 540, screenY: 520 })));
  await settle();
  assert.equal(await page.evaluate(() => sprites[0].dragState.active), false);
  checks.push('DOM pointer drag and release');
  const animations = await page.evaluate(() => {
    const s = sprites[0]; s.stopThrow(); s.stopMove();
    // The user's pack has no turn/move clips. Exercise those paths with existing
    // click media in memory, without adding assets or editing their configuration.
    window.__regressionPools = { turn: s.animations.turn, moves: s.animations.moves, weights: s.weights };
    s.animations.turn = [s.animations.clicks[0]];
    s.animations.moves = { ...s.animations.moves,
      actions: [{ name: s.animations.clicks[1], params: { leadSec: 0, tailSec: 0 } }] };
    s.customPos = { rx: 0.5, ry: 0.5 };
    s.sendBounds(VIEW.w / 2 - s.halfW, VIEW.h / 2 - s.halfH);
    return { turn: s.animations.turn, move: s.animations.moves.actions.map(a => a.name) };
  });
  if (animations.turn.length) {
    const before = await page.evaluate(() => sprites[0].facing);
    await page.evaluate(() => {
      sprites[0].weights = { idle: 0, turn: 100, move: 0 };
      sprites[0].playIdle();
    });
    await settle(); await finish();
    assert.notEqual(await page.evaluate(() => sprites[0].facing), before);
    checks.push('random chain turn and EOF facing change (synthetic pool)');
  }
  if (animations.move.length) {
    await page.evaluate(() => { sprites[0].weights = window.__regressionPools.weights; });
    await page.evaluate(() => {
      const s = sprites[0], r = s.hit.getBoundingClientRect();
      s.hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    });
    await page.waitForSelector('.dsh-pet-menu-column');
    await page.evaluate(name => sprites[0].onMenuAction({ anim: name }), animations.move[0]);
    await settle();
    assert.equal(await page.evaluate(() => sprites[0].menuOpen), false);
    await page.waitForFunction(() => sprites[0].moveRef !== null, null, { timeout: 5000 });
    const movement = await page.evaluate(() => {
      const s = sprites[0];
      return { active: s.moveRef !== null, pending: s.pendingMove, throwActive: s.throwRef !== null,
        pos: s.pos, customPos: s.customPos, facing: s.facing, anim: s.anim,
        currentTime: (s.front === 0 ? s.videoA : s.videoB).currentTime,
        moves: s.animations.moves, view: VIEW, areas: AREAS };
    });
    if (!movement.active) console.error('Movement state:', movement);
    assert.equal(movement.active, true);
    await finish();
    checks.push('menu movement drive and EOF (synthetic pool)');
  }
  await page.evaluate(() => {
    const s = sprites[0], saved = window.__regressionPools;
    s.stopMove(); s.animations.turn = saved.turn; s.animations.moves = saved.moves; s.weights = saved.weights;
    delete window.__regressionPools;
  });
  // Synthetic pool uses existing real media; user config on disk is never changed.
  await page.evaluate(name => {
    const s = sprites[0]; s.stopMove(); s.stopThrow();
    window.__regressionEvents = s.animations.events;
    s.animations.events = { ...s.animations.events, workStatus: [[name]] };
    s.workState = Object.keys(S.WORK_STATUS_INDEX).find(k => S.WORK_STATUS_INDEX[k] === 0);
    s.resumeWorkStatusAnim();
  }, idle);
  await settle();
  assert.equal(await page.evaluate(() => (sprites[0].front === 0 ? sprites[0].videoA : sprites[0].videoB).loop), true);
  checks.push('single candidate work status native loop');
  const alternative = await page.evaluate(() => sprites[0].animations.clicks[0]);
  await page.evaluate(({ idle, alternative }) => {
    const s = sprites[0]; s.animations.events.workStatus = [[idle, alternative]];
    s.resumeWorkStatusAnim();
  }, { idle, alternative });
  await settle(); await finish();
  assert.equal(await page.evaluate(() => (sprites[0].front === 0 ? sprites[0].videoA : sprites[0].videoB).loop), false);
  checks.push('multiple candidate work status EOF rotation');
  await page.evaluate(() => {
    sprites[0].workState = null;
    sprites[0].animations.events = window.__regressionEvents;
    delete window.__regressionEvents;
  });
  await page.evaluate(({ idle, alternative }) => {
    const s = sprites[0];
    for (let i = 0; i < 6; i++) s.playOnce(i % 2 ? idle : alternative);
  }, { idle, alternative });
  await settle();
  assert.equal(await page.evaluate(() => sprites[0].anim), idle);
  checks.push('rapid consecutive switches settle on final request');
  await page.evaluate(() => sprites[0].playOnce('__missing_regression_asset__'));
  await page.waitForFunction(() => !sprites[0].pending, null, { timeout: 12000 });
  await checkVideoVisibility(page);
  await page.evaluate(name => sprites[0].playOnce(name), idle);
  await settle();
  checks.push('missing media releases pending and valid playback recovers');
  // Keep the old layer looping so natural EOF cannot supersede the stalled
  // request and accidentally masquerade as a successful timeout test.
  await page.evaluate(() => {
    const s = sprites[0], v = s.front === 0 ? s.videoA : s.videoB;
    v.loop = true; v.onended = null;
  });
  const stalledAt = Date.now();
  await page.evaluate(() => sprites[0].playOnce('__stalled_regression_asset__'));
  await page.waitForFunction(() => !sprites[0].pending, null, { timeout: 13000 });
  assert.ok(Date.now() - stalledAt >= 9500, 'stalled media must exercise the real 10 second guard');
  await checkVideoVisibility(page);
  await page.evaluate(name => sprites[0].playOnce(name), idle);
  await settle();
  checks.push('stalled media 10s timeout and valid playback recovery');
  return checks;
}
