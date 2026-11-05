import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { BridgeError, UPSTREAM, WaterDoAdapter } from '../src/core.mjs';
import { SelfTestTransport } from '../src/self-test-transport.mjs';

const TOKEN = 'synthetic-self-test-token';
const SECRET = 'synthetic-upstream-private-detail';
const MAX_BYTES = 8 * 1024 * 1024;
const row = (changes = {}) => ({ id: 'temporary_1', title: '合成专用临时任务', memo: '仅合成数据',
  series_id: 'synthetic-series', task_due_at: '2026-11-06T09:00:00+08:00', task_done_at: null,
  is_deleted: false, is_remind_enabled: false, repeating_pattern: 0, ...changes });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const mockTransport = fetchImpl => new SelfTestTransport(TOKEN, { fetchImpl });
const actions = [
  ['create', transport => transport.createTask(row())],
  ['update', transport => transport.updateTask('temporary_1', row())],
  ['delete', transport => transport.deleteTask('temporary_1')],
];
function safeError(code, status) {
  return error => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    for (const exposed of [error.message, error.stack, JSON.stringify(error), inspect(error)]) {
      assert.ok(!exposed.includes(TOKEN));
      assert.ok(!exposed.includes(SECRET));
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('self-test transport fixes TLS origin, routes, auth, methods, query and snake_case body', async () => {
  const calls = [];
  const original = row();
  const changed = row({ title: '合成修改', task_due_at: '2026-11-07T10:30:00+08:00' });
  const replies = [response({ tasks: [original] }), response(original), response(original, 201), response(changed), new Response(null, { status: 204 })];
  const transport = mockTransport(async (url, options) => { calls.push([url, options]); return replies.shift(); });
  assert.deepEqual(await transport.getTasks(), [original]);
  assert.deepEqual(await transport.getTask('temporary_1'), original);
  assert.deepEqual(await transport.createTask(original), original);
  assert.deepEqual(await transport.updateTask('temporary_1', changed), changed);
  assert.deepEqual(await transport.deleteTask('temporary_1'), { deleted: true });
  assert.deepEqual(calls.map(([url, options]) => [url, options.method]), [
    [`${UPSTREAM}/tasks/all`, 'GET'], [`${UPSTREAM}/tasks/temporary_1`, 'GET'],
    [`${UPSTREAM}/tasks?sem_ver=2.13.0`, 'POST'], [`${UPSTREAM}/tasks/temporary_1?sem_ver=2.13.0`, 'PUT'],
    [`${UPSTREAM}/tasks/temporary_1`, 'DELETE'],
  ]);
  for (const [url, options] of calls) {
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(new URL(url).host, 'water-web-china.upwardsware.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.headers['X-Auth-Token'], TOKEN);
    assert.equal(options.headers.Accept, 'application/json');
    if (['POST', 'PUT'].includes(options.method)) assert.equal(options.headers['Content-Type'], 'application/json');
    else { assert.ok(!Object.hasOwn(options, 'body')); assert.ok(!Object.hasOwn(options.headers, 'Content-Type')); }
  }
  assert.deepEqual(JSON.parse(calls[2][1].body), { task: original });
  assert.deepEqual(JSON.parse(calls[3][1].body), { task: changed });
  assert.equal(Object.hasOwn(JSON.parse(calls[3][1].body).task, 'taskDueAt'), false);
});

test('tag lookup uses the observed list endpoint and updates only the pinned tag', async () => {
  const calls = [], tag = { id: 7, name: 'Synthetic tag', color_id: 4, is_deleted: false };
  const transport = mockTransport(async (url, options) => {
    calls.push({ url, options });
    return options.method === 'PUT' ? response(tag) : response({ tags: [tag] });
  });
  assert.deepEqual(await transport.getTags(), [tag]);
  assert.deepEqual(await transport.getTag('7'), tag);
  assert.deepEqual(await transport.updateTag('7', tag), tag);
  assert.equal(calls[1].url, `${UPSTREAM}/tags`);
  assert.equal(calls[2].url, `${UPSTREAM}/tags/7?sem_ver=2.13.0`);
  assert.deepEqual(JSON.parse(calls[2].options.body), { tag });
  await assert.rejects(transport.updateTag('8', tag), { code: 'INVALID_TASK' });
  await assert.rejects(transport.getTag('8'), { code: 'NOT_FOUND' });
});
test('numeric raw IDs remain raw while every path ID must be a strict string', async () => {
  const task = row({ id: 1793941200000 });
  const transport = mockTransport(async () => response(task));
  assert.equal((await transport.createTask(task)).id, task.id);
  assert.equal((await transport.getTask(String(task.id))).id, task.id);
  assert.equal((await transport.updateTask(String(task.id), task)).id, task.id);
  await assert.rejects(transport.getTask(task.id), safeError('INVALID_ID', 400));
  const assigned = mockTransport(async () => response(row()));
  assert.deepEqual(await assigned.createTask({ title: '合成服务器分配 ID' }), row());
  assert.equal((await assigned.createTask({ ...row(), id: 1793941200000 })).id, 'temporary_1');
});

test('only the standalone transport adds mutations and keeps its token private', async () => {
  assert.deepEqual(Object.getOwnPropertyNames(SelfTestTransport.prototype), [
    'constructor', 'invalid', 'getTasks', 'getTags', 'getTag', 'updateTag', 'getTask', 'createTask', 'updateTask', 'deleteTask',
  ]);
  assert.deepEqual(Object.getOwnPropertyNames(WaterDoAdapter.prototype), ['constructor', 'tasks', 'task', 'tags']);
  const transport = mockTransport(async () => response({ tasks: [] }));
  assert.deepEqual(Object.keys(transport), []);
  assert.equal(transport.invalid, false);
  assert.ok(!JSON.stringify(transport).includes(TOKEN));
  assert.ok(!inspect(transport, { showHidden: true }).includes(TOKEN));
  assert.throws(() => { transport.invalid = false; }, TypeError);
  for (const token of [undefined, null, '', 'short', 'with\nnewline', 'x'.repeat(8193)]) {
    assert.throws(() => new SelfTestTransport(token, { fetchImpl: () => assert.fail('must not fetch') }), { code: 'INVALID_TOKEN' });
  }
  assert.throws(() => new SelfTestTransport(TOKEN, { fetchImpl: null }), { code: 'INVALID_TRANSPORT' });
});

test('arbitrary URL/header overrides are ignored and unsafe IDs never reach fetch', async () => {
  let calls = 0;
  const transport = new SelfTestTransport(TOKEN, { baseUrl: 'http://untrusted.invalid', headers: { 'X-Auth-Token': 'wrong' },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, `${UPSTREAM}/tasks/all`);
      assert.equal(options.headers['X-Auth-Token'], TOKEN);
      return response({ tasks: [] });
    },
  });
  for (const id of ['../tasks', 'https://other.invalid', 'x?foo=bar', 'x#frag', 'x/y', '%2f', 'space id', '', 'a'.repeat(129), 1, null, {}, ['id']]) {
    await assert.rejects(transport.getTask(id), { code: 'INVALID_ID' });
    await assert.rejects(transport.updateTask(id, row()), { code: 'INVALID_ID' });
    await assert.rejects(transport.deleteTask(id), { code: 'INVALID_ID' });
  }
  assert.equal(calls, 0);
  await transport.getTasks();
  assert.equal(calls, 1);
});

test('write input must be a plain, serializable task and PUT body ID must match the path', async () => {
  let calls = 0;
  const transport = mockTransport(async () => { calls++; return response(row()); });
  const circular = {}; circular.task = circular;
  const throwing = { get id() { throw Error(SECRET); } };
  for (const task of [null, [], 'task', 123, new Date(), new (class Task {})(), Object.create({ id: 'temporary_1' }),
    { id: '../bad' }, { id: null }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: 1.5 },
    { title: 1n }, circular, throwing, { toJSON() { throw Error(SECRET); } }, { toJSON() { return []; } },
    { id: 'temporary_1', toJSON() { return { id: 'different' }; } }, { memo: 'x'.repeat(MAX_BYTES) }]) {
    await assert.rejects(transport.createTask(task), safeError('INVALID_TASK', 400));
    await assert.rejects(transport.updateTask('temporary_1', task), safeError('INVALID_TASK', 400));
  }
  for (const task of [{}, row({ id: 'other_task' }), { id: 'temporary_1', toJSON() { return {}; } }]) {
    await assert.rejects(transport.updateTask('temporary_1', task), safeError('INVALID_TASK', 400));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await transport.createTask(Object.assign(Object.create(null), row())), row());
  assert.equal(calls, 1);
});

