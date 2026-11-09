import ssh2 from 'ssh2';
import { fingerprintOfBlob } from '../agent.js';

const { Client, utils } = ssh2;

/**
 * Read an SSH server's host key without authenticating (the handshake is
 * aborted right after the key is received), like `ssh-keyscan`.
 */
export function scanHostKey(host, port = 22, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let result = null;
    let banner = null;
    const done = (err) => {
      c.removeAllListeners();
      c.on('error', () => {});
      c.end();
      if (result) resolve({ ...result, banner });
      else reject(err || new Error('no host key received'));
    };
    c.on('error', (err) => done(result ? null : new Error(`${host}:${port}: ${err.message}`)));
    c.on('close', () => done());
    c.on('handshake', () => {});
    try {
      c.connect({
        host,
        port,
        username: 'pamssh-mcp-keyscan',
        readyTimeout: timeoutMs,
        hostVerifier: (key) => {
          const parsed = utils.parseKey(key);
          result = {
            fingerprint: fingerprintOfBlob(key),
            type: parsed instanceof Error ? 'unknown' : parsed.type,
          };
          return false; // abort before authentication
        },
        debug: (msg) => {
          const m = /Remote ident: '(.*)'/.exec(msg);
          if (m) banner = m[1];
        },
      });
    } catch (err) {
      done(err);
    }
  });
}
