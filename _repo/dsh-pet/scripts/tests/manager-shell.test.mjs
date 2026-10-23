import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createHostRequest } = createRequire(import.meta.url)('../../runtime/electron-helper/manager-shell.js');
test('bridge transport waits for the callback address before sending its first request', async () => {
  let ready = false,
    calls = 0;
  const request = createHostRequest({
    bridge: true,
    ready: () => ready,
    request: async () => {
      calls++;
      return { status: 200 };
    },
  });
  const pending = request('GET', '/config');
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(calls, 0);
  ready = true;
  assert.equal((await pending).status, 200);
  assert.equal(calls, 1);
});
test('failed callback startup times out without sending a request with empty callback', async () => {
  const request = createHostRequest({
    bridge: true,
    ready: () => false,
    timeout: 30,
    request: () => assert.fail('must not send'),
  });
  await assert.rejects(request('GET', '/config'), /尚未就绪/);
});
