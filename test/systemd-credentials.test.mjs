import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { loadSystemdToken, enrollSystemdToken } from '../src/systemd-credentials.mjs';

const TOKEN = 'synthetic-systemd-token-only';
const ENCRYPTED = '/etc/credstore.encrypted/waterdo-token';
const STORAGE_ERROR = { code: 'SYSTEMD_CREDENTIAL_STORAGE' };
// Synthetic temporary directories only; leave cleanup to the OS, no real vaults.
async function fixture(token = TOKEN, mode = 0o400) {
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-systemd-test-'));
  await writeFile(join(directory, 'waterdo-token'), token, { mode });
  return directory;
}
function mockSpawn(steps = [0, 0, 0]) {
  const calls = [];
  return {
    calls,
    spawnImpl(command, args, options) {
      const step = steps[calls.length];
      assert.notEqual(step, undefined, 'Unexpected additional child process');
      const call = { command, args, options, input: [], umask: process.umask() }; calls.push(call);
      if (step === 'throw') throw new Error(`${TOKEN}: unsafe spawn error`);
      const child = new EventEmitter(); child.kill = () => true;
      const close = () => queueMicrotask(() => {
        if (step === 'error') child.emit('error', new Error(`${TOKEN}: unsafe child error`));
        else if (step === 'signal') child.emit('close', null, 'SIGTERM');
        else child.emit('close', step, null);
      });
      if (options.stdio[0] === 'pipe') {
        child.stdin = new Writable({
          write(chunk, encoding, callback) {
            call.input.push(Buffer.from(chunk));
            if (step === 'stdin-error') callback(new Error(`${TOKEN}: unsafe EPIPE`));
            else callback();
          },
          final(callback) { callback(); close(); },
        });
      } else close();
      return child;
    },
  };
}

test('systemd token loader reads strict 0400/0600 synthetic regular files', async () => {
  for (const mode of [0o400, 0o600]) {
    const directory = await fixture(TOKEN, mode);
    assert.equal(await loadSystemdToken({ env: {}, directory }), TOKEN);
  }
  assert.equal(await loadSystemdToken({ directory: await fixture('A'.repeat(8192)) }), 'A'.repeat(8192));
});

test('systemd named-user ACL permits only this service user, never a broad group or extra user', async () => {
  const directory = await fixture(); const file = join(directory, 'waterdo-token'); const uid = process.getuid();
  await chmod(directory, 0o500);
  await exec('/usr/bin/setfacl', ['-m', `u:${uid}:r-x,g::---,m::r-x,o::---`, directory]);
  await exec('/usr/bin/setfacl', ['-m', `u:${uid}:r--,g::---,m::r--,o::---`, file]);
  assert.equal(await loadSystemdToken({ directory }), TOKEN);
  await exec('/usr/bin/setfacl', ['-m', 'g::r--', file]);
  await assert.rejects(loadSystemdToken({ directory }), STORAGE_ERROR);
  await exec('/usr/bin/setfacl', ['-m', `g::---,g:${process.getgid()}:r--`, file]);
  await assert.rejects(loadSystemdToken({ directory }), STORAGE_ERROR);
});

test('production loader requires the exact systemd directory, never arbitrary env paths', async () => {
  for (const value of [undefined, '', '/tmp/custom-credentials', '/run/credentials/other.service',
    '/run/credentials/waterdo-bridge.service/', '/run/credentials/../credentials/waterdo-bridge.service']) {
    await assert.rejects(loadSystemdToken({ env: { CREDENTIALS_DIRECTORY: value } }), STORAGE_ERROR);
  }
  for (const directory of ['relative', '/tmp/../tmp/credentials', '/tmp/credentials/']) {
    await assert.rejects(loadSystemdToken({ env: {}, directory }), STORAGE_ERROR);
  }
});