test('GET requires tasks array and a raw object with a matching valid task ID', async () => {
  for (const body of [null, [], {}, { tasks: null }, { tasks: {} }, { data: { tasks: [] } }]) {
    const transport = mockTransport(async () => response(body));
    await assert.rejects(transport.getTasks(), safeError('UPSTREAM_SCHEMA', 502));
  }
  for (const body of [null, [], {}, { task: row() }, row({ id: 'different' }), row({ id: '../bad' }), row({ id: null }), row({ id: Number.MAX_SAFE_INTEGER + 1 })]) {
    const transport = mockTransport(async () => response(body));
    await assert.rejects(transport.getTask('temporary_1'), safeError('UPSTREAM_SCHEMA', 502));
  }
  assert.deepEqual(await mockTransport(async () => response({ tasks: [] })).getTasks(), []);
});

test('GET status errors are safe, distinct, and never retried', async () => {
  for (const [status, code, expectedStatus] of [
    [401, 'AUTH_EXPIRED', 401], [403, 'UPSTREAM_FORBIDDEN', 403], [404, 'NOT_FOUND', 404],
    [429, 'UPSTREAM_RATE_LIMIT', 429], [400, 'UPSTREAM_ERROR', 502], [422, 'UPSTREAM_ERROR', 502],
    [500, 'UPSTREAM_ERROR', 502], [503, 'UPSTREAM_ERROR', 502], [302, 'UPSTREAM_ERROR', 502],
  ]) {
    let calls = 0;
    const transport = mockTransport(async () => { calls++; return response({ error: `${TOKEN} ${SECRET}` }, status); });
    await assert.rejects(transport.getTasks(), safeError(code, expectedStatus));
    assert.equal(calls, 1);
  }
});

