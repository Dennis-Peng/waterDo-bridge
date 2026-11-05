import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createHttpServer, fetchBridge } from '../src/http.mjs';
import { MutationService, validateMutation } from '../src/mutations.mjs';
import { normalizeTag } from '../src/core.mjs';

const apiKey = randomBytes(32).toString('base64url');
const writeKey = randomBytes(32).toString('base64url');
const requestId = '12345678-1234-4234-8234-123456789abc';
const input = { request_id: requestId, action: 'create', changes: { title: 'Synthetic task', due_at: null } };
const operation = { request_id: requestId, action: 'create', state: 'succeeded', task_id: 'test-task',
  result_version: 'a'.repeat(64), created_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-05T00:00:00.000Z', error_code: null, warnings: [] };
const advanced = { recurrence: 'implemented_not_account_tested', complete: 'implemented_not_account_tested',
  reminder_settings: 'implemented_not_account_tested', tag_update: 'implemented_not_account_tested' };
const warnings = [
  '仅支持基础重复规则（Asia/Shanghai）；提醒仅存储开关与到期时刻，delivery_verified=false，未验收手机通知送达。',
  '重复完成先完成原项再创建下一项，非事务；仅推进一期，不自动跳过历史期数。',
  'weekdays仅指周一至周五，不含法定节假日或调休；桥接保留Asia/Shanghai同一时分秒，与网页本周分支可能归零到午夜的行为不同。',
  'monthly逐实例以当前日期推进，月底不足则clamp到月底，可能发生31日→28日→28日漂移；不自动恢复原月底锚点。',
  '上游没有条件写入保证；版本核对与写入间仍存在并发窗口，列表完整性未经验证。',
  '结果未知时不得换请求 ID 重发；相同请求 ID 仅查询或回放原操作。',
];

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return server.address().port;
}

async function fixture(t, { mutations = {}, config = {}, reads = {} } = {}) {
  const calls = [];
  const mutationService = {
    mutate: async (value) => { calls.push(['mutate', value]); return operation; },
    getOperation: async (id) => { calls.push(['getOperation', id]); return operation; },
    status: () => ({ writes_blocked: false, blocking_request_id: null }),
    ...mutations,
  };
  const service = {
    connection: () => ({ read_only: true, service_mode: 'read-only', writes_enabled: false, access: 'read', writes_available: false }),
    capabilities: () => ({ read_only: true, writes: 'disabled' }),
    listTasks: async () => ({ items: [] }), getTask: async (id) => ({ item: { id } }), listTags: async () => ({ items: [] }),
    ...reads,
  };
  const server = createHttpServer({ service, apiKey, writeKey, mutationService, port: 0, ...config });
  return { server, port: await listen(t, server), calls };
}

function request(port, { path = '/v1/operations', method = 'POST', key = writeKey, headers = {}, body = JSON.stringify(input) } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { Authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body ?? '') } : {}), ...headers },
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
    req.end(method === 'GET' ? undefined : body);
  });
}

function rawRequest(port, extra, body = '{}') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    socket.on('connect', () => socket.end(`POST /v1/operations HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${writeKey}\r\n${extra.join('\r\n')}\r\nConnection: close\r\n\r\n${body}`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
  });
}

test('write credentials are distinct strong keys and opt-in needs both service and key', async (t) => {
  for (const key of [apiKey, 'weak', 'a'.repeat(43)]) {
    assert.throws(() => createHttpServer({ service: {}, apiKey, writeKey: key }), { code: 'INVALID_CONFIGURATION' });
  }
  assert.throws(() => createHttpServer({ service: {}, apiKey, writeKey, mutationService: {} }), { code: 'INVALID_CONFIGURATION' });
  for (const config of [{ mutationService: null }, { writeKey: null }, { mutationService: null, writeKey: null }]) {
    const { port, calls } = await fixture(t, { config });
    const res = await request(port, { key: apiKey });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'WRITES_DISABLED');
    assert.equal(calls.length, 0);
    if (config.mutationService === null && config.writeKey !== null) {
      assert.equal((await request(port, { method: 'GET', path: '/v1/tasks', key: writeKey })).status, 200);
      const writeDenied = await request(port, { key: writeKey });
      assert.equal(writeDenied.body.error.code, 'WRITES_DISABLED');
    }
  }
});

