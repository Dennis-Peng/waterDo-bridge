import { randomUUID, createHash } from 'node:crypto';
import { BridgeError, normalizeTask } from './core.mjs';

const fail = (code, message) => { throw new BridgeError(code, message, 409); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone = value => structuredClone(value);
const safeCode = error => error instanceof BridgeError ? error.code : 'SELF_TEST_FAILED';
export function makeTestPlan(now = new Date()) {
  const runId = randomUUID();
  const day = 86400000;
  const due = new Date(Math.floor((now.getTime() + 8 * 3600000) / day) * day + day + 2 * 3600000).toISOString();
  const prefix = `[接口测试，请勿操作] ${runId}`;
  return { run_id: runId, series_id: randomUUID(), created_at: now.toISOString(),
    title: `${prefix} 新增验证`, updated_title: `${prefix} 修改验证`,
    memo: `WaterDo Bridge disposable test ${runId}; no real schedule; delete after verification.`,
    updated_memo: `WaterDo Bridge disposable test ${runId}; update verified; delete after verification.`,
    due_at: due };
}
function createPayload(plan) {
  return { id: Date.parse(plan.created_at), title: plan.title, memo: plan.memo, tag_id: null,
    task_created_at: plan.created_at, task_due_at: null, task_done_at: null, done_date: null,
    is_deleted: false, is_restored: false, is_remind_enabled: false, repeating_pattern: 0,
    reorderable_orders: [], sequence_num: 1, series_id: plan.series_id, importance: 1,
    modified_time: plan.created_at, created_at: null, updated_at: null, repeating_origin_id: null, ignore_expired: false };
}
function expectedFields(plan, step) {
  return { title: step === 'create' ? plan.title : plan.updated_title,
    memo: step === 'create' ? plan.memo : plan.updated_memo,
    task_due_at: step === 'reschedule' ? plan.due_at : null };
}
function verifyOwned(raw, state, { deleted = false } = {}) {
  const normalized = normalizeTask(raw);
  if (state.baseline.some(t => t.id === normalized.id)) fail('SELF_TEST_EXISTING_ID', '返回了既有任务 ID；绝不修改或删除。');
  if (state.task_id !== null && normalized.id !== state.task_id) fail('SELF_TEST_ID_MISMATCH', '任务 ID 不匹配，停止操作。');
  const p = state.plan;
  if (raw.series_id !== p.series_id || ![p.title, p.updated_title].includes(raw.title)
      || ![p.memo, p.updated_memo].includes(raw.memo) || raw.tag_id !== null || raw.task_done_at !== null
      || raw.done_date !== null || raw.is_remind_enabled !== false || raw.repeating_pattern !== 0
      || (Object.hasOwn(raw, 'repeating_origin_id') && raw.repeating_origin_id !== null)
      || (!deleted && raw.is_deleted !== false)) {
    fail('SELF_TEST_OWNERSHIP', '临时任务标识或安全字段不匹配；停止操作，避免误改。');
  }
  return normalized.id;
}
function verifyExpected(raw, plan, step) {
  const expected = expectedFields(plan, step);
  for (const [key, value] of Object.entries(expected)) {
    const same = key === 'task_due_at' && value !== null ? Date.parse(raw[key]) === Date.parse(value) : raw[key] === value;
    if (!same) fail('SELF_TEST_READBACK', '回读内容与预期不一致；停止操作。');
  }
}
async function baseline(transport) {
  const tasks = await transport.getTasks();
  const records = tasks.map(raw => ({ id: normalizeTask(raw).id, hash: fingerprint(raw) }));
  if (new Set(records.map(t => t.id)).size !== records.length) fail('SELF_TEST_DUPLICATES', '上游列表出现重复 ID，不能安全测试。');
  return records;
}
async function checkBaseline(transport, state) {
  const after = await baseline(transport);
  const map = new Map(after.map(t => [t.id, t.hash]));
  return state.baseline.every(t => map.get(t.id) === t.hash);
}
async function checkUnchanged(transport, state) {
  const raw = await transport.getTask(state.task_id);
  verifyOwned(raw, state);
  if (fingerprint(raw) !== state.last_hash) fail('SELF_TEST_CONCURRENT_CHANGE', '测试任务发生并发修改；不会覆盖或删除。');
  return raw;
}
async function verifyDeletion(transport, state) {
  let deleted = false;
  try {
    const raw = await transport.getTask(state.task_id);
    verifyOwned(raw, state, { deleted: true });
    deleted = raw.is_deleted === true;
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'NOT_FOUND') deleted = true;
    else throw error;
  }
  const list = await transport.getTasks();
  const same = list.filter(raw => String(raw.id) === state.task_id || raw.series_id === state.plan.series_id);
  if (!deleted || same.some(raw => raw.is_deleted !== true)) fail('SELF_TEST_DELETE_UNVERIFIED', '无法确认测试任务已删除；不会重复删除。');
}
function publicReport(state) {
  if (!state) return { state: 'not_started', writes_enabled: false };
  return { state: state.stage, run_id: state.plan.run_id, task_id: state.task_id,
    test_title: state.plan.title, changed_title: state.plan.updated_title,
    scheduled_at: state.plan.due_at, reminder_enabled: false, recurrence_enabled: false,
    verified_steps: state.verified_steps, baseline_records_checked: state.baseline.length,
    baseline_unchanged: state.baseline_unchanged ?? null, error_code: state.error_code ?? null,
    cleanup: state.stage === 'completed' || state.stage === 'cleaned' ? 'verified_deleted' : 'not_verified',
    uncertain_write: state.uncertain_write === true,
    warnings: ['只核对本次上游响应中的记录，不承诺账号全量完整性。', '网页/手机显示和提醒未验收；测试未启用提醒。'] };
}
export { publicReport as selfTestReport };

