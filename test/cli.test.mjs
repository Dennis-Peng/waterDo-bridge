import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function command(script, args, input = '') {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test('write-enabled CLI once-started service performs CRUD and idempotent replay without prompts', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-write-cli-test-'));
  await cp(fileURLToPath(new URL('../src', import.meta.url)), join(directory, 'src'), { recursive: true });
  const script = join(directory, 'src', 'cli.mjs');
  const port = await availablePort();
  const server = spawn(process.execPath, [script, 'serve', '--demo', '--enable-writes', '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => server.once('close', resolve));
  t.after(async () => { server.kill('SIGTERM'); await closed; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.kill('SIGKILL'); reject(Error('write demo startup timeout')); }, 5000);
    let text = ''; server.stderr.setEncoding('utf8');
    server.stderr.on('data', data => { text += data; if (text.includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } });
    server.once('error', e => { clearTimeout(timer); reject(e); });
    server.once('close', () => { clearTimeout(timer); reject(Error('write demo failed startup')); });
  });
  const args = ['--port', String(port)];
  const readStatus = JSON.parse((await command(script, ['status', ...args])).stdout);
  assert.equal(readStatus.access, 'read'); assert.equal(readStatus.writes_available, false);
  const writeStatus = JSON.parse((await command(script, ['status', '--write', ...args])).stdout);
  assert.equal(writeStatus.access, 'write'); assert.equal(writeStatus.writes_available, true);
  const create = { request_id: randomUUID(), action: 'create', changes: { title: 'Synthetic new task', notes: 'synthetic notes', due_at: null } };
  async function mutate(input) {
    const out = await command(script, ['mutate', '--json-stdin', ...args], JSON.stringify(input));
    assert.equal(out.stderr, ''); assert.equal(out.code, 0); return JSON.parse(out.stdout);
  }
  const created = await mutate(create);
  assert.equal(created.state, 'succeeded'); assert.equal(created.action, 'create');
  assert.ok(created.task_id); assert.equal(Object.hasOwn(created, 'request_hash'), false);
  const replay = await mutate(create); assert.equal(replay.task_id, created.task_id);
  const current = JSON.parse((await command(script, ['task', created.task_id, ...args])).stdout).item;
  const updated = await mutate({ request_id: randomUUID(), action: 'update', task_id: current.id, expected_version: current.version,
    changes: { title: 'Synthetic changed', due_at: '2026-11-07T10:00:00+08:00' } });
  assert.equal(updated.state, 'succeeded');
  const deleted = await mutate({ request_id: randomUUID(), action: 'delete', task_id: current.id, expected_version: updated.result_version });
  assert.equal(deleted.state, 'succeeded');
  const report = await command(script, ['operation', deleted.request_id, ...args]);
  assert.equal(report.code, 0); assert.equal(JSON.parse(report.stdout).state, 'succeeded');
  const after = JSON.parse((await command(script, ['tasks', '--q', 'Synthetic', ...args])).stdout);
  assert.equal(after.items.length, 0);
  const habit = await mutate({ request_id: randomUUID(), action: 'create', changes: {
    title: 'Synthetic habit', due_at: '2026-11-07T10:00:00+08:00', recurrence: 'weekly', reminder_enabled: true, tag_id: '1' } });
  const completed = await mutate({ request_id: randomUUID(), action: 'complete', task_id: habit.task_id, expected_version: habit.result_version });
  assert.equal(completed.state, 'succeeded');
  const habits = JSON.parse((await command(script, ['tasks', '--q', 'Synthetic habit', ...args])).stdout).items;
  assert.equal(habits.length, 1); assert.notEqual(habits[0].id, habit.task_id);
  assert.equal(habits[0].due.value, '2026-11-14T02:00:00.000Z');
  const tags = JSON.parse((await command(script, ['tags', ...args])).stdout).items;
  const tag = await mutate({ request_id: randomUUID(), action: 'tag_update', tag_id: '1', expected_version: tags[0].version,
    changes: { name: 'Synthetic renamed category', color_id: 7 } });
  assert.equal(tag.state, 'succeeded');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  const readMcp = await command(script, ['mcp', ...args], messages);
  assert.equal(JSON.parse(readMcp.stdout.trim().split('\n')[1]).result.tools.length, 4);
  const writeMcp = await command(script, ['mcp', '--write', ...args], messages);
  const tools = JSON.parse(writeMcp.stdout.trim().split('\n')[1]).result.tools;
  assert.equal(tools.length, 10); assert.ok(tools.some(tool => tool.name === 'waterdo_delete_task'));
});