test('loader rejects symlinks at the file, directory and ancestor levels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'waterdo-systemd-links-test-'));
  const source = await fixture();
  await symlink(join(source, 'waterdo-token'), join(root, 'waterdo-token'));
  await assert.rejects(loadSystemdToken({ directory: root }), STORAGE_ERROR);
  const linkedDirectory = join(root, 'linked'); await symlink(source, linkedDirectory);
  await assert.rejects(loadSystemdToken({ directory: linkedDirectory }), STORAGE_ERROR);
  const nested = join(source, 'nested'); await mkdir(nested, { mode: 0o700 });
  await writeFile(join(nested, 'waterdo-token'), TOKEN, { mode: 0o400 });
  await assert.rejects(loadSystemdToken({ directory: join(linkedDirectory, 'nested') }), STORAGE_ERROR);
});

test('loader rejects broad permissions, nonregular files, missing and oversized credentials', async () => {
  for (const mode of [0o000, 0o200, 0o440, 0o644, 0o700, 0o640, 0o4600]) {
    const directory = await fixture(); await chmod(join(directory, 'waterdo-token'), mode);
    await assert.rejects(loadSystemdToken({ directory }), STORAGE_ERROR);
  }
  const broad = await fixture(); await chmod(broad, 0o755);
  await assert.rejects(loadSystemdToken({ directory: broad }), STORAGE_ERROR);
  const directory = await mkdtemp(join(tmpdir(), 'waterdo-systemd-empty-test-'));
  await assert.rejects(loadSystemdToken({ directory }), STORAGE_ERROR);
  await mkdir(join(directory, 'waterdo-token'), { mode: 0o700 });
  await assert.rejects(loadSystemdToken({ directory }), STORAGE_ERROR);
  await assert.rejects(loadSystemdToken({ directory: await fixture('A'.repeat(8193)) }), STORAGE_ERROR);
});

test('loader rejects credentials owned by neither root nor the current uid', async t => {
  if (process.getuid() === 0) { t.skip('Cannot synthesize a non-root owner without chown'); return; }
  const directory = await fixture(), actualUid = process.getuid();
  t.mock.method(process, 'getuid', () => actualUid + 1);
  await assert.rejects(loadSystemdToken({ directory }), STORAGE_ERROR);
});

test('loader validates exact token bytes and emits only fixed safe errors', async () => {
  for (const token of ['', 'short', `${TOKEN}\n`, `${TOKEN}\r`, `${TOKEN}\0`, `${TOKEN} with spaces`,
    `${TOKEN}中文`, Buffer.from([0xff, 0xfe, ...Buffer.from(TOKEN)])]) {
    const directory = await fixture(token);
    await assert.rejects(loadSystemdToken({ directory }), error => {
      assert.equal(error.code, STORAGE_ERROR.code);
      assert.ok(!error.message.includes(TOKEN)); assert.ok(!error.message.includes(directory));
      assert.equal(error.cause, undefined); return true;
    });
  }
});

test('enrollment sends token only over stdin to fixed sudo systemd-creds argv', async () => {
  const mock = mockSpawn();
  assert.equal(await enrollSystemdToken(TOKEN, mock), undefined);
  assert.equal(mock.calls.length, 3);
  const encrypt = mock.calls[1];
  assert.deepEqual(encrypt.args, ['-n', '/usr/bin/systemd-creds', 'encrypt', '--name=waterdo-token',
    '--with-key=host+tpm2', '--tpm2-pcrs=7', '-', ENCRYPTED]);
  assert.equal(Buffer.concat(encrypt.input).toString(), TOKEN);
  assert.equal(mock.calls[0].input.length, 0); assert.equal(mock.calls[2].input.length, 0);
  assert.match(mock.calls[0].args[3], /\[ -e .*waterdo-token \] \|\| \[ -L .*waterdo-token \]/);
  assert.match(mock.calls[0].args[3], /exit 73/);
  assert.match(mock.calls[0].args[3], /\/usr\/bin\/mkdir --mode=0700 -- \/etc\/credstore\.encrypted\/\.waterdo-token\.enrollment-lock \|\| exit 74/);
  assert.ok(!mock.calls.some(call => call.args.some(arg => /\b(rm|rmdir|unlink|mv)\b/.test(arg))));
  assert.match(mock.calls[2].args[3], /\/usr\/bin\/chmod 0600 -- \/etc\/credstore\.encrypted\/waterdo-token/);
  assert.match(mock.calls[2].args[3], /0:600/);
  for (const call of mock.calls) {
    assert.equal(call.umask, 0o077);
    assert.equal(call.command, '/usr/bin/sudo'); assert.equal(call.options.shell, false);
    assert.ok(!JSON.stringify(call.args).includes(TOKEN));
    assert.ok(!JSON.stringify(call.options).includes(TOKEN));
    assert.deepEqual(call.options.stdio.slice(1), ['ignore', 'ignore']);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.ok(!call.args.some(arg => arg.startsWith('--with-key=auto') || arg === '--with-key=host'));
  }
});