/** Diagnostic reads only; expose types/comparisons, not arbitrary upstream fields. */
export async function inspectSelfTest({ transport, journal }) {
  await journal.acquire();
  try {
    const state = await journal.load();
    if (!state) return publicReport(state);
    const p = state.plan;
    const all = await transport.getTasks();
    const candidates = all.filter(raw => raw.title === p.title && raw.memo === p.memo);
    if (candidates.length !== 1) return { run_id: p.run_id, candidate_count: candidates.length, writes_performed: false };
    const item = candidates[0], id = normalizeTask(item).id;
    if (state.baseline.some(t => t.id === id)) fail('SELF_TEST_EXISTING_ID', '候选为既有任务，不操作。');
    const raw = await transport.getTask(id);
    if (String(raw.id) !== id || raw.title !== p.title || raw.memo !== p.memo) fail('SELF_TEST_OWNERSHIP', '诊断候选不匹配。');
    const scalar = key => !Object.hasOwn(raw, key) ? { type: 'missing' }
      : raw[key] === null ? { type: 'null' }
      : typeof raw[key] === 'boolean' || (typeof raw[key] === 'number' && Number.isFinite(raw[key])) ? { type: typeof raw[key], value: raw[key] }
      : { type: typeof raw[key] };
    return { run_id: p.run_id, candidate_count: 1, task_id: id, writes_performed: false,
      title_matches: true, memo_matches: true,
      series_id: { type: raw.series_id === null ? 'null' : typeof raw.series_id,
        exact_match: raw.series_id === p.series_id,
        case_insensitive_match: typeof raw.series_id === 'string' && raw.series_id.toLowerCase() === p.series_id.toLowerCase() },
      fields: Object.fromEntries(['tag_id', 'task_done_at', 'done_date', 'is_remind_enabled', 'repeating_pattern', 'repeating_origin_id', 'is_deleted'].map(key => [key, scalar(key)])),
      due_is_null: raw.task_due_at === null,
      baseline_unchanged: await checkBaseline(transport, state) };
  } finally { await journal.release(); }
}