test('read credentials never mutate; write credentials also read all existing routes', async (t) => {
  const { port, calls } = await fixture(t);
  const denied = await request(port, { key: apiKey });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'WRITE_AUTH_REQUIRED');
  assert.equal((await request(port, { key: randomBytes(32).toString('base64url') })).status, 401);
  assert.equal(calls.length, 0);
  assert.deepEqual((await request(port)).body, operation);
  assert.deepEqual(calls, [['mutate', input]]);
  for (const key of [apiKey, writeKey]) {
    for (const path of ['/v1/connection', '/v1/capabilities', '/v1/tasks', '/v1/tasks/task-1', '/v1/tags', `/v1/operations/${requestId}`]) {
      assert.equal((await request(port, { method: 'GET', path, key })).status, 200);
    }
  }
});

test('connection and capabilities coordinate service mode, caller access and safe mutation status', async (t) => {
  let blocked = false;
  const { port } = await fixture(t, { mutations: { status: () => ({ writes_blocked: blocked, blocking_request_id: blocked ? requestId : null, secret: writeKey }) } });
  for (const key of [apiKey, writeKey]) {
    for (const path of ['/v1/connection', '/v1/capabilities']) {
      const res = await request(port, { method: 'GET', path, key });
      assert.equal(res.body.service_mode, 'read-write');
      assert.equal(res.body.access, key === writeKey ? 'write' : 'read');
      assert.equal(res.body.read_only, key !== writeKey);
      assert.equal(res.body.writes_enabled, true);
      assert.equal(res.body.writes_available, key === writeKey);
      assert.equal(res.body.writes_blocked, false);
      assert.deepEqual(res.body.advanced, advanced);
      assert.equal(res.body.reminder_delivery, false);
      assert.equal(res.text.includes(writeKey), false);
    }
  }
  blocked = true;
  const res = await request(port, { method: 'GET', path: '/v1/connection' });
  assert.equal(res.body.writes_available, false);
  assert.equal(res.body.blocking_request_id, requestId);
});

test('advanced capability merge distinguishes implementation from access and account acceptance', async (t) => {
  for (const config of [{}, { mutationService: null, writeKey: null }]) {
    const existing = { mode: 'demo', read_only: true, writes_enabled: false, writes_available: false,
      writes: 'disabled', reminder_delivery: true, mobile_sync_verified: false, account_identity_verified: false,
      advanced: { unrelated_read: 'unverified', complete: 'account_tested' } };
    const { port } = await fixture(t, { config, reads: { connection: () => existing, capabilities: () => existing } });
    for (const path of ['/v1/connection', '/v1/capabilities']) {
      const res = await request(port, { method: 'GET', path, key: apiKey });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.advanced, { ...advanced, unrelated_read: 'unverified' });
      assert.equal(res.body.mode, 'demo');
      assert.equal(res.body.read_only, true);
      assert.equal(res.body.writes_available, false);
      assert.equal(res.body.writes_enabled, config.mutationService !== null);
      assert.equal(res.body.reminder_delivery, false);
      assert.equal(res.body.mobile_sync_verified, false);
      assert.equal(res.body.account_identity_verified, false);
      assert.doesNotMatch(res.text, /"account_tested"/);
    }
    assert.equal(existing.advanced.complete, 'account_tested');
    assert.equal(existing.reminder_delivery, true);
  }
});

test('advanced mutation POST forwards explicit fields and projects complete/tag_update metadata only', async (t) => {
  const calls = [];
  let result;
  const { port } = await fixture(t, { mutations: {
    mutate: async (value) => { calls.push(value); return result; }, getOperation: async () => result,
  } });
  const target = { request_id: requestId, task_id: 'test-task', expected_version: operation.result_version };
  const cases = [
    { request_id: requestId, action: 'create', changes: { title: 'Synthetic', recurrence: 'weekdays', reminder_enabled: true, tag_id: 'test-tag', due_at: '2026-11-06T09:00:00+08:00' } },
    { ...target, action: 'update', changes: { recurrence: 'none', reminder_enabled: false, tag_id: null } },
    { ...target, action: 'complete' },
    { request_id: requestId, action: 'tag_update', tag_id: 'test-tag', expected_version: operation.result_version, changes: { name: 'Synthetic tag', color_id: 10 } },
  ];
  for (const value of cases) {
    const expected = { ...operation, action: value.action, task_id: value.action === 'tag_update' ? 'test-tag' : 'test-task', warnings };
    result = { ...expected, request_hash: 'secret-hash', changes: value.changes, tag_id: 'secret-tag',
      resource_type: 'secret-resource', title: 'secret-title', notes: 'secret-notes', token: writeKey,
      warnings: [...warnings, warnings[0], 'secret-warning', '仅支持普通未完成、非重复、未启用提醒的任务；日期是上游时间戳，不代表提醒或全天事件。'] };
    const posted = await fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: value });
    assert.deepEqual(posted, expected);
    assert.deepEqual(calls.at(-1), value);
    const readback = await request(port, { method: 'GET', path: `/v1/operations/${requestId}`, key: apiKey });
    assert.deepEqual(readback.body, expected);
    assert.equal(readback.text.includes('secret'), false);
    assert.equal(readback.text.includes(writeKey), false);
  }
  assert.equal(calls.length, cases.length);
});

