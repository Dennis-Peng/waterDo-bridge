import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, appendFile, readFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError } from '../src/core.mjs';
import { runSelfTest, resumeSelfTest, cleanupSelfTest, inspectSelfTest, makeTestPlan } from '../src/self-test.mjs';
import { SelfTestJournal } from '../src/self-test-journal.mjs';

const plan = () => makeTestPlan(new Date('2026-11-05T10:00:00Z'));
class MemoryJournal {
  state = null; locked = false; history = [];
  async acquire() { assert.equal(this.locked, false); this.locked = true; }
  async load() { return structuredClone(this.state); }
  async save(state) { this.state = structuredClone(state); this.history.push(state.stage); }
  async release() { this.locked = false; }
}
const existing = () => ({ id: 8, title: 'PRIVATE existing task text', memo: 'PRIVATE existing notes', tag_id: null,
  task_due_at: null, task_done_at: null, done_date: null, is_remind_enabled: false, is_deleted: false, repeating_pattern: 0,
  series_id: 'old-series', repeating_origin_id: null, mystery_field: 'keep-me' });
function fixture(hooks = {}) {
  const journal = new MemoryJournal(), tasks = new Map([['8', existing()]]), calls = [];
  const transport = {
    async getTasks() { return [...tasks.values()].map(x => structuredClone(x)); },
    async getTask(id) {
      await hooks.get?.(id, tasks, calls);
      if (!tasks.has(id)) throw new BridgeError('NOT_FOUND', 'not found', 404);
      return structuredClone(tasks.get(id));
    },
    async createTask(task) {
      assert.equal(journal.state.stage, 'create_pending');
      calls.push(['create', structuredClone(task)]);
      const created = { ...structuredClone(task), id: 99, server_unknown: { keep: true } };
      tasks.set('99', created);
      if (hooks.create) return hooks.create(created, tasks, calls);
      return structuredClone(created);
    },
    async updateTask(id, task) {
      assert.match(journal.state.stage, /^(update|reschedule)_pending$/);
      calls.push(['update', id, structuredClone(task)]);
      if (hooks.update) await hooks.update(id, task, tasks, calls);
      tasks.set(id, structuredClone(task)); return structuredClone(task);
    },
    async deleteTask(id) {
      assert.match(journal.state.stage, /^(delete_pending|cleanup_delete_pending)$/);
      calls.push(['delete', id]);
      if (hooks.remove) return hooks.remove(id, tasks, calls);
      tasks.set(id, { ...tasks.get(id), is_deleted: true }); return { deleted: true };
    },
  };
  return { transport, journal, calls, tasks };
}
test('self-test creates only one disposable task, verifies changes and deletes; old tasks unchanged', async () => {
  const f = fixture(), before = structuredClone(f.tasks.get('8'));
  const report = await runSelfTest({ ...f, plan: plan() });
  assert.equal(report.state, 'completed'); assert.equal(report.baseline_unchanged, true);
  assert.deepEqual(report.verified_steps, ['create', 'update', 'reschedule', 'delete']);
  assert.deepEqual(f.calls.map(c => c[0]), ['create', 'update', 'update', 'delete']);
  assert.equal(f.calls[0][1].task_due_at, null);
  assert.equal(f.calls[2][2].task_due_at, '2026-11-06T02:00:00.000Z');
  assert.deepEqual(f.calls[1][2].server_unknown, { keep: true });
  for (const call of f.calls.slice(1)) assert.equal(call[1], '99');
  assert.deepEqual(f.tasks.get('8'), before);
  assert.equal(f.tasks.get('99').is_deleted, true);
  assert.ok(!JSON.stringify(f.journal.state).includes('PRIVATE'));
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  await runSelfTest({ ...f, plan: plan() });
  assert.equal(f.calls.length, 4, 're-running must not create a second task');
});
test('unknown create outcome is journaled and never retried or automatically deleted', async () => {
  const f = fixture({ create: () => { throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', 'unknown', 502); } });
  const report = await runSelfTest({ ...f, plan: plan() });
  assert.equal(report.state, 'stopped'); assert.equal(report.error_code, 'SELF_TEST_WRITE_UNKNOWN');
  assert.equal(report.task_id, null); assert.equal(f.calls.length, 1);
  await runSelfTest({ ...f, plan: plan() }); assert.equal(f.calls.length, 1);
  const cleanup = await cleanupSelfTest(f);
  assert.equal(cleanup.error_code, 'SELF_TEST_UNCERTAIN_REVIEW');
  assert.equal(cleanup.task_id, null); assert.equal(f.calls.length, 1);
});
test('create reply using existing task ID cannot authorize update/delete', async () => {
  const f = fixture({ create: created => ({ ...created, id: 8 }) });
  const report = await runSelfTest({ ...f, plan: plan() });
  assert.equal(report.error_code, 'SELF_TEST_EXISTING_ID'); assert.equal(f.calls.length, 1);
});
test('read-only diagnostics identify field drift without exporting secret or task text', async () => {
  const f = fixture({ create: (created, tasks) => {
    const altered = { ...created, done_date: 0, secret: 'never-export-this', series_id: created.series_id.toUpperCase() };
    delete altered.repeating_origin_id;
    tasks.set('99', altered); return altered;
  } });
  await runSelfTest({ ...f, plan: plan() });
  const before = JSON.stringify(f.journal.state);
  const diagnostic = await inspectSelfTest(f);
  assert.equal(diagnostic.writes_performed, false);
  assert.equal(diagnostic.series_id.exact_match, false);
  assert.equal(diagnostic.series_id.case_insensitive_match, true);
  assert.deepEqual(diagnostic.fields.done_date, { type: 'number', value: 0 });
  assert.deepEqual(diagnostic.fields.repeating_origin_id, { type: 'missing' });
  assert.equal(diagnostic.baseline_unchanged, true);
  assert.ok(!JSON.stringify(diagnostic).includes('never-export-this'));
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
  assert.equal(JSON.stringify(f.journal.state), before);
  assert.equal(f.calls.length, 1);
});
test('a non-recurring task may omit nullable repeating_origin_id without weakening other guards', async () => {
  const f = fixture({ create: (created, tasks) => {
    delete created.repeating_origin_id; tasks.set('99', created); return created;
  } });
  assert.equal((await runSelfTest({ ...f, plan: plan() })).state, 'completed');
});
test('resume the diagnosed omission modifies/deletes the same new task without another POST', async () => {
  const f = fixture({ create: (created, tasks) => {
    delete created.repeating_origin_id; tasks.set('99', created);
    throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', 'simulate old interrupted state', 502);
  } });
  await runSelfTest({ ...f, plan: plan() });
  f.journal.state.error_code = 'SELF_TEST_OWNERSHIP'; // The recorded old-version failure, not a generic timeout.
  const result = await resumeSelfTest(f);
  assert.equal(result.state, 'completed'); assert.equal(result.task_id, '99');
  assert.deepEqual(f.calls.map(c => c[0]), ['create', 'update', 'update', 'delete']);
  await resumeSelfTest(f); assert.equal(f.calls.length, 4);
});
test('resume cannot override unknown writes, existing IDs or unexplained state', async () => {
  const f = fixture({ create: () => { throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', 'unknown', 502); } });
  await runSelfTest({ ...f, plan: plan() });
  await assert.rejects(resumeSelfTest(f), { code: 'SELF_TEST_RESUME_DENIED' });
  assert.equal(f.calls.length, 1);
  f.journal.state.error_code = 'SELF_TEST_OWNERSHIP';
  f.tasks.get('99').id = 8;
  const result = await resumeSelfTest(f);
  assert.equal(result.error_code, 'SELF_TEST_EXISTING_ID'); assert.equal(f.calls.length, 1);
});
test('reminder/repeat/ownership drift stops before updating', async () => {
  for (const changed of [{ is_remind_enabled: true }, { repeating_pattern: 1 }, { series_id: 'other' }, { tag_id: 42 }]) {
    const f = fixture({ create: created => ({ ...created, ...changed }) });
    const report = await runSelfTest({ ...f, plan: plan() });
    assert.equal(report.error_code, 'SELF_TEST_OWNERSHIP'); assert.equal(f.calls.length, 1);
  }
});
test('concurrent test edit stops before any update and explicit cleanup also refuses', async () => {
  let reads = 0;
  const f = fixture({ get: (id, tasks) => {
    if (id === '99' && ++reads === 2) tasks.get('99').server_unknown = 'externally-changed';
  } });
  const result = await runSelfTest({ ...f, plan: plan() });
  assert.equal(result.error_code, 'SELF_TEST_CONCURRENT_CHANGE'); assert.equal(f.calls.length, 1);
  assert.equal((await cleanupSelfTest(f)).error_code, 'SELF_TEST_CLEANUP_REVIEW');
  assert.equal(f.calls.length, 1);
});
test('failed update can be explicitly cleaned only if last verified object is unchanged', async () => {
  const f = fixture({ update: () => { throw new BridgeError('SELF_TEST_REJECTED', 'rejected', 422); } });
  assert.equal((await runSelfTest({ ...f, plan: plan() })).state, 'stopped');
  assert.deepEqual(f.calls.map(c => c[0]), ['create', 'update']);
  const cleanup = await cleanupSelfTest(f);
  assert.equal(cleanup.state, 'cleaned'); assert.equal(cleanup.baseline_unchanged, true);
  assert.equal(f.calls.at(-1)[0], 'delete'); assert.equal(f.calls.at(-1)[1], '99');
});
test('unknown delete response requires manual review and never repeats DELETE', async () => {
  const f = fixture({ remove: (id, tasks) => {
    tasks.delete(id); throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', 'unknown', 502);
  } });
  const initial = await runSelfTest({ ...f, plan: plan() });
  assert.equal(initial.state, 'stopped'); assert.equal(f.calls.length, 4);
  assert.equal((await cleanupSelfTest(f)).error_code, 'SELF_TEST_UNCERTAIN_REVIEW'); assert.equal(f.calls.length, 4);
});
test('delayed unknown PUT cannot be followed by automatic cleanup DELETE', async () => {
  let finishPut;
  const f = fixture({ update: (id, body, tasks) => {
    finishPut = () => tasks.set(id, structuredClone(body));
    throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', 'still in flight', 502);
  } });
  assert.equal((await runSelfTest({ ...f, plan: plan() })).state, 'stopped');
  assert.equal((await cleanupSelfTest(f)).error_code, 'SELF_TEST_UNCERTAIN_REVIEW');
  finishPut();
  assert.equal((await cleanupSelfTest(f)).error_code, 'SELF_TEST_UNCERTAIN_REVIEW');
  assert.deepEqual(f.calls.map(c => c[0]), ['create', 'update']);
});
test('large baseline is rejected before POST and cannot corrupt the durable journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-selftest-budget-'));
  const journal = new SelfTestJournal(directory);
  let writes = 0;
  const transport = {
    getTasks: async () => Array.from({ length: 8000 }, (_, i) => ({ ...existing(), id: i + 1 })),
    createTask: async () => { writes++; },
  };
  await assert.rejects(runSelfTest({ transport, journal, plan: plan() }), { code: 'SELF_TEST_BASELINE_TOO_LARGE' });
  assert.equal(writes, 0); assert.equal(await journal.load(), null);
  assert.deepEqual(await readdir(directory), []);
});
test('unchanged list after purported deletion is not claimed as success', async () => {
  const f = fixture({ remove: () => ({ deleted: true }) });
  const result = await runSelfTest({ ...f, plan: plan() });
  assert.equal(result.error_code, 'SELF_TEST_DELETE_UNVERIFIED');
  assert.equal(result.cleanup, 'not_verified');
});
test('changes to original tasks are reported, never automatically restored', async () => {
  const f = fixture({ remove: (id, tasks) => { tasks.delete(id); tasks.get('8').title = 'concurrent edit'; } });
  const result = await runSelfTest({ ...f, plan: plan() });
  assert.equal(result.error_code, 'SELF_TEST_BASELINE_CHANGED');
  assert.equal(result.baseline_unchanged, false);
  assert.equal(f.calls.length, 4);
});
test('journal failure before a write cannot send the remote write', async () => {
  const f = fixture();
  f.journal.save = async () => { throw new BridgeError('SELF_TEST_JOURNAL', 'disk failed', 409); };
  await assert.rejects(runSelfTest({ ...f, plan: plan() }), { code: 'SELF_TEST_JOURNAL' });
  assert.equal(f.calls.length, 0); assert.equal(f.journal.locked, false);
});
test('persistent journal is private, append-only, locked and contains no original task text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-selftest-'));
  const disk = new SelfTestJournal(directory);
  const f = fixture();
  // The fixture asserts pending-state safety via the same in-memory journal;
  // mirror saved states to disk for durability tests without touching live credentials.
  const memory = f.journal;
  const originalSave = memory.save.bind(memory);
  memory.acquire = () => disk.acquire(); memory.release = () => disk.release();
  memory.save = async state => { await disk.save(state); await originalSave(state); };
  const result = await runSelfTest({ ...f, plan: plan() });
  assert.equal(result.state, 'completed');
  const loaded = await disk.load(); assert.equal(loaded.stage, 'completed');
  const path = join(directory, 'self-test.jsonl');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const text = await readFile(path, 'utf8'); assert.ok(!text.includes('PRIVATE'));
  assert.ok(text.trim().split('\n').length > 5);
  assert.deepEqual(await readdir(directory), ['self-test.jsonl']);
  await disk.acquire();
  await assert.rejects(new SelfTestJournal(directory).acquire(), { code: 'SELF_TEST_LOCKED' });
  await disk.release();
  await appendFile(path, '{partial');
  await assert.rejects(disk.load(), { code: 'SELF_TEST_JOURNAL' });
  await chmod(path, 0o644);
  await assert.rejects(disk.load(), { code: 'SELF_TEST_JOURNAL' });
});
