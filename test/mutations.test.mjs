import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../src/operation-store.mjs';
import { BridgeError, normalizeTask, normalizeTag } from '../src/core.mjs';
import { MutationService, validateMutation, validateRequestId } from '../src/mutations.mjs';
import { RECURRENCE_PATTERNS, shanghaiDate } from '../src/recurrence.mjs';

const copy = value => structuredClone(value);
const PRIVATE = 'synthetic private text never returned in metadata';
const row = (changes = {}) => ({ id: 8, title: PRIVATE, memo: 'synthetic notes', tag_id: null,
  task_due_at: null, task_done_at: null, done_date: null, is_deleted: false, is_restored: false,
  is_remind_enabled: false, repeating_pattern: 0, repeating_origin_id: null, ignore_expired: false,
  series_id: 'existing-series', sequence_num: 1, importance: 1, mystery: { nested: ['keep', 42] }, ...changes });
const tagRow = (changes = {}) => ({ id: 42, name: 'Synthetic tag', color_id: 3, is_deleted: false, mystery: { keep: [true] }, ...changes });
const canonical = v => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const version = raw => createHash('sha256').update(JSON.stringify(canonical(raw))).digest('hex');
class MemoryStore {
  records = new Map(); history = []; failAppend = 0;
  list() { return [...this.records.values()].map(copy); }
  get(id) { return copy(this.records.get(id) ?? null); }
  append(record) {
    if (++this.appends === this.failAppend) throw Error(PRIVATE);
    this.records.set(record.request_id, copy(record)); this.history.push(copy(record));
  }
  appends = 0;
}
function fixture(hooks = {}, store = new MemoryStore()) {
  const tasks = new Map([['8', row()]]), tags = new Map([['42', tagRow()]]), writes = [], reads = [];
  const pending = () => assert.ok(store.history.some(r => r.state === 'pending'));
  const transport = {
    async getTags() { reads.push(['tags']); return [...tags.values()].map(copy); },
    async getTag(id) {
      reads.push(['tag', id]);
      const result = await hooks.tag?.(id, tags, writes, reads);
      if (result !== undefined) return result;
      if (!tags.has(id)) throw new BridgeError('NOT_FOUND', PRIVATE, 404);
      return copy(tags.get(id));
    },
    async updateTag(id, payload) {
      pending(); writes.push(['tag_update', id, copy(payload)]);
      if (hooks.tagUpdate) return hooks.tagUpdate(id, payload, tags, writes);
      tags.set(id, copy(payload)); return copy(payload);
    },
    async getTasks() {
      reads.push(['list']);
      const result = await hooks.list?.(tasks, writes, reads);
      return result === undefined ? [...tasks.values()].map(copy) : result;
    },
    async getTask(id) {
      reads.push(['get', id]);
      const result = await hooks.get?.(id, tasks, writes, reads);
      if (result !== undefined) return result;
      if (!tasks.has(id)) throw new BridgeError('NOT_FOUND', PRIVATE, 404);
      return copy(tasks.get(id));
    },
    async createTask(payload) {
      pending(); writes.push(['create', copy(payload)]);
      if (hooks.create) return hooks.create(payload, tasks, writes);
      const raw = { ...copy(payload), id: 99, server_unknown: { keep: true } };
      tasks.set('99', raw); return copy(raw);
    },
    async updateTask(id, payload) {
      pending(); writes.push(['update', id, copy(payload)]);
      if (hooks.update) return hooks.update(id, payload, tasks, writes);
      tasks.set(id, copy(payload)); return copy(payload);
    },
    async deleteTask(id) {
      pending(); writes.push(['delete', id]);
      if (hooks.delete) return hooks.delete(id, tasks, writes);
      tasks.delete(id); return { deleted: true };
    },
  };
  const service = new MutationService({ transport, store });
  const create = (changes = {}, request_id = randomUUID()) => ({ request_id, action: 'create', changes: { title: ' Synthetic new task ', ...changes } });
  const update = (changes = { title: 'Synthetic edit' }, request_id = randomUUID(), task_id = '8') => ({ request_id,
    action: 'update', task_id, expected_version: normalizeTask(tasks.get(task_id)).version, changes });
  const remove = (request_id = randomUUID(), task_id = '8') => ({ request_id,
    action: 'delete', task_id, expected_version: normalizeTask(tasks.get(task_id)).version });
  const complete = (request_id = randomUUID(), task_id = '8') => ({ ...remove(request_id, task_id), action: 'complete' });
  const tagUpdate = (changes = { name: 'Renamed tag' }, request_id = randomUUID(), tag_id = '42') => ({ request_id,
    action: 'tag_update', tag_id, expected_version: version(tags.get(tag_id)), changes });
  return { service, transport, store, tasks, tags, writes, reads, create, update, remove, complete, tagUpdate };
}
const errorCode = code => e => e instanceof BridgeError && e.code === code && !e.message.includes(PRIVATE);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('validation returns independent normalized input with explicit dates and create defaults', () => {
  const id = randomUUID();
  const input = { request_id: id, action: 'create', changes: { title: ' title ', due_at: '2028-02-29T10:30:00+08:00' } };
  assert.equal(validateRequestId(id), id);
  assert.deepEqual(validateMutation(input), { request_id: id, action: 'create', changes: { title: 'title', notes: '', due_at: '2028-02-29T02:30:00.000Z', recurrence: 'none', reminder_enabled: false, tag_id: null } });
  assert.equal(input.changes.title, ' title ');
  assert.equal(validateMutation({ ...input, changes: { title: 'x', due_at: '2028-02-29T10:30:00.123456789+08:00' } }).changes.due_at, '2028-02-29T02:30:00.123456789Z');
  const update = { request_id: id, action: 'update', task_id: 'abc_1-2', expected_version: 'A'.repeat(64), changes: { notes: '  preserve whitespace  ' } };
  assert.deepEqual(validateMutation(update), { ...update, expected_version: 'a'.repeat(64) });
  assert.deepEqual(validateMutation({ ...update, changes: { due_at: null } }).changes, { due_at: null });
});
test('UUIDs, top-level fields, action, task IDs and versions are strictly validated', () => {
  const f = fixture(), good = f.create();
  for (const id of [undefined, null, 1, '', randomUUID().toUpperCase(), '12345678-1234-1234-8234-123456789abc', `${randomUUID()} `]) {
    assert.throws(() => validateRequestId(id), errorCode('INVALID_MUTATION'));
  }
  for (const bad of [null, [], 'create', {}, { ...good, extra: true }, { ...good, task_id: '8' }, { ...good, expected_version: 'a'.repeat(64) },
    { ...good, action: 'complete' }, { ...good, action: 1 }, { ...f.remove(), changes: {} }, { ...f.update(), task_id: 8 },
    { ...f.update(), task_id: '../8' }, { ...f.update(), expected_version: 'short' }, { ...f.update(), expected_version: 1 },
    Object.assign(Object.create({ inherited: true }), good)]) {
    assert.throws(() => validateMutation(bad), errorCode('INVALID_MUTATION'));
  }
  const getter = { ...good }; Object.defineProperty(getter, 'action', { enumerable: true, get() { throw Error(PRIVATE); } });
  assert.throws(() => validateMutation(getter), errorCode('INVALID_MUTATION'));
  assert.throws(() => validateMutation({ ...good, [Symbol('secret')]: true }), errorCode('INVALID_MUTATION'));
});
test('changes reject unsupported writes and invalid advanced field types', () => {
  const f = fixture();
  for (const changes of [undefined, null, [], {}, { notes: 'no title' }, { title: null }, { title: 1 }, { title: '' }, { title: '  ' },
    { title: 'x'.repeat(501) }, { title: 'x', notes: null }, { title: 'x', notes: 1 }, { title: 'x', notes: 'x'.repeat(10001) },
    { title: 'x', due_at: undefined }, { title: 'x', due_at: 123 }, { title: 'x', due_at: {} },
    ...['tag_id', 'status', 'reminder', 'recurrence', 'priority', 'completion', 'is_deleted', 'task_due_at', 'memo', '__proto__'].map(key => Object.fromEntries([['title', 'x'], [key, true]]))]) {
    assert.throws(() => validateMutation({ ...f.create(), changes }), errorCode('INVALID_MUTATION'));
  }
  assert.throws(() => validateMutation(f.update({})), errorCode('INVALID_MUTATION'));
  assert.doesNotThrow(() => validateMutation(f.create({ title: 'x'.repeat(500), notes: 'x'.repeat(10000) })));
});
test('due_at never accepts ambiguous dates or calendar rollovers', () => {
  const f = fixture();
  for (const due_at of ['2026-11-06', 'tomorrow', '2026-11-06T10:00:00', '2026-11-06 10:00:00Z', '2026-11-06T10:00Z',
    '2026-02-29T00:00:00Z', '2028-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '0000-01-01T00:00:00Z',
    '2026-11-06T24:00:00Z', '2026-11-06T00:60:00Z', '2026-11-06T00:00:60Z', '2026-11-06T00:00:00+24:00',
    '2026-11-06T00:00:00+08:60', '2026-11-06T00:00:00-00:00', '2026-11-06T00:00:00z', '2026-11-06T00:00:00.1234567890Z']) {
    assert.throws(() => validateMutation(f.create({ due_at })), errorCode('INVALID_MUTATION'));
  }
});
test('create/update/delete persist pending first and return metadata only', async () => {
  const f = fixture(), baseline = copy(f.tasks.get('8'));
  const created = await f.service.mutate(f.create({ notes: PRIVATE, due_at: '2026-11-06T10:00:00+08:00' }));
  assert.equal(created.state, 'succeeded'); assert.equal(created.task_id, '99');
  assert.equal(created.result_version, normalizeTask(f.tasks.get('99')).version);
  assert.equal(f.writes[0][1].title, 'Synthetic new task'); assert.equal(f.writes[0][1].is_remind_enabled, false);
  assert.equal(f.writes[0][1].task_due_at, '2026-11-06T02:00:00.000Z');
  assert.ok(Number.isSafeInteger(f.writes[0][1].id)); assert.notEqual(f.writes[0][1].id, 8);
  validateRequestId(f.writes[0][1].series_id);
  const updated = await f.service.mutate(f.update({ title: ' edited ', due_at: null }, randomUUID(), '99'));
  assert.equal(updated.state, 'succeeded'); assert.equal(f.tasks.get('99').title, 'edited'); assert.equal(f.tasks.get('99').task_due_at, null);
  assert.deepEqual(f.writes[1][2].server_unknown, { keep: true }); assert.equal(f.writes[1][2].memo, PRIVATE);
  const deleted = await f.service.mutate(f.remove(randomUUID(), '99'));
  assert.equal(deleted.state, 'succeeded'); assert.equal(deleted.result_version, null);
  assert.deepEqual(f.store.history.map(r => r.state), ['pending', 'succeeded', 'pending', 'succeeded', 'pending', 'succeeded']);
  assert.deepEqual(f.tasks.get('8'), baseline);
  for (const operation of [created, updated, deleted, await f.service.getOperation(created.request_id)]) {
    assert.equal(own(operation, 'request_hash'), false); assert.equal(own(operation, 'title'), false);
    assert.ok(!JSON.stringify(operation).includes(PRIVATE)); assert.ok(operation.warnings.length > 0);
  }
  assert.ok(!JSON.stringify(f.store.history).includes(PRIVATE));
  assert.deepEqual(await f.service.status(), { writes_blocked: false, blocking_request_id: null });
});
const own = (o, k) => Object.hasOwn(o, k);
test('production OperationStore integrates using only a synthetic temporary directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-mutation-test-'));
  const store = new OperationStore(directory); await store.init('a'.repeat(64));
  const history = [];
  const tracked = { history, list: () => store.list(), get: id => store.get(id),
    async append(record) { await store.append(record); history.push(copy(record)); } };
  const f = fixture({}, tracked), request = f.create();
  let result;
  try {
    result = await f.service.mutate(request);
    assert.equal(result.state, 'succeeded');
    assert.equal((await f.service.mutate(f.update({ notes: 'new' }, randomUUID(), '99'))).state, 'succeeded');
    assert.equal((await f.service.mutate(f.remove(randomUUID(), '99'))).state, 'succeeded');
  } finally { await store.close(); }
  const reopened = new OperationStore(directory); await reopened.init('a'.repeat(64));
  try {
    const service = new MutationService({ transport: f.transport, store: reopened });
    assert.deepEqual(await service.mutate(request), result);
    assert.equal(f.writes.length, 3); assert.equal((await service.status()).writes_blocked, false);
  } finally { await reopened.close(); }
});
test('async stores are awaited, including durable pending completion before POST', async () => {
  const base = new MemoryStore(), gate = deferred(), entered = deferred();
  const store = { history: base.history, async list() { await Promise.resolve(); return base.list(); }, async get(id) { await Promise.resolve(); return base.get(id); },
    async append(r) { if (r.state === 'pending') { entered.resolve(); await gate.promise; } base.append(r); } };
  const f = fixture({}, store), pending = f.service.mutate(f.create());
  await entered.promise; assert.equal(f.writes.length, 0); gate.resolve();
  assert.equal((await pending).state, 'succeeded'); assert.equal(f.writes.length, 1);
});
test('idempotency normalizes title/dates/defaults and hashes all body fields', async () => {
  const f = fixture(), request = f.create({ due_at: '2026-11-06T10:00:00+08:00' });
  const result = await f.service.mutate(request);
  const replay = await f.service.mutate({ changes: { due_at: '2026-11-06T02:00:00.000Z', notes: '', title: 'Synthetic new task' }, action: 'create', request_id: request.request_id });
  assert.deepEqual(replay, result); assert.equal(f.writes.length, 1);
  for (const other of [f.create({ title: 'different' }, request.request_id), f.create({ notes: 'different' }, request.request_id),
    f.create({ due_at: null }, request.request_id), { ...f.update(), request_id: request.request_id }, { ...f.remove(), request_id: request.request_id }]) {
    await assert.rejects(f.service.mutate(other), errorCode('IDEMPOTENCY_CONFLICT'));
  }
  const update = f.update(), changed = await f.service.mutate(update);
  assert.deepEqual(await f.service.mutate(update), changed);
  for (const delta of [{ expected_version: '0'.repeat(64) }, { task_id: '99' }, { changes: { notes: 'different' } }]) {
    await assert.rejects(f.service.mutate({ ...update, ...delta }), errorCode('IDEMPOTENCY_CONFLICT'));
  }
  assert.equal(f.writes.length, 2);
});
test('same UUID concurrent request joins execution; different content/UUID never queues', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ list: async (_tasks, writes) => { if (!writes.length) { entered.resolve(); await gate.promise; } } });
  const input = f.create(), first = f.service.mutate(input);
  await entered.promise;
  const sameRequest = f.service.mutate(copy(input));
  await assert.rejects(f.service.mutate(f.create()), errorCode('OPERATION_BUSY'));
  await assert.rejects(f.service.mutate({ ...input, changes: { title: 'changed' } }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.store.history.length, 0); gate.resolve();
  assert.deepEqual(await sameRequest, await first); assert.equal(f.writes.length, 1);
});
test('validation/read failures, stale versions and no changes have no journal or write side effects', async () => {
  for (const action of ['update', 'delete']) {
    const f = fixture(), request = action === 'update' ? f.update() : f.remove();
    f.tasks.get('8').mystery.nested.push('concurrent');
    await assert.rejects(f.service.mutate(request), errorCode('VERSION_CONFLICT'));
    assert.equal(f.store.history.length, 0); assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.service.mutate(f.update({ title: PRIVATE })), errorCode('NO_CHANGES'));
  await assert.rejects(f.service.mutate(f.update({ due_at: null })), errorCode('NO_CHANGES'));
  for (const e of [Error(PRIVATE), new BridgeError('NOT_FOUND', PRIVATE, 404), new BridgeError('UPSTREAM_NETWORK', PRIVATE, 502)]) {
    const broken = fixture({ get: () => { throw e; } });
    await assert.rejects(broken.service.mutate(broken.update()), err => !err.message.includes(PRIVATE));
    assert.equal(broken.store.history.length, 0); assert.equal(broken.writes.length, 0);
  }
  const broken = fixture({ list: () => { throw Error(PRIVATE); } });
  await assert.rejects(broken.service.mutate(broken.create()), errorCode('UPSTREAM_NETWORK'));
  assert.equal(broken.store.history.length, 0); assert.equal(broken.writes.length, 0);
});
test('updates preserve all unknown JSON fields and do not write tag/status', async () => {
  const f = fixture(); f.tasks.get('8').tag_id = 42;
  f.tasks.get('8').future = { raw: [null, false, { nested: 'unchanged' }] };
  const before = copy(f.tasks.get('8'));
  assert.equal((await f.service.mutate(f.update({ notes: '' }))).state, 'succeeded');
  const sent = f.writes[0][2];
  for (const key of Object.keys(before).filter(k => !['memo', 'modified_time'].includes(k))) assert.deepEqual(sent[key], before[key]);
});
test('unsupported status/flag and malformed fields are rejected before update/delete', async () => {
  for (const altered of [{ task_done_at: '2026-11-06T10:00:00Z' }, { done_date: 1 }, { is_remind_enabled: true, task_due_at: null },
    { repeating_pattern: 1 }, { repeating_origin_id: 5 }, { is_restored: true }, { ignore_expired: true },
    { done_date: false }, { is_restored: 'false' }, { ignore_expired: 0 }, { is_remind_enabled: 'false' },
    { repeating_pattern: '0' }, { title: 42 }, { memo: null }, { task_due_at: 1 }, { isDeleted: true }]) {
    for (const action of ['update', 'delete']) {
      const f = fixture(), request = action === 'update' ? f.update() : f.remove();
      Object.assign(f.tasks.get('8'), altered);
      await assert.rejects(f.service.mutate(request), e => ['UNSUPPORTED_TASK', 'UPSTREAM_SCHEMA'].includes(e.code));
      assert.equal(f.writes.length, 0); assert.equal(f.store.history.length, 0);
    }
  }
});
test('deleted/nonexistent targets cannot be newly deleted; successful delete replays', async () => {
  const f = fixture(), request = f.remove();
  const result = await f.service.mutate(request);
  assert.equal(result.state, 'succeeded'); assert.deepEqual(await f.service.mutate(request), result);
  await assert.rejects(f.service.mutate({ ...request, request_id: randomUUID() }), errorCode('NOT_FOUND'));
  assert.equal(f.writes.length, 1);
  const tombstone = fixture(); tombstone.tasks.get('8').is_deleted = true;
  await assert.rejects(tombstone.service.mutate(tombstone.remove()), errorCode('NOT_FOUND'));
  assert.equal(tombstone.writes.length, 0);
});
test('write network/5xx/unknown failures latch globally and never retry even with new UUID', async () => {
  for (const thrown of [new BridgeError('SELF_TEST_WRITE_UNKNOWN', PRIVATE, 502), new BridgeError('UPSTREAM_ERROR', PRIVATE, 502), Error(PRIVATE),
    new BridgeError('SECRET_ERROR_CODE', PRIVATE, 400)]) {
    const f = fixture({ create: () => { throw thrown; } }), request = f.create();
    const result = await f.service.mutate(request);
    assert.equal(result.state, 'unknown'); assert.ok(!JSON.stringify(result).includes(PRIVATE));
    assert.deepEqual(await f.service.status(), { writes_blocked: true, blocking_request_id: request.request_id });
    assert.deepEqual(await f.service.mutate(request), result);
    await assert.rejects(f.service.mutate(f.create()), errorCode('WRITES_BLOCKED'));
    assert.equal(f.writes.length, 1);
    const restored = new MutationService({ transport: f.transport, store: f.store });
    assert.deepEqual(await restored.mutate(request), result);
    await assert.rejects(restored.mutate(f.create()), errorCode('WRITES_BLOCKED'));
  }
});
test('known write rejection is failed, safe and replayable without globally blocking', async () => {
  for (const [code, status] of [['AUTH_EXPIRED', 401], ['UPSTREAM_FORBIDDEN', 403], ['NOT_FOUND', 404], ['UPSTREAM_RATE_LIMIT', 429], ['SELF_TEST_REJECTED', 422]]) {
    const f = fixture({ create: () => { throw new BridgeError(code, PRIVATE, status); } }), request = f.create();
    const failed = await f.service.mutate(request);
    assert.equal(failed.state, 'failed'); assert.equal(failed.error_code, code);
    assert.deepEqual(await f.service.mutate(request), failed); assert.equal(f.writes.length, 1);
    assert.equal((await f.service.status()).writes_blocked, false);
  }
});
test('post-write readback failure remains unknown even if it is a known HTTP 4xx', async () => {
  for (const action of ['create', 'update', 'delete']) {
    for (const [code, status] of [['UPSTREAM_NETWORK', 502], ['AUTH_EXPIRED', 401], ['UPSTREAM_FORBIDDEN', 403], ['UPSTREAM_RATE_LIMIT', 429]]) {
      const f = fixture({ get: (_id, _tasks, writes) => { if (writes.length) throw new BridgeError(code, PRIVATE, status); } });
      const request = action === 'create' ? f.create() : action === 'update' ? f.update() : f.remove();
      const result = await f.service.mutate(request);
      assert.equal(result.state, 'unknown'); assert.equal(f.writes.length, 1); assert.equal(result.error_code, code);
      await assert.rejects(f.service.mutate(f.create()), errorCode('WRITES_BLOCKED'));
    }
  }
});
test('malformed/write reply/readback drift is always unknown', async () => {
  for (const altered of [{ title: 'wrong' }, { memo: 'wrong' }, { task_due_at: '2026-11-07T00:00:00Z' },
    { is_remind_enabled: true }, { done_date: 1 }, { repeating_pattern: 1 }, { tag_id: 7 }, { series_id: 'wrong' }, { id: 8 },
    { is_restored: true }, { ignore_expired: true }, { importance: 2 }, { sequence_num: 2 }, { reorderable_orders: [1] },
    { task_created_at: '2026-01-01T00:00:00Z' }]) {
    const f = fixture({ create: payload => ({ ...copy(payload), id: 99, ...altered }) });
    assert.equal((await f.service.mutate(f.create())).state, 'unknown');
    assert.equal(f.writes.length, 1);
  }
  for (const altered of [{ title: 'external-edit' }, { memo: 'external-edit' }, { tag_id: 7 }, { mystery: 'lost' }, { is_remind_enabled: true }]) {
    const f = fixture({ get: (id, tasks, writes) => { if (writes.length) return { ...copy(tasks.get(id)), ...altered }; } });
    assert.equal((await f.service.mutate(f.update())).state, 'unknown'); assert.equal(f.writes.length, 1);
  }
});
test('create detects duplicate IDs and series without cleaning up or touching baseline tasks', async () => {
  const duplicateBaseline = fixture({ list: tasks => [copy(tasks.get('8')), copy(tasks.get('8'))] });
  await assert.rejects(duplicateBaseline.service.mutate(duplicateBaseline.create()), errorCode('UPSTREAM_SCHEMA'));
  assert.equal(duplicateBaseline.writes.length, 0);
  const duplicateCreate = fixture({ create: (payload, tasks) => {
    const first = { ...copy(payload), id: 99 }, second = { ...copy(payload), id: 100 };
    tasks.set('99', first); tasks.set('100', second); return copy(first);
  } });
  const before = copy(duplicateCreate.tasks.get('8'));
  const result = await duplicateCreate.service.mutate(duplicateCreate.create());
  assert.equal(result.state, 'unknown'); assert.equal(result.error_code, 'WRITE_READBACK');
  assert.equal(duplicateCreate.writes.length, 1); assert.deepEqual(duplicateCreate.tasks.get('8'), before);
  await assert.rejects(duplicateCreate.service.mutate(duplicateCreate.create()), errorCode('WRITES_BLOCKED'));
});
test('create random IDs and series differ across attempts while baseline IDs are excluded', async () => {
  const sent = [];
  for (let i = 0; i < 4; i++) {
    const f = fixture(); await f.service.mutate(f.create()); sent.push(f.writes[0][1]);
  }
  assert.equal(new Set(sent.map(t => t.id)).size, 4); assert.equal(new Set(sent.map(t => t.series_id)).size, 4);
});
test('delete requires both a confirmed tombstone/404 and no active list record', async () => {
  const soft = fixture({ delete: (id, tasks) => { tasks.get(id).is_deleted = true; return { deleted: true }; } });
  assert.equal((await soft.service.mutate(soft.remove())).state, 'succeeded');
  const ignored = fixture({ delete: () => ({ deleted: true }) });
  assert.equal((await ignored.service.mutate(ignored.remove())).state, 'unknown');
  const staleList = fixture({ list: () => [row()] });
  assert.equal((await staleList.service.mutate(staleList.remove())).state, 'unknown');
  const listError = fixture({ list: () => { throw new BridgeError('NOT_FOUND', PRIVATE, 404); } });
  assert.equal((await listError.service.mutate(listError.remove())).state, 'unknown');
});
test('crash-restored pending records block globally and the same request never writes again', async () => {
  const f = fixture(), request = f.create(); await f.service.mutate(request);
  const pending = f.store.history[0]; f.store.records.set(request.request_id, copy(pending));
  const service = new MutationService({ transport: f.transport, store: f.store });
  assert.deepEqual(await service.status(), { writes_blocked: true, blocking_request_id: request.request_id });
  assert.equal((await service.getOperation(request.request_id)).state, 'pending');
  assert.equal((await service.mutate(request)).state, 'pending');
  await assert.rejects(service.mutate(f.create()), errorCode('WRITES_BLOCKED'));
  await assert.rejects(service.mutate(f.create({ title: 'different' }, request.request_id)), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.writes.length, 1);
});
test('store append failure before and after upstream write stops this service and preserves pending on crash', async () => {
  for (const failingAppend of [1, 2]) {
    const store = new MemoryStore(); store.failAppend = failingAppend;
    const f = fixture({}, store), request = f.create();
    await assert.rejects(f.service.mutate(request), errorCode('OPERATION_STORE'));
    assert.equal(f.writes.length, failingAppend - 1);
    assert.equal((await f.service.status()).writes_blocked, true);
    await assert.rejects(f.service.mutate(f.create()), errorCode('OPERATION_STORE'));
    assert.equal(f.writes.length, failingAppend - 1);
    if (failingAppend === 2) {
      const restarted = new MutationService({ transport: f.transport, store });
      assert.equal((await restarted.mutate(request)).state, 'pending');
      await assert.rejects(restarted.mutate(f.create()), errorCode('WRITES_BLOCKED'));
    }
  }
});
test('store read failures and invalid records fail closed without leaking data', async () => {
  for (const method of ['list', 'get']) {
    const store = new MemoryStore(); store[method] = async () => { throw Error(PRIVATE); };
    const f = fixture({}, store);
    await assert.rejects(f.service.mutate(f.create()), errorCode('OPERATION_STORE'));
    assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.store.records.set(randomUUID(), { secret: PRIVATE });
  await assert.rejects(f.service.status(), errorCode('OPERATION_STORE'));
  await assert.rejects(f.service.mutate(f.create()), errorCode('OPERATION_STORE'));
  await assert.rejects(f.service.getOperation('not-a-uuid'), errorCode('INVALID_MUTATION'));
  const healthy = fixture(); await assert.rejects(healthy.service.getOperation(randomUUID()), errorCode('OPERATION_NOT_FOUND'));
});
test('a late asynchronous status snapshot cannot relatch a completed pending operation', async () => {
  const writeGate = deferred(), enteredWrite = deferred(), statusGate = deferred(), enteredStatus = deferred();
  const f = fixture({ create: async (payload, tasks) => {
    enteredWrite.resolve(); await writeGate.promise;
    const result = { ...copy(payload), id: 99 }; tasks.set('99', result); return copy(result);
  } });
  const mutating = f.service.mutate(f.create()); await enteredWrite.promise;
  const list = f.store.list.bind(f.store);
  f.store.list = async () => { const snapshot = list(); enteredStatus.resolve(); await statusGate.promise; return snapshot; };
  const status = f.service.status(); await enteredStatus.promise;
  writeGate.resolve(); assert.equal((await mutating).state, 'succeeded');
  statusGate.resolve(); assert.equal((await status).writes_blocked, false);
  f.store.list = list; assert.equal((await f.service.status()).writes_blocked, false);
});
test('concurrent store failure during pending append prevents the subsequent upstream write', async () => {
  const base = new MemoryStore(), appendGate = deferred(), enteredAppend = deferred();
  const store = { history: base.history, list: () => base.list(), get: id => base.get(id),
    async append(record) { enteredAppend.resolve(); await appendGate.promise; base.append(record); } };
  const f = fixture({}, store), result = f.service.mutate(f.create());
  await enteredAppend.promise;
  store.get = () => { throw Error(PRIVATE); };
  await assert.rejects(f.service.getOperation(randomUUID()), errorCode('OPERATION_STORE'));
  appendGate.resolve(); await assert.rejects(result, errorCode('OPERATION_STORE'));
  assert.equal(f.writes.length, 0); assert.equal((await f.service.status()).writes_blocked, true);
});
test('advanced validation constrains colors, actions, recurrence and explicit reminder time', () => {
  const f = fixture();
  for (const color_id of [0, -1, 11, 12, 13, 1.5, '1', null, true]) {
    assert.throws(() => validateMutation(f.tagUpdate({ color_id })), errorCode('INVALID_MUTATION'));
  }
  for (const color_id of [1, 10]) assert.equal(validateMutation(f.tagUpdate({ color_id })).changes.color_id, color_id);
  for (const changes of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: null }, { name: 'x', is_deleted: true }, {}]) {
    assert.throws(() => validateMutation(f.tagUpdate(changes)), errorCode('INVALID_MUTATION'));
  }
  assert.equal(validateMutation(f.tagUpdate({ name: ' Renamed ' })).changes.name, 'Renamed');
  for (const input of [{ ...f.complete(), changes: {} }, { ...f.complete(), tag_id: '42' }, { ...f.tagUpdate(), task_id: '8' },
    f.create({ recurrence: 'custom', due_at: '2026-11-06T10:00:00+08:00' }), f.create({ recurrence: 'daily' }),
    f.update({ reminder_enabled: true }), f.create({ reminder_enabled: true }), f.update({ reminder_enabled: true, due_at: null })]) {
    assert.throws(() => validateMutation(input), errorCode('INVALID_MUTATION'));
  }
  assert.doesNotThrow(() => validateMutation(f.update({ reminder_enabled: false })));
  assert.doesNotThrow(() => validateMutation(f.update({ reminder_enabled: true, due_at: '2026-11-06T10:00:00+08:00' })));
});
test('create supports every basic recurrence plus explicit reminder and raw numeric tag ID', async () => {
  for (const recurrence of Object.keys(RECURRENCE_PATTERNS)) {
    const f = fixture();
    const input = f.create({ recurrence, reminder_enabled: true, due_at: '2026-11-06T10:30:00+08:00', tag_id: '42' });
    const result = await f.service.mutate(input);
    assert.equal(result.state, 'succeeded'); assert.equal(f.writes.length, 1);
    const sent = f.writes[0][1];
    assert.equal(sent.repeating_pattern, RECURRENCE_PATTERNS[recurrence]);
    assert.equal(sent.task_due_at, '2026-11-06T02:30:00.000Z'); assert.equal(sent.is_remind_enabled, true);
    assert.equal(sent.tag_id, 42); assert.equal(typeof sent.tag_id, 'number');
    assert.equal(sent.ignore_expired, false);
    assert.ok(result.warnings.some(w => w.includes('delivery_verified=false')));
    assert.ok(result.warnings.some(w => w.includes('网页') && w.includes('午夜')));
    assert.ok(result.warnings.some(w => w.includes('clamp') && w.includes('漂移')));
    assert.deepEqual(await f.service.mutate(input), result); assert.equal(f.writes.length, 1);
  }
});
test('advanced idempotency binds recurrence, reminder, tag, tag color and completion action', async () => {
  const f = fixture();
  const request = f.create({ title: 'habit', due_at: '2026-11-06T10:00:00+08:00', recurrence: 'daily', reminder_enabled: true, tag_id: '42' });
  assert.equal((await f.service.mutate(request)).state, 'succeeded');
  for (const changed of [{ recurrence: 'weekly' }, { reminder_enabled: false }, { tag_id: null }]) {
    await assert.rejects(f.service.mutate({ ...request, changes: { ...request.changes, ...changed } }), errorCode('IDEMPOTENCY_CONFLICT'));
  }
  assert.equal(f.writes.length, 1);
  const tag = f.tagUpdate({ color_id: 1 });
  assert.equal((await f.service.mutate(tag)).state, 'succeeded');
  await assert.rejects(f.service.mutate({ ...tag, changes: { color_id: 2 } }), errorCode('IDEMPOTENCY_CONFLICT'));
  const complete = f.complete();
  assert.equal((await f.service.mutate(complete)).state, 'succeeded');
  await assert.rejects(f.service.mutate({ ...complete, action: 'delete' }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(f.writes.map(w => w[0]), ['create', 'tag_update', 'update']);
});
test('recurrence/reminder/tag updates retain old fields and require explicit disabling when clearing due', async () => {
  const f = fixture();
  const original = copy(f.tasks.get('8'));
  const enabled = await f.service.mutate(f.update({ recurrence: 'weekdays', reminder_enabled: true,
    due_at: '2026-11-06T09:30:00+08:00', tag_id: '42' }));
  assert.equal(enabled.state, 'succeeded');
  const raw = f.tasks.get('8');
  assert.equal(raw.repeating_pattern, RECURRENCE_PATTERNS.weekdays); assert.equal(raw.tag_id, 42);
  assert.equal(raw.is_remind_enabled, true); assert.equal(raw.task_due_at, '2026-11-06T01:30:00.000Z');
  assert.deepEqual(raw.mystery, original.mystery); assert.equal(raw.series_id, original.series_id);
  assert.equal(raw.sequence_num, original.sequence_num);
  await assert.rejects(f.service.mutate(f.update({ due_at: null })), errorCode('INVALID_MUTATION'));
  assert.equal(f.writes.length, 1);
  const edited = await f.service.mutate(f.update({ notes: 'changed without touching reminder' }));
  assert.equal(edited.state, 'succeeded'); assert.equal(f.tasks.get('8').is_remind_enabled, true);
  const disabled = await f.service.mutate(f.update({ recurrence: 'none', reminder_enabled: false, due_at: null, tag_id: null }));
  assert.equal(disabled.state, 'succeeded');
  assert.equal(f.tasks.get('8').repeating_pattern, 0); assert.equal(f.tasks.get('8').task_due_at, null);
  assert.equal(f.tasks.get('8').is_remind_enabled, false); assert.equal(f.tasks.get('8').tag_id, null);
});
test('tag assignments validate live ID and do not guess names or mutate tag definitions', async () => {
  for (const altered of [{ is_deleted: true }, { id: 43 }, { color_id: 11 }, { color_id: -1 }]) {
    const f = fixture(); Object.assign(f.tags.get('42'), altered);
    for (const input of [f.create({ tag_id: '42' }), f.update({ tag_id: '42' })]) {
      await assert.rejects(f.service.mutate(input), e => ['NOT_FOUND', 'UPSTREAM_SCHEMA'].includes(e.code));
    }
    assert.equal(f.writes.length, 0); assert.equal(f.store.history.length, 0);
  }
  const f = fixture(); f.tags.clear();
  await assert.rejects(f.service.mutate(f.create({ tag_id: '42' })), errorCode('NOT_FOUND'));
  assert.equal(f.writes.length, 0);
});
test('real upstream nullable repeating_origin_id omission is accepted for create and update', async () => {
  const f = fixture({ create: (payload, tasks) => {
    const raw = { ...copy(payload), id: 99 }; delete raw.repeating_origin_id;
    tasks.set('99', raw); return copy(raw);
  } });
  assert.equal((await f.service.mutate(f.create())).state, 'succeeded');
  assert.equal((await f.service.mutate(f.update({ notes: 'edit' }, randomUUID(), '99'))).state, 'succeeded');
  const wrong = fixture({ create: payload => ({ ...copy(payload), id: 99, repeating_origin_id: '8' }) });
  assert.equal((await wrong.service.mutate(wrong.create())).state, 'unknown');
});
test('ordinary completion writes done timestamp and Shanghai date once, preserving reminder and other fields', async () => {
  const f = fixture();
  Object.assign(f.tasks.get('8'), { task_due_at: '2026-11-06T09:30:00+08:00', is_remind_enabled: true, tag_id: 42 });
  const input = f.complete(), original = copy(f.tasks.get('8'));
  const before = Date.now(), result = await f.service.mutate(input), after = Date.now();
  assert.equal(result.state, 'succeeded'); assert.equal(result.action, 'complete'); assert.equal(result.task_id, '8');
  assert.deepEqual(f.writes.map(w => w[0]), ['update']);
  const completed = f.tasks.get('8');
  assert.ok(Date.parse(completed.task_done_at) >= before && Date.parse(completed.task_done_at) <= after);
  assert.equal(completed.done_date, shanghaiDate(completed.task_done_at));
  for (const key of Object.keys(original).filter(k => !['task_done_at', 'done_date', 'modified_time'].includes(k))) {
    assert.deepEqual(completed[key], original[key]);
  }
  assert.equal(result.result_version, version(completed));
  assert.deepEqual(await f.service.mutate(input), result); assert.equal(f.writes.length, 1);
  await assert.rejects(f.service.mutate(f.complete()), errorCode('UNSUPPORTED_TASK'));
  assert.equal(f.writes.length, 1);
});
test('recurring completion durably precedes PUT, verifies completion, checks duplicate list, then creates exactly one successor', async () => {
  for (const [name, due, expected] of [
    ['daily', '2020-01-01T09:30:00+08:00', '2020-01-02T01:30:00.000Z'],
    ['weekdays', '2026-11-02T09:30:00+08:00', '2026-11-03T01:30:00.000Z'],
    ['weekly', '2026-11-05T09:30:00+08:00', '2026-11-12T01:30:00.000Z'],
    ['monthly', '2027-01-31T09:30:00+08:00', '2027-02-28T01:30:00.000Z'],
  ]) {
    const f = fixture();
    Object.assign(f.tasks.get('8'), { task_due_at: due, repeating_pattern: RECURRENCE_PATTERNS[name],
      is_remind_enabled: true, tag_id: 42, sequence_num: 4, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' });
    const original = copy(f.tasks.get('8')), input = f.complete(), events = [];
    for (const method of ['getTask', 'getTasks', 'updateTask', 'createTask']) {
      const old = f.transport[method].bind(f.transport);
      f.transport[method] = async (...args) => { events.push(method); return old(...args); };
    }
    const result = await f.service.mutate(input);
    assert.equal(result.state, 'succeeded'); assert.equal(result.task_id, '8');
    assert.deepEqual(events, ['getTask', 'getTasks', 'updateTask', 'getTask', 'getTasks', 'createTask', 'getTask', 'getTasks']);
    assert.deepEqual(f.writes.map(w => w[0]), ['update', 'create']);
    assert.deepEqual(f.store.history.map(r => r.state), ['pending', 'succeeded']);
    const successor = f.tasks.get('99'), sent = f.writes[1][1];
    assert.equal(successor.series_id, original.series_id); assert.equal(successor.sequence_num, 5);
    assert.equal(successor.task_due_at, expected); assert.equal(successor.task_done_at, null); assert.equal(successor.done_date, null);
    assert.equal(successor.is_restored, false); assert.equal(successor.is_remind_enabled, true); assert.equal(successor.ignore_expired, false);
    assert.equal(sent.created_at, null); assert.equal(sent.updated_at, null); assert.notEqual(sent.task_created_at, original.created_at);
    assert.equal(successor.tag_id, 42); assert.equal(successor.title, original.title); assert.equal(successor.memo, original.memo);
    assert.deepEqual(successor.mystery, original.mystery);
    assert.equal(result.result_version, version(f.tasks.get('8')));
    assert.deepEqual(await f.service.mutate(input), result); assert.equal(f.writes.length, 2);
    const restarted = new MutationService({ transport: f.transport, store: f.store });
    assert.deepEqual(await restarted.mutate(input), result); assert.equal(f.writes.length, 2);
  }
});
test('complete terminal persistence failure retains durable pending and cannot generate another successor', async () => {
  const store = new MemoryStore(); store.failAppend = 2;
  const f = fixture({}, store);
  Object.assign(f.tasks.get('8'), { repeating_pattern: RECURRENCE_PATTERNS.daily, task_due_at: '2026-11-05T09:00:00+08:00' });
  const input = f.complete();
  await assert.rejects(f.service.mutate(input), errorCode('OPERATION_STORE'));
  assert.deepEqual(f.writes.map(w => w[0]), ['update', 'create']);
  assert.equal(store.get(input.request_id).state, 'pending');
  const restored = new MutationService({ transport: f.transport, store });
  assert.equal((await restored.mutate(input)).state, 'pending');
  await assert.rejects(restored.mutate(f.create()), errorCode('WRITES_BLOCKED'));
  assert.equal(f.writes.length, 2);
});
test('recurring completion validates next date, series identity, baseline and existing successor before PUT', async () => {
  for (const altered of [{ sequence_num: 0 }, { sequence_num: '1' }, { sequence_num: Number.MAX_SAFE_INTEGER },
    { series_id: null }, { repeating_pattern: 1 }, { ignore_expired: true }, { is_restored: true },
    { task_due_at: '9999-12-31T09:00:00+08:00' }]) {
    const f = fixture(); Object.assign(f.tasks.get('8'), { task_due_at: '2026-11-06T09:30:00+08:00', repeating_pattern: RECURRENCE_PATTERNS.daily }, altered);
    await assert.rejects(f.service.mutate(f.complete()), e => ['UPSTREAM_SCHEMA', 'UNSUPPORTED_TASK', 'INVALID_MUTATION'].includes(e.code));
    assert.equal(f.writes.length, 0); assert.equal(f.store.history.length, 0);
  }
  for (const nextChanges of [{}, { task_done_at: '2026-11-07T10:00:00Z', done_date: 20261107 }]) {
    const f = fixture(); Object.assign(f.tasks.get('8'), { task_due_at: '2026-11-06T09:30:00+08:00', repeating_pattern: RECURRENCE_PATTERNS.daily });
    f.tasks.set('9', row({ ...copy(f.tasks.get('8')), id: 9, sequence_num: 2, ...nextChanges }));
    await assert.rejects(f.service.mutate(f.complete()), errorCode('VERSION_CONFLICT'));
    assert.equal(f.writes.length, 0); assert.equal(f.store.history.length, 0);
  }
});
test('recurring completion partial failures including known POST 4xx remain unknown and cannot repeat either stage', async () => {
  for (const phase of ['put_unknown', 'put_readback', 'next_conflict', 'post_rejected', 'post_unknown', 'post_duplicate', 'post_readback']) {
    const f = fixture({
      update: (id, payload, tasks) => {
        if (phase === 'put_unknown') throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', PRIVATE, 502);
        tasks.set(id, copy(payload));
        if (phase === 'next_conflict') tasks.set('9', { ...copy(payload), id: 9, sequence_num: 2, task_done_at: null, done_date: null });
        return copy(payload);
      },
      get: (id, tasks, writes) => {
        if ((phase === 'put_readback' && writes.length === 1) || (phase === 'post_readback' && writes.length === 2)) {
          throw new BridgeError('AUTH_EXPIRED', PRIVATE, 401);
        }
      },
      create: (payload, tasks) => {
        if (phase === 'post_rejected') throw new BridgeError('SELF_TEST_REJECTED', PRIVATE, 422);
        if (phase === 'post_unknown') throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', PRIVATE, 502);
        const result = { ...copy(payload), id: 99 }; tasks.set('99', result);
        if (phase === 'post_duplicate') tasks.set('100', { ...copy(payload), id: 100 });
        return copy(result);
      },
    });
    Object.assign(f.tasks.get('8'), { task_due_at: '2026-11-06T09:30:00+08:00', repeating_pattern: RECURRENCE_PATTERNS.daily });
    const input = f.complete(), result = await f.service.mutate(input), writes = f.writes.length;
    assert.equal(result.state, 'unknown', phase); assert.equal(result.task_id, '8'); assert.equal(result.result_version, null);
    assert.deepEqual(f.store.history.map(r => r.state), ['pending', 'unknown']);
    if (['put_unknown', 'put_readback', 'next_conflict'].includes(phase)) assert.equal(writes, 1);
    else assert.equal(writes, 2);
    assert.deepEqual(await f.service.mutate(input), result); assert.equal(f.writes.length, writes);
    await assert.rejects(f.service.mutate(f.create()), errorCode('WRITES_BLOCKED'));
    const restarted = new MutationService({ transport: f.transport, store: f.store });
    assert.equal((await restarted.mutate(input)).state, 'unknown'); assert.equal(f.writes.length, writes);
    await assert.rejects(restarted.mutate(f.create()), errorCode('WRITES_BLOCKED'));
  }
});
test('recurring completion awaits durable pending before PUT and refuses drifted/duplicate series baselines', async () => {
  const gate = deferred(), stored = deferred(), memory = new MemoryStore();
  const store = { history: memory.history, list: () => memory.list(), get: id => memory.get(id),
    async append(record) {
      if (record.state === 'pending') { stored.resolve(); await gate.promise; }
      memory.append(record);
    } };
  const f = fixture({}, store);
  Object.assign(f.tasks.get('8'), { repeating_pattern: RECURRENCE_PATTERNS.daily, task_due_at: '2026-11-05T09:00:00+08:00' });
  const op = f.service.mutate(f.complete()); await stored.promise;
  assert.equal(f.writes.length, 0); gate.resolve();
  assert.equal((await op).state, 'succeeded'); assert.equal(f.writes.length, 2);
  for (const phase of ['missing_source', 'changed_source', 'duplicate_current', 'malformed_sequence']) {
    const broken = fixture({ list: tasks => {
      const all = [...tasks.values()].map(copy);
      if (phase === 'missing_source') return [];
      if (phase === 'changed_source') return all.map(t => ({ ...t, title: 'changed' }));
      return [...all, { ...all[0], id: 9, sequence_num: phase === 'duplicate_current' ? 1 : '2' }];
    } });
    Object.assign(broken.tasks.get('8'), { repeating_pattern: RECURRENCE_PATTERNS.daily, task_due_at: '2026-11-05T09:00:00+08:00' });
    await assert.rejects(broken.service.mutate(broken.complete()), e => ['VERSION_CONFLICT', 'UPSTREAM_SCHEMA'].includes(e.code));
    assert.equal(broken.writes.length, 0); assert.equal(broken.store.history.length, 0);
  }
});
test('completion refuses invalid readback or successor identity rather than declaring partial success', async () => {
  for (const phase of ['source_reopened', 'next_existing_id', 'next_deleted', 'source_final_drift', 'next_sequence_drift']) {
    const f = fixture({ create: (payload, tasks) => {
      const created = { ...copy(payload), id: phase === 'next_existing_id' ? 8 : 99 };
      if (phase === 'next_deleted') created.is_deleted = true;
      tasks.set(String(created.id), copy(created));
      if (phase === 'source_reopened') tasks.get('8').task_done_at = null;
      if (phase === 'source_final_drift') tasks.get('8').mystery = 'changed-after-next';
      if (phase === 'next_sequence_drift') tasks.get('99').sequence_num++;
      return copy(created);
    } });
    Object.assign(f.tasks.get('8'), { repeating_pattern: RECURRENCE_PATTERNS.daily, task_due_at: '2026-11-05T09:00:00+08:00' });
    const input = f.complete(), result = await f.service.mutate(input);
    assert.equal(result.state, 'unknown', phase); assert.equal(result.task_id, '8'); assert.equal(result.result_version, null);
    assert.deepEqual(await f.service.mutate(input), result); assert.equal(f.writes.length, 2);
    await assert.rejects(f.service.mutate(f.create()), errorCode('WRITES_BLOCKED'));
  }
});
test('unsupported optional tag methods fail before writing unrelated task or pending record', async () => {
  const f = fixture(); delete f.transport.getTag;
  await assert.rejects(f.service.mutate(f.create({ tag_id: '42' })), errorCode('UPSTREAM_SCHEMA'));
  assert.equal(f.writes.length, 0); assert.equal(f.store.history.length, 0);
  const g = fixture(); delete g.transport.updateTag;
  await assert.rejects(g.service.mutate(g.tagUpdate()), errorCode('UPSTREAM_SCHEMA'));
  assert.equal(g.writes.length, 0); assert.equal(g.store.history.length, 0);
});
test('tag rename/color keeps all unknown fields, tolerates read default color 0 and replays without touching tasks', async () => {
  const f = fixture(); f.tags.get('42').color_id = 0;
  const originalTasks = copy([...f.tasks.values()]), originalTag = copy(f.tags.get('42'));
  const input = f.tagUpdate({ name: ' Updated category ', color_id: 10 });
  assert.equal(input.expected_version, normalizeTag(originalTag).version);
  const result = await f.service.mutate(input);
  assert.equal(result.state, 'succeeded'); assert.equal(result.action, 'tag_update'); assert.equal(result.task_id, '42');
  assert.equal(result.result_version, normalizeTag(f.tags.get('42')).version);
  assert.equal(f.tags.get('42').name, 'Updated category'); assert.equal(f.tags.get('42').color_id, 10);
  assert.deepEqual(f.tags.get('42').mystery, originalTag.mystery); assert.deepEqual([...f.tasks.values()], originalTasks);
  assert.deepEqual(f.writes.map(w => w[0]), ['tag_update']);
  assert.deepEqual(await f.service.mutate(input), result); assert.equal(f.writes.length, 1);
  await assert.rejects(f.service.mutate(f.tagUpdate({ name: 'Updated category', color_id: 10 })), errorCode('NO_CHANGES'));
});
test('tag edits verify version and readback and conservatively block on partial or unknown outcomes', async () => {
  const stale = fixture(), input = stale.tagUpdate(); stale.tags.get('42').mystery = 'changed';
  await assert.rejects(stale.service.mutate(input), errorCode('VERSION_CONFLICT')); assert.equal(stale.writes.length, 0);
  for (const mode of ['reply', 'readback', 'network']) {
    const f = fixture({ tagUpdate: (id, payload, tags) => {
      if (mode === 'network') throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', PRIVATE, 502);
      tags.set(id, copy(payload));
      return mode === 'reply' ? { ...copy(payload), color_id: 2 } : copy(payload);
    }, tag: (id, tags, writes) => {
      if (mode === 'readback' && writes.length) return { ...copy(tags.get(id)), mystery: 'lost' };
    } });
    const result = await f.service.mutate(f.tagUpdate({ name: 'New category', color_id: 10 }));
    assert.equal(result.state, 'unknown'); assert.equal(result.task_id, '42'); assert.equal(f.writes.length, 1);
    await assert.rejects(f.service.mutate(f.create()), errorCode('WRITES_BLOCKED'));
  }
});
test('advanced complete and tag records persist through the production store without expanding the schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-advanced-mutation-'));
  const store = new OperationStore(directory); await store.init('a'.repeat(64));
  const history = [], tracked = { history, list: () => store.list(), get: id => store.get(id),
    async append(record) { await store.append(record); history.push(copy(record)); } };
  const f = fixture({}, tracked);
  let completeRequest, tagRequest, completeResult, tagResult;
  try {
    Object.assign(f.tasks.get('8'), { task_due_at: '2026-11-06T09:30:00+08:00', repeating_pattern: RECURRENCE_PATTERNS.daily });
    completeRequest = f.complete(); completeResult = await f.service.mutate(completeRequest);
    tagRequest = f.tagUpdate({ name: 'Updated', color_id: 1 }); tagResult = await f.service.mutate(tagRequest);
    assert.equal(completeResult.state, 'succeeded'); assert.equal(tagResult.state, 'succeeded');
    for (const record of await store.list()) assert.equal(Object.keys(record).length, 9);
  } finally { await store.close(); }
  const restored = new OperationStore(directory); await restored.init('a'.repeat(64));
  try {
    const service = new MutationService({ transport: f.transport, store: restored });
    assert.deepEqual(await service.mutate(completeRequest), completeResult);
    assert.deepEqual(await service.mutate(tagRequest), tagResult);
    assert.equal(f.writes.length, 3);
  } finally { await restored.close(); }
});

test('operation timeout bounds uncooperative transport and latches unknown without later retry', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  // Compress only the service's long deadline timer. No network or actual minute-long test wait.
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms > 50_000 ? 10 : ms, ...args);
  try {
    const gate = deferred(), f = fixture({ create: () => gate.promise }), request = f.create();
    const result = await f.service.mutate(request);
    assert.equal(result.state, 'unknown'); assert.equal(result.error_code, 'WRITE_TIMEOUT');
    await assert.rejects(f.service.mutate(f.create()), errorCode('WRITES_BLOCKED'));
    gate.resolve({}); await Promise.resolve(); assert.equal(f.writes.length, 1);
    assert.equal((await f.service.getOperation(request.request_id)).state, 'unknown');
  } finally { globalThis.setTimeout = originalSetTimeout; }
});
