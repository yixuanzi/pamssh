#!/usr/bin/env node
/**
 * Mock PAM SSH gateway for local development and tests.
 *
 * Mimics the login format of PAM bastions such as JumpServer / CyberArk PSMP:
 *     ssh <pamUser>@<account>@<host>@<gateway>
 * authenticates the PAM user by public key (so the 1Password SSH agent flow is
 * exercised for real), prints a banner, then hands the session to a local
 * shell in a real PTY (via `script`) as if it were the target host.
 *
 *   node examples/mock-pam-server.js --port 2222 --authorized-key "ssh-ed25519 AAAA..."
 *   node examples/mock-pam-server.js --authorized-keys ~/.ssh/id_ed25519.pub --no-exec
 *
 * Do not expose it beyond localhost: it gives a real local shell.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;

function parseAuthorized(lines) {
  return lines
    .flatMap((l) => l.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const k = utils.parseKey(l);
      if (k instanceof Error) throw new Error(`bad authorized key "${l.slice(0, 40)}…": ${k.message}`);
      return Array.isArray(k) ? k[0] : k;
    });
}

function spawnShell(shell, { pty }) {
  const args = ['--noprofile', '--norc', '-i'];
  if (shell.endsWith('zsh')) args.splice(0, 2, '-f');
  if (!pty) return spawn(shell, args, { stdio: 'pipe' });
  // Node gives children socketpairs for stdio; `script` wants a pipe/tty on
  // stdin (tcgetattr fails on sockets on macOS), hence the `< <(cat)` shim.
  // `exec` makes the child pid *be* script, so its exit is seen immediately.
  const scriptCmd = process.platform === 'darwin'
    ? 'exec script -q /dev/null "$@" < <(exec cat)'
    : 'exec script -qfec "$*" /dev/null < <(exec cat)';
  return spawn('/bin/bash', ['-c', scriptCmd, 'bash', shell, ...args], { stdio: 'pipe' });
}

/**
 * @param {object} o
 * @param {string[]} o.authorizedKeys  OpenSSH public key lines allowed to log in
 * @param {string[]} [o.pamUsers]      accepted PAM users (any when empty)
 * @param {boolean} [o.allowExec=true] accept `exec` requests
 * @param {boolean} [o.pty=true]       run the shell inside a real PTY
 * @param {string} [o.shell]           shell binary (default /bin/bash)
 * @param {string} [o.banner]          text printed before the shell starts
 * @param {'none'|'empty'|'otp'} [o.secondFactor='none']
 *   After the key is accepted, require keyboard-interactive like
 *   `AuthenticationMethods publickey,keyboard-interactive`:
 *   'empty' = a round with no prompts (common on OpenSSH+Linux-PAM gateways),
 *   'otp'   = asks "Verification code:" and accepts `otpCode`.
 * @param {string} [o.otpCode='123456']
 * @param {number} [o.loginDelayMs=0]  simulate a multi-hop login: the target
 *   shell starts after this delay and input received before that is dropped.
 */
