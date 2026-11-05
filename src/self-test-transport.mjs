import { BridgeError, UPSTREAM, validateId, validateToken } from './core.mjs';

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const WRITE_UNKNOWN = 'WaterDo 测试写入结果未知，可能已经生效；未自动重试，请先核对专用测试任务。';
const own = (value, key) => Object.hasOwn(value, key);
const plainObject = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
// Only locally created errors may retain their message; even a fetch-thrown BridgeError is untrusted.
class ReadFailure extends BridgeError {}
const schemaError = () => new ReadFailure('UPSTREAM_SCHEMA', 'WaterDo 返回格式尚不兼容；未推断测试任务状态。', 502);
const networkError = () => new ReadFailure('UPSTREAM_NETWORK', '无法安全读取 WaterDo（网络、超时或重定向）；未自动重试。', 502);
const invalidTask = () => new BridgeError('INVALID_TASK', '测试任务必须是可序列化的普通对象，且任务 ID 必须与路径一致。', 400);
const expiredError = () => new BridgeError('AUTH_EXPIRED', 'WaterDo 授权已失效；请重新配置，不会自动重试。', 401);

// Upstream raw IDs may be safe integers; route IDs always use validateId's strict string contract.
function rawId(id) {
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw schemaError();
  if (typeof id !== 'string' && typeof id !== 'number') throw schemaError();
  try { return validateId(String(id)); } catch { throw schemaError(); }
}

function taskBody(task, expectedId, resource = 'task') {
  try {
    if (!plainObject(task)) throw invalidTask();
    if (expectedId !== undefined && (!own(task, 'id') || rawId(task.id) !== expectedId)) throw invalidTask();
    if (own(task, 'id')) rawId(task.id);
    const body = JSON.stringify({ [resource]: task });
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw invalidTask();
    // Check the bytes actually sent, not only a pre-serialization object whose toJSON/getters can differ.
    const serialized = JSON.parse(body)[resource];
    if (!plainObject(serialized)) throw invalidTask();
    if (own(serialized, 'id')) rawId(serialized.id);
    if (own(task, 'id') && (!own(serialized, 'id') || rawId(serialized.id) !== rawId(task.id))) throw invalidTask();
    if (expectedId !== undefined && (!own(serialized, 'id') || rawId(serialized.id) !== expectedId)) throw invalidTask();
    return { body, id: own(serialized, 'id') ? rawId(serialized.id) : undefined };
  } catch { throw invalidTask(); }
}

// Cancellation is best effort: an uncooperative body must not hold up a safety error or timeout.
function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Never expose upstream errors. */ }
}