test('all write 4xx errors are known rejection, safely redacted, and never retried', async () => {
  for (const [, action] of actions) {
    for (const [status, code, expectedStatus] of [
      [401, 'AUTH_EXPIRED', 401], [403, 'UPSTREAM_FORBIDDEN', 403], [404, 'NOT_FOUND', 404],
      [429, 'UPSTREAM_RATE_LIMIT', 429], [400, 'SELF_TEST_REJECTED', 422],
      [409, 'SELF_TEST_REJECTED', 422], [422, 'SELF_TEST_REJECTED', 422],
    ]) {
      let calls = 0;
      const transport = mockTransport(async () => { calls++; return new Response(`${TOKEN} ${SECRET}`, { status }); });
      await assert.rejects(action(transport), safeError(code, expectedStatus));
      assert.equal(calls, 1);
    }
  }
});

test('401 permanently latches every read/write method on that instance', async () => {
  for (const trigger of [transport => transport.getTasks(), transport => transport.getTask('temporary_1'), ...actions.map(([, action]) => action)]) {
    let calls = 0;
    const transport = mockTransport(async () => { calls++; return response({ error: TOKEN }, 401); });
    await assert.rejects(trigger(transport), safeError('AUTH_EXPIRED', 401));
    assert.equal(transport.invalid, true);
    for (const action of [transport => transport.getTasks(), transport => transport.getTask('temporary_1'), ...actions.map(([, action]) => action)]) {
      await assert.rejects(action(transport), safeError('AUTH_EXPIRED', 401));
    }
    assert.equal(calls, 1);
  }
});

test('a concurrent successful request cannot clear the invalid latch', async () => {
  let release;
  const transport = mockTransport(async url => url.endsWith('/tasks/all')
    ? new Promise(resolve => { release = () => resolve(response({ tasks: [] })); })
    : response({}, 401));
  const pending = transport.getTasks();
  await assert.rejects(transport.deleteTask('temporary_1'), { code: 'AUTH_EXPIRED' });
  release();
  await pending;
  assert.equal(transport.invalid, true);
  await assert.rejects(transport.createTask(row()), { code: 'AUTH_EXPIRED' });
});

