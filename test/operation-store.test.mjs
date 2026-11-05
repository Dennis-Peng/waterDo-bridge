import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, appendFile, chmod, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperationStore } from '../src/operation-store.mjs';
const BINDING = 'a'.repeat(64);
const pending = (extra = {}) => ({ request_id: randomUUID(), request_hash: 'b'.repeat(64), action: 'create', state: 'pending', task_id: null,
  result_version: null, created_at: '2026-11-05T12:00:00.000Z', updated_at: '2026-11-05T12:00:00.000Z', error_code: null, ...extra });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'waterdo-operations-'));
  const store = new OperationStore(dir); await store.init(BINDING); t.after(() => store.close());
  return { store, dir };
}
test('operations persist through restart, are private and contain only strict metadata', async t => {
  const { store, dir } = await fixture(t);
  const p = pending(); await store.append(p);
  const success = { ...p, state: 'succeeded', task_id: '12', result_version: 'c'.repeat(64) };
  await store.append(success);
  assert.deepEqual(await store.get(p.request_id), success);
  assert.equal((await stat(join(dir, 'operations.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await store.close();
  const next = new OperationStore(dir); await next.init(BINDING); t.after(() => next.close());
  assert.deepEqual(await next.list(), [success]);
  assert.ok(!(await readFile(join(dir, 'operations.jsonl'), 'utf8')).includes('title'));
  const returned = await next.get(p.request_id); returned.task_id = 'other';
  assert.equal((await next.get(p.request_id)).task_id, '12');
});
test('lifetime writer lock prevents parallel service and credential binding prevents cross-account replay', async t => {
  const { store, dir } = await fixture(t);
  await assert.rejects(new OperationStore(dir).init(BINDING), { code: 'OPERATION_STORE_LOCKED' });
  await store.close();
  await assert.rejects(new OperationStore(dir).init('d'.repeat(64)), { code: 'ACCOUNT_BINDING_CHANGED' });
  const again = new OperationStore(dir); await again.init(BINDING); await again.close();
});
test('pending records survive crashes and cannot be removed by normal transition', async t => {
  const { store, dir } = await fixture(t); const p = pending(); await store.append(p); await store.close();
  const restored = new OperationStore(dir); await restored.init(BINDING); t.after(() => restored.close());
  assert.equal((await restored.get(p.request_id)).state, 'pending');
  await restored.append({ ...p, state: 'unknown', error_code: 'UPSTREAM_TIMEOUT' });
  await assert.rejects(restored.append({ ...p, state: 'succeeded', task_id: '123' }), { code: 'OPERATION_STORE' });
});
test('schema rejects user content, hidden properties and invalid transitions before append', async t => {
  const { store } = await fixture(t); const p = pending();
  for (const invalid of [{ ...p, title: 'must not be stored' }, { ...p, request_id: '../bad' }, { ...p, error_code: 'private notes' },
    { ...p, created_at: 'not-time' }, { ...p, action: 'delete' }, { ...p, request_hash: 'bad' }, { ...p, state: 'succeeded' },
    { ...p, get state() { return 'pending'; } }]) {
    await assert.rejects(store.append(invalid), { code: 'OPERATION_STORE' });
  }
  assert.deepEqual(await store.list(), []);
  await store.append(p);
  await assert.rejects(store.append({ ...p, request_hash: 'd'.repeat(64) }), { code: 'OPERATION_STORE' });
});
test('partial journal, unsafe permissions, missing binding and changed files fail closed', async t => {
  const { store, dir } = await fixture(t); const p = pending(); await store.append(p); await store.close();
  await appendFile(join(dir, 'operations.jsonl'), '{partial');
  await assert.rejects(new OperationStore(dir).init(BINDING), { code: 'OPERATION_STORE' });
  const { store: second, dir: secondDir } = await fixture(t);
  await chmod(join(secondDir, 'operations.jsonl'), 0o644);
  await assert.rejects(second.append(pending()), { code: 'OPERATION_STORE' });
  const thirdDir = await mkdtemp(join(tmpdir(), 'waterdo-operations-unbound-'));
  await writeFile(join(thirdDir, 'operations.jsonl'), '', { mode: 0o600 });
  await assert.rejects(new OperationStore(thirdDir).init(BINDING), { code: 'OPERATION_STORE' });
});
test('shutdown drains actual delayed fsync before releasing the writer lock', async t => {
  const { store, dir } = await fixture(t); const p = pending(); await store.append(p);
  const sample = await open(join(dir, 'operations.jsonl'), 'r');
  const proto = Object.getPrototypeOf(sample), original = proto.sync; await sample.close();
  const target = await stat(join(dir, 'operations.jsonl'));
  let unblock, began;
  const gate = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  t.mock.method(proto, 'sync', async function () {
    const current = await this.stat();
    if (current.ino === target.ino && current.dev === target.dev) { began(); await gate; }
    return original.call(this);
  });
  const append = store.append({ ...p, state: 'succeeded', task_id: '12', result_version: 'c'.repeat(64) });
  await started;
  let closed = false;
  const closing = store.close().then(() => { closed = true; });
  try {
    await assert.rejects(new OperationStore(dir).init(BINDING), { code: 'OPERATION_STORE_LOCKED' });
    assert.equal(closed, false);
    await assert.rejects(store.append(pending()), { code: 'OPERATION_STORE' });
  } finally { unblock(); }
  await append; await closing;
  const restored = new OperationStore(dir); await restored.init(BINDING);
  assert.equal((await restored.get(p.request_id)).state, 'succeeded'); await restored.close();
});
test('a prior-boot lock can be reclaimed without deleting pending operation history', async t => {
  const { store, dir } = await fixture(t); const p = pending(); await store.append(p); await store.close();
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const otherBoot = boot === '00000000-0000-0000-0000-000000000001' ? '00000000-0000-0000-0000-000000000002' : '00000000-0000-0000-0000-000000000001';
  await writeFile(join(dir, 'writer.lock'), JSON.stringify({ pid: 123, created_at: '2026-11-05T12:00:00.000Z', boot_id: otherBoot }) + '\n', { flag: 'wx', mode: 0o600 });
  const contenders = [new OperationStore(dir), new OperationStore(dir)];
  const results = await Promise.allSettled(contenders.map(next => next.init(BINDING)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const next = contenders[results.findIndex(result => result.status === 'fulfilled')]; t.after(() => next.close());
  assert.equal((await next.get(p.request_id)).state, 'pending');
  const lock = JSON.parse(await readFile(join(dir, 'writer.lock'), 'utf8'));
  assert.equal(lock.boot_id, boot);
  await assert.rejects(new OperationStore(dir).init(BINDING), { code: 'OPERATION_STORE_LOCKED' });
});
test('external append is detected and all later appends are latched off', async t => {
  const { store, dir } = await fixture(t);
  await appendFile(join(dir, 'operations.jsonl'), '{}\n');
  await assert.rejects(store.append(pending()), { code: 'OPERATION_STORE' });
  await assert.rejects(store.list(), { code: 'OPERATION_STORE' });
  await assert.rejects(store.append(pending()), { code: 'OPERATION_STORE' });
});
