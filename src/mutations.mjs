import { createHash, randomInt, randomUUID } from 'node:crypto';
import { BridgeError, normalizeTask, validateId } from './core.mjs';
import { RECURRENCE_PATTERNS, RECURRENCE_WARNINGS, recurrenceName, nextDueAt, shanghaiDate } from './recurrence.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const error = (code, message, status) => new BridgeError(code, message, status);
const invalid = () => error('INVALID_MUTATION', '写入参数不合法；仅支持受控任务、基础重复、提醒开关与标签修改。', 400);
const actions = ['create', 'update', 'delete', 'complete', 'tag_update'];
const schema = () => error('UPSTREAM_SCHEMA', 'WaterDo 任务格式无法安全验证；未自动重试。', 502);
const mismatch = () => error('WRITE_READBACK', '写入回读不一致；停止后续写入，请先核对操作状态。', 502);
const storeError = () => error('OPERATION_STORE', '操作记录不可安全使用；已停止后续写入。', 503);
const timeoutError = () => error('WRITE_TIMEOUT', '操作时间超出安全上限；未自动重试。', 504);
const blocked = () => error('WRITES_BLOCKED', '存在待核对的写入结果；不能使用新的请求 ID 重发。', 409);
const hashPattern = /^[a-f0-9]{64}$/;
const recordKeys = ['request_id', 'request_hash', 'action', 'state', 'task_id', 'result_version', 'created_at', 'updated_at', 'error_code'];
const states = new Set(['pending', 'succeeded', 'failed', 'unknown']);
const warnings = [
  '仅支持基础重复规则（Asia/Shanghai）；提醒仅存储开关与到期时刻，delivery_verified=false，未验收手机通知送达。',
  '重复完成先完成原项再创建下一项，非事务；仅推进一期，不自动跳过历史期数。',
  ...RECURRENCE_WARNINGS,
  '上游没有条件写入保证；版本核对与写入间仍存在并发窗口，列表完整性未经验证。',
  '结果未知时不得换请求 ID 重发；相同请求 ID 仅查询或回放原操作。',
];
const safeCodes = new Set(['AUTH_EXPIRED', 'UPSTREAM_FORBIDDEN', 'NOT_FOUND', 'UPSTREAM_RATE_LIMIT',
  'SELF_TEST_REJECTED', 'SELF_TEST_WRITE_UNKNOWN', 'UPSTREAM_ERROR', 'UPSTREAM_NETWORK', 'UPSTREAM_SCHEMA',
  'UPSTREAM_TOO_LARGE', 'INVALID_TASK', 'WRITE_READBACK', 'WRITE_TIMEOUT', 'UNSUPPORTED_TASK']);