test('every write network failure, redirect, 5xx, or invalid body has one unknown-outcome error', async () => {
  const failures = [
    async () => { throw Error(`${TOKEN} ${SECRET}`); },
    async () => { throw undefined; },
    async () => { throw new BridgeError('SELF_TEST_REJECTED', SECRET, 422); },
    async () => response({ error: `${TOKEN} ${SECRET}` }, 500),
    async () => response({ error: `${TOKEN} ${SECRET}` }, 503),
    async () => response({}, 302, { Location: 'https://untrusted.invalid' }),
    async () => { const result = response(row()); Object.defineProperty(result, 'redirected', { value: true }); return result; },
    async () => new Response(`<html>${TOKEN} ${SECRET}</html>`),
    async () => new Response(`{"broken":"${SECRET}"`, { headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    async () => response(null), async () => response([]),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(Error(`${TOKEN} ${SECRET}`)); } }), { headers: { 'Content-Type': 'application/json' } }),
  ];
  const messages = new Set();
  for (const [, action] of actions) {
    for (const fail of failures) {
      let calls = 0;
      const transport = mockTransport(async (...args) => { calls++; return fail(...args); });
      await assert.rejects(action(transport), error => { messages.add(error.message); return safeError('SELF_TEST_WRITE_UNKNOWN', 502)(error); });
      assert.equal(calls, 1);
    }
  }
  assert.equal(messages.size, 1);
});

test('POST/PUT reject malformed replies; only PUT requires the original ID', async () => {
  for (const [name, action] of actions.slice(0, 2)) {
    for (const body of [{}, { task: row() }, { data: row() }, ...(name === 'update' ? [row({ id: 'other' })] : []), row({ id: null }), row({ id: '../bad' }), row({ id: Number.MAX_SAFE_INTEGER + 1 })]) {
      let calls = 0;
      const transport = mockTransport(async () => { calls++; return response(body); });
      await assert.rejects(action(transport), safeError('SELF_TEST_WRITE_UNKNOWN', 502));
      assert.equal(calls, 1);
    }
    for (const result of [new Response(null, { status: 204 }), new Response('')]) {
      await assert.rejects(action(mockTransport(async () => result)), safeError('SELF_TEST_WRITE_UNKNOWN', 502));
    }
  }
});

test('GET network, malformed body and fake BridgeError details cannot escape', async () => {
  for (const failure of [Error(`${TOKEN} ${SECRET}`), undefined, new BridgeError('UPSTREAM_SCHEMA', `${TOKEN} ${SECRET}`, 502)]) {
    let calls = 0;
    const transport = mockTransport(async () => { calls++; throw failure; });
    await assert.rejects(transport.getTasks(), safeError('UPSTREAM_NETWORK', 502));
    assert.equal(calls, 1);
  }
  for (const result of [new Response(SECRET), new Response('{bad json', { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }), new Response(null, { status: 204 })]) {
    await assert.rejects(mockTransport(async () => result).getTasks(), safeError('UPSTREAM_SCHEMA', 502));
  }
  const broken = mockTransport(async () => new Response(new ReadableStream({ start(controller) { controller.error(Error(SECRET)); } }), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(broken.getTasks(), safeError('UPSTREAM_NETWORK', 502));
});

test('DELETE accepts 204 and empty body without assuming JSON, plus bounded JSON object replies', async () => {
  for (const result of [new Response(null, { status: 204 }), new Response(''),
    new Response('', { headers: { 'Content-Type': 'text/plain' } }), response({}), response({ deleted: true }), response(row())]) {
    let calls = 0;
    assert.deepEqual(await mockTransport(async () => { calls++; return result; }).deleteTask('temporary_1'), { deleted: true });
    assert.equal(calls, 1);
  }
});

test('8 MiB response limit covers actual bytes, declared length, and DELETE/204 bodies', async () => {
  for (const [name, action] of [['get', transport => transport.getTasks()], ...actions]) {
    for (const declared of [false, true]) {
      let canceled = 0;
      const stream = new ReadableStream({
        start(controller) { if (!declared) controller.enqueue(new Uint8Array(MAX_BYTES + 1)); },
        cancel() { canceled++; },
      });
      const transport = mockTransport(async () => new Response(stream, { headers: {
        'Content-Type': 'application/json', ...(declared ? { 'Content-Length': String(MAX_BYTES + 1) } : {}),
      } }));
      await assert.rejects(action(transport), safeError(name === 'get' ? 'UPSTREAM_TOO_LARGE' : 'SELF_TEST_WRITE_UNKNOWN', 502));
      assert.equal(canceled, 1);
    }
  }
  // A malformed/mock 204 with a body is still constrained rather than accepted early.
  const transport = mockTransport(async () => ({ ok: true, status: 204, redirected: false, headers: new Headers(),
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BYTES + 1)); controller.close(); } }),
  }));
  await assert.rejects(transport.deleteTask('temporary_1'), safeError('SELF_TEST_WRITE_UNKNOWN', 502));
});