test('HTTP applies current mutation validation to invalid recurrence, reminder and tag colors', async (t) => {
  let dispatched = 0;
  const { port } = await fixture(t, { mutations: { mutate: async (value) => {
    validateMutation(value); dispatched++; return { ...operation, action: value.action };
  } } });
  const update = { request_id: requestId, action: 'tag_update', tag_id: 'tag-1', expected_version: operation.result_version };
  const bad = [
    ...['custom', 'Daily', null, 50331649].map((recurrence) => ({ ...input, changes: { ...input.changes, recurrence } })),
    ...['true', null, 1].map((reminder_enabled) => ({ ...input, changes: { ...input.changes, reminder_enabled } })),
    { ...input, changes: { title: 'Synthetic', reminder_enabled: true } },
    { ...input, changes: { title: 'Synthetic', recurrence: 'daily' } },
    ...[0, 11, 12, 13, '1', true, null, 1.5].map((color_id) => ({ ...update, changes: { color_id } })),
    { ...update, changes: {} }, { ...update, changes: { name: '   ' } },
  ];
  for (const value of bad) {
    const res = await request(port, { body: JSON.stringify(value) });
    assert.equal(res.status, 400, JSON.stringify(value));
    assert.equal(res.body.error.code, 'INVALID_MUTATION');
  }
  assert.equal(dispatched, 0);
  for (const color_id of [1, 10]) {
    assert.equal((await request(port, { body: JSON.stringify({ ...update, changes: { color_id } }) })).status, 200);
  }
  assert.equal(dispatched, 2);
});

test('HTTP projects current MutationService warnings and advanced actions with synthetic transport only', async (t) => {
  const copy = (value) => structuredClone(value);
  const records = new Map(), tasks = new Map();
  const tag = { id: 42, name: 'Synthetic private tag', color_id: 1, is_deleted: false };
  const tags = new Map([['42', tag]]);
  const service = new MutationService({
    store: { list: () => [...records.values()].map(copy), get: (id) => copy(records.get(id) ?? null),
      append: (record) => records.set(record.request_id, copy(record)) },
    transport: {
      getTasks: async () => [...tasks.values()].map(copy), getTask: async (id) => copy(tasks.get(id)),
      createTask: async (payload) => { const row = { ...copy(payload), id: 99 }; tasks.set('99', row); return copy(row); },
      updateTask: async (id, payload) => { tasks.set(id, copy(payload)); return copy(payload); }, deleteTask: async (id) => tasks.delete(id),
      getTags: async () => [...tags.values()].map(copy), getTag: async (id) => copy(tags.get(id)),
      updateTag: async (id, payload) => { tags.set(id, copy(payload)); return copy(payload); },
    },
  });
  const { port } = await fixture(t, { config: { mutationService: service } });
  const create = { request_id: requestId, action: 'create', changes: { title: 'Synthetic private task',
    due_at: '2026-11-06T09:00:00+08:00', recurrence: 'none', reminder_enabled: true, tag_id: '42' } };
  const created = await fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: create });
  assert.equal(created.state, 'succeeded');
  assert.deepEqual(created.warnings, warnings);
  assert.equal(tasks.get('99').tag_id, 42);
  const done = await fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: {
    request_id: '22345678-1234-4234-8234-123456789abc', action: 'complete', task_id: created.task_id, expected_version: created.result_version,
  } });
  assert.equal(done.action, 'complete'); assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.warnings, warnings);
  const updated = await fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: {
    request_id: '32345678-1234-4234-8234-123456789abc', action: 'tag_update', tag_id: '42',
    expected_version: normalizeTag(tag).version, changes: { color_id: 10 },
  } });
  assert.equal(updated.action, 'tag_update'); assert.equal(updated.task_id, '42'); assert.equal(updated.state, 'succeeded');
  assert.equal(tags.get('42').color_id, 10);
  const metadata = await fetchBridge({ port, apiKey, path: `/v1/operations/${updated.request_id}` });
  assert.deepEqual(metadata, updated);
  assert.deepEqual(metadata.warnings, warnings);
  assert.equal(JSON.stringify([created, done, metadata]).includes('Synthetic private'), false);
});

