import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createHttpServer, fetchBridge } from '../src/http.mjs';

const apiKey = randomBytes(32).toString('base64url');
const authorization = `Bearer ${apiKey}`;

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return server.address().port;
}

async function fixture(t, overrides = {}) {
  const calls = [];
  const service = {
    connection: () => { calls.push(['connection']); return { read_only: true }; },
    capabilities: () => { calls.push(['capabilities']); return { writes: 'disabled' }; },
    listTasks: async (query) => { calls.push(['listTasks', query]); return { items: [{ id: 'task-1' }] }; },
    getTask: async (id) => { calls.push(['getTask', id]); return { item: { id } }; },
    listTags: async () => { calls.push(['listTags']); return { items: [] }; },
    ...overrides,
  };
  const server = createHttpServer({ service, apiKey, port: 0 });
  const port = await listen(t, server);
  return { server, port, service, calls };
}

function request(port, { path = '/v1/connection', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { Authorization: authorization, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : undefined });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function rawRequest(port, headers, target = '/v1/connection') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
  });
}

test('createHttpServer does not listen, validates strong key shape, and sets resource bounds', async (t) => {
  const server = createHttpServer({ service: {}, apiKey });
  assert.equal(server.listening, false);
  assert.equal(server.maxConnections, 64);
  assert.equal(server.maxRequestsPerSocket, 100);
  assert.equal(server.requestTimeout, 20000);
  assert.equal(server.headersTimeout, 10000);
  assert.equal(server.keepAliveTimeout, 5000);
  assert.equal(server.timeout, 20000);
  for (const key of ['', 'weak', 'a'.repeat(43), randomBytes(31).toString('base64url')]) {
    assert.throws(() => createHttpServer({ service: {}, apiKey: key }), { code: 'INVALID_CONFIGURATION' });
  }
  for (const port of [-1, 65536, '8788', 1.1]) {
    assert.throws(() => createHttpServer({ service: {}, apiKey, port }), { code: 'INVALID_CONFIGURATION' });
  }
  const { port } = await fixture(t);
  const res = await request(port);
  assert.equal(res.status, 200);
});