async function finishSelfTest(transport, state, save) {
  const { plan, task_id: id } = state;
  for (const step of ['update', 'reschedule']) {
    let raw = await checkUnchanged(transport, state);
    const body = { ...raw, ...expectedFields(plan, step), modified_time: new Date().toISOString() };
    await save(`${step}_pending`);
    await transport.updateTask(id, body);
    raw = await transport.getTask(id);
    verifyOwned(raw, state); verifyExpected(raw, plan, step);
    state.last_hash = fingerprint(raw); state.verified_steps.push(step); await save(`${step}_verified`);
  }
  await checkUnchanged(transport, state);
  await save('delete_pending');
  await transport.deleteTask(id);
  await verifyDeletion(transport, state);
  state.verified_steps.push('delete'); await save('delete_verified');
  state.baseline_unchanged = await checkBaseline(transport, state);
  if (!state.baseline_unchanged) fail('SELF_TEST_BASELINE_CHANGED', '既有记录与测试前不一致，需人工核对；未尝试恢复或覆盖。');
  await save('completed'); return publicReport(state);
}

/** Only recover the diagnosed, successful POST with omitted nullable origin; never retry POST. */
export async function resumeSelfTest({ transport, journal }) {
  await journal.acquire();
  let state;
  let eligible = false;
  const save = async stage => { state.stage = stage; state.updated_at = new Date().toISOString(); await journal.save(state); };
  try {
    state = await journal.load();
    if (!state) fail('SELF_TEST_RESUME_DENIED', '没有可继续的测试记录。');
    if (['completed', 'cleaned'].includes(state.stage)) return publicReport(state);
    if (state.stage !== 'stopped' || state.stopped_at !== 'create_pending' || state.error_code !== 'SELF_TEST_OWNERSHIP'
        || state.task_id !== null || state.verified_steps.length !== 0) {
      fail('SELF_TEST_RESUME_DENIED', '只允许继续已定位为创建后字段兼容问题的测试，不重试未知写入。');
    }
    eligible = true;
    const matches = (await transport.getTasks()).filter(raw => raw.series_id === state.plan.series_id
      && raw.title === state.plan.title && raw.memo === state.plan.memo);
    if (matches.length !== 1) fail('SELF_TEST_AMBIGUOUS', '测试事项不是唯一匹配；不继续。');
    const id = verifyOwned(matches[0], state);
    let raw = await transport.getTask(id);
    verifyOwned(raw, state); verifyExpected(raw, state.plan, 'create');
    // Recovery is limited to the single observed omission, not a broad relaxation.
    if (Object.hasOwn(raw, 'repeating_origin_id')) fail('SELF_TEST_RESUME_DENIED', '不符合已确认的字段缺省情形，需重新核对。');
    if (!(await checkBaseline(transport, state))) fail('SELF_TEST_BASELINE_CHANGED', '既有记录已变化，不继续测试。');
    state.task_id = id; state.last_hash = fingerprint(raw);
    state.verified_steps = ['create']; state.error_code = null; state.uncertain_write = false;
    await save('create_verified');
    return await finishSelfTest(transport, state, save);
  } catch (error) {
    if (!eligible) throw error;
    state.error_code = safeCode(error); state.stopped_at = state.stage;
    state.uncertain_write = state.uncertain_write || state.error_code === 'SELF_TEST_WRITE_UNKNOWN'
      || (state.stage.endsWith('_pending') && !['SELF_TEST_REJECTED', 'UPSTREAM_FORBIDDEN', 'AUTH_EXPIRED', 'UPSTREAM_RATE_LIMIT', 'INVALID_TASK'].includes(state.error_code));
    await save('stopped'); return publicReport(state);
  } finally { await journal.release(); }
}

