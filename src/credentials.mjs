import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, realpath, unlink } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, validateToken } from './core.mjs';

const scrypt = promisify(scryptCallback);
export const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.private');
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const AAD = Buffer.from('waterdo-bridge-vault:v1');
const error = () => new BridgeError('CREDENTIAL_STORAGE', '凭据文件缺失、权限不安全或格式不正确；请在服务器终端运行 configure。', 503);
const isOwner = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
export async function secureDirectory(directory) {
  const path = resolve(directory);
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwner(stat) || (stat.mode & 0o077) !== 0) throw error();
  return path;
}
async function privateRead(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !isOwner(stat) || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw error();
    return await handle.readFile('utf8');
  } catch { throw error(); } finally { await handle?.close(); }
}
async function privateWrite(path, content, replace = false) {
  let handle;
  try {
    // Replace atomically: a failed write must not destroy the last valid credential.
    if (replace) {
      await privateRead(path);
      const directory = dirname(path);
      const before = await lstat(path);
      if (await realpath(path) !== resolve(path)) throw error();
      const temporary = resolve(directory, `.vault-${randomBytes(16).toString('hex')}.tmp`);
      if (dirname(temporary) !== directory) throw error();
      let created = false;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
        const current = await lstat(path);
        if (current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()
            || await realpath(path) !== resolve(path) || await realpath(temporary) !== temporary) throw error();
        // Both absolute rename targets were checked above in the private directory.
        await rename(temporary, path); created = false;
        const dirHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
        return;
      } finally {
        await handle?.close(); handle = undefined;
        if (created) {
          const stat = await lstat(temporary);
          if (stat.isFile() && !stat.isSymbolicLink() && await realpath(temporary) === temporary && dirname(temporary) === directory) {
            await unlink(temporary);
          }
        }
      }
    }
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, 'utf8'); await handle.sync();
  } catch (e) {
    if (e.code === 'EEXIST') throw new BridgeError('ALREADY_CONFIGURED', '已有授权文件；若需替换，请使用 configure --replace。', 409);
    if (e instanceof BridgeError) throw e;
    throw error();
  } finally { await handle?.close(); }
}
export async function encryptToken(token, passphrase) {
  validateToken(token);
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
    throw new BridgeError('WEAK_PASSPHRASE', '本地加密口令至少 12 个字符，且不超过 1024 个字符。');
  }
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, 32, KDF);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return { version: 1, kdf: 'scrypt-32768-8-1', cipher: 'aes-256-gcm', salt: salt.toString('hex'),
      iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
  } finally { key.fill(0); }
}
export async function decryptToken(envelope, passphrase) {
  let key;
  try {
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw Error();
    if (envelope?.version !== 1 || envelope.kdf !== 'scrypt-32768-8-1' || envelope.cipher !== 'aes-256-gcm') throw Error();
    for (const [field, length] of [['salt', 32], ['iv', 24], ['tag', 32]]) {
      if (typeof envelope[field] !== 'string' || envelope[field].length !== length || !/^[0-9a-f]+$/.test(envelope[field])) throw Error();
    }
    if (typeof envelope.ciphertext !== 'string' || !/^(?:[0-9a-f]{2}){8,8192}$/.test(envelope.ciphertext)) throw Error();
    key = await scrypt(passphrase, Buffer.from(envelope.salt, 'hex'), 32, KDF);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return validateToken(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'hex')), decipher.final()]).toString('utf8'));
  } catch { throw new BridgeError('UNLOCK_FAILED', '本地口令不正确，或授权文件已损坏；未连接 WaterDo。', 401); }
  finally { key?.fill(0); }
}
export async function saveCredentials(token, passphrase, { directory = STATE_DIR, replace = false } = {}) {
  const dir = await secureDirectory(directory);
  const envelope = await encryptToken(token, passphrase);
  await privateWrite(resolve(dir, 'credentials.vault.json'), JSON.stringify(envelope) + '\n', replace);
  await ensureBridgeKey(dir);
}
export async function loadCredentials(passphrase, directory = STATE_DIR) {
  const dir = await secureDirectory(directory);
  let envelope;
  try { envelope = JSON.parse(await privateRead(resolve(dir, 'credentials.vault.json'))); } catch { throw error(); }
  return decryptToken(envelope, passphrase);
}
async function ensureLocalKey(directory, filename) {
  const dir = await secureDirectory(directory);
  const path = resolve(dir, filename);
  try {
    await lstat(path);
  } catch (e) {
    if (e.code !== 'ENOENT') throw error();
    try { await privateWrite(path, randomBytes(32).toString('base64url') + '\n'); }
    catch (e) { if (e.code !== 'ALREADY_CONFIGURED') throw e; }
  }
  return readLocalKey(dir, filename);
}
async function readLocalKey(directory, filename) {
  const dir = await secureDirectory(directory);
  const key = (await privateRead(resolve(dir, filename))).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').toString('base64url') !== key) throw error();
  return key;
}
export const ensureBridgeKey = (directory = STATE_DIR) => ensureLocalKey(directory, 'bridge.key');
export const readBridgeKey = (directory = STATE_DIR) => readLocalKey(directory, 'bridge.key');
export const ensureWriteKey = (directory = STATE_DIR) => ensureLocalKey(directory, 'write.key');
export const readWriteKey = (directory = STATE_DIR) => readLocalKey(directory, 'write.key');

/** Do not accept secrets as command arguments, environment variables or piped stdin. */
export function hiddenPrompt(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new BridgeError('TTY_REQUIRED', '请在服务器的交互终端中输入凭据；不要通过聊天、命令参数或管道传入。');
  }
  output.write(prompt);
  return new Promise((resolvePromise, reject) => {
    let value = ''; const previousRaw = Boolean(input.isRaw);
    const finish = (err) => {
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      input.setRawMode(previousRaw); input.pause(); output.write('\n');
      if (err) reject(err); else resolvePromise(value);
      value = '';
    };
    const onEnd = () => finish(new BridgeError('CANCELLED', '输入已取消。'));
    const onError = () => finish(new BridgeError('INPUT_ERROR', '无法读取安全输入。'));
    const onData = data => {
      for (const char of data.toString('utf8')) {
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u0003' || char === '\u0004') { onEnd(); return; }
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char >= ' ' && char !== '\u007f') value += char;
        if (value.length > 8192) { finish(new BridgeError('INPUT_TOO_LONG', '输入过长。')); return; }
      }
    };
    input.setEncoding('utf8'); input.setRawMode(true); input.on('data', onData);
    input.once('end', onEnd); input.once('error', onError); input.resume();
  });
}
