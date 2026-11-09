import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function hasBinary(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
}

export const canRunAgent = hasBinary('ssh-agent') && hasBinary('ssh-keygen') && hasBinary('ssh-add');
export const canRunPty = process.platform !== 'win32' && hasBinary('script') && hasBinary('bash');

export function tmpDir() {
  // Short path: Unix socket paths are limited to ~104 bytes on macOS.
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'pamssh-t-'));
}

export function genKey(dir, name, comment) {
  const file = path.join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
  return { file, publicKey: fs.readFileSync(`${file}.pub`, 'utf8').trim() };
}

/** Start a private OpenSSH agent holding the given private key files. */
export async function startAgent(dir, keyFiles) {
  const sock = path.join(dir, 'agent.sock');
  const proc = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await delay(50);
  if (!fs.existsSync(sock)) throw new Error('ssh-agent did not start');
  for (const f of keyFiles) {
    execFileSync('ssh-add', ['-q', f], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: 'ignore' });
  }
  return { sock, stop: () => proc.kill() };
}
