import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptToken, decryptToken, saveCredentials, loadCredentials, readBridgeKey, ensureBridgeKey, ensureWriteKey, readWriteKey, hiddenPrompt } from '../src/credentials.mjs';

const TOKEN = 'test-only-upstream-token';
const PASS = 'long-local-test-passphrase';
// Test directories contain synthetic secrets only; left to OS temporary cleanup.
async function dir() { return mkdtemp(join(tmpdir(), 'waterdo-vault-test-')); }

test('AES-GCM vault roundtrips and ciphertext does not contain the token', async () => {
  const data = await encryptToken(TOKEN, PASS);
  assert.ok(!JSON.stringify(data).includes(TOKEN));
  assert.equal(await decryptToken(data, PASS), TOKEN);
  await assert.rejects(decryptToken(data, 'wrong-long-passphrase'), { code: 'UNLOCK_FAILED' });
  await assert.rejects(decryptToken({ ...data, tag: '00'.repeat(16) }, PASS), { code: 'UNLOCK_FAILED' });
  await assert.rejects(decryptToken({ ...data, kdf: 'arbitrary-parameters' }, PASS), { code: 'UNLOCK_FAILED' });
});
test('short passphrases and invalid header tokens are rejected', async () => {
  await assert.rejects(encryptToken(TOKEN, 'short'), { code: 'WEAK_PASSPHRASE' });
  for (const token of ['tiny', 'secret\r\nHeader:evil', '含有中文的错误token', 'token with spaces']) {
    await assert.rejects(encryptToken(token, PASS), { code: 'INVALID_TOKEN' });
  }
});
test('private files use 0600; upstream secret encrypted; Bridge key is separate', async () => {
  const directory = await dir();
  await saveCredentials(TOKEN, PASS, { directory });
  const vault = join(directory, 'credentials.vault.json');
  assert.equal((await stat(vault)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'bridge.key'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(vault, 'utf8')).includes(TOKEN));
  assert.equal(await loadCredentials(PASS, directory), TOKEN);
  const key = await readBridgeKey(directory);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await ensureBridgeKey(directory), key);
  await assert.rejects(saveCredentials(TOKEN, PASS, { directory }), { code: 'ALREADY_CONFIGURED' });
  await saveCredentials('updated-synthetic-token', PASS, { directory, replace: true });
  assert.equal(await loadCredentials(PASS, directory), 'updated-synthetic-token');
});
test('unsafe directory/file permissions and symlinks fail closed', async () => {
  const directory = await dir();
  await chmod(directory, 0o755);
  await assert.rejects(ensureBridgeKey(directory), { code: 'CREDENTIAL_STORAGE' });
  await chmod(directory, 0o700);
  await ensureBridgeKey(directory);
  await chmod(join(directory, 'bridge.key'), 0o644);
  await assert.rejects(readBridgeKey(directory), { code: 'CREDENTIAL_STORAGE' });
  const second = await dir();
  const external = join(directory, 'external.key');
  await writeFile(external, 'x'.repeat(43), { mode: 0o600 });
  await symlink(external, join(second, 'bridge.key'));
  await assert.rejects(readBridgeKey(second), { code: 'CREDENTIAL_STORAGE' });
});
test('write credential is independently generated, private and never falls back to read credential', async () => {
  const directory = await dir();
  const read = await ensureBridgeKey(directory);
  await assert.rejects(readWriteKey(directory), { code: 'CREDENTIAL_STORAGE' });
  const write = await ensureWriteKey(directory);
  assert.notEqual(write, read); assert.equal(await readWriteKey(directory), write);
  assert.equal((await stat(join(directory, 'write.key'))).mode & 0o777, 0o600);
  assert.equal(await ensureWriteKey(directory), write);
});
test('credentials input refuses non-interactive piping', () => {
  assert.throws(() => hiddenPrompt('secret:', { input: { isTTY: false }, output: { write() {} } }), { code: 'TTY_REQUIRED' });
});
