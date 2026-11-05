#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { BridgeError, WaterDoAdapter, WaterDoService, validateId, parseQuery } from './core.mjs';
import { saveCredentials, loadCredentials, hiddenPrompt, readBridgeKey, ensureBridgeKey, readWriteKey, ensureWriteKey } from './credentials.mjs';
import { DemoAdapter } from './demo.mjs';
import { createHttpServer, fetchBridge } from './http.mjs';
import { runMcp } from './mcp.mjs';

const HELP = `WaterDo Bridge — 默认只读，可显式启用写入（Node.js >=22，无第三方依赖）

node src/cli.mjs configure [--replace]   在交互终端隐藏输入 Token 和本地加密口令
node src/cli.mjs serve [--port 8788]     解锁令牌，启动 127.0.0.1 只读服务
node src/cli.mjs serve --enable-writes  本地解锁一次，开启任务写入服务
node src/cli.mjs service-enroll         本地解锁后将Token加密托管到systemd（需sudo -v）
node src/cli.mjs serve --demo            启动合成数据演示，不连接 WaterDo
node src/cli.mjs status                 查看服务/连接状态
node src/cli.mjs capabilities           查看能力限制
node src/cli.mjs tasks [--q 关键词] [--status open|completed|all]
    [--from ISO时间] [--to ISO时间] [--unscheduled true|false]
    [--tag-id ID] [--limit 50] [--offset 0] [--timezone Asia/Shanghai]
node src/cli.mjs task ID                查询一条任务
node src/cli.mjs tags                   查询标签
node src/cli.mjs mcp [--write]          stdio MCP，默认仅暴露查询，--write显式开放写工具
node src/cli.mjs mutate --json-stdin    从标准输入读取单个操作JSON；不重复确认，无自动重试
node src/cli.mjs operation UUID        查询操作状态，失败/超时后先查此命令
node src/cli.mjs self-test --run        交互确认后仅测试一条新建临时事项的增改删
node src/cli.mjs self-test --report     只读查看最近自检报告（不输出凭据）
node src/cli.mjs self-test --inspect    解锁后只读诊断测试事项字段差异
node src/cli.mjs self-test --resume     仅继续已确认字段缺省的原测试，不重复创建
node src/cli.mjs self-test --cleanup    显式确认后清理可验证且未改动的测试事项

查询和 MCP 可加 --port；status 可加 --write 查看写权限。支持基础重复、完成、提醒设置及现有标签修改；手机送达未验证。
mutate JSON 必须包含 UUIDv4 request_id；update/delete/complete还需task_id和expected_version，标签修改用tag_id及版本；超时不得换UUID重试。
秘密值不能作为参数输入，不要发到聊天中。服务只读不代表上游 Token 权限只读。
`;
function parseArgs(args) {
  const command = args.shift() ?? 'help';
  const flags = {}, positional = [];
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (Object.hasOwn(flags, arg)) throw new BridgeError('INVALID_ARGUMENT', '参数重复。');
    if (['--demo', '--replace', '--run', '--report', '--cleanup', '--inspect', '--resume', '--enable-writes', '--write', '--json-stdin', '--systemd-credential'].includes(arg)) flags[arg] = true;
    else {
      if (!args.length || args[0].startsWith('--')) throw new BridgeError('INVALID_ARGUMENT', '参数缺少值。');
      flags[arg] = args.shift();
    }
  }
  return { command, flags, positional };
}
function validateOptions(flags, allowed) {
  if (Object.keys(flags).some(f => !allowed.includes(f))) throw new BridgeError('INVALID_ARGUMENT', '存在不支持的参数；秘密不能放在参数里。');
}
async function mutationInput() {
  if (process.stdin.isTTY) throw new BridgeError('INVALID_MUTATION', '请通过 --json-stdin 提供一个操作 JSON，不在参数中放日程正文。');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 65536) throw new BridgeError('INVALID_MUTATION', '操作 JSON 超过64KiB限制。');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new BridgeError('INVALID_MUTATION', '操作 JSON 格式不正确。'); }
}
export async function main(argv = process.argv.slice(2)) {
  const { command, flags, positional } = parseArgs([...argv]);
  if (['help', '--help', '-h'].includes(command)) { process.stdout.write(HELP); return; }
  const commands = ['configure', 'serve', 'status', 'capabilities', 'tasks', 'task', 'tags', 'mcp', 'self-test', 'mutate', 'operation', 'service-enroll'];
  if (!commands.includes(command)) throw new BridgeError('INVALID_ARGUMENT', '未知命令；运行 node src/cli.mjs help 查看帮助。');
  if ((['task', 'operation'].includes(command) && positional.length !== 1) || (!['task', 'operation'].includes(command) && positional.length)) throw new BridgeError('INVALID_ARGUMENT', '位置参数不正确。');
  const listOptions = ['--q', '--status', '--from', '--to', '--unscheduled', '--tag-id', '--limit', '--offset', '--timezone'];
  validateOptions(flags, command === 'service-enroll' ? [] : command === 'mutate' ? ['--json-stdin', '--port'] : ['status', 'capabilities', 'mcp'].includes(command) ? ['--write', '--port']
    : command === 'self-test' ? ['--run', '--report', '--cleanup', '--inspect', '--resume']
    : command === 'configure' ? ['--replace'] : command === 'serve' ? ['--demo', '--enable-writes', '--systemd-credential', '--port'] : command === 'tasks' ? ['--port', ...listOptions] : ['--port']);
  const portValue = flags['--port'] ?? '8788';
  if (!/^\d+$/.test(portValue) || Number(portValue) < 1024 || Number(portValue) > 65535) throw new BridgeError('INVALID_ARGUMENT', '端口必须在 1024–65535 之间。');
  const port = Number(portValue);
  if (command === 'self-test') {
    if (Object.keys(flags).length !== 1) throw new BridgeError('INVALID_ARGUMENT', '请选择 --run、--report、--inspect、--resume 或 --cleanup 中的一项。');
    const { SelfTestJournal } = await import('./self-test-journal.mjs');
    const { runSelfTest, resumeSelfTest, cleanupSelfTest, inspectSelfTest, selfTestReport, makeTestPlan } = await import('./self-test.mjs');
    const journal = new SelfTestJournal();
    const prior = await journal.load();
    if (flags['--report'] || (flags['--run'] && prior) || (flags['--cleanup'] && (!prior || ['completed', 'cleaned'].includes(prior.stage)))) {
      process.stdout.write(JSON.stringify(selfTestReport(prior), null, 2) + '\n');
      if (prior && !['completed', 'cleaned'].includes(prior.stage)) process.exitCode = 1;
      return;
    }
    const plan = prior?.plan ?? makeTestPlan();
    process.stderr.write(`专用接口自检，不开放一般写入。\n测试标识：${plan.run_id}\n临时标题：${plan.title}\n`);
    process.stderr.write(flags['--inspect'] ? '只读诊断：仅读取本次测试事项，输出安全字段类型/匹配结果，不写入上游。\n'
      : flags['--resume'] ? '继续同一条已创建测试事项：重新核对后修改、改期并删除。不发新增请求，不修改原有任务。\n' : flags['--run']
      ? '将新增1条无提醒/无重复/无标签事项，修改标题备注，设为明天北京时间10点，回读后删除。不会完成任务或改动已有事项。\n'
      : '仅在测试标识、ID和已验证快照都匹配时删除测试事项；不确定时停止。\n');
    if (!flags['--inspect']) {
      const approval = await hiddenPrompt('确认上述测试范围，请输入 TEST（不回显）：');
      if (approval !== 'TEST') throw new BridgeError('CANCELLED', '未确认，未执行自检。');
    }
    let passphrase = await hiddenPrompt('解锁本地 WaterDo 授权：');
    let transport;
    try {
      const { SelfTestTransport } = await import('./self-test-transport.mjs');
      transport = new SelfTestTransport(await loadCredentials(passphrase));
    } finally { passphrase = ''; }
    const result = flags['--inspect'] ? await inspectSelfTest({ transport, journal })
      : flags['--resume'] ? await resumeSelfTest({ transport, journal })
      : flags['--cleanup'] ? await cleanupSelfTest({ transport, journal }) : await runSelfTest({ transport, journal, plan });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!flags['--inspect'] && !['completed', 'cleaned'].includes(result.state)) process.exitCode = 1;
    return;
  }
  if (command === 'configure') {
    process.stderr.write('仅在你自己的服务器终端操作。输入不会显示，配置时不向 WaterDo 发送请求。\n');
    let token = await hiddenPrompt('WaterDo X-Auth-Token：');
    let passphrase = await hiddenPrompt('设置本地加密口令（至少12字符，不是WaterDo密码）：');
    let confirm = await hiddenPrompt('再次输入本地口令：');
    try {
      if (passphrase !== confirm) throw new BridgeError('PASSPHRASE_MISMATCH', '两次口令不一致，未保存。');
      await saveCredentials(token, passphrase, { replace: flags['--replace'] === true });
    } finally { token = ''; passphrase = ''; confirm = ''; }
    process.stderr.write('已加密保存授权。下一步运行 node src/cli.mjs serve；不要把口令告诉助手。\n');
    return;
  }
  if (command === 'service-enroll') {
    process.stderr.write('仅本机注册：Token经管道交给systemd-creds，以host+TPM2/PCR7加密；不会输出密码或Token。请先 sudo -v。\n');
    let passphrase = await hiddenPrompt('解锁现有 WaterDo 授权：');
    let token;
    try {
      token = await loadCredentials(passphrase);
      const { enrollSystemdToken } = await import('./systemd-credentials.mjs');
      await enrollSystemdToken(token);
    } finally { passphrase = ''; token = ''; }
    process.stderr.write('systemd加密凭据已注册。停止旧前台服务后运行 sudo systemctl enable --now waterdo-bridge.service。\n');
    return;
  }
  if (command === 'serve') {
    if (flags['--demo'] && flags['--systemd-credential']) throw new BridgeError('INVALID_ARGUMENT', '演示不能使用真实systemd凭据。');
    let adapter, transport, binding, store, mutationService = null, writeKey = null;
    const writes = flags['--enable-writes'] === true;
    if (flags['--demo']) { adapter = new DemoAdapter(); transport = adapter; binding = createHash('sha256').update('synthetic-demo').digest('hex'); }
    else {
      let passphrase = flags['--systemd-credential'] ? null : await hiddenPrompt('解锁本地 WaterDo 授权：');
      let token;
      try {
        if (flags['--systemd-credential']) {
          const { loadSystemdToken } = await import('./systemd-credentials.mjs');
          token = await loadSystemdToken();
        } else token = await loadCredentials(passphrase);
        adapter = new WaterDoAdapter(token);
        if (writes) {
          const { SelfTestTransport } = await import('./self-test-transport.mjs');
          transport = new SelfTestTransport(token); binding = createHash('sha256').update(token).digest('hex');
        }
      } finally { passphrase = ''; token = ''; }
    }
    const active = new Set(); let stopping = false;
    try {
      const apiKey = await ensureBridgeKey();
      const service = new WaterDoService(adapter, { demo: flags['--demo'] === true });
      if (writes) {
        const { OperationStore } = await import('./operation-store.mjs');
        const { MutationService } = await import('./mutations.mjs');
        // Demo is in-memory data with an isolated metadata store, never live history.
        store = new OperationStore(flags['--demo'] ? await mkdtemp(join(tmpdir(), 'waterdo-demo-ops-')) : undefined);
        await store.init(binding); writeKey = await ensureWriteKey();
        const instance = new MutationService({ transport, store });
        mutationService = {
          status: () => instance.status(), getOperation: id => instance.getOperation(id),
          mutate: input => {
            if (stopping) throw new BridgeError('OPERATION_BUSY', '服务正在停止，未接收新的写入。', 409);
            const operation = instance.mutate(input); active.add(operation);
            operation.finally(() => active.delete(operation)).catch(() => {}); return operation;
          },
        };
      }
      const server = createHttpServer({ service, apiKey, port, mutationService, writeKey });
      await new Promise((resolvePromise, reject) => {
        server.once('error', () => reject(new BridgeError('LISTEN_FAILED', '无法监听本机端口，可能已被占用。', 503)));
        server.listen(port, '127.0.0.1', resolvePromise);
      });
      process.stderr.write(`WaterDo Bridge ${flags['--demo'] ? 'DEMO（合成数据）' : 'LIVE'}: http://127.0.0.1:${port}，${writes ? '普通任务写入已启用' : '只读'}。\n`);
      const shutdown = () => {
        if (stopping) return; stopping = true;
        server.close(async () => {
          await Promise.allSettled([...active]);
          await store?.close().catch(() => { process.exitCode = 1; });
          adapter = null; transport = null;
        });
        server.closeIdleConnections();
      };
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    } catch (error) { await store?.close().catch(() => {}); throw error; }
    return;
  }
  // Fail invalid queries before reading local credentials or making requests.
  let query;
  if (command === 'tasks') {
    query = Object.fromEntries(Object.entries(flags).filter(([k]) => k !== '--port').map(([k, v]) => [k.slice(2).replaceAll('-', '_'), v]));
    parseQuery(query);
  }
  if (command === 'task') validateId(positional[0]);
  let operationInput;
  if (command === 'mutate') {
    if (!flags['--json-stdin']) throw new BridgeError('INVALID_ARGUMENT', '写入必须使用 --json-stdin。');
    const { validateMutation } = await import('./mutations.mjs');
    operationInput = validateMutation(await mutationInput());
  }
  if (command === 'operation') {
    const { validateRequestId } = await import('./mutations.mjs'); validateRequestId(positional[0]);
  }
  const writeEnabled = command === 'mutate' || flags['--write'] === true;
  const apiKey = writeEnabled ? await readWriteKey() : await readBridgeKey();
  const request = (path, q) => fetchBridge({ port, apiKey, path, query: q });
  const client = {
    connection: () => request('/v1/connection'), capabilities: () => request('/v1/capabilities'),
    listTasks: q => request('/v1/tasks', q), getTask: id => request(`/v1/tasks/${encodeURIComponent(validateId(id))}`),
    listTags: () => request('/v1/tags'),
    mutate: body => fetchBridge({ port, apiKey, path: '/v1/operations', method: 'POST', body }),
    getOperation: id => request(`/v1/operations/${encodeURIComponent(id)}`),
  };
  if (command === 'mcp') { await runMcp({ client, writeEnabled }); return; }
  const result = command === 'status' ? await client.connection() : command === 'capabilities' ? await client.capabilities()
    : command === 'tasks' ? await client.listTasks(query) : command === 'task' ? await client.getTask(positional[0])
    : command === 'mutate' ? await client.mutate(operationInput) : command === 'operation' ? await client.getOperation(positional[0]) : await client.listTags();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (command === 'mutate' && result.state !== 'succeeded') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // CLI never prints arbitrary stack traces or original remote error bodies.
    const safe = error instanceof BridgeError || (typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) && Number.isInteger(error.status));
    process.stderr.write(JSON.stringify({ error: { code: safe ? error.code : 'INTERNAL_ERROR', message: safe ? error.message : '操作失败；未输出敏感错误详情。' } }) + '\n');
    process.exitCode = 1;
  });
}