test('operation metadata rejects unsupported actions and never echoes unsafe advanced errors', async (t) => {
  let result = { ...operation, action: 'tag_delete', warnings };
  let thrown;
  const { port } = await fixture(t, { mutations: {
    getOperation: async () => result,
    mutate: async () => { if (thrown) throw thrown; return result; },
  } });
  for (const action of ['tag_create', 'tag_delete', 'complete-secret', null, {}]) {
    result = { ...operation, action, private: writeKey };
    for (const options of [{}, { method: 'GET', path: `/v1/operations/${requestId}` }]) {
      const res = await request(port, options);
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, 'INTERNAL_ERROR');
      assert.equal(res.text.includes(writeKey), false);
    }
  }
  for (const action of ['complete', 'tag_update']) {
    for (const code of ['INVALID_MUTATION', 'VERSION_CONFLICT', 'UNSUPPORTED_TASK', 'UPSTREAM_SCHEMA', 'WRITE_READBACK']) {
      const status = { INVALID_MUTATION: 400, VERSION_CONFLICT: 409, UNSUPPORTED_TASK: 422, UPSTREAM_SCHEMA: 502, WRITE_READBACK: 502 }[code];
      thrown = { code, status, message: 'secret-advanced-input' };
      const res = await request(port, { body: JSON.stringify({ ...input, action }) });
      assert.equal(res.status, status);
      assert.equal(res.body.error.code, code);
      assert.equal(res.text.includes('secret-advanced-input'), false);
    }
  }
});

test('operation routes are canonical UUIDv4, query-free, and metadata only', async (t) => {
  const leaked = { ...operation, request_hash: 'private-hash', title: 'private title', notes: 'private notes', token: writeKey, warnings: ['private warning'] };
  const { port, calls } = await fixture(t, { mutations: { getOperation: async () => leaked, mutate: async () => leaked } });
  for (const id of ['', 'not-uuid', requestId.toUpperCase(), requestId.replace('-4', '-1'), `%31${requestId.slice(1)}`, `${requestId}/extra`]) {
    const res = await request(port, { method: 'GET', path: `/v1/operations/${id}`, key: apiKey });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_MUTATION');
  }
  for (const path of ['/v1/operations?', '/v1/operations?q=x', `/v1/operations/${requestId}?`]) {
    const res = await request(port, { path, method: path.includes(requestId) ? 'GET' : 'POST' });
    assert.equal(res.status, 400);
  }
  assert.equal(calls.length, 0);
  for (const options of [{}, { method: 'GET', path: `/v1/operations/${requestId}`, key: apiKey }]) {
    const res = await request(port, options);
    assert.deepEqual(res.body, operation);
    assert.equal(res.text.includes('private'), false);
    assert.equal(res.text.includes(writeKey), false);
  }
});

test('operation results preserve only static warnings and safe outcome codes', async (t) => {
  const knownWarning = '上游没有条件写入保证；版本核对与写入间仍存在并发窗口，列表完整性未经验证。';
  let result = { ...operation, warnings: [knownWarning, 'secret-warning'] };
  const { port } = await fixture(t, { mutations: { getOperation: async () => result } });
  let res = await request(port, { method: 'GET', path: `/v1/operations/${requestId}` });
  assert.deepEqual(res.body.warnings, [knownWarning]);
  for (const code of ['WRITE_UNKNOWN', 'WRITE_READBACK', 'WRITE_TIMEOUT']) {
    result = { ...operation, state: 'unknown', error_code: code };
    res = await request(port, { method: 'GET', path: `/v1/operations/${requestId}` });
    assert.equal(res.body.error_code, code);
    assert.match(res.body.warnings[0], /not confirmed/);
  }
  result = { ...operation, state: 'failed', error_code: 'secret-error-code' };
  res = await request(port, { method: 'GET', path: `/v1/operations/${requestId}` });
  assert.equal(res.body.error_code, 'INTERNAL_ERROR');
  assert.equal(res.text.includes('secret'), false);
});

