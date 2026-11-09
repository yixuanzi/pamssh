import ssh2 from 'ssh2';
import { SelectiveAgent } from '../agent.js';

const { Client } = ssh2;

export class PamConnectError extends Error {
  constructor(message, { cause, level } = {}) {
    super(message, { cause });
    this.name = 'PamConnectError';
    this.level = level;
  }
}

function explain(err, { target, hostKeyResult, agentSocket, kbdPrompts }) {
  const pam = target.pamServer;
  const where = `${target.username}@${pam.host}:${pam.port}`;
  if (kbdPrompts) {
    return new PamConnectError(
      `the gateway accepted the key but then asked for keyboard-interactive input `
      + `(${kbdPrompts.map((p) => JSON.stringify(p.prompt)).join(', ')}), e.g. an OTP / 2FA code. `
      + 'pamssh-mcp does not answer such prompts (nothing was sent); ask your PAM admin for a key-only login '
      + 'policy for this account, or log in once interactively if the gateway caches 2FA.',
      { cause: err, level: 'keyboard-interactive' });
  }
  if (hostKeyResult && !hostKeyResult.ok) {
    return new PamConnectError(`host key verification failed for ${pam.host}:${pam.port}: ${hostKeyResult.reason}`,
      { cause: err, level: 'host-key' });
  }
  switch (err.level) {
    case 'client-authentication':
      return new PamConnectError(
        `PAM authentication failed for ${where}. Check that (1) the signature request was approved in 1Password, `
        + `(2) the public key is registered to PAM user "${pam.user}", (3) account "${target.account}" on "${target.host}" `
        + 'is granted to you in PAM and the usernameTemplate matches the gateway\'s login format.',
        { cause: err, level: err.level });
    case 'agent':
      return new PamConnectError(
        `SSH agent error (${agentSocket}): ${err.message}. Is 1Password running, unlocked, and "Use the SSH agent" enabled?`,
        { cause: err, level: err.level });
    case 'client-timeout':
      return new PamConnectError(
        `timed out after ${pam.readyTimeoutMs}ms connecting to ${where} (handshake/authentication did not finish; `
        + 'was the 1Password prompt approved?)',
        { cause: err, level: err.level });
    case 'client-socket':
      return new PamConnectError(`network error connecting to ${pam.host}:${pam.port}: ${err.message}`,
        { cause: err, level: err.level });
    default:
      return new PamConnectError(`SSH error for ${where}: ${err.message}`, { cause: err, level: err.level });
  }
}

/**
 * Open an authenticated SSH connection to the PAM gateway for one target.
 * The login user encodes "<pam user>@<target account>@<target host>" (or the
 * configured template) and the gateway proxies the session to the target.
 */
export function connectPam({ target, agentSocket, keySelector, hostKeys, logger }) {
  const pam = target.pamServer;
  const agent = new SelectiveAgent(agentSocket, {
    selector: keySelector,
    onSignRequest: () => logger.info(
      `SSH agent signature requested for ${target.username}@${pam.host} — approve in 1Password if prompted`),
  });

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let hostKeyResult;
    let kbdPrompts;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners('ready');
      client.on('error', () => {});
      client.end();
      reject(explain(err, { target, hostKeyResult, agentSocket, kbdPrompts }));
    };

    // Many PAM gateways (OpenSSH + Linux-PAM) use `AuthenticationMethods
    // publickey,keyboard-interactive`: after the key is accepted they run a
    // keyboard-interactive round. When that round has no prompts it is a
    // formality (OpenSSH and ssh2 answer it automatically). When it does ask
    // for something (OTP, password) we refuse to guess: answering wrongly
    // could count as a failed 2FA attempt or lock the account.
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      if (!prompts || prompts.length === 0) {
        finish([]);
        return;
      }
      kbdPrompts = prompts;
      logger.warn(`gateway asks for keyboard-interactive input: ${prompts.map((p) => p.prompt).join(' | ')}`);
      fail(Object.assign(new Error('keyboard-interactive prompts not supported'), { level: 'client-authentication' }));
    });

    client.once('ready', () => {
      if (settled) return;
      settled = true;
      client.removeListener('close', onEarlyClose);
      resolve({ client, hostKey: hostKeyResult });
    });
    client.on('error', fail);
    const onEarlyClose = () => fail(Object.assign(new Error('connection closed by gateway before authentication completed'), { level: 'client-socket' }));
    client.once('close', onEarlyClose);

    try {
      client.connect({
        host: pam.host,
        port: pam.port,
        username: target.username,
        agent,
        tryKeyboard: true,
        readyTimeout: pam.readyTimeoutMs,
        keepaliveInterval: pam.keepaliveIntervalMs,
        keepaliveCountMax: pam.keepaliveCountMax,
        algorithms: pam.algorithms,
        hostVerifier: (keyBlob) => {
          hostKeyResult = hostKeys.verify(`${pam.host}:${pam.port}`, keyBlob, pam.hostFingerprints);
          if (!hostKeyResult.ok) logger.error(hostKeyResult.reason);
          return hostKeyResult.ok;
        },
        debug: process.env.PAMSSH_SSH_DEBUG ? (msg) => logger.debug(`ssh2: ${msg}`) : undefined,
      });
    } catch (err) {
      fail(err);
    }
  });
}
