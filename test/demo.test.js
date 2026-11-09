import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';

import { createDemoServer } from '../demo/server.js';

async function start(t) {
  const server = createDemoServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return server.address().port;
}

const post = (port, route, body = {}) =>
  fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// fetch won't let us set Host or Origin, so use node:http for the guard checks.
function raw(port, { method = 'GET', path = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

test('serves the demo page', async (t) => {
  const port = await start(t);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /nodejs-supply-chain-security/);
});

test('each demo shows the unsafe side exploited and the safe side not', async (t) => {
  const port = await start(t);
  for (const route of ['postinstall', 'scan', 'permission']) {
    const res = await post(port, route);
    assert.equal(res.status, 200, route);
    const { unsafe, safe } = await res.json();
    assert.equal(unsafe.exploited, true, `${route} unsafe`);
    assert.equal(safe.exploited, false, `${route} safe`);
  }
});

test('postinstall: tokens leak without --ignore-scripts, and only the fake ones', async (t) => {
  const port = await start(t);
  const { unsafe, safe } = await (await post(port, 'postinstall', { tokens: ['GITHUB_TOKEN'] })).json();
  assert.deepEqual(unsafe.exfiltrated, { GITHUB_TOKEN: 'ghp_FAKE_demo_token_456' });
  assert.equal(safe.exfiltrated, null);
});

test('scan and permission respond to their inputs', async (t) => {
  const port = await start(t);
  const scan = await (await post(port, 'scan', { allow: '@scope/native,deep,evil' })).json();
  assert.equal(scan.safe.exitCode, 0);

  const perm = await (await post(port, 'permission', { grants: ['child-process'] })).json();
  const spawn = perm.safe.attempts.find((a) => a.action === 'spawn child process');
  assert.equal(spawn.result, 'allowed');
});

test('guards: only local hosts and origins, JSON only', async (t) => {
  const port = await start(t);
  const json = { 'Content-Type': 'application/json' };
  assert.equal(await raw(port, { headers: { Host: 'evil.example' } }), 403);
  assert.equal(await raw(port, { method: 'POST', path: '/api/scan', headers: { 'Content-Type': 'text/plain' } }), 415);
  assert.equal(await raw(port, { method: 'POST', path: '/api/scan', headers: { ...json, Origin: 'https://evil.example' } }), 403);
  assert.equal(await raw(port, { method: 'POST', path: '/api/scan', headers: { ...json, Origin: `http://localhost:${port}` } }), 200);
});