const rejectedCodes = new Set(['AUTH_EXPIRED', 'UPSTREAM_FORBIDDEN', 'NOT_FOUND', 'UPSTREAM_RATE_LIMIT', 'SELF_TEST_REJECTED', 'INVALID_TASK']);
const safeCode = e => e instanceof BridgeError && safeCodes.has(e.code) ? e.code : 'WRITE_UNKNOWN';
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// API input is JSON-shaped data only: reject accessors, symbols and prototype tricks before reading values.
function fields(value, allowed) {
  if (!plain(value)) throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !own(descriptor, 'value')) throw invalid();
  }
}
export function validateRequestId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw invalid();
  return id;
}
function timestamp(value) {
  if (typeof value !== 'string') throw invalid();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) throw invalid();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!year || month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59
      || m[8] === '-00:00' || (m[8] !== 'Z' && (Number(m[8].slice(1, 3)) > 23 || Number(m[8].slice(4)) > 59))) throw invalid();
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw invalid();
  // Preserve sub-millisecond precision rather than silently rounding an otherwise explicit timestamp.
  const fraction = (m[7]?.slice(1) ?? '').padEnd(3, '0').replace(/0+$/, '');
  const utc = new Date(millis).toISOString();
  if (utc.length !== 24 || utc.startsWith('0000-')) throw invalid();
  return `${utc.slice(0, 19)}.${fraction.padEnd(3, '0')}Z`;
}
export function validateMutation(input) {
  fields(input, ['request_id', 'action', 'task_id', 'tag_id', 'expected_version', 'changes']);
  const request_id = validateRequestId(input.request_id), action = input.action;
  if (!actions.includes(action)) throw invalid();
  const target = action === 'tag_update' ? 'tag_id' : 'task_id';
  fields(input, action === 'create' ? ['request_id', 'action', 'changes']
    : ['delete', 'complete'].includes(action) ? ['request_id', 'action', target, 'expected_version']
      : ['request_id', 'action', target, 'expected_version', 'changes']);
  const result = { request_id, action };
  if (action !== 'create') {
    try { result[target] = validateId(input[target]); } catch { throw invalid(); }
    if (typeof input.expected_version !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.expected_version)) throw invalid();
    result.expected_version = input.expected_version.toLowerCase();
  }
  if (action === 'tag_update') {
    fields(input.changes, ['name', 'color_id']);
    if (!Object.keys(input.changes).length) throw invalid();
    result.changes = {};
    if (own(input.changes, 'name')) {
      if (typeof input.changes.name !== 'string' || !input.changes.name.trim() || input.changes.name.length > 100) throw invalid();
      result.changes.name = input.changes.name.trim();
    }
    if (own(input.changes, 'color_id')) {
      if (!Number.isInteger(input.changes.color_id) || input.changes.color_id < 1 || input.changes.color_id > 10) throw invalid();
      result.changes.color_id = input.changes.color_id;
    }
  } else if (['create', 'update'].includes(action)) {
    fields(input.changes, ['title', 'notes', 'due_at', 'recurrence', 'reminder_enabled', 'tag_id']);
    if (!Object.keys(input.changes).length || (action === 'create' && !own(input.changes, 'title'))) throw invalid();
    const changes = {};
    if (own(input.changes, 'title')) {
      if (typeof input.changes.title !== 'string' || input.changes.title.length > 500 || !input.changes.title.trim()) throw invalid();
      changes.title = input.changes.title.trim();
    }
    if (own(input.changes, 'notes')) {
      if (typeof input.changes.notes !== 'string' || input.changes.notes.length > 10000) throw invalid();
      changes.notes = input.changes.notes;
    } else if (action === 'create') changes.notes = '';
    if (own(input.changes, 'due_at')) changes.due_at = input.changes.due_at === null ? null : timestamp(input.changes.due_at);
    else if (action === 'create') changes.due_at = null;
    if (own(input.changes, 'recurrence')) {
      if (typeof input.changes.recurrence !== 'string' || !own(RECURRENCE_PATTERNS, input.changes.recurrence)) throw invalid();
      changes.recurrence = input.changes.recurrence;
    } else if (action === 'create') changes.recurrence = 'none';
    if (own(input.changes, 'reminder_enabled')) {
      if (typeof input.changes.reminder_enabled !== 'boolean') throw invalid();
      changes.reminder_enabled = input.changes.reminder_enabled;
    } else if (action === 'create') changes.reminder_enabled = false;
    if (own(input.changes, 'tag_id')) {
      try { changes.tag_id = input.changes.tag_id === null ? null : validateId(input.changes.tag_id); } catch { throw invalid(); }
    } else if (action === 'create') changes.tag_id = null;
    if (changes.reminder_enabled === true && (!own(input.changes, 'due_at') || changes.due_at === null)) throw invalid();
    if (changes.due_at === null && (changes.reminder_enabled === true || (own(changes, 'recurrence') && changes.recurrence !== 'none'))) throw invalid();
    result.changes = changes;
  }
  return result;
}