test('CLI help, input rejection, isolated demo REST and stdio MCP roundtrip', { timeout: 20000 }, async t => {
  // Copy code into a fresh synthetic workspace; never touch the user's .private directory.
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-cli-test-'));
  await cp(fileURLToPath(new URL('../src', import.meta.url)), join(directory, 'src'), { recursive: true });
  const script = join(directory, 'src', 'cli.mjs');
  const help = await command(script, ['help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /只读/);
  const configure = await command(script, ['configure'], 'do-not-accept-piped-secret\n');
  assert.equal(configure.code, 1); assert.match(configure.stderr, /TTY_REQUIRED/);
  assert.ok(!configure.stderr.includes('do-not-accept-piped-secret'));
  const report = await command(script, ['self-test', '--report']);
  assert.equal(report.code, 0); assert.equal(JSON.parse(report.stdout).state, 'not_started');
  const selfTest = await command(script, ['self-test', '--run'], 'TEST\nnever-use-piped-passphrase\n');
  assert.equal(selfTest.code, 1); assert.match(selfTest.stderr, /TTY_REQUIRED/);
  assert.ok(!selfTest.stderr.includes('never-use-piped-passphrase'));
  const wrongScope = await command(script, ['self-test', '--run', '--task-id', '8']);
  assert.equal(wrongScope.code, 1); assert.match(wrongScope.stderr, /INVALID_ARGUMENT/);
  const noMode = await command(script, ['self-test']);
  assert.equal(noMode.code, 1); assert.match(noMode.stderr, /INVALID_ARGUMENT/);
  const unknown = await command(script, ['serve', '--token', 'never-echo-this-value']);
  assert.equal(unknown.code, 1); assert.ok(!unknown.stderr.includes('never-echo-this-value'));
  const port = await availablePort();
  const server = spawn(process.execPath, [script, 'serve', '--demo', '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => server.once('close', resolve));
  t.after(async () => { server.kill('SIGTERM'); await closed; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { server.kill('SIGKILL'); reject(Error('demo startup timeout')); }, 5000);
    server.stderr.setEncoding('utf8');
    let text = '';
    server.stderr.on('data', data => { text += data; if (text.includes(`127.0.0.1:${port}`)) { clearTimeout(timeout); resolve(); } });
    server.once('error', err => { clearTimeout(timeout); reject(err); });
    server.once('close', () => { clearTimeout(timeout); reject(Error('demo ended before startup')); });
  });
  const status = await command(script, ['status', '--port', String(port)]);
  assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).mode, 'demo');
  const tasks = await command(script, ['tasks', '--limit', '1', '--port', String(port)]);
  assert.equal(tasks.code, 0); assert.equal(JSON.parse(tasks.stdout).items.length, 1);
  assert.equal(JSON.parse(tasks.stdout).mode, 'demo');
  const single = await command(script, ['task', '101', '--port', String(port)]);
  assert.equal(single.code, 0); assert.equal(JSON.parse(single.stdout).item.id, '101');
  const bad = await command(script, ['tasks', '--from', 'tomorrow', '--port', String(port)]);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /INVALID_TIME/);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'waterdo_list_tasks', arguments: { limit: 1 } } },
  ];
  const mcp = await command(script, ['mcp', '--port', String(port)], messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  assert.equal(mcp.code, 0); assert.equal(mcp.stderr, '');
  const responses = mcp.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses[1].result.tools.length, 4);
  assert.equal(JSON.parse(responses[2].result.content[0].text).data.mode, 'demo');
  assert.equal(responses[2].result.isError, false);
});
