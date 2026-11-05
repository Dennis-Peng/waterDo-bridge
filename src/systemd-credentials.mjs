import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { BridgeError, validateToken } from './core.mjs';

const CREDENTIAL_DIRECTORY = '/run/credentials/waterdo-bridge.service';
const ENCRYPTED_CREDENTIAL = '/etc/credstore.encrypted/waterdo-token';
const TOKEN_LIMIT = 8192;
const storageError = () => new BridgeError('SYSTEMD_CREDENTIAL_STORAGE', 'systemd 凭据缺失、路径或权限不安全；请在本机终端检查部署。', 503);
const enrollError = () => new BridgeError('SYSTEMD_ENROLL_FAILED', 'systemd 凭据注册失败；请在本机终端检查部署、sudo 缓存、TPM2 及是否有未完成注册。不要盲目重试或删除锁；未输出子进程详情。', 503);
const existsError = () => new BridgeError('SYSTEMD_CREDENTIAL_EXISTS', '已有 systemd 凭据，拒绝覆盖；请先核对未决操作和历史绑定，再人工安排安全迁移。', 409);
const isOwner = stat => typeof process.getuid === 'function' && (stat.uid === 0 || stat.uid === process.getuid());
const isPrivateFile = stat => stat.isFile() && isOwner(stat) && stat.nlink === 1
  && [0o400, 0o600, 0o440].includes(stat.mode & 0o7777) && stat.size <= TOKEN_LIMIT;

// systemd 255 may keep credentials root-owned with a named-user ACL. Its ACL
// mask appears as group bits (0440/0550); never treat that as a general group grant.
async function checkReadOnlyAcl(handle, directory) {
  const permission = directory ? 'r-x' : 'r--';
  const expected = new Set([`user::${permission}`, `user:${process.getuid()}:${permission}`,
    'group::---', `mask::${permission}`, 'other::---']);
  const text = await new Promise((resolveText, reject) => {
    const child = spawn('/usr/bin/getfacl', ['-c', '-n', '-p', '/proc/self/fd/3'], {
      shell: false, stdio: ['ignore', 'pipe', 'ignore', handle.fd],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    let result = '', settled = false;
    const done = (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(storageError()); else resolveText(result);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); done(true); }, 5000);
    child.once('error', () => done(true));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      result += chunk; if (result.length > 2048) { child.kill('SIGTERM'); done(true); }
    });
    child.once('close', code => done(code !== 0));
  });
  const lines = text.trim().split('\n');
  if (lines.length !== expected.size || lines.some(line => !expected.has(line)) || new Set(lines).size !== lines.length) throw storageError();
}