// Unknown JSON fields survive update unchanged, but malformed/non-JSON objects never reach PUT.
function jsonData(value, depth = 0, seen = new Set()) {
  if (depth > 100) throw schema();
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if ((!plain(value) && !Array.isArray(value)) || seen.has(value)) throw schema();
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d.enumerable || !own(d, 'value')) throw schema();
    jsonData(d.value, depth + 1, seen);
  }
  seen.delete(value);
}
function rawTask(raw) {
  if (!plain(raw)) throw schema();
  jsonData(raw);
  for (const key of ['id', 'title', 'memo', 'task_due_at', 'task_done_at', 'is_deleted', 'is_remind_enabled', 'repeating_pattern']) {
    if (!own(raw, key)) throw schema();
  }
  // A second camelCase representation must not hide a contradictory safety flag.
  for (const [snake, camel] of [['is_deleted', 'isDeleted'], ['task_done_at', 'taskDoneAt'], ['is_remind_enabled', 'isRemindEnabled'],
    ['repeating_pattern', 'repeatingPattern'], ['done_date', 'doneDate'], ['is_restored', 'isRestored'],
    ['repeating_origin_id', 'repeatingOriginId'], ['ignore_expired', 'ignoreExpired'], ['task_due_at', 'taskDueAt'], ['tag_id', 'tagId']]) {
    if (own(raw, camel) && (!own(raw, snake) || !same(raw[snake], raw[camel]))) throw schema();
  }
  for (const key of ['task_due_at', 'task_done_at']) {
    if (raw[key] !== null) { try { timestamp(raw[key]); } catch { throw schema(); } }
  }
  try { return normalizeTask(raw); } catch { throw schema(); }
}
function supportedTask(raw, { deleted = false, completed = null } = {}) {
  const task = rawTask(raw), recurrence = recurrenceName(raw.repeating_pattern);
  if (raw.is_deleted !== deleted || recurrence === null
      || (completed === null ? raw.task_done_at !== null || (own(raw, 'done_date') && raw.done_date !== null)
        : !sameDue(raw.task_done_at, completed.task_done_at) || raw.done_date !== completed.done_date)
      || ((raw.is_remind_enabled || recurrence !== 'none') && raw.task_due_at === null)
      || (own(raw, 'repeating_origin_id') && raw.repeating_origin_id !== null)
      || (own(raw, 'is_restored') && raw.is_restored !== false)
      || (own(raw, 'ignore_expired') && raw.ignore_expired !== false)) {
    throw error('UNSUPPORTED_TASK', '仅可写入受支持的未完成任务；复杂重复、自动跳期、恢复状态不受支持。', 422);
  }
  if (recurrence !== 'none' && (typeof raw.series_id !== 'string' || !raw.series_id
      || !Number.isSafeInteger(raw.sequence_num) || raw.sequence_num < 1 || raw.sequence_num >= Number.MAX_SAFE_INTEGER)) throw schema();
  return task;
}
function rawTag(raw) {
  if (!plain(raw)) throw schema();
  jsonData(raw);
  if (!own(raw, 'id') || !['number', 'string'].includes(typeof raw.id) || (typeof raw.id === 'number' && !Number.isSafeInteger(raw.id))
    || typeof raw.name !== 'string' || typeof raw.is_deleted !== 'boolean' || !Number.isInteger(raw.color_id)
    || raw.color_id < 0 || raw.color_id > 10) throw schema();
  for (const [snake, camel] of [['color_id', 'colorId'], ['is_deleted', 'isDeleted']]) {
    if (own(raw, camel) && !same(raw[snake], raw[camel])) throw schema();
  }
  let id; try { id = validateId(String(raw.id)); } catch { throw schema(); }
  return { id, version: hash(raw) };
}
function taskList(list) {
  if (!Array.isArray(list)) throw schema();
  const ids = new Set();
  for (const raw of list) { const id = rawTask(raw).id; if (ids.has(id)) throw schema(); ids.add(id); }
  return ids;
}
function sameDue(a, b) {
  if (a === null || b === null) return a === b;
  try { return timestamp(a) === timestamp(b); } catch { return false; }
}
function verifyFields(raw, expected, ignored = ['modified_time', 'updated_at']) {
  for (const key of Object.keys(expected)) {
    if (ignored.includes(key)) continue;
    // Real upstream omits this nullable field on persisted non-shadow tasks.
    // No other absent/null field is silently treated as equivalent.
    if (key === 'repeating_origin_id' && expected[key] === null && !own(raw, key)) continue;
    if (!own(raw, key) || !(key.startsWith('task_') && key.endsWith('_at') ? sameDue(raw[key], expected[key]) : same(raw[key], expected[key]))) throw mismatch();
  }
}
function verifyCreated(raw, payload, baseline) {
  const task = supportedTask(raw);
  if (baseline.ids.has(task.id)) throw mismatch();
  verifyFields(raw, payload, ['id', 'created_at', 'updated_at', 'modified_time']);
  return task;
}
function temporaryId(baseline) {
  let id; do { id = randomInt(1, 2 ** 48); } while (baseline.ids.has(String(id)));
  return id;
}
function createPayload(input, baseline, tagId) {
  const id = temporaryId(baseline);
  let series_id; do { series_id = randomUUID(); } while (baseline.raw.some(task => task.series_id === series_id));
  const now = new Date().toISOString();
  return { id, title: input.changes.title, memo: input.changes.notes, tag_id: tagId,
    task_created_at: now, task_due_at: input.changes.due_at, task_done_at: null, done_date: null,
    is_deleted: false, is_restored: false, is_remind_enabled: input.changes.reminder_enabled, repeating_pattern: RECURRENCE_PATTERNS[input.changes.recurrence],
    reorderable_orders: [], sequence_num: 1, series_id, importance: 1,
    modified_time: now, created_at: null, updated_at: null, repeating_origin_id: null, ignore_expired: false };
}
function nextPayload(original, baseline) {
  const now = new Date().toISOString();
  return { ...structuredClone(original), id: temporaryId(baseline), task_created_at: now, modified_time: now,
    task_due_at: nextDueAt(original.task_due_at, original.repeating_pattern), sequence_num: original.sequence_num + 1,
    task_done_at: null, done_date: null, is_deleted: false, is_restored: false, created_at: null, updated_at: null };
}
function seriesCandidates(list, payload) {
  return list.filter(t => t.is_deleted === false && t.series_id === payload.series_id && t.sequence_num === payload.sequence_num);
}
function verifySeriesBaseline(list, original, next, expectedVersion, conflict) {
  taskList(list);
  const source = list.find(t => String(t.id) === String(original.id));
  const current = seriesCandidates(list, original);
  if (!source || rawTask(source).version !== expectedVersion || current.length !== 1 || current[0] !== source
    || seriesCandidates(list, next).length !== 0) throw conflict();
  // Malformed sequence values in this series must not hide an existing successor.
  if (list.some(t => t.is_deleted === false && t.series_id === original.series_id
    && (!Number.isSafeInteger(t.sequence_num) || t.sequence_num < 1))) throw schema();
}
function checkRecord(record) {
  try {
    fields(record, recordKeys);
    if (Object.keys(record).length !== recordKeys.length) throw storeError();
    validateRequestId(record.request_id);
    if (typeof record.request_hash !== 'string' || !hashPattern.test(record.request_hash) || !actions.includes(record.action) || !states.has(record.state)
      || (record.task_id !== null && validateId(record.task_id) !== record.task_id)
      || (record.result_version !== null && (typeof record.result_version !== 'string' || !hashPattern.test(record.result_version)))
      || ![record.created_at, record.updated_at].every(t => typeof t === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t) && new Date(t).toISOString() === t)
      || (record.error_code !== null && (typeof record.error_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(record.error_code)))
      || record.updated_at < record.created_at || (record.action !== 'create' && record.task_id === null)
      || (record.state === 'succeeded' && (record.task_id === null || record.error_code !== null))) throw storeError();
    return structuredClone(record);
  } catch { throw storeError(); }
}
function publicOperation(record) {
  const { request_hash: _private, ...metadata } = checkRecord(record);
  // Never expose arbitrary external error text, even if a caller supplies an unsafe store implementation.
  if (metadata.error_code !== null && !safeCodes.has(metadata.error_code)) metadata.error_code = 'WRITE_UNKNOWN';
  return { ...metadata, warnings: [...warnings] };
}

