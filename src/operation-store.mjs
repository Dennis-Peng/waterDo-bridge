import { constants } from 'node:fs';
import { open, lstat, realpath, unlink, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { STATE_DIR, secureDirectory } from './credentials.mjs';
import { BridgeError } from './core.mjs';

const LIMIT = 16 * 1024 * 1024;
const FIELDS = ['request_id', 'request_hash', 'action', 'state', 'task_id', 'result_version', 'created_at', 'updated_at', 'error_code'];
const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const iso = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const fail = () => new BridgeError('OPERATION_STORE', '操作记录不可用或不安全；停止写入，勿删除记录后重试。', 503);
const owner = s => typeof process.getuid !== 'function' || s.uid === process.getuid();
const safeFile = s => s.isFile() && s.nlink === 1 && owner(s) && (s.mode & 0o7777) === 0o600;
const same = (a, b) => a.ino === b.ino && a.dev === b.dev;
function record(input) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).length !== FIELDS.length || Reflect.ownKeys(input).some(k => !FIELDS.includes(k))) throw fail();
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail();
  }
  const r = { ...input };
  if (!uuid(r.request_id) || !hash(r.request_hash) || !['create', 'update', 'delete', 'complete', 'tag_update'].includes(r.action)
      || !['pending', 'succeeded', 'failed', 'unknown'].includes(r.state)
      || !(r.task_id === null || id(r.task_id)) || !(r.result_version === null || hash(r.result_version))
      || !iso(r.created_at) || !iso(r.updated_at) || Date.parse(r.updated_at) < Date.parse(r.created_at)
      || !(r.error_code === null || (typeof r.error_code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(r.error_code)))) throw fail();
  if (r.action !== 'create' && r.task_id === null) throw fail();
  if (r.state === 'succeeded' && (r.task_id === null || r.error_code !== null)) throw fail();
  return r;
}
function transition(previous, next) {
  if (!previous) { if (next.state !== 'pending') throw fail(); return; }
  if (previous.state !== 'pending' || previous.request_hash !== next.request_hash || previous.action !== next.action
      || previous.created_at !== next.created_at || Date.parse(previous.updated_at) > Date.parse(next.updated_at)
      || (previous.task_id !== null && previous.task_id !== next.task_id)) throw fail();
}

