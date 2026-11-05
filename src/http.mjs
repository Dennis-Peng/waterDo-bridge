import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const QUERY_FIELDS = new Set([
  'q', 'from', 'to', 'status', 'tag_id', 'unscheduled', 'limit', 'offset', 'timezone',
]);
const MAX_URI_BYTES = 8192;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const CLIENT_TIMEOUT_MS = 25_000;
const WRITE_TIMEOUT_MS = 120_000;
const WRITE_CLIENT_TIMEOUT_MS = 125_000;
const MAX_BODY_BYTES = 64 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plainObject = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function failure(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function checkPort(port, allowZero = false) {
  if (!Number.isInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) {
    throw failure('INVALID_CONFIGURATION', 'Invalid local bridge port.', 400);
  }
}

function checkApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(apiKey)
      || Buffer.from(apiKey, 'base64url').length !== 32
      || Buffer.from(apiKey, 'base64url').toString('base64url') !== apiKey) {
    throw failure('INVALID_CONFIGURATION', 'A 32-byte base64url API key is required.', 400);
  }
}

const PUBLIC_ERRORS = {
  INVALID_QUERY: [400, 'Invalid query parameters.'],
  INVALID_ID: [400, 'Invalid task identifier.'],
  INVALID_TIME: [400, 'Invalid timestamp or time range.'],
  INVALID_TOKEN: [400, 'Invalid authorization configuration.'],
  INVALID_REQUEST: [400, 'Invalid request.'],
  UNAUTHORIZED: [401, 'Valid bearer authentication is required.'],
  AUTH_EXPIRED: [401, 'WaterDo authorization has expired; reconfiguration is required.'],
  FORBIDDEN: [403, 'Request is not allowed.'],
  UPSTREAM_FORBIDDEN: [403, 'WaterDo denied access.'],
  NOT_FOUND: [404, 'Resource not found.'],
  URI_TOO_LONG: [414, 'Request URI is too long.'],
  TOO_MANY_HEADERS: [431, 'Too many request headers.'],
  REQUEST_TIMEOUT: [504, 'Request timed out.'],
  UPSTREAM_RATE_LIMIT: [429, 'WaterDo rate limit exceeded; try again later.'],
  UPSTREAM_NETWORK: [502, 'Could not safely connect to WaterDo.'],
  UPSTREAM_ERROR: [502, 'WaterDo returned an error.'],
  UPSTREAM_SCHEMA: [502, 'WaterDo returned an unsupported response format.'],
  UPSTREAM_TOO_LARGE: [502, 'WaterDo response exceeds the size limit.'],
  NOT_CONFIGURED: [503, 'WaterDo authorization has not been configured.'],
  WRITES_DISABLED: [403, 'Writes are disabled on the local bridge.'],
  WRITE_AUTH_REQUIRED: [403, 'A separate write credential is required.'],
  INVALID_MUTATION: [400, 'Invalid operation input or request identifier.'],
  UNSUPPORTED_TASK: [422, 'This task does not support the requested operation.'],
  VERSION_CONFLICT: [409, 'Target or recurring series changed; read it again before proceeding.'],
  IDEMPOTENCY_CONFLICT: [409, 'Request identifier was already used for different input.'],
  WRITES_BLOCKED: [409, 'An unresolved operation blocks new writes; inspect its status.'],
  OPERATION_BUSY: [409, 'Another operation is in progress.'],
  OPERATION_NOT_FOUND: [404, 'Operation not found.'],
  OPERATION_STORE: [503, 'Operation storage is unavailable; writes have stopped.'],
  ACCOUNT_BINDING_CHANGED: [409, 'Operation storage belongs to a different account.'],
  NO_CHANGES: [400, 'No changes were requested.'],
  PAYLOAD_TOO_LARGE: [413, 'Request body exceeds the size limit.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'An uncompressed application/json body is required.'],
  SELF_TEST_REJECTED: [422, 'WaterDo rejected the operation.'],
  SELF_TEST_WRITE_UNKNOWN: [502, 'The write outcome is unknown; inspect the same request identifier without retrying.'],
  WRITE_UNKNOWN: [502, 'The write outcome is unknown; inspect the same request identifier without retrying.'],
  WRITE_READBACK: [502, 'Write readback could not be verified; inspect the operation before proceeding.'],
  WRITE_TIMEOUT: [504, 'Write processing timed out; inspect the same request identifier without retrying.'],
  INVALID_TASK: [400, 'Invalid task data.'],
  BRIDGE_REDIRECT: [502, 'Local bridge redirects are not allowed.'],
  INVALID_BRIDGE_RESPONSE: [502, 'Invalid local bridge response.'],
  BRIDGE_UNAVAILABLE: [503, 'Local bridge is unavailable.'],
  BRIDGE_TIMEOUT: [504, 'Local bridge request timed out; inspect write status before proceeding.'],
};

// Never trust an exception's message, even when it resembles a service error.
// The allowlist retains useful error codes without echoing upstream bodies.
function publicFailure(error) {
  const entry = error && typeof error.code === 'string' && Object.hasOwn(PUBLIC_ERRORS, error.code)
    ? PUBLIC_ERRORS[error.code] : undefined;
  if (entry && error.status === entry[0]) {
    return { status: entry[0], code: error.code, message: entry[1] };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error.' };
}

function headerValues(request, name) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
  }
  return values;
}