test('POST requires exact media type and refuses all encodings and browser origins', async (t) => {
  const { port, calls } = await fixture(t);
  for (const headers of [{ 'Content-Type': '' }, { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=utf-8' }, { 'Content-Type': 'Application/JSON' }, { 'Content-Encoding': 'gzip' }, { 'Content-Encoding': 'identity' }]) {
    assert.equal((await request(port, { headers })).status, 415);
  }
  for (const origin of ['', 'null', `http://127.0.0.1:${port}`, 'https://attacker.invalid']) {
    const res = await request(port, { headers: { Origin: origin } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'attacker.invalid' }]) {
    assert.equal((await request(port, { headers })).status, 403);
  }
  assert.equal((await request(port, { method: 'OPTIONS', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal(calls.length, 0);
});

test('POST rejects missing, duplicated, chunked, and otherwise ambiguous headers', async (t) => {
  const { port, calls } = await fixture(t);
  const headers = [
    ['Content-Type: application/json'],
    ['Content-Type: application/json', 'Content-Length: 02'],
    ['Content-Type: application/json', 'Content-Length: 2', 'Content-Length: 2'],
    ['Content-Type: application/json', 'Content-Type: application/json', 'Content-Length: 2'],
    ['Content-Type: application/json', 'Content-Length: 2', 'X-Extra: a', 'X-Extra: b'],
    ['Content-Type: application/json', 'Transfer-Encoding: chunked'],
    ['Content-Type: application/json', 'Content-Length: 2', 'Transfer-Encoding: chunked'],
    ['Content-Type: application/json', 'Content-Length: 2', 'Expect: 100-continue'],
    ['Content-Type: application/json', 'Content-Length: 2', 'Trailer: x-secret'],
  ];
  for (const extra of headers) {
    const res = await rawRequest(port, extra);
    assert.match(res, /^HTTP\/1\.1 400 /, extra.join(', '));
    assert.doesNotMatch(res, /100 Continue/);
  }
  assert.equal(calls.length, 0);
});

test('POST accepts exactly 64KiB but rejects larger, malformed UTF-8 and nonobject JSON', async (t) => {
  const { port, calls } = await fixture(t);
  for (const body of ['', '{', '[]', 'null', '42', '"text"', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
    const res = await request(port, { body });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_MUTATION');
  }
  const exact = JSON.stringify({ x: 'x'.repeat(65536 - 8) });
  assert.equal(Buffer.byteLength(exact), 65536);
  assert.equal((await request(port, { body: exact })).status, 200);
  assert.equal((await request(port, { body: exact + ' ' })).status, 413);
  // Node rejects integer-overflow framing before the application sees it.
  assert.equal((await request(port, { headers: { 'Content-Length': '999999999999999999999999999' }, body: '' })).status, 400);
  assert.equal(calls.length, 1);
});

test('POST deadline is 120s and an expired partial body never dispatches late writes', async (t) => {
  const { port, server, calls } = await fixture(t);
  assert.equal(server.requestTimeout, 120000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = once(server, 'request');
  const socket = net.connect({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  socket.on('error', () => {});
  const closed = once(socket, 'close');
  await once(socket, 'connect');
  socket.write(`POST /v1/operations HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${writeKey}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{`);
  await received;
  t.mock.timers.tick(119999);
  assert.equal(calls.length, 0);
  assert.equal(chunks.length, 0);
  t.mock.timers.tick(1);
  socket.write('}');
  await closed;
  assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 504 /);
  assert.equal(calls.length, 0);
  t.mock.timers.reset();
});

test('disconnecting an incomplete body never dispatches mutations', async (t) => {
  const { port, server, calls } = await fixture(t);
  const received = once(server, 'request');
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`POST /v1/operations HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${writeKey}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{`);
  const [incoming] = await received;
  const aborted = once(incoming, 'aborted');
  socket.destroy();
  await aborted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('in-flight mutation is not retried after a deadline and GET still has its old deadline', async (t) => {
  let resolveMutation;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  let count = 0;
  const { port } = await fixture(t, { mutations: { mutate: () => { count++; started(); return new Promise((resolve) => { resolveMutation = resolve; }); } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = request(port);
  await began;
  t.mock.timers.tick(119999);
  assert.equal(count, 1);
  t.mock.timers.tick(1);
  const res = await response;
  assert.equal(res.status, 504);
  assert.match(res.body.error.message, /unknown/);
  resolveMutation(operation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 1);
  t.mock.timers.reset();
  let tagsStarted;
  const tagsBegan = new Promise((resolve) => { tagsStarted = resolve; });
  const read = await fixture(t, { reads: { listTags: () => { tagsStarted(); return new Promise(() => {}); } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const get = request(read.port, { method: 'GET', path: '/v1/tags', key: apiKey });
  await tagsBegan;
  t.mock.timers.tick(20000);
  assert.equal((await get).status, 504);
  t.mock.timers.reset();
});

test('fetchBridge POST uses strict fixed-loopback framing and preserves safe write errors', async (t) => {
  const { port, calls } = await fixture(t);
  assert.deepEqual(await fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: input }), operation);
  assert.deepEqual(calls, [['mutate', input]]);
  await assert.rejects(fetchBridge({ port, apiKey, path: '/v1/operations', method: 'POST', body: input }), { code: 'WRITE_AUTH_REQUIRED', status: 403 });
  for (const options of [{ path: '/v1/tasks' }, { path: '/v1/operations?' }, { path: `http://127.0.0.1:${port}/v1/operations` }, { query: { q: 'x' } }, { body: [] }, { method: 'DELETE' }]) {
    await assert.rejects(fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: input, ...options }));
  }
  await assert.rejects(fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: { notes: 'x'.repeat(65536) } }), { code: 'PAYLOAD_TOO_LARGE' });
  await assert.rejects(fetchBridge({ port, apiKey, path: '/v1/tasks', body: {} }), { code: 'INVALID_REQUEST' });
});

test('HTTP and client expose static operation/store/transport errors without secrets', async (t) => {
  let error;
  const { port } = await fixture(t, { mutations: { mutate: () => { throw error; } } });
  for (const [code, status] of [['INVALID_MUTATION', 400], ['NO_CHANGES', 400], ['UNSUPPORTED_TASK', 422], ['VERSION_CONFLICT', 409], ['IDEMPOTENCY_CONFLICT', 409], ['WRITES_BLOCKED', 409], ['OPERATION_BUSY', 409], ['OPERATION_NOT_FOUND', 404], ['OPERATION_STORE', 503], ['ACCOUNT_BINDING_CHANGED', 409], ['SELF_TEST_REJECTED', 422], ['SELF_TEST_WRITE_UNKNOWN', 502], ['WRITE_UNKNOWN', 502], ['WRITE_READBACK', 502], ['WRITE_TIMEOUT', 504]]) {
    error = { code, status, message: `secret-${writeKey}` };
    await assert.rejects(fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: input }), (value) => value.code === code && value.status === status && !value.message.includes(writeKey));
  }
  for (const value of [{ code: 'VERSION_CONFLICT', status: 500, message: writeKey }, new Error(writeKey), { code: writeKey, status: 500 }]) {
    error = value;
    const res = await request(port);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.equal(res.text.includes(writeKey), false);
  }
});

test('POST client has 125s timeout, no redirect following and no automatic retry', async (t) => {
  let requests = 0;
  const server = http.createServer(() => { requests++; });
  const port = await listen(t, server);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = once(server, 'request');
  const pending = fetchBridge({ port, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: input });
  const rejected = assert.rejects(pending, (error) => error.code === 'BRIDGE_TIMEOUT' && /unknown/.test(error.message));
  await received;
  t.mock.timers.tick(124999);
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(requests, 1);
  t.mock.timers.reset();
  let targetCalls = 0;
  const target = http.createServer((req, res) => { targetCalls++; res.end('{}'); });
  const targetPort = await listen(t, target);
  const redirect = http.createServer((req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/v1/operations` }); res.end(); });
  const redirectPort = await listen(t, redirect);
  await assert.rejects(fetchBridge({ port: redirectPort, apiKey: writeKey, path: '/v1/operations', method: 'POST', body: input }), { code: 'BRIDGE_REDIRECT' });
  assert.equal(targetCalls, 0);
});