test('all five read routes are authenticated and successful results remain JSON', async (t) => {
  const { port, calls } = await fixture(t, { connection: async () => ({ read_only: true, async: true }) });
  const advanced = { advanced: { recurrence: 'implemented_not_account_tested', complete: 'implemented_not_account_tested', reminder_settings: 'implemented_not_account_tested', tag_update: 'implemented_not_account_tested' }, reminder_delivery: false };
  const cases = [
    ['/v1/connection', { read_only: true, async: true, ...advanced }],
    ['/v1/capabilities', { writes: 'disabled', ...advanced }],
    ['/v1/tasks', { items: [{ id: 'task-1' }] }],
    ['/v1/tasks/task-1', { item: { id: 'task-1' } }],
    ['/v1/tags', { items: [] }],
  ];
  for (const [path, expected] of cases) {
    const denied = await request(port, { path, headers: { Authorization: '' } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers['www-authenticate'], 'Bearer');
    const res = await request(port, { path });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, expected);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal(calls.length, 4);
});

test('bearer comparison is exact and duplicate authentication is rejected', async (t) => {
  const { port, calls } = await fixture(t);
  for (const auth of ['', `bearer ${apiKey}`, `Basic ${apiKey}`, `Bearer ${randomBytes(32).toString('base64url')}`, `${authorization}x`, `Bearer  ${apiKey}`]) {
    assert.equal((await request(port, { headers: { Authorization: auth } })).status, 401);
  }
  const missing = await rawRequest(port, [`Host: 127.0.0.1:${port}`]);
  assert.match(missing, /^HTTP\/1\.1 401 /);
  const duplicate = await rawRequest(port, [`Host: 127.0.0.1:${port}`, `Authorization: ${authorization}`, `Authorization: ${authorization}`]);
  assert.match(duplicate, /^HTTP\/1\.1 401 /);
  assert.equal(calls.length, 0);
});

test('Host permits only exact loopback names with the configured actual port', async (t) => {
  const { port, calls } = await fixture(t);
  for (const host of ['attacker.invalid', `attacker.invalid:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `LOCALHOST:${port}`, `[::1]:${port}`, `127.0.0.1:${port}.evil`, `user@localhost:${port}`]) {
    assert.equal((await request(port, { headers: { Host: host } })).status, 403);
  }
  const duplicate = await rawRequest(port, [`Host: 127.0.0.1:${port}`, `Host: localhost:${port}`, `Authorization: ${authorization}`]);
  assert.match(duplicate, /^HTTP\/1\.1 403 /);
  const missing = await rawRequest(port, [`Authorization: ${authorization}`]);
  assert.match(missing, /^HTTP\/1\.1 (400|403) /);
  assert.equal(calls.length, 0);
  assert.equal((await request(port, { headers: { Host: `localhost:${port}` } })).status, 200);
});

test('every Origin is forbidden and only absent or none Sec-Fetch-Site is accepted', async (t) => {
  const { port, calls } = await fixture(t);
  for (const origin of ['', 'null', `http://127.0.0.1:${port}`, 'https://attacker.invalid']) {
    const res = await request(port, { headers: { Origin: origin } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  for (const site of ['', 'same-origin', 'same-site', 'cross-site', 'None']) {
    assert.equal((await request(port, { headers: { 'Sec-Fetch-Site': site } })).status, 403);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request(port, { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
});

test('writes, HEAD and preflight return 405 without reaching the service', async (t) => {
  const { port, calls } = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    for (const path of ['/v1/tasks', '/v1/not-a-route']) {
      const res = await request(port, { path, method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.allow, 'GET');
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  }
  assert.equal(calls.length, 0);
  assert.equal((await request(port, { method: 'POST', headers: { Authorization: '' } })).status, 401);
});

test('URL query values are decoded strings without transport coercion', async (t) => {
  const { port, calls } = await fixture(t);
  const query = { q: '日程 + &', from: '2026-11-05T00:00:00+08:00', to: 'raw', status: 'unknown', tag_id: 'tag-1', unscheduled: 'false', limit: '003', offset: '-1', timezone: 'Asia/Shanghai' };
  const response = await request(port, { path: `/v1/tasks?${new URLSearchParams(query)}` });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['listTasks', query]]);
  assert.equal((await request(port, { path: '/v1/tasks/%74ask-1' })).status, 200);
  assert.deepEqual(calls[1], ['getTask', 'task-1']);
});

test('unknown and duplicate query parameters never reach the service', async (t) => {
  const { port, calls } = await fixture(t);
  for (const path of ['/v1/tasks?unknown=x', '/v1/tasks?status=open&status=all', '/v1/tasks?q=a&%71=b', '/v1/tasks?__proto__=x', '/v1/tasks?constructor=x', '/v1/tags?limit=2', '/v1/connection?q=x', '/v1/tasks/task-1?offset=0']) {
    assert.equal((await request(port, { path })).status, 400, path);
  }
  assert.equal(calls.length, 0);
});

test('invalid encodings, ambiguous identifiers, unknown routes and long URIs fail closed', async (t) => {
  const { port, calls } = await fixture(t);
  for (const path of ['/v1/tasks/%', '/v1/tasks/%FF', '/v1/tasks/%C0%AF', '/v1/tasks/a%2Fb', '/v1/tasks/a/b', '/v1/tasks/%5cfoo', '/v1/tasks/%2e%2e', '/v1/tasks/%00', '/v1/tasks?q=%ZZ', '/v1/tasks?q=%FF', '/v1/tasks#fragment', '//attacker.invalid/v1/tasks', 'http://attacker.invalid/v1/tasks']) {
    assert.equal((await request(port, { path })).status, 400, path);
  }
  for (const path of ['/v1/unknown', '/v1/tasks/', '/v1/../v1/tasks', '/%76%31/tasks']) {
    assert.equal((await request(port, { path })).status, 404, path);
  }
  assert.equal((await request(port, { path: `/v1/tasks?q=${'x'.repeat(8200)}` })).status, 414);
  assert.equal(calls.length, 0);
});

test('GET bodies and headers beyond the limit cannot bypass request guards', async (t) => {
  const { port, calls } = await fixture(t);
  assert.equal((await request(port, { headers: { 'Content-Length': '2' }, body: '{}' })).status, 400);
  const many = [`Host: 127.0.0.1:${port}`, `Authorization: ${authorization}`, ...Array.from({ length: 65 }, (_, i) => `X-Header-${i}: value`), 'Origin: https://attacker.invalid'];
  assert.match(await rawRequest(port, many), /^HTTP\/1\.1 431 /);
  const invalid = await rawRequest(port, [`Host: 127.0.0.1:${port}`, `Authorization: ${authorization}`, 'X-Test: value'], '/v1/tasks/%FF');
  assert.match(invalid, /^HTTP\/1\.1 400 /);
  assert.equal(calls.length, 0);
});

test('safe service codes survive but arbitrary errors and messages never leak', async (t) => {
  let error;
  const { port } = await fixture(t, { listTasks: async () => { throw error; } });
  for (const value of [new Error(`secret=${apiKey}`), { code: 'ESECRET', status: 502, message: apiKey }, { code: 'INVALID_QUERY', status: 500, message: apiKey }]) {
    error = value;
    const res = await request(port, { path: '/v1/tasks' });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
    assert.equal(res.text.includes(apiKey), false);
  }
  error = Object.assign(new Error(apiKey), { code: 'INVALID_QUERY', status: 400 });
  const known = await request(port, { path: '/v1/tasks' });
  assert.equal(known.status, 400);
  assert.equal(known.body.error.code, 'INVALID_QUERY');
  assert.equal(known.text.includes(apiKey), false);
});

test('unserializable and missing service results produce safe internal failures', async (t) => {
  const cycle = {}; cycle.self = cycle;
  const { port } = await fixture(t, { connection: () => cycle, capabilities: () => undefined });
  for (const path of ['/v1/connection', '/v1/capabilities']) {
    const res = await request(port, { path });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  }
});

test('server request deadline bounds stalled service responses', async (t) => {
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const { port } = await fixture(t, { listTags: () => { started(); return new Promise(() => {}); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = request(port, { path: '/v1/tags' });
  await began;
  t.mock.timers.tick(20000);
  const res = await response;
  assert.equal(res.status, 504);
  assert.equal(res.body.error.code, 'REQUEST_TIMEOUT');
  assert.equal(res.headers['cache-control'], 'no-store');
  t.mock.timers.reset();
});

test('fetchBridge uses fixed loopback GETs and propagates only safe errors', async (t) => {
  const { port, calls } = await fixture(t, { getTask: async () => { throw { code: 'NOT_FOUND', status: 404, message: 'private notes' }; } });
  assert.deepEqual(await fetchBridge({ port, apiKey, path: '/v1/tasks', query: { q: 'hello', limit: '5' } }), { items: [{ id: 'task-1' }] });
  assert.deepEqual(calls, [['listTasks', { q: 'hello', limit: '5' }]]);
  await assert.rejects(fetchBridge({ port, apiKey, path: '/v1/tasks/missing' }), (error) => error instanceof Error && error.code === 'NOT_FOUND' && error.status === 404 && !error.message.includes('private'));
  for (const path of ['https://attacker.invalid/v1/tasks', '//attacker.invalid/v1/tasks', '/v1/tasks?x=y', '/v1/tasks#x', '/v1/tasks/%2f%2fattacker.invalid', '/v1/tasks/../connection']) {
    await assert.rejects(fetchBridge({ port, apiKey, path }));
  }
  await assert.rejects(fetchBridge({ port, apiKey, path: '/v1/tasks', query: { limit: 5 } }), { code: 'INVALID_QUERY' });
  await assert.rejects(fetchBridge({ port: '8788', apiKey, path: '/v1/tasks' }), { code: 'INVALID_CONFIGURATION' });
});

test('fetchBridge refuses redirects without sending credentials to their target', async (t) => {
  let redirectedRequests = 0;
  const destination = http.createServer((req, res) => { redirectedRequests++; res.end('{}'); });
  const targetPort = await listen(t, destination);
  const source = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, authorization);
    assert.equal(req.headers.host, `127.0.0.1:${source.address().port}`);
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/steal` });
    res.end();
  });
  const port = await listen(t, source);
  await assert.rejects(fetchBridge({ port, apiKey, path: '/v1/connection' }), { code: 'BRIDGE_REDIRECT', status: 502 });
  assert.equal(redirectedRequests, 0);
});

test('fetchBridge rejects non-JSON data and times out a stalled local response', async (t) => {
  const malformed = http.createServer((req, res) => { res.end('secret upstream body'); });
  const malformedPort = await listen(t, malformed);
  await assert.rejects(fetchBridge({ port: malformedPort, apiKey, path: '/v1/tasks' }), { code: 'INVALID_BRIDGE_RESPONSE', status: 502 });
  const stalled = http.createServer(() => {});
  const port = await listen(t, stalled);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested = once(stalled, 'request');
  const promise = fetchBridge({ port, apiKey, path: '/v1/tasks' });
  await requested;
  const rejection = assert.rejects(promise, { code: 'BRIDGE_TIMEOUT', status: 504 });
  t.mock.timers.tick(25000);
  await rejection;
  t.mock.timers.reset();
});