test('existing credential and unsafe metadata fail before token is piped', async () => {
  for (const status of [73, 72, 74, 1]) {
    const mock = mockSpawn([status]);
    await assert.rejects(enrollSystemdToken(TOKEN, mock), {
      code: status === 73 ? 'SYSTEMD_CREDENTIAL_EXISTS' : 'SYSTEMD_ENROLL_FAILED',
    });
    assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].input.length, 0);
  }
});

test('concurrent enrollment reservation permits only one encrypt process', async () => {
  const first = mockSpawn([0, 0, 0]);
  const second = mockSpawn([74]);
  const results = await Promise.allSettled([
    enrollSystemdToken(TOKEN, first), enrollSystemdToken(TOKEN, second),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'SYSTEMD_ENROLL_FAILED');
  assert.equal([...first.calls, ...second.calls].filter(call => call.args[1] === '/usr/bin/systemd-creds').length, 1);
  assert.equal(second.calls[0].input.length, 0);
});

test('invalid tokens never invoke sudo', async () => {
  for (const token of ['tiny', `${TOKEN}\n`, 'A'.repeat(8193), null]) {
    const mock = mockSpawn([]);
    await assert.rejects(enrollSystemdToken(token, mock), { code: 'INVALID_TOKEN' });
    assert.equal(mock.calls.length, 0);
  }
});

test('child failures, signals, stdin errors and unsafe output metadata expose no secrets or fallback', async () => {
  for (const steps of [['throw'], ['error'], ['signal'], [0, 'throw'], [0, 'error'], [0, 'signal'],
    [0, 'stdin-error'], [0, 1], [0, 0, 72]]) {
    const mock = mockSpawn(steps), previousMask = process.umask();
    await assert.rejects(enrollSystemdToken(TOKEN, mock), error => {
      assert.equal(error.code, 'SYSTEMD_ENROLL_FAILED');
      assert.ok(!error.message.includes(TOKEN)); assert.ok(!error.message.includes('unsafe'));
      assert.equal(error.cause, undefined); return true;
    });
    assert.equal(mock.calls.length, steps.length);
    assert.equal(process.umask(), previousMask);
  }
});

test('deployment template pins loopback CLI, credential source and sandbox boundaries', async () => {
  const unit = await readFile(new URL('../deploy/waterdo-bridge.service', import.meta.url), 'utf8');
  for (const directive of ['User=@SERVICE_USER@', 'Group=@SERVICE_GROUP@', 'WorkingDirectory=@PROJECT_DIR@',
    'ExecStart=/usr/bin/node src/cli.mjs serve --enable-writes --systemd-credential',
    `LoadCredentialEncrypted=waterdo-token:${ENCRYPTED}`, 'Restart=on-failure', 'UMask=0077',
    'NoNewPrivileges=true', 'ProtectSystem=strict', 'ReadWritePaths=@PROJECT_DIR@/.private',
    'PrivateTmp=true', 'ProtectHome=read-only', 'LimitCORE=0', 'StandardInput=null',
    'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'UnsetEnvironment=NODE_OPTIONS NODE_PATH',
    'Environment=NODE_ENV=production', 'WantedBy=multi-user.target']) {
    assert.ok(unit.split('\n').includes(directive), directive);
  }
  assert.deepEqual(unit.match(/@[A-Z_]+@/g), ['@SERVICE_USER@', '@SERVICE_GROUP@', '@PROJECT_DIR@', '@PROJECT_DIR@']);
  assert.ok(Number(unit.match(/^TimeoutStopSec=(\d+)s?$/m)?.[1]) >= 150);
  assert.ok(!unit.includes('8787')); assert.ok(!unit.includes('Environment=TOKEN'));
});

test('installer derives sudo identity and canonical checkout, never custom command or secret inputs', async () => {
  const installer = await readFile(new URL('../deploy/install-systemd.sh', import.meta.url), 'utf8');
  await exec('/usr/bin/bash', ['-n', new URL('../deploy/install-systemd.sh', import.meta.url).pathname]);
  for (const required of [
    '[[ $# -eq 0 ]]', '[[ $EUID -eq 0 ]]', 'readonly service_user=$SUDO_USER',
    'service_uid=$(id -u -- "$service_user")', 'service_gid=$(id -g -- "$service_user")',
    'service_group=$(id -gn -- "$service_user")', '${SUDO_USER:-} != root',
    '$service_uid =~ ^[1-9][0-9]*$', '$service_gid =~ ^[1-9][0-9]*$',
    '$(id -un -- "$service_user") == "$service_user"',
    '${SUDO_UID:-} == "$service_uid"', '${SUDO_GID:-} == "$service_gid"',
    '${SUDO_USER:-} =~ ^[A-Za-z_][A-Za-z0-9_-]*$', '$service_group =~ ^[A-Za-z_][A-Za-z0-9_-]*$',
    'script_path=${BASH_SOURCE[0]}', 'readonly project=${script_path%/deploy/install-systemd.sh}',
    'readonly source_unit=$project/deploy/waterdo-bridge.service',
    'canonical_path "$script_path"', 'canonical_path "$source_unit"', 'canonical_path "$project/src/cli.mjs"',
    'canonical_path "$project/.private"', '$(stat -c \'%u\' -- "$project") == "$service_uid"',
    '$(stat -c \'%u:%a\' -- "$project/.private") == "$service_uid:700"',
    'readonly target_unit=/etc/systemd/system/waterdo-bridge.service', 'readonly credstore=/etc/credstore.encrypted',
    'canonical_path /etc/systemd/system', '! -L $target_unit', '! -L $credstore',
    '$(stat -c \'%u:%a\' -- "$credstore") == 0:700',
    'export PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'unset NODE_OPTIONS NODE_PATH',
    '-x /usr/bin/node', '-x /usr/bin/systemd-creds', '-x /usr/bin/getfacl', '-x /usr/bin/systemd-analyze',
    '/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/node -p', '>= 22',
  ]) assert.ok(installer.includes(required), required);
  assert.ok(!/^\s*(?:eval|source)\s/m.test(installer));
  assert.ok(!/^\s*(?:export\s+)?(?:TOKEN|PROJECT_DIR|SERVICE_USER|SERVICE_GROUP)=/m.test(installer));
  assert.ok(!/\b(?:read|chown|chmod)\b[^\n]*\$project\/\.private/.test(installer));
});

test('installer path validation rejects unsafe characters, noncanonical paths and every symlink component', async () => {
  const installer = await readFile(new URL('../deploy/install-systemd.sh', import.meta.url), 'utf8');
  const start = installer.indexOf('safe_path()');
  const end = installer.indexOf('\n[[ $# -eq 0 ]]');
  assert.ok(start > 0 && end > start);
  // Exercise only these pure validation functions, never the root installer.
  const functions = installer.slice(start, end);
  assert.match(functions, /\^\/\[A-Za-z0-9_\.\/-\]\+\$/);
  assert.ok(functions.includes('[[ ! -L $cursor ]]'));
  assert.ok(functions.includes('$(realpath -e -- "$path") == "$path"'));
  const validate = path => exec('/usr/bin/bash', ['-c', `${functions}\ncanonical_path "$1"`, 'validation-only', path], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  const root = await mkdtemp(join(tmpdir(), 'waterdo-installer-path-test-'));
  const directory = join(root, 'Safe_Ascii-1.2'); await mkdir(directory);
  const file = join(directory, 'unit.service'); await writeFile(file, 'synthetic');
  await validate(directory); await validate(file);
  const linked = join(root, 'linked-directory'); await symlink(directory, linked);
  const linkedFile = join(directory, 'linked-file'); await symlink(file, linkedFile);
  for (const path of [linked, `${linked}/unit.service`, linkedFile, 'relative', '/', `${directory}/`,
    `${root}//Safe_Ascii-1.2`, `${root}/./Safe_Ascii-1.2`, `${directory}/../Safe_Ascii-1.2`,
    `${directory}/.`, `${directory}/..`, `${root}/missing`,
    ...[' ', '%', '\n', '\r', '\\', '中文', '&', '|', '$', '\t'].map(character => `${root}/bad${character}path`)]) {
    await assert.rejects(validate(path), { code: 1 }, JSON.stringify(path));
  }
});

test('installer renders and verifies a root-private temporary unit with guarded cleanup; enables without starting', async () => {
  const installer = await readFile(new URL('../deploy/install-systemd.sh', import.meta.url), 'utf8');
  for (const required of [
    'mktemp -d /tmp/waterdo-systemd-install.XXXXXXXXXX', 'trap cleanup EXIT',
    '^/tmp/waterdo-systemd-install\\.[A-Za-z0-9]{10}$',
    'canonical_path "$temp_dir"', '$(stat -c \'%u:%a\' -- "$temp_dir") != 0:700',
    '$temp_unit == "$temp_dir/waterdo-bridge.service"', 'canonical_path "$temp_unit"',
    '$(stat -c \'%u:%a:%h\' -- "$temp_unit") == 0:600:1',
    'rm -- "${temp_unit:?}"', 'rmdir -- "${temp_dir:?}"',
    's|@SERVICE_USER@|$service_user|g', 's|@SERVICE_GROUP@|$service_group|g', 's|@PROJECT_DIR@|$project|g',
    '/usr/bin/systemd-analyze verify "$temp_unit"',
    'install --owner=root --group=root --mode=0644 -- "$temp_unit" "$target_unit"',
    'mkdir --mode=0700 -- "$credstore"',
  ]) assert.ok(installer.includes(required), required);
  assert.ok(installer.indexOf('canonical_path "$temp_dir"') < installer.indexOf('rmdir --'));
  assert.ok(installer.indexOf('canonical_path "$temp_unit"') < installer.indexOf('rm --'));
  assert.ok(installer.indexOf('systemd-analyze verify') < installer.indexOf('\ninstall --'));
  assert.match(installer, /^systemctl daemon-reload$/m);
  assert.match(installer, /^systemctl enable waterdo-bridge\.service$/m);
  assert.ok(!/^\s*systemctl (start|restart|enable --now)\b/m.test(installer));
  assert.ok(!/^\s*(?:mv|unlink)\b/m.test(installer));
  assert.ok(!/^\s*rm\s+[^\n]*-[rf]/m.test(installer));
  assert.ok(!/^\s*[^#\n]*systemd-creds\s+(encrypt|decrypt|cat)\b/m.test(installer));
});

test('rendered synthetic template passes systemd-analyze verify without installing or starting', async () => {
  const unit = await readFile(new URL('../deploy/waterdo-bridge.service', import.meta.url), 'utf8');
  const project = await mkdtemp(join(tmpdir(), 'waterdo-unit-verify-test-'));
  await mkdir(join(project, '.private'), { mode: 0o700 });
  const rendered = unit.replaceAll('@SERVICE_USER@', String(process.getuid()))
    .replaceAll('@SERVICE_GROUP@', String(process.getgid())).replaceAll('@PROJECT_DIR@', project);
  assert.ok(!/@[A-Z_]+@/.test(rendered));
  const path = join(project, 'waterdo-bridge.service'); await writeFile(path, rendered, { mode: 0o600 });
  await exec('/usr/bin/systemd-analyze', ['verify', path], {
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
  });
});