test('exactly 8 MiB is allowed and multibyte text is measured as bytes', async () => {
  const prefix = '{"tasks":[],"padding":"';
  const suffix = '"}';
  const exact = `${prefix}${'x'.repeat(MAX_BYTES - Buffer.byteLength(prefix + suffix))}${suffix}`;
  assert.equal(Buffer.byteLength(exact), MAX_BYTES);
  const transport = mockTransport(async () => new Response(exact, { headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual(await transport.getTasks(), []);
  const over = `${prefix}${'测'.repeat(Math.ceil(MAX_BYTES / 3))}${suffix}`;
  await assert.rejects(mockTransport(async () => new Response(over, { headers: { 'Content-Type': 'application/json' } })).getTasks(), safeError('UPSTREAM_TOO_LARGE', 502));
});

test('15-second timeout covers fetch even when a synthetic implementation ignores its signal', async t => {
  for (const [name, action] of [['get', transport => transport.getTasks()], ...actions]) {
    const controller = new AbortController();
    const durations = [];
    const timeout = t.mock.method(AbortSignal, 'timeout', ms => { durations.push(ms); return controller.signal; });
    let calls = 0;
    const transport = mockTransport(async (_url, options) => {
      calls++;
      assert.equal(options.signal, controller.signal);
      queueMicrotask(() => controller.abort(Error(SECRET)));
      return new Promise(() => {});
    });
    await assert.rejects(action(transport), safeError(name === 'get' ? 'UPSTREAM_NETWORK' : 'SELF_TEST_WRITE_UNKNOWN', 502));
    assert.deepEqual(durations, [15000]);
    assert.equal(calls, 1);
    timeout.mock.restore();
  }
});

test('timeout remains active during response streaming, including empty DELETE, without retry', async t => {
  for (const [name, action] of [['get', transport => transport.getTasks()], ...actions]) {
    const controller = new AbortController();
    const timeout = t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 15000); return controller.signal; });
    let canceled = 0;
    let calls = 0;
    const transport = mockTransport(async () => {
      calls++;
      return new Response(new ReadableStream({
        pull() { queueMicrotask(() => controller.abort(Error(SECRET))); return new Promise(() => {}); },
        cancel() { canceled++; return new Promise(() => {}); },
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } });
    });
    await assert.rejects(action(transport), safeError(name === 'get' ? 'UPSTREAM_NETWORK' : 'SELF_TEST_WRITE_UNKNOWN', 502));
    assert.equal(calls, 1);
    assert.equal(canceled, 1);
    timeout.mock.restore();
  }
});

test('uncooperative cancellation cannot hang a known 4xx failure', async () => {
  let canceled = 0;
  const transport = mockTransport(async () => new Response(new ReadableStream({
    cancel() { canceled++; return new Promise(() => {}); },
  }), { status: 401 }));
  await assert.rejects(transport.createTask(row()), safeError('AUTH_EXPIRED', 401));
  assert.equal(canceled, 1);
  assert.equal(transport.invalid, true);
});