// Linux openat-style traversal: each component is opened relative to a pinned
// directory FD. Only the kernel's /proc/self/fd links are followed, never links
// supplied in the credential path, including intermediate directory components.
async function openDirectoryNoFollow(directory) {
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of directory.split('/').filter(Boolean)) {
      const next = await open(`/proc/self/fd/${handle.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const previous = handle; handle = next; await previous.close();
      if (!isOwner(await handle.stat())) throw storageError();
    }
    const stat = await handle.stat();
    if (!stat.isDirectory() || !isOwner(stat)) throw storageError();
    if ((stat.mode & 0o7777) === 0o550) await checkReadOnlyAcl(handle, true);
    else if ((stat.mode & 0o7077) !== 0) throw storageError();
    return handle;
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

/** directory is an explicit synthetic-test seam, never a CLI option or env override. */
export async function loadSystemdToken({ env = process.env, directory } = {}) {
  let parent, file;
  const bytes = Buffer.alloc(TOKEN_LIMIT + 1);
  try {
    const path = directory === undefined ? env.CREDENTIALS_DIRECTORY : directory;
    if (directory === undefined && path !== CREDENTIAL_DIRECTORY) throw storageError();
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw storageError();
    parent = await openDirectoryNoFollow(path);
    // O_NONBLOCK prevents an attacker-controlled FIFO from blocking before fstat.
    file = await open(`/proc/self/fd/${parent.fd}/waterdo-token`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!isPrivateFile(before)) throw storageError();
    if ((before.mode & 0o7777) === 0o440) await checkReadOnlyAcl(file, false);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > TOKEN_LIMIT || !isPrivateFile(after) || before.size !== length || after.size !== length
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw storageError();
    // No trim: whitespace/newlines/NUL and non-ASCII input must fail validation.
    return validateToken(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch { throw storageError(); }
  finally {
    bytes.fill(0);
    await file?.close().catch(() => {});
    await parent?.close().catch(() => {});
  }
}

// Fixed non-secret root metadata checks and an atomic, one-shot reservation.
// Keep the empty marker even on failure: a killed/uncertain encrypt child must
// never race a retry and silently overwrite the operation-store token binding.
// Explicit credential rotation/recovery requires administrator review, not an
// automatic unlink. Exit 73 differs from sudo failures and reserved-attempt 74.
const CHECK_ABSENT = `set -eu
[ -d /etc/credstore.encrypted ] && [ ! -L /etc/credstore.encrypted ] || exit 72
[ "$(/usr/bin/stat -c '%u:%a' -- /etc/credstore.encrypted)" = '0:700' ] || exit 72
if [ -e ${ENCRYPTED_CREDENTIAL} ] || [ -L ${ENCRYPTED_CREDENTIAL} ]; then exit 73; fi
/usr/bin/mkdir --mode=0700 -- /etc/credstore.encrypted/.waterdo-token.enrollment-lock || exit 74
if [ -e ${ENCRYPTED_CREDENTIAL} ] || [ -L ${ENCRYPTED_CREDENTIAL} ]; then exit 73; fi
`;
const CHECK_CREATED = `set -eu
[ -f ${ENCRYPTED_CREDENTIAL} ] && [ ! -L ${ENCRYPTED_CREDENTIAL} ] || exit 72
[ "$(/usr/bin/stat -c '%u' -- ${ENCRYPTED_CREDENTIAL})" = '0' ] || exit 72
/usr/bin/chmod 0600 -- ${ENCRYPTED_CREDENTIAL}
[ "$(/usr/bin/stat -c '%u:%a' -- ${ENCRYPTED_CREDENTIAL})" = '0:600' ] || exit 72
`;

function sudoCommand(args, { spawnImpl, input } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child, timer, finished = false;
    const finish = (error, code) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(enrollError()); else resolvePromise(code);
    };
    try {
      // spawn inherits this umask synchronously; restore before yielding to other
      // code. A final root chmod/check also covers sudoers umask overrides.
      const previousMask = process.umask(0o077);
      try {
        child = spawnImpl('/usr/bin/sudo', ['-n', ...args], {
          shell: false, cwd: '/',
          // Do not inherit debugging hooks, environment-provided secrets or pagers.
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
          stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
        });
      } finally { process.umask(previousMask); }
      child.once('error', () => finish(true));
      child.once('close', (code, signal) => finish(Boolean(signal) || !Number.isInteger(code), code));
      timer = setTimeout(() => {
        finish(true);
        try { child.kill('SIGTERM'); } catch { /* Never expose child exceptions. */ }
      }, 120_000);
      if (input !== undefined) {
        child.stdin.once('error', () => {
          finish(true);
          try { child.kill('SIGTERM'); } catch { /* Never expose child exceptions. */ }
        });
        child.stdin.end(input);
      }
    } catch {
      finish(true);
      try { child?.kill('SIGTERM'); } catch { /* Never expose child exceptions. */ }
    }
  });
}

/** Caller unlocks the existing vault locally; only this token goes to sudo stdin. */
export async function enrollSystemdToken(token, { spawnImpl = spawn } = {}) {
  validateToken(token);
  const absent = await sudoCommand(['/usr/bin/bash', '-c', CHECK_ABSENT], { spawnImpl });
  if (absent === 73) throw existsError();
  if (absent !== 0) throw enrollError();
  const input = Buffer.from(token, 'utf8');
  try {
    const status = await sudoCommand(['/usr/bin/systemd-creds', 'encrypt', '--name=waterdo-token',
      '--with-key=host+tpm2', '--tpm2-pcrs=7', '-', ENCRYPTED_CREDENTIAL], { spawnImpl, input });
    if (status !== 0) throw enrollError();
  } finally { input.fill(0); }
  const verified = await sudoCommand(['/usr/bin/bash', '-c', CHECK_CREATED], { spawnImpl });
  if (verified !== 0) throw enrollError();
}