function withAbort(signal, operation) {
  if (signal.aborted) return Promise.reject(networkError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(networkError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw networkError();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Only for the standalone, ownership-checked self-test runner; never a service/REST/MCP adapter. */
export class SelfTestTransport {
  #token;
  #fetch;
  #invalid = false;

  constructor(token, { fetchImpl = globalThis.fetch } = {}) {
    this.#token = validateToken(token);
    if (typeof fetchImpl !== 'function') throw new BridgeError('INVALID_TRANSPORT', '测试传输配置不正确。', 400);
    this.#fetch = fetchImpl;
  }

  get invalid() { return this.#invalid; }

  #statusError(status, write) {
    if (status === 401) { this.#invalid = true; return expiredError(); }
    if (status === 403) return new BridgeError('UPSTREAM_FORBIDDEN', 'WaterDo 拒绝访问；请检查账号或网页订阅权限。', 403);
    if (status === 404) return new BridgeError('NOT_FOUND', 'WaterDo 中未找到该资源。', 404);
    if (status === 429) return new BridgeError('UPSTREAM_RATE_LIMIT', 'WaterDo 请求频率受限，请稍后核对。', 429);
    if (write && status >= 400 && status < 500) return new BridgeError('SELF_TEST_REJECTED', 'WaterDo 拒绝了专用测试写入；原始响应未公开。', 422);
    return new BridgeError('UPSTREAM_ERROR', 'WaterDo 返回错误；原始响应未公开。', 502);
  }

  async #readBody(response, signal) {
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
      cancelBody(response.body);
      throw new ReadFailure('UPSTREAM_TOO_LARGE', '响应超过安全上限，无法确认完整性。', 502);
    }
    if (response.body === null) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await withAbort(signal, () => reader.read());
        if (done) break;
        if (!(value instanceof Uint8Array)) throw schemaError();
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new ReadFailure('UPSTREAM_TOO_LARGE', '响应超过安全上限，无法确认完整性。', 502);
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      cancelBody(reader);
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* Cancellation may still be pending. */ }
    }
  }

  async #request(method, path, { body, expectedId, list = false, listKey = 'tasks', deleteEmpty = false } = {}) {
    if (this.#invalid) throw expiredError();
    const write = method !== 'GET';
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response;
    let knownStatusError;
    try {
      response = await withAbort(signal, () => this.#fetch(`${UPSTREAM}${path}`, {
        method,
        headers: { 'X-Auth-Token': this.#token, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
        redirect: 'error', signal,
      }));
      if (response.redirected) throw networkError();
      if (!response.ok) {
        knownStatusError = this.#statusError(response.status, write);
        cancelBody(response.body);
        throw knownStatusError;
      }
      // Even DELETE/204 is bounded and timed: do not skip or blindly drain a response body.
      const bytes = await this.#readBody(response, signal);
      if (deleteEmpty && bytes.length === 0) return { deleted: true };
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw schemaError();
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw schemaError(); }
      if (deleteEmpty) {
        if (!plainObject(data)) throw schemaError();
        return { deleted: true };
      }
      if (list) {
        if (!plainObject(data) || !Array.isArray(data[listKey])) throw schemaError();
        return data[listKey];
      }
      // The public frontend consumes a raw object, not {task: ...} or another guessed envelope.
      if (!plainObject(data) || !own(data, 'id')) throw schemaError();
      const id = rawId(data.id);
      if (expectedId !== undefined && id !== expectedId) throw schemaError();
      return data;
    } catch (error) {
      cancelBody(response?.body);
      if (knownStatusError && error === knownStatusError && response.status >= 400 && response.status < 500) throw error;
      if (write) throw new BridgeError('SELF_TEST_WRITE_UNKNOWN', WRITE_UNKNOWN, 502);
      if ((knownStatusError && error === knownStatusError) || error instanceof ReadFailure) throw error;
      throw networkError();
    }
  }

  async getTasks() { return this.#request('GET', '/tasks/all', { list: true }); }
  async getTags() { return this.#request('GET', '/tags', { list: true, listKey: 'tags' }); }
  async getTag(id) {
    validateId(id);
    const matches = (await this.getTags()).filter(tag => plainObject(tag) && String(tag.id) === id);
    if (matches.length === 0) throw new BridgeError('NOT_FOUND', '标签不存在。', 404);
    if (matches.length !== 1) throw schemaError();
    return matches[0];
  }
  async updateTag(id, tag) {
    validateId(id);
    const { body } = taskBody(tag, id, 'tag');
    return this.#request('PUT', `/tags/${id}?sem_ver=2.13.0`, { body, expectedId: id });
  }

  async getTask(id) {
    validateId(id);
    return this.#request('GET', `/tasks/${id}`, { expectedId: id });
  }

  async createTask(task) {
    const { body } = taskBody(task);
    // The browser sends a temporary timestamp ID; the server assigns the persistent ID.
    // The runner verifies series_id, markers and exclusion from the existing-ID baseline.
    return this.#request('POST', '/tasks?sem_ver=2.13.0', { body });
  }

  async updateTask(id, task) {
    validateId(id);
    const { body } = taskBody(task, id);
    return this.#request('PUT', `/tasks/${id}?sem_ver=2.13.0`, { body, expectedId: id });
  }

  async deleteTask(id) {
    validateId(id);
    return this.#request('DELETE', `/tasks/${id}`, { deleteEmpty: true });
  }
}
