import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let parseSample;
try {
  ({ parseSample } = require('../../runtime/electron-helper/fullscreen-observer.js'));
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
}
test('probe accepts finite monitor rectangles and rejects malformed or unbounded input', () => {
  assert.equal(typeof parseSample, 'function');
  assert.deepEqual(parseSample('{"screens":[{"x":-1920,"y":0,"width":1920,"height":1080}]}'), [
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ]);
  for (const text of ['not JSON', '{}', '{"screens":[{"x":0,"y":0,"width":0,"height":1}]}', 'x'.repeat(20000)])
    assert.throws(() => parseSample(text));
});