function parseTarget(target) {
  if (typeof target !== 'string' || Buffer.byteLength(target) > MAX_URI_BYTES) {
    throw failure('URI_TOO_LONG', 'Request URI is too long.', 414);
  }
  if (!target.startsWith('/') || target.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(target)) {
    throw failure('INVALID_REQUEST', 'Invalid request target.', 400);
  }
  // URLSearchParams otherwise silently tolerates malformed percent escapes and
  // invalid UTF-8. Validate the original target before parsing or normalizing it.
  try { decodeURIComponent(target); } catch {
    throw failure('INVALID_REQUEST', 'Invalid URI encoding.', 400);
  }
  const separator = target.indexOf('?');
  const pathname = separator === -1 ? target : target.slice(0, separator);
  const search = separator === -1 ? '' : target.slice(separator + 1);
  let route;
  let id;
  if (['/v1/connection', '/v1/capabilities', '/v1/tasks', '/v1/tags', '/v1/operations'].includes(pathname)) {
    route = pathname;
  } else if (pathname.startsWith('/v1/operations/')) {
    id = pathname.slice('/v1/operations/'.length);
    if (!UUID_V4.test(id)) throw failure('INVALID_MUTATION', 'Invalid operation identifier.', 400);
    route = '/v1/operations/{id}';
  } else if (pathname.startsWith('/v1/tasks/') && pathname.slice(10)) {
    id = decodeURIComponent(pathname.slice(10));
    if (/[\/\\?#\x00-\x1f\x7f]/.test(id) || id === '.' || id === '..') {
      throw failure('INVALID_REQUEST', 'Invalid task identifier.', 400);
    }
    route = '/v1/tasks/{id}';
  } else {
    throw failure('NOT_FOUND', 'Route not found.', 404);
  }
  if (route.startsWith('/v1/operations') && separator !== -1) {
    throw failure('INVALID_QUERY', 'Operation routes do not accept a query.', 400);
  }
  const query = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (route !== '/v1/tasks' || !QUERY_FIELDS.has(key) || Object.hasOwn(query, key)) {
      throw failure('INVALID_QUERY', 'Unknown or duplicate query parameter.', 400);
    }
    query[key] = value;
  }
  return { route, id, query };
}

const OPERATION_WARNINGS = new Set([
  '仅支持基础重复规则（Asia/Shanghai）；提醒仅存储开关与到期时刻，delivery_verified=false，未验收手机通知送达。',
  '重复完成先完成原项再创建下一项，非事务；仅推进一期，不自动跳过历史期数。',
  'weekdays仅指周一至周五，不含法定节假日或调休；桥接保留Asia/Shanghai同一时分秒，与网页本周分支可能归零到午夜的行为不同。',
  'monthly逐实例以当前日期推进，月底不足则clamp到月底，可能发生31日→28日→28日漂移；不自动恢复原月底锚点。',
  '上游没有条件写入保证；版本核对与写入间仍存在并发窗口，列表完整性未经验证。',
  '结果未知时不得换请求 ID 重发；相同请求 ID 仅查询或回放原操作。',
]);

