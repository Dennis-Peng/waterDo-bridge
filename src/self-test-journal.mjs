import { constants } from 'node:fs';
import { open, lstat, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { STATE_DIR, secureDirectory } from './credentials.mjs';
import { BridgeError } from './core.mjs';

const safeError = () => new BridgeError('SELF_TEST_JOURNAL', '测试记录缺失、损坏或权限异常；停止写入，勿删除记录后重跑。', 409);
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const owner = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
function validate(state) {
  if (!state || state.version !== 1 || !uuid(state.plan?.run_id) || !uuid(state.plan?.series_id)
      || !Array.isArray(state.baseline) || state.baseline.some(t => !id(t.id) || !hash(t.hash))
      || (state.task_id !== null && !id(state.task_id)) || (state.last_hash !== null && !hash(state.last_hash))
      || !Array.isArray(state.verified_steps) || state.verified_steps.some(s => !['create', 'update', 'reschedule', 'delete'].includes(s))
      || typeof state.stage !== 'string' || !/^[a-z_]{1,40}$/.test(state.stage)) throw safeError();
  for (const field of ['title', 'updated_title', 'memo', 'updated_memo', 'created_at', 'due_at']) {
    if (typeof state.plan[field] !== 'string' || state.plan[field].length > 1024) throw safeError();
  }
  if (state.plan.title !== `[接口测试，请勿操作] ${state.plan.run_id} 新增验证`
      || state.plan.updated_title !== `[接口测试，请勿操作] ${state.plan.run_id} 修改验证`
      || state.plan.memo !== `WaterDo Bridge disposable test ${state.plan.run_id}; no real schedule; delete after verification.`
      || state.plan.updated_memo !== `WaterDo Bridge disposable test ${state.plan.run_id}; update verified; delete after verification.`
      || !Number.isFinite(Date.parse(state.plan.created_at)) || !Number.isFinite(Date.parse(state.plan.due_at))) throw safeError();
  return state;
}
function safeRecord(state) {
  validate(state);
  // Persist only the test plan and existing-record IDs/hashes, never real task text or credentials.
  return { version: state.version, plan: state.plan,
    baseline: state.baseline.map(({ id, hash }) => ({ id, hash })), task_id: state.task_id, last_hash: state.last_hash,
    stage: state.stage, verified_steps: state.verified_steps, updated_at: state.updated_at,
    baseline_unchanged: state.baseline_unchanged, error_code: state.error_code, stopped_at: state.stopped_at,
    uncertain_write: state.uncertain_write === true };
}
export class SelfTestJournal {
  #directory; #lock;
  constructor(directory = STATE_DIR) { this.#directory = resolve(directory); }
  async acquire() {
    if (this.#lock) throw safeError();
    await secureDirectory(this.#directory);
    try {
      this.#lock = await open(resolve(this.#directory, 'self-test.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await this.#lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
      await this.#lock.sync(); await this.#syncDirectory();
    } catch (error) {
      if (error.code === 'EEXIST') throw new BridgeError('SELF_TEST_LOCKED', '另一次测试正在运行，或上次中断留下锁；请勿并行测试或删除记录后重跑。', 409);
      throw safeError();
    }
  }
  async #syncDirectory() {
    const handle = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async prepare(state) {
    // A run uses fewer than 20 checkpoints. Reserve 128 including failure/recovery
    // attempts so a large baseline cannot exhaust the journal during a normal run.
    const bytes = Buffer.byteLength(JSON.stringify(safeRecord(state))) + 2048;
    if (bytes * 128 > 4 * 1024 * 1024) throw new BridgeError('SELF_TEST_BASELINE_TOO_LARGE', '基线记录过大，尚未发送写请求；需调整日志存储后再测试。', 409);
  }
  async load() {
    await secureDirectory(this.#directory);
    let handle;
    try {
      handle = await open(resolve(this.#directory, 'self-test.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || !owner(stat) || (stat.mode & 0o077) || stat.size > 4 * 1024 * 1024) throw safeError();
      const text = await handle.readFile('utf8');
      if (!text || !text.endsWith('\n')) throw safeError();
      const records = text.trimEnd().split('\n').map(line => validate(JSON.parse(line)));
      const first = records[0];
      for (const state of records) {
        if (JSON.stringify(state.plan) !== JSON.stringify(first.plan) || JSON.stringify(state.baseline) !== JSON.stringify(first.baseline)) throw safeError();
      }
      return records.at(-1);
    } catch (error) { if (error.code === 'ENOENT') return null; throw safeError(); }
    finally { await handle?.close(); }
  }
  async save(state) {
    if (!this.#lock) throw safeError();
    const record = safeRecord(state);
    const line = JSON.stringify(record) + '\n';
    // Inspect existing state before append; a damaged journal must never be overwritten.
    const prior = await this.load();
    if (prior && (JSON.stringify(prior.plan) !== JSON.stringify(record.plan) || JSON.stringify(prior.baseline) !== JSON.stringify(record.baseline))) throw safeError();
    let handle;
    try {
      handle = await open(resolve(this.#directory, 'self-test.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = await handle.stat();
      if (!stat.isFile() || !owner(stat) || (stat.mode & 0o077) || stat.size + Buffer.byteLength(line) > 4 * 1024 * 1024) throw safeError();
      await handle.writeFile(line); await handle.sync(); await this.#syncDirectory();
    } catch { throw safeError(); }
    finally { await handle?.close(); }
  }
  async release() {
    if (!this.#lock) return;
    const handle = this.#lock; this.#lock = undefined;
    const path = resolve(this.#directory, 'self-test.lock');
    try {
      const opened = await handle.stat(), current = await lstat(path);
      // Verify the exact absolute lock before unlink; never remove another process's lock.
      if (dirname(path) !== this.#directory || await realpath(path) !== path || !current.isFile()
          || current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev) throw safeError();
      await unlink(path);
    } finally { await handle.close(); }
  }
}