/** Single writer lifetime lock. No plaintext task content, tokens or passphrases in records. */
export class OperationStore {
  #directory; #lock; #ready = false; #records = new Map(); #observed; #failed = false; #saving = false;
  #appendDone = null; #closing = false;
  constructor(directory = resolve(STATE_DIR, 'operations')) { this.#directory = resolve(directory); }
  async #directoryCheck() {
    const s = await lstat(this.#directory);
    if (!s.isDirectory() || s.isSymbolicLink() || !owner(s) || (s.mode & 0o7777) !== 0o700 || await realpath(this.#directory) !== this.#directory) throw fail();
  }
  async #syncDirectory() {
    const h = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await h.sync(); } finally { await h.close(); }
  }
  async #readFile(name, limit = LIMIT) {
    const path = resolve(this.#directory, name);
    let h;
    try {
      const observed = await lstat(path);
      if (!safeFile(observed) || observed.size > limit || await realpath(path) !== path) throw fail();
      h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const s = await h.stat();
      if (!safeFile(s) || !same(s, observed) || s.size !== observed.size) throw fail();
      const bytes = Buffer.alloc(s.size + 1);
      let total = 0;
      while (total < bytes.length) { const { bytesRead } = await h.read(bytes, total, bytes.length - total, total); if (!bytesRead) break; total += bytesRead; }
      const after = await h.stat(), current = await lstat(path);
      if (total !== s.size || !same(after, current) || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) throw fail();
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)), stat: after };
    } catch (error) { if (error.code === 'ENOENT') return null; throw fail(); }
    finally { await h?.close(); }
  }
  async #newFile(name, text) {
    let h;
    try {
      h = await open(resolve(this.#directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await h.writeFile(text); await h.sync(); await this.#syncDirectory();
    } finally { await h?.close(); }
  }
  async #checkLock() {
    if (!this.#lock) throw fail();
    await this.#directoryCheck();
    const path = resolve(this.#directory, 'writer.lock');
    const current = await lstat(path), held = await this.#lock.stat();
    if (!safeFile(current) || !same(current, held) || await realpath(path) !== path) throw fail();
  }
  async #bootId() {
    const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw fail();
    return value;
  }
  async #acquireLock() {
    const path = resolve(this.#directory, 'writer.lock');
    const bootId = await this.#bootId();
    try { return { handle: await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), bootId }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Only a different kernel boot proves the previous process cannot exist.
      // Same-boot crashes stay locked for manual review; pending records are never erased.
      const previous = await this.#readFile('writer.lock', 512);
      let meta;
      try { meta = JSON.parse(previous?.text); } catch { throw new BridgeError('OPERATION_STORE_LOCKED', '旧锁不可验证，需人工核对。', 409); }
      if (!meta || !Number.isSafeInteger(meta.pid) || meta.pid < 1 || !iso(meta.created_at)
          || typeof meta.boot_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(meta.boot_id)
          || meta.boot_id === bootId) throw new BridgeError('OPERATION_STORE_LOCKED', '另一个写服务正在运行或本次开机留下锁，请先核对。', 409);
      // Serialize stale-lock recovery too. Keep this tiny per-boot marker: a
      // crashed/uncertain recovery cannot race another startup and unlink its lock.
      let recovery;
      try { recovery = await open(resolve(this.#directory, `recovery-${bootId}.lock`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch { throw new BridgeError('OPERATION_STORE_LOCKED', '本次开机已有恢复尝试，请先核对。', 409); }
      try { await recovery.writeFile('reserved\n'); await recovery.sync(); } finally { await recovery.close(); }
      await this.#syncDirectory();
      const current = await lstat(path);
      if (!same(current, previous.stat) || !safeFile(current) || await realpath(path) !== path || dirname(path) !== this.#directory) throw fail();
      await unlink(path); await this.#syncDirectory();
      return { handle: await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), bootId };
    }
  }
  async init(binding) {
    if (this.#ready || this.#lock || !hash(binding)) throw fail();
    try {
      await secureDirectory(this.#directory); await this.#directoryCheck();
      // Persist the new operations-directory entry itself, not only files inside it.
      const parent = await open(dirname(this.#directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
      const lock = await this.#acquireLock(); this.#lock = lock.handle;
      await this.#lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), boot_id: lock.bootId }) + '\n');
      await this.#lock.sync(); await this.#syncDirectory();
      const existing = await this.#readFile('binding', 128);
      const log = await this.#readFile('operations.jsonl');
      if (existing) {
        if (existing.text !== `${binding}\n`) throw new BridgeError('ACCOUNT_BINDING_CHANGED', '凭据绑定已变化；为防跨账号重放停止写入，请核对后迁移操作记录。', 409);
        if (!log) throw fail();
      } else {
        if (log) throw fail();
        await this.#newFile('binding', `${binding}\n`);
        await this.#newFile('operations.jsonl', '');
      }
      const loaded = log ?? await this.#readFile('operations.jsonl');
      if (!loaded || (loaded.text && !loaded.text.endsWith('\n'))) throw fail();
      for (const line of loaded.text ? loaded.text.slice(0, -1).split('\n') : []) {
        const next = record(JSON.parse(line)); transition(this.#records.get(next.request_id), next); this.#records.set(next.request_id, next);
      }
      this.#observed = loaded.stat; this.#ready = true;
    } catch (error) {
      await this.close().catch(() => {});
      if (error instanceof BridgeError) throw error;
      throw fail();
    }
  }
  #assertReady() { if (!this.#ready || this.#failed || this.#closing) throw fail(); }
  async list() { this.#assertReady(); return structuredClone([...this.#records.values()]); }
  async get(requestId) { this.#assertReady(); return structuredClone(this.#records.get(requestId) ?? null); }
  async append(input) {
    this.#assertReady();
    if (this.#saving) throw fail();
    const next = record(input); transition(this.#records.get(next.request_id), next);
    const line = JSON.stringify(next) + '\n';
    if (Buffer.byteLength(line) > 2048) throw fail();
    this.#saving = true;
    let completeAppend;
    this.#appendDone = new Promise(resolveDone => { completeAppend = resolveDone; });
    let h;
    try {
      await this.#checkLock();
      const path = resolve(this.#directory, 'operations.jsonl');
      const observed = await lstat(path);
      if (!safeFile(observed) || !same(observed, this.#observed) || observed.size !== this.#observed.size
          || observed.mtimeMs !== this.#observed.mtimeMs || observed.ctimeMs !== this.#observed.ctimeMs || await realpath(path) !== path) throw fail();
      // Leave a full record of space to persist a final/unknown outcome after pending.
      const reserve = next.state === 'pending' ? 2048 : 0;
      if (observed.size + Buffer.byteLength(line) + reserve > LIMIT) throw fail();
      h = await open(path, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await h.stat();
      if (!safeFile(before) || !same(before, observed) || before.size !== observed.size) throw fail();
      await h.writeFile(line); await h.sync(); await this.#syncDirectory();
      this.#observed = await h.stat(); this.#records.set(next.request_id, next);
    } catch { this.#failed = true; throw fail(); }
    finally {
      try { await h?.close(); }
      finally { this.#saving = false; completeAppend(); }
    }
  }
  async close() {
    this.#closing = true; this.#ready = false;
    // A service timeout does not cancel underlying fsync. Keep the writer lock
    // until the actual append/descriptor close settles, not just mutate's timeout.
    await this.#appendDone;
    if (!this.#lock) return;
    const h = this.#lock;
    try {
      await this.#checkLock();
      const path = resolve(this.#directory, 'writer.lock');
      if (dirname(path) !== this.#directory || await realpath(path) !== path) throw fail();
      await unlink(path); await this.#syncDirectory();
    } finally { await h.close(); this.#lock = undefined; }
  }
}