// Operation responses are metadata only, even if a service accidentally returns
// its internal record (request_hash) or task content alongside the public fields.
function operationMetadata(value) {
  if (!plainObject(value) || !UUID_V4.test(value.request_id)
      || !['create', 'update', 'delete', 'complete', 'tag_update'].includes(value.action)
      || !['pending', 'succeeded', 'failed', 'unknown'].includes(value.state)
      || !(value.task_id === null || (typeof value.task_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.task_id)))
      || !(value.result_version === null || (typeof value.result_version === 'string' && /^[0-9a-f]{64}$/.test(value.result_version)))
      || ![value.created_at, value.updated_at].every((time) => typeof time === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(time) && Number.isFinite(Date.parse(time)))) {
    throw failure('INTERNAL_ERROR', 'Invalid operation metadata.', 500);
  }
  const result = Object.fromEntries(['request_id', 'action', 'state', 'task_id', 'result_version', 'created_at', 'updated_at']
    .map((key) => [key, value[key]]));
  result.error_code = value.error_code === null ? null
    : (typeof value.error_code === 'string' && Object.hasOwn(PUBLIC_ERRORS, value.error_code) ? value.error_code : 'INTERNAL_ERROR');
  // Only known static service warnings survive; never echo free-form diagnostics.
  result.warnings = Array.isArray(value.warnings) ? [...OPERATION_WARNINGS].filter((warning) => value.warnings.includes(warning)) : [];
  if (['pending', 'unknown'].includes(value.state)) {
    result.warnings.push('Operation outcome is not confirmed. Inspect this request identifier; do not submit a new write.');
  }
  return result;
}

function bodyLength(request) {
  const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
  if (new Set(names).size !== names.length || headerValues(request, 'transfer-encoding').length
      || headerValues(request, 'expect').length || headerValues(request, 'trailer').length) {
    throw failure('INVALID_REQUEST', 'Ambiguous request framing is not allowed.', 400);
  }
  if (headerValues(request, 'content-type').length !== 1 || request.headers['content-type'] !== 'application/json'
      || headerValues(request, 'content-encoding').length) {
    throw failure('UNSUPPORTED_MEDIA_TYPE', 'An uncompressed application/json body is required.', 415);
  }
  const lengths = headerValues(request, 'content-length');
  if (lengths.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(lengths[0])) {
    throw failure('INVALID_REQUEST', 'A single Content-Length is required.', 400);
  }
  const length = Number(lengths[0]);
  if (length > MAX_BODY_BYTES) throw failure('PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit.', 413);
  return length;
}

function readBody(request, length, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      request.off('data', data); request.off('end', end);
      request.off('aborted', aborted); request.off('error', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => { cleanup(); reject(failure('INVALID_REQUEST', 'Request was interrupted.', 400)); };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > length || bytes > MAX_BODY_BYTES) {
        cleanup(); request.pause(); reject(failure('PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit.', 413));
      } else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        if (bytes !== length) throw new Error();
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
        if (!plainObject(value)) throw new Error();
        resolve(value);
      } catch { reject(failure('INVALID_MUTATION', 'A JSON object encoded as UTF-8 is required.', 400)); }
    };
    if (signal.aborted) { aborted(); return; }
    request.on('data', data); request.once('end', end);
    request.once('aborted', aborted); request.once('error', aborted);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** The caller must explicitly bind this authenticated server to 127.0.0.1. */