/** A durable single run. No parameters can name an existing task to mutate. */
export async function runSelfTest({ transport, journal, plan = makeTestPlan() }) {
  await journal.acquire();
  let state;
  const save = async stage => { state.stage = stage; state.updated_at = new Date().toISOString(); await journal.save(state); };
  try {
    state = await journal.load();
    if (state) return publicReport(state); // Never recreate/retry a prior run.
    state = { version: 1, plan: clone(plan), baseline: await baseline(transport), task_id: null,
      last_hash: null, verified_steps: [], stage: 'prepared' };
    if (state.baseline.some(t => t.id === String(Date.parse(plan.created_at)))) fail('SELF_TEST_ID_COLLISION', '临时创建 ID 与既有任务重合。');
    await journal.prepare?.(state); // Reserve enough journal budget before any remote write.
    await save('create_pending'); // Durable before any remote mutation.
    const created = await transport.createTask(createPayload(plan));
    const id = verifyOwned(created, state); verifyExpected(created, plan, 'create');
    state.task_id = id;
    await save('create_returned');
    let raw = await transport.getTask(id);
    verifyOwned(raw, state); verifyExpected(raw, plan, 'create');
    state.last_hash = fingerprint(raw); state.verified_steps.push('create'); await save('create_verified');

    return await finishSelfTest(transport, state, save);
  } catch (error) {
    if (!state) throw error;
    state.error_code = safeCode(error); state.stopped_at = state.stage;
    state.uncertain_write = state.error_code === 'SELF_TEST_WRITE_UNKNOWN'
      || (state.stage.endsWith('_pending') && !['SELF_TEST_REJECTED', 'UPSTREAM_FORBIDDEN', 'AUTH_EXPIRED', 'UPSTREAM_RATE_LIMIT', 'INVALID_TASK'].includes(state.error_code));
    if (state.error_code === 'SELF_TEST_BASELINE_TOO_LARGE') throw error;
    // Never attempt another mutation automatically after an uncertain result.
    await save('stopped'); return publicReport(state);
  } finally { await journal.release(); }
}

/** Explicit, separate recovery. Only delete a positively identified unchanged test task. */
export async function cleanupSelfTest({ transport, journal }) {
  await journal.acquire();
  let state;
  const save = async stage => { state.stage = stage; state.updated_at = new Date().toISOString(); await journal.save(state); };
  try {
    state = await journal.load();
    if (!state || ['completed', 'cleaned'].includes(state.stage)) return publicReport(state);
    if (state.uncertain_write || state.stage.endsWith('_pending')) {
      // A timed-out PUT may still be in flight and can resurrect a subsequently deleted row.
      // Do not infer quiescence from one old snapshot or retry an uncertain DELETE.
      fail('SELF_TEST_UNCERTAIN_REVIEW', '上次写入可能仍在处理；禁止自动清理或重发，请先人工核对测试事项。');
    }
    const tasks = await transport.getTasks();
    const matches = tasks.filter(raw => raw.series_id === state.plan.series_id);
    if (matches.length > 1) fail('SELF_TEST_AMBIGUOUS', '出现多个测试标识匹配，禁止批量清理。');
    let raw;
    if (state.task_id) {
      try { raw = await transport.getTask(state.task_id); }
      catch (error) {
        if (!(error instanceof BridgeError && error.code === 'NOT_FOUND')) throw error;
        await verifyDeletion(transport, state);
      }
    } else if (matches.length === 1) {
      raw = matches[0]; state.task_id = verifyOwned(raw, state, { deleted: true });
      await save('cleanup_identified'); raw = await transport.getTask(state.task_id);
    } else {
      fail('SELF_TEST_NOT_LOCATED', '没有定位到测试任务；不重复创建，需检查网页或稍后只读核对。');
    }
    if (raw) {
      verifyOwned(raw, state, { deleted: true });
      if (!raw.is_deleted) {
        // Unknown writes without a verified snapshot are intentionally not auto-deleted.
        if (!state.last_hash || fingerprint(raw) !== state.last_hash) {
          fail('SELF_TEST_CLEANUP_REVIEW', '没有匹配的已验证快照，需人工核对临时事项后再处理；未删除。');
        }
        await save('cleanup_delete_pending');
        await transport.deleteTask(state.task_id);
      }
      await verifyDeletion(transport, state);
    }
    state.baseline_unchanged = await checkBaseline(transport, state);
    state.error_code = null;
    if (!state.baseline_unchanged) fail('SELF_TEST_BASELINE_CHANGED', '既有记录发生变化；测试任务清理后请人工核对。');
    await save('cleaned'); return publicReport(state);
  } catch (error) {
    if (!state) throw error;
    state.error_code = safeCode(error); state.stopped_at = state.stage;
    state.uncertain_write = state.uncertain_write || state.stage.endsWith('_pending') || state.error_code === 'SELF_TEST_WRITE_UNKNOWN';
    await save('stopped'); return publicReport(state);
  } finally { await journal.release(); }
}
