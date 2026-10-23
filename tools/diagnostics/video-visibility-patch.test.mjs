import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchVideoVisibility } from '../apply-desktop-video-visibility.mjs';

const source = readFileSync(new URL('../../_repo/dsh-pet/runtime/electron-helper/index.html', import.meta.url), 'utf8');

test('patch is idempotent on the source helper', () => {
  assert.equal(patchVideoVisibility(source), source);
});

test('patch changes only the two video rules and preserves reduced motion', () => {
  const old = source.replace('opacity: 1;', 'opacity: 0;')
    .replace('transition: none;', 'transition: opacity 0.18s ease;').replace('visibility: visible;', 'opacity: 1;');
  const patched = patchVideoVisibility(old);
  assert.equal(patched, source);
  const strip = html => html.replace(/^      video\.pet-video(?:\.is-front)? \{[^}]+\}/gm, 'VIDEO');
  assert.equal(strip(patched), strip(old));
});

test('patch refuses duplicate or missing primary rules', () => {
  assert.throws(() => patchVideoVisibility(source + '\n      video.pet-video { opacity: 0; }'), /exactly one/);
  assert.throws(() => patchVideoVisibility(source.replace('video.pet-video.is-front', '.unknown')), /exactly one/);
});

test('patch refuses unexpected video effects', () => {
  assert.throws(() => patchVideoVisibility(source.replace('opacity: 1;', 'opacity: 1;\n        filter: blur(2px);')), /Unexpected/);
});