export function createHttpServer({ service, apiKey, port = 8788, mutationService = null, writeKey = null }) {
  checkApiKey(apiKey);
  checkPort(port, true);
  if (writeKey !== null) {
    checkApiKey(writeKey);
    if (writeKey === apiKey) throw failure('INVALID_CONFIGURATION', 'Read and write credentials must differ.', 400);
  }
  if (mutationService !== null && !['mutate', 'getOperation', 'status'].every((name) => typeof mutationService[name] === 'function')) {
    throw failure('INVALID_CONFIGURATION', 'Invalid mutation service.', 400);
  }
  const writesEnabled = mutationService !== null && writeKey !== null;
  const expectedAuthorization = Buffer.from(`Bearer ${apiKey}`);
  const expectedWriteAuthorization = Buffer.from(`Bearer ${writeKey ?? apiKey}`);
  const server = http.createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: 10_000,
    requestTimeout: writesEnabled ? WRITE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 5_000,
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  // Retain every parsed header so security-relevant headers cannot be hidden
  // after a parser truncation boundary; enforce our count explicitly instead.
  server.maxHeadersCount = 0;
  server.setTimeout(REQUEST_TIMEOUT_MS, (socket) => socket.destroy());

  const closingSockets = new WeakSet();
  function send(response, status, body, extraHeaders = {}) {
    if (response.destroyed || response.writableEnded) return;
    let serialized;
    try {
      serialized = JSON.stringify(body);
      if (serialized === undefined || Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) throw new Error();
    } catch {
      status = 500;
      serialized = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
    }
    if (extraHeaders.Connection === 'close' && response.socket) closingSockets.add(response.socket);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(serialized),
      ...extraHeaders,
    });
    response.end(serialized);
  }

  async function describe(result, access) {
    if (!plainObject(result)) throw failure('INTERNAL_ERROR', 'Missing service status.', 500);
    // Implementation availability is not account acceptance or permission to write.
    // Retain unrelated capabilities while making unverified delivery explicit even in read-only mode.
    result = { ...result, advanced: { ...(plainObject(result.advanced) ? result.advanced : {}),
      recurrence: 'implemented_not_account_tested', complete: 'implemented_not_account_tested',
      reminder_settings: 'implemented_not_account_tested', tag_update: 'implemented_not_account_tested' }, reminder_delivery: false };
    if (!writesEnabled) return result;
    const status = await mutationService.status();
    if (!plainObject(status) || typeof status.writes_blocked !== 'boolean'
        || !(status.blocking_request_id === null || (typeof status.blocking_request_id === 'string' && UUID_V4.test(status.blocking_request_id)))) {
      throw failure('INTERNAL_ERROR', 'Invalid write status.', 500);
    }
    return { ...result, service_mode: 'read-write', read_only: access !== 'write', writes_enabled: true,
      ...(Object.hasOwn(result, 'writes') ? { writes: 'enabled' } : {}),
      access, writes_available: access === 'write' && !status.writes_blocked,
      writes_blocked: status.writes_blocked, blocking_request_id: status.blocking_request_id };
  }

  async function handle(request, response) {
    const controller = new AbortController();
    let active = true;
    const stop = () => { active = false; controller.abort(); };
    const timeout = request.method === 'POST' && writesEnabled ? WRITE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    request.setTimeout(timeout);
    const timer = setTimeout(() => {
      stop();
      send(response, 504, { error: { code: 'REQUEST_TIMEOUT', message: request.method === 'POST'
        ? 'Request timed out. If submitted, the write outcome is unknown; inspect this request identifier without retrying.'
        : 'Request timed out.' } }, { Connection: 'close' });
    }, timeout);
    timer.unref();
    const closed = () => { stop(); clearTimeout(timer); };
    request.once('aborted', closed);
    response.once('close', closed);
    response.once('finish', closed);
    try {
      if (request.rawHeaders.length > 128) {
        throw failure('TOO_MANY_HEADERS', 'Too many request headers.', 431);
      }
      const address = server.address();
      const expectedPort = port === 0 && address && typeof address === 'object' ? address.port : port;
      const hosts = headerValues(request, 'host');
      if (hosts.length !== 1 || ![`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`].includes(hosts[0])) {
        throw failure('FORBIDDEN', 'Request host is not allowed.', 403);
      }
      const fetchSites = headerValues(request, 'sec-fetch-site');
      if (headerValues(request, 'origin').length || fetchSites.length > 1
          || (fetchSites.length === 1 && fetchSites[0] !== 'none')) {
        throw failure('FORBIDDEN', 'Browser-originated requests are not allowed.', 403);
      }
      const authorization = headerValues(request, 'authorization');
      const provided = Buffer.from(authorization.length === 1 ? authorization[0] : '');
      // Compare a fixed-length buffer even for wrong-length inputs.
      const candidate = provided.length === expectedAuthorization.length ? provided : Buffer.alloc(expectedAuthorization.length);
      const readAuthorized = timingSafeEqual(candidate, expectedAuthorization) && provided.length === expectedAuthorization.length;
      const writeAuthorized = timingSafeEqual(candidate, expectedWriteAuthorization) && provided.length === expectedWriteAuthorization.length && writeKey !== null;
      if (!readAuthorized && !writeAuthorized) {
        throw failure('UNAUTHORIZED', 'Valid bearer authentication is required.', 401);
      }
      if (request.method === 'POST' && request.url.split('?')[0] === '/v1/operations') {
        if (!writesEnabled) throw failure('WRITES_DISABLED', 'Writes are disabled.', 403);
        if (!writeAuthorized) throw failure('WRITE_AUTH_REQUIRED', 'Write authorization is required.', 403);
        parseTarget(request.url);
        const input = await readBody(request, bodyLength(request), controller.signal);
        // This check is adjacent to dispatch: a body completing after a deadline
        // or disconnect must never trigger a late mutation. Once dispatched, the
        // mutation service owns its journal and must finish recording the outcome.
        if (!active || request.aborted || response.destroyed || response.writableEnded) return;
        const result = await mutationService.mutate(input);
        if (active) send(response, 200, operationMetadata(result));
        return;
      }
      if (request.method !== 'GET') {
        send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method is not allowed.' } }, { Allow: 'GET', Connection: 'close' });
        return;
      }
      if (request.headers['transfer-encoding'] !== undefined
          || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
        throw failure('INVALID_REQUEST', 'Request bodies are not allowed.', 400);
      }
      const { route, id, query } = parseTarget(request.url);
      const access = writeAuthorized ? 'write' : 'read';
      let result;
      switch (route) {
        case '/v1/connection': result = await describe(await service.connection(), access); break;
        case '/v1/capabilities': result = await describe(await service.capabilities(), access); break;
        case '/v1/tasks': result = await service.listTasks(query); break;
        case '/v1/tasks/{id}': result = await service.getTask(id); break;
        case '/v1/tags': result = await service.listTags(); break;
        case '/v1/operations/{id}':
          if (!mutationService) throw failure('WRITES_DISABLED', 'Writes are disabled.', 403);
          result = operationMetadata(await mutationService.getOperation(id)); break;
        default: throw failure('NOT_FOUND', 'Route not found.', 404);
      }
      if (active) send(response, 200, result);
    } catch (error) {
      const safe = publicFailure(error);
      send(response, safe.status, { error: { code: safe.code, message: safe.message } }, {
        Connection: 'close',
        ...(safe.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
      });
    }
  }

  server.on('request', handle);
  // Do not emit a 100 Continue response or automatic 417 before security checks.
  server.on('checkContinue', handle);
  server.on('checkExpectation', handle);
  server.on('clientError', (error, socket) => {
    if (!socket.writable || socket.destroyed || closingSockets.has(socket)) return;
    closingSockets.add(socket);
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    const reason = status === 431 ? 'Request Header Fields Too Large' : 'Bad Request';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
  });
  return server;
}