/** No retries. Store ownership/account binding must be initialized by the startup code first. */
export class MutationService {
  #transport;
  #store;
  #active = null;
  #blocking = null;
  #storeBroken = false;
  #settled = new Set();
  constructor({ transport, store }) {
    if (!transport || !store || !['getTasks', 'getTask', 'createTask', 'updateTask', 'deleteTask'].every(k => typeof transport[k] === 'function')
      || !['list', 'get', 'append'].every(k => typeof store[k] === 'function')) throw storeError();
    this.#transport = transport; this.#store = store;
  }
  // Use one absolute deadline for the entire operation, including slow/asynchronous stores.
  // Leave 2 seconds of the ~60 second budget to persist a safe terminal outcome.
  async #bounded(fn, deadline) {
    if (performance.now() >= deadline) throw timeoutError();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (performance.now() >= deadline) throw timeoutError(); return fn(); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), Math.max(1, deadline - performance.now())); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async #storage(method, args, deadline) {
    if (this.#storeBroken) throw storeError();
    try { return await this.#bounded(() => this.#store[method](...args), deadline); }
    catch { this.#storeBroken = true; throw storeError(); }
  }
  async #records(deadline) {
    const records = await this.#storage('list', [], deadline);
    try {
      if (!Array.isArray(records)) throw storeError();
      const ids = new Set();
      for (const raw of records) {
        const r = checkRecord(raw);
        if (ids.has(r.request_id)) throw storeError();
        ids.add(r.request_id);
        // A concurrent status() may finish a stale pending snapshot after durable completion.
        if (r.state === 'unknown' || (r.state === 'pending' && !this.#settled.has(r.request_id))) this.#blocking ??= r.request_id;
      }
      return records;
    } catch { this.#storeBroken = true; throw storeError(); }
  }
  async #get(id, deadline) {
    const record = await this.#storage('get', [id], deadline);
    if (record === null) return null;
    try { const checked = checkRecord(record); if (checked.request_id !== id) throw storeError(); return checked; }
    catch { this.#storeBroken = true; throw storeError(); }
  }
  async status() {
    if (!this.#storeBroken) await this.#records(performance.now() + 60_000);
    return { writes_blocked: this.#storeBroken || this.#blocking !== null, blocking_request_id: this.#blocking };
  }
  async getOperation(requestId) {
    validateRequestId(requestId);
    const record = await this.#get(requestId, performance.now() + 60_000);
    if (!record) throw error('OPERATION_NOT_FOUND', '未找到该操作。', 404);
    return publicOperation(record);
  }
  async mutate(value) {
    const input = validateMutation(value);
    const { request_id, ...body } = input;
    // Preserve hashes for already persisted ordinary create requests across this additive API upgrade.
    if (body.action === 'create') {
      body.changes = { ...body.changes };
      if (body.changes.recurrence === 'none') delete body.changes.recurrence;
      if (body.changes.reminder_enabled === false) delete body.changes.reminder_enabled;
      if (body.changes.tag_id === null) delete body.changes.tag_id;
    }
    const request_hash = hash(body);
    if (this.#active) {
      if (this.#active.id !== request_id) throw error('OPERATION_BUSY', '已有操作正在执行；未排队或发送本次写入。', 409);
      if (this.#active.hash !== request_hash) throw error('IDEMPOTENCY_CONFLICT', '同一请求 ID 不能用于不同内容。', 409);
      return this.#active.promise;
    }
    // Set the lock synchronously, before the first asynchronous store or transport access.
    const active = { id: request_id, hash: request_hash, promise: null };
    this.#active = active;
    active.promise = Promise.resolve().then(() => this.#run(input, request_hash)).finally(() => { this.#active = null; });
    return active.promise;
  }
  async #readTag(id, deadline) {
    if (typeof this.#transport.getTag !== 'function') throw schema();
    const raw = await this.#bounded(() => this.#transport.getTag(id), deadline);
    const tag = rawTag(raw);
    if (tag.id !== id) throw schema();
    if (raw.is_deleted) throw error('NOT_FOUND', '标签不存在或已删除。', 404);
    return raw;
  }
  async #verifyCreated(response, payload, baseline, deadline, { original = null, completedVersion = null } = {}) {
    const created = verifyCreated(response, payload, baseline);
    const readback = await this.#bounded(() => this.#transport.getTask(created.id), deadline);
    const task = verifyCreated(readback, payload, baseline);
    if (task.id !== created.id) throw mismatch();
    const list = await this.#bounded(() => this.#transport.getTasks(), deadline);
    taskList(list);
    const matches = original ? seriesCandidates(list, payload) : list.filter(t => t.series_id === payload.series_id);
    const listed = list.find(t => String(t.id) === created.id);
    if (matches.length !== 1 || !listed || matches[0] !== listed || rawTask(listed).version !== task.version) throw mismatch();
    if (original) {
      const source = list.find(t => String(t.id) === String(original.id));
      if (!source || rawTask(source).version !== completedVersion || seriesCandidates(list, original).length !== 1) throw mismatch();
    }
    return task;
  }
  async #run(input, request_hash) {
    const end = performance.now() + 60_000, deadline = end - 2_000;
    await this.#records(deadline);
    const prior = await this.#get(input.request_id, deadline);
    if (prior) {
      if (prior.request_hash !== request_hash) throw error('IDEMPOTENCY_CONFLICT', '同一请求 ID 不能用于不同内容。', 409);
      return publicOperation(prior);
    }
    if (this.#blocking !== null) throw blocked();
    let original, payload, baseline, successor;
    const conflict = () => error('VERSION_CONFLICT', '目标或重复系列已发生变化；请重新读取后再决定操作。', 409);
    try {
      if (input.action === 'create') {
        const raw = await this.#bounded(() => this.#transport.getTasks(), deadline);
        baseline = { raw, ids: taskList(raw) };
        const tagId = input.changes.tag_id === null ? null : (await this.#readTag(input.changes.tag_id, deadline)).id;
        payload = createPayload(input, baseline, tagId);
        supportedTask(payload);
      } else if (input.action === 'tag_update') {
        if (typeof this.#transport.updateTag !== 'function') throw schema();
        original = await this.#readTag(input.tag_id, deadline);
        if (rawTag(original).version !== input.expected_version) throw conflict();
        payload = { ...structuredClone(original), ...input.changes };
        if (same(payload, original)) throw error('NO_CHANGES', '没有需要写入的变化。', 400);
        payload.modified_time = new Date().toISOString();
        rawTag(payload);
      } else {
        original = await this.#bounded(() => this.#transport.getTask(input.task_id), deadline);
        const normalized = rawTask(original);
        if (normalized.id !== input.task_id) throw schema();
        if (normalized.status === 'deleted') throw error('NOT_FOUND', '任务不存在或已删除。', 404);
        supportedTask(original);
        if (normalized.version !== input.expected_version) throw conflict();
        if (input.action === 'update') {
          payload = structuredClone(original);
          if (own(input.changes, 'title')) payload.title = input.changes.title;
          if (own(input.changes, 'notes')) payload.memo = input.changes.notes;
          if (own(input.changes, 'due_at')) payload.task_due_at = input.changes.due_at;
          if (own(input.changes, 'recurrence')) payload.repeating_pattern = RECURRENCE_PATTERNS[input.changes.recurrence];
          if (own(input.changes, 'reminder_enabled')) payload.is_remind_enabled = input.changes.reminder_enabled;
          if (own(input.changes, 'tag_id')) payload.tag_id = input.changes.tag_id === null ? null : (await this.#readTag(input.changes.tag_id, deadline)).id;
          if (payload.task_due_at === null && (payload.is_remind_enabled || payload.repeating_pattern !== 0)) throw invalid();
          if (same(payload, original) || (same({ ...payload, task_due_at: original.task_due_at }, original) && sameDue(payload.task_due_at, original.task_due_at))) {
            throw error('NO_CHANGES', '没有需要写入的变化。', 400);
          }
          payload.modified_time = new Date().toISOString();
          supportedTask(payload); // Reject contradictory duplicate safety/date fields rather than guessing merge semantics.
        } else if (input.action === 'complete') {
          const completedAt = new Date().toISOString();
          payload = { ...structuredClone(original), task_done_at: completedAt, done_date: shanghaiDate(completedAt), modified_time: completedAt };
          supportedTask(payload, { completed: payload });
          if (original.repeating_pattern !== 0) {
            const raw = await this.#bounded(() => this.#transport.getTasks(), deadline);
            baseline = { raw, ids: taskList(raw) };
            successor = nextPayload(original, baseline);
            supportedTask(successor);
            verifySeriesBaseline(raw, original, successor, normalized.version, conflict);
          }
        }
      }
    } catch (e) {
      if (e instanceof BridgeError && ['INVALID_MUTATION', 'VERSION_CONFLICT', 'NO_CHANGES', 'UNSUPPORTED_TASK'].includes(e.code)) throw e;
      const code = safeCode(e);
      throw error(code === 'WRITE_UNKNOWN' ? 'UPSTREAM_NETWORK' : code, '写入前读取或安全检查失败；未发送写入。', e instanceof BridgeError && [401, 403, 404, 429].includes(e.status) ? e.status : 502);
    }
    const now = new Date().toISOString();
    const record = { request_id: input.request_id, request_hash, action: input.action, state: 'pending',
      task_id: input.action === 'create' ? null : input.action === 'tag_update' ? input.tag_id : input.task_id, result_version: null,
      created_at: now, updated_at: now, error_code: null };
    // Conservatively latch before append: a failed acknowledgement may still have persisted pending.
    this.#blocking = input.request_id;
    await this.#storage('append', [structuredClone(record)], deadline);
    let writeAttempted = false, writeCompleted = false;
    try {
      const response = await this.#bounded(() => {
        if (this.#storeBroken) throw storeError();
        writeAttempted = true;
        return input.action === 'create' ? this.#transport.createTask(payload)
          : ['update', 'complete'].includes(input.action) ? this.#transport.updateTask(input.task_id, payload)
            : input.action === 'tag_update' ? this.#transport.updateTag(input.tag_id, payload)
              : this.#transport.deleteTask(input.task_id);
      }, deadline);
      writeCompleted = true;
      if (input.action === 'create') {
        record.task_id = verifyCreated(response, payload, baseline).id;
        record.result_version = (await this.#verifyCreated(response, payload, baseline, deadline)).version;
      } else if (input.action === 'tag_update') {
        if (rawTag(response).id !== input.tag_id || response.is_deleted) throw mismatch();
        verifyFields(response, payload);
        const readback = await this.#readTag(input.tag_id, deadline);
        verifyFields(readback, payload);
        record.result_version = rawTag(readback).version;
      } else if (['update', 'complete'].includes(input.action)) {
        const options = input.action === 'complete' ? { completed: payload } : {};
        if (supportedTask(response, options).id !== input.task_id) throw mismatch();
        verifyFields(response, payload);
        const readback = await this.#bounded(() => this.#transport.getTask(input.task_id), deadline);
        const task = supportedTask(readback, options);
        if (task.id !== input.task_id) throw mismatch();
        verifyFields(readback, payload);
        record.result_version = task.version;
        if (successor) {
          // An external client or upstream may have created the next occurrence after our baseline.
          // Re-read immediately before POST; any ambiguity after PUT is unknown, including a known POST 4xx.
          const raw = await this.#bounded(() => this.#transport.getTasks(), deadline);
          verifySeriesBaseline(raw, original, successor, task.version, mismatch);
          baseline = { raw, ids: taskList(raw) };
          successor = { ...successor, id: temporaryId(baseline) };
          const created = await this.#bounded(() => {
            if (this.#storeBroken) throw storeError();
            return this.#transport.createTask(successor);
          }, deadline);
          await this.#verifyCreated(created, successor, baseline, deadline, { original, completedVersion: task.version });
        }
      } else {
        let deleted = false;
        try {
          const readback = await this.#bounded(() => this.#transport.getTask(input.task_id), deadline);
          const task = supportedTask(readback, { deleted: true });
          if (task.id !== input.task_id) throw mismatch();
          deleted = true;
        } catch (e) {
          if (e instanceof BridgeError && e.code === 'NOT_FOUND' && e.status === 404) deleted = true;
          else throw e;
        }
        const list = await this.#bounded(() => this.#transport.getTasks(), deadline);
        taskList(list);
        if (!deleted || list.some(t => String(t.id) === input.task_id && t.is_deleted !== true)) throw mismatch();
      }
      record.state = 'succeeded';
    } catch (e) {
      const knownRejected = !writeCompleted && e instanceof BridgeError && e.status >= 400 && e.status < 500 && rejectedCodes.has(e.code);
      record.state = !writeAttempted || knownRejected ? 'failed' : 'unknown';
      record.error_code = safeCode(e);
      record.result_version = null;
    }
    record.updated_at = new Date().toISOString();
    await this.#storage('append', [structuredClone(record)], end);
    if (record.state !== 'unknown') {
      this.#settled.add(record.request_id);
      if (this.#blocking === record.request_id) this.#blocking = null;
    }
    return publicOperation(record);
  }
}