export async function startMockPam({
  port = 0, host = '127.0.0.1', authorizedKeys, pamUsers = [], allowExec = true, pty = true,
  shell = '/bin/bash', banner = 'Mock PAM gateway: session is being recorded.\r\n', log = () => {},
  secondFactor = 'none', otpCode = '123456', loginDelayMs = 0,
} = {}) {
  const droppedInput = [];
  const allowed = parseAuthorized(authorizedKeys);
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const logins = [];
  const kbdAnswers = [];
  const firstMethods = secondFactor === 'none' ? ['publickey'] : ['publickey', 'keyboard-interactive'];

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let login = null;
    let keyOk = null;
    const complete = (ctx, who) => {
      login = { ...who, at: new Date() };
      logins.push(login);
      log(`login ${who.pamUser} -> ${who.account}@${who.target}`);
      ctx.accept();
    };
    client.on('authentication', (ctx) => {
      const parts = ctx.username.split('@');
      if (parts.length !== 3 || parts.some((p) => !p)) {
        log(`reject username format "${ctx.username}"`);
        return ctx.reject(firstMethods);
      }
      const [pamUser, account, target] = parts;
      if (pamUsers.length && !pamUsers.includes(pamUser)) return ctx.reject(firstMethods);

      if (ctx.method === 'keyboard-interactive') {
        if (!keyOk) return ctx.reject(firstMethods); // second factor only after the key
        if (secondFactor === 'empty') return ctx.prompt([], () => complete(ctx, keyOk));
        return ctx.prompt([{ prompt: 'Verification code: ', echo: false }], 'MFA', '', (answers) => {
          kbdAnswers.push(answers);
          if (answers[0] === otpCode) complete(ctx, keyOk);
          else ctx.reject(['keyboard-interactive']);
        });
      }
      if (ctx.method !== 'publickey') return ctx.reject(keyOk ? ['keyboard-interactive'] : firstMethods);
      const key = allowed.find((k) => k.type === ctx.key.algo
        && k.getPublicSSH().length === ctx.key.data.length
        && timingSafeEqual(k.getPublicSSH(), ctx.key.data));
      if (!key) return ctx.reject(firstMethods);
      if (!ctx.signature) return ctx.accept(); // PK_OK: key is acceptable, client may sign
      if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(firstMethods);
      if (secondFactor !== 'none') {
        keyOk = { pamUser, account, target };
        return ctx.reject(['keyboard-interactive'], true); // partial success
      }
      complete(ctx, { pamUser, account, target });
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('pty', (accept) => accept?.());
        session.on('window-change', (accept) => accept?.());
        session.on('env', (accept) => accept?.());
        session.on('signal', (accept, _reject, info) => {
          accept?.();
          session._child?.kill(`SIG${info.name}`);
        });
        session.once('shell', (accept) => {
          const stream = accept();
          stream.write(banner);
          stream.write(`Connected to ${login.account}@${login.target}\r\n`);
          const startShell = () => {
            const child = spawnShell(shell, { pty });
            session._child = child;
            stream.pipe(child.stdin);
            child.stdout.pipe(stream, { end: false });
            child.stderr.pipe(stream.stderr, { end: false });
            child.on('exit', (code) => {
              try { stream.exit(code ?? 0); stream.end(); } catch { /* client gone */ }
            });
            stream.on('close', () => child.kill('SIGHUP'));
          };
          if (!loginDelayMs) return startShell();
          // Simulate a second hop: input typed before the target shell is up is flushed.
          const drop = (d) => { droppedInput.push(d.toString()); };
          stream.on('data', drop);
          setTimeout(() => {
            stream.removeListener('data', drop);
            stream.write('Last login: Mon Nov  9 11:05:48 2026 from 10.0.0.1\r\n');
            startShell();
          }, loginDelayMs);
        });
        session.once('exec', (accept, reject, info) => {
          if (!allowExec) return reject();
          const stream = accept();
          const child = spawn('/bin/sh', ['-c', info.command], { stdio: 'pipe' });
          session._child = child;
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on('exit', (code, signal) => {
            try {
              if (signal) stream.exit(signal.replace(/^SIG/, ''), false, '');
              else stream.exit(code ?? 0);
              stream.end();
            } catch { /* client gone */ }
          });
        });
      });
    });
    client.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const fingerprint = (await import('../src/agent.js')).fingerprintOfBlob(
    utils.parseKey(hostKey).getPublicSSH());
  return {
    port: server.address().port,
    host,
    hostKeyFingerprint: fingerprint,
    logins,
    kbdAnswers,
    droppedInput,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    server,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '2222' },
      host: { type: 'string', default: '127.0.0.1' },
      'authorized-key': { type: 'string', multiple: true },
      'authorized-keys': { type: 'string' },
      'pam-user': { type: 'string', multiple: true },
      'no-exec': { type: 'boolean' },
      'no-pty': { type: 'boolean' },
      'second-factor': { type: 'string', default: 'none' },
      'login-delay-ms': { type: 'string', default: '0' },
      shell: { type: 'string' },
    },
  });
  const keys = [...(values['authorized-key'] || [])];
  if (values['authorized-keys']) keys.push(fs.readFileSync(values['authorized-keys'], 'utf8'));
  if (!keys.length) {
    console.error('need --authorized-key "<public key>" or --authorized-keys <file>');
    console.error('tip: `pamssh-mcp keys` prints the public keys held by 1Password');
    process.exit(2);
  }
  const srv = await startMockPam({
    port: Number(values.port),
    host: values.host,
    authorizedKeys: keys,
    pamUsers: values['pam-user'] || [],
    allowExec: !values['no-exec'],
    pty: !values['no-pty'],
    shell: values.shell,
    secondFactor: values['second-factor'],
    loginDelayMs: Number(values['login-delay-ms']),
    log: (m) => console.error(`[mock-pam] ${m}`),
  });
  console.error(`[mock-pam] listening on ${srv.host}:${srv.port}  host key ${srv.hostKeyFingerprint}`);
  console.error(`[mock-pam] try: ssh -p ${srv.port} you@root@web-01@${srv.host}`);
}