/** Fixed-loopback client: reads, or a POST to the sole operation endpoint. */
export async function fetchBridge({ port = 8788, apiKey, path, query = {}, method = 'GET', body }) {
  checkPort(port);
  checkApiKey(apiKey);
  if (typeof path !== 'string' || path.includes('?') || path.includes('#')
      || !query || typeof query !== 'object' || Array.isArray(query)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(query))) {
    throw failure('INVALID_REQUEST', 'Invalid bridge request.', 400);
  }
  if (!['GET', 'POST'].includes(method) || (method === 'GET' && body !== undefined)
      || (method === 'POST' && (path !== '/v1/operations' || Object.keys(query).length || !plainObject(body)))) {
    throw failure('INVALID_REQUEST', 'Invalid bridge request.', 400);
  }
  let serialized;
  if (method === 'POST') {
    try {
      serialized = JSON.stringify(body);
      if (!plainObject(JSON.parse(serialized))) throw new Error();
    } catch { throw failure('INVALID_MUTATION', 'Invalid operation JSON.', 400); }
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw failure('PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit.', 413);
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_FIELDS.has(key) || typeof value !== 'string') {
      throw failure('INVALID_QUERY', 'Query values must be supported string parameters.', 400);
    }
    params.append(key, value);
  }
  const target = `${path}${params.size ? `?${params}` : ''}`;
  parseTarget(target);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const request = http.request({
      hostname: '127.0.0.1', port, path: target, method, agent: false,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) } : {}) },
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        finish(failure('BRIDGE_REDIRECT', 'Bridge redirects are not allowed.', 502));
        response.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          finish(failure('INVALID_BRIDGE_RESPONSE', 'Bridge response is too large.', 502));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => finish(failure('BRIDGE_UNAVAILABLE', 'Local bridge response failed.', 502)));
      response.on('end', () => {
        if (settled) return;
        let body;
        try {
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) throw new Error();
          body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          finish(failure('INVALID_BRIDGE_RESPONSE', 'Invalid local bridge response.', 502));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const safe = publicFailure({ ...body?.error, status: response.statusCode });
          const message = method === 'POST' && safe.code === 'REQUEST_TIMEOUT'
            ? 'Request timed out; the write outcome may be unknown. Inspect this request identifier without retrying.' : safe.message;
          finish(failure(safe.code, message, safe.status));
        } else finish(null, body);
      });
    });
    request.on('error', () => finish(failure('BRIDGE_UNAVAILABLE', 'Could not connect to the local bridge.', 503)));
    timer = setTimeout(() => {
      finish(failure('BRIDGE_TIMEOUT', method === 'POST'
        ? 'Local bridge request timed out; the write outcome may be unknown. Inspect this request identifier without retrying.'
        : 'Local bridge request timed out.', 504));
      request.destroy();
    }, method === 'POST' ? WRITE_CLIENT_TIMEOUT_MS : CLIENT_TIMEOUT_MS);
    timer.unref();
    request.end(serialized);
  });
}
