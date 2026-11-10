import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ConfigError, exampleConfig, loadConfig, resolveConfigPath } from './config.js';
import { listAgentIdentities } from './agent.js';
import { createLogger } from './logger.js';
import { resolveAgentSocket } from './paths.js';
import { SessionManager } from './session-manager.js';
import { ConfigStore } from './config-store.js';
import { startHttpServer } from './mcp/http-server.js';
import { startStdioServer } from './mcp/stdio-server.js';
import { AlreadyRunningError, acquireInstanceLock } from './instance.js';
import { serveActions, serveOptions } from './serve-control.js';
import { VERSION } from './version.js';

const HELP = `pamssh-mcp ${VERSION}
MCP server that runs shell commands on PAM-managed hosts through persistent SSH
sessions, authenticating with your key in the 1Password SSH agent.

Usage: pamssh-mcp <command> [options]

Commands:
  init                 Create a config file with fresh MCP and admin tokens
  keys                 List keys in the SSH agent (1Password) with fingerprints
  targets              List configured targets and their PAM login strings
  test <target>        Log in to a target and run a check command
  serve                Run the Streamable HTTP MCP server and the admin UI (/admin) in the
                       foreground. Only one instance runs at a time; manage it with:
    serve start          start it in the background (through the user service if installed)
    serve stop           stop the running instance (closes its SSH sessions first)
    serve restart        stop, then start again with the same options
    serve status         show whether it is running, and whether the service is installed
    serve install        install and start a user-level service that starts at login
                         (macOS: LaunchAgent, Windows: Task Scheduler; no admin rights)
    serve uninstall      stop it and remove the user-level service
  stdio                Run the MCP server over stdio (spawned by an agent)
  token                Print the MCP access token (--admin: admin UI token; --rotate: replace it)

Options:
  -c, --config <file>  Config file (default: $PAMSSH_MCP_CONFIG or ~/.config/pamssh-mcp/config.json)
      --host <addr>    serve [start|restart|install]: bind address (default from config, 127.0.0.1)
  -p, --port <n>       serve [start|restart|install]: port (default from config, 8765)
      --command <cmd>  test: command to run (default: id; hostname; pwd)
      --session <name> test: session name
      --socket <path>  keys: SSH agent socket to query
      --admin          token: use the admin UI token instead of the MCP token
      --rotate         token: generate and store a new token
  -f, --force          init: overwrite an existing config
      --log-level <l>  error | warn | info | debug
  -h, --help           Show help
  -v, --version        Show version
`;

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  host: { type: 'string' },
  port: { type: 'string', short: 'p' },
  command: { type: 'string' },
  session: { type: 'string' },
  socket: { type: 'string' },
  'no-service': { type: 'boolean' }, // serve start: spawn directly even if a service is installed
  rotate: { type: 'boolean' },
  admin: { type: 'boolean' },
  force: { type: 'boolean', short: 'f' },
  'log-level': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const newToken = () => randomBytes(32).toString('base64url');

function writeJsonPrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function makeRuntime(values) {
  const config = loadConfig(values.config);
  const logger = createLogger(values['log-level'] || config.logLevel || 'info');
  const manager = new SessionManager(config, { logger });
  return { config, logger, manager };
}

function onShutdown(fn) {
  let done = false;
  const handler = async (sig) => {
    if (done) process.exit(1);
    done = true;
    await fn(sig);
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return handler;
}

const commands = {
  async init(values) {
    const file = resolveConfigPath(values.config);
    if (fs.existsSync(file) && !values.force) {
      throw new ConfigError('already exists (use --force to overwrite)', file);
    }
    writeJsonPrivate(file, exampleConfig({ authToken: newToken(), adminToken: newToken() }));
    console.log(`Created ${file} (mode 600)

Next steps:
  1. pamssh-mcp keys              # find your PAM key in 1Password (fingerprint / title)
  2. Edit ${file}:
       pamServers.*  -> PAM gateway host, your PAM user, identity (key fingerprint or title),
                        usernameTemplate matching your gateway's login format
       targets.*     -> target host + account as granted to you in PAM
     (or start the server and use the admin UI: http://127.0.0.1:8765/admin)
  3. pamssh-mcp test <target>      # approve the 1Password prompt
  4. pamssh-mcp serve              # admin UI login token: pamssh-mcp token --admin`);
  },

  async keys(values) {
    let configured;
    try { configured = loadConfig(values.config).agentSocket; } catch { /* config optional here */ }
    const sock = values.socket ? { source: '--socket', path: values.socket } : resolveAgentSocket(configured);
    const keys = await listAgentIdentities(sock.path);
    console.log(`SSH agent: ${sock.path} (${sock.source})`);
    if (!keys.length) {
      console.log('No keys. In 1Password: Settings > Developer > "Use the SSH agent", and store the key in an allowed vault.');
      return;
    }
    for (const k of keys) {
      console.log(`\n${k.comment || '(no title)'}\n  type:        ${k.type}\n  fingerprint: ${k.fingerprint}\n  public key:  ${k.publicKey}`);
    }
    console.log('\nUse one of them in pamServers.<id>.identity, e.g. { "fingerprint": "SHA256:..." } or { "comment": "<title>" }.');
  },

  async targets(values) {
    const { manager } = makeRuntime({ ...values, 'log-level': 'error' });
    const rows = manager.listTargets().map((t) => {
      const full = manager.target(t.id);
      return { id: t.id, login: `ssh ${full.username}@${full.pamServer.host} -p ${full.pamServer.port}`, mode: t.mode, description: t.description };
    });
    for (const r of rows) console.log(`${r.id}\n  ${r.login}\n  mode: ${r.mode}${r.description ? `\n  ${r.description}` : ''}`);
    await manager.closeAll();
  },

  async test(values, positionals) {
    const targetId = positionals[0];
    if (!targetId) throw new Error('usage: pamssh-mcp test <target> [--command "..."]');
    const { manager, logger } = makeRuntime(values);
    const t = manager.target(targetId);
    logger.info(`logging in: ssh ${t.username}@${t.pamServer.host} -p ${t.pamServer.port} (agent: ${manager.agentSocketFor(t.pamServer).path})`);
    try {
      const status = await manager.openSession(targetId, values.session);
      logger.info(`connected; PAM host key ${status.hostKey}`);
      const r = await manager.exec(targetId, values.command || 'id; hostname; pwd', { session: values.session, actor: { client: 'cli' } });
      console.log(r.output);
      console.log(`\n[exit=${r.exitCode} ${r.durationMs}ms cwd=${r.cwd ?? 'n/a'}]`);
      process.exitCode = r.exitCode === 0 ? 0 : 1;
    } finally {
      await manager.closeAll();
    }
  },

  async serve(values, positionals) {
    const [action, ...extra] = positionals;
    if (action) {
      const run = Object.hasOwn(serveActions, action) && !extra.length ? serveActions[action] : null;
      if (!run) throw new Error(`usage: pamssh-mcp serve [${Object.keys(serveActions).join('|')}]`);
      return run(values);
    }

    let lock;
    try {
      lock = await acquireInstanceLock({
        version: VERSION,
        foreground: process.stderr.isTTY === true,
        service: process.env.PAMSSH_MCP_SERVICE || null,
        options: serveOptions(values),
      });
    } catch (err) {
      if (!(err instanceof AlreadyRunningError)) throw err;
      console.error(`${err.message}. Only one instance may run at a time: use it, or stop it with \`pamssh-mcp serve stop\`.`);
      // Started by a service manager: exit cleanly so it does not keep retrying.
      process.exitCode = process.env.PAMSSH_MCP_SERVICE ? 0 : 1;
      return undefined;
    }
    const store = ConfigStore.load(resolveConfigPath(values.config));
    const config = store.config;
    const logger = createLogger(values['log-level'] || config.logLevel || 'info');
    const manager = new SessionManager(config, { logger });
    manager.startMaintenance(); // audit retention now and every 6 hours
    const port = values.port !== undefined ? Number(values.port) : undefined;
    const http = await startHttpServer({
      store, manager, logger, host: values.host, port, cliLogLevel: values['log-level'],
    });
    const agent = resolveAgentSocket(config.agentSocket);
    lock.update({ url: http.url, adminUrl: config.server.adminToken ? http.adminUrl : null, config: config.file });
    logger.info(`pamssh-mcp ${VERSION} listening on ${http.url} (pid ${process.pid})`);
    if (config.server.adminToken) {
      logger.info(`admin UI: ${http.adminUrl} (login token: pamssh-mcp token --admin)`);
    } else {
      logger.info('admin UI disabled: no server.adminToken. Enable it with `pamssh-mcp token --admin --rotate`, then restart');
    }
    logger.info(`config: ${config.file}`);
    logger.info(`SSH agent: ${agent.path} (${agent.source})`);
    logger.info(`targets: ${Object.keys(config.targets).join(', ') || '(none)'}`);
    logger.info(`connect an agent, e.g.: claude mcp add --transport http pamssh ${http.url} --header "Authorization: Bearer $(pamssh-mcp token)"`);
    const shutdown = onShutdown(async (sig) => {
      logger.info(`${sig}: closing SSH sessions`);
      await manager.closeAll();
      await http.close();
    });
    lock.onStop(() => shutdown('stop requested'));
    return undefined;
  },

  async stdio(values) {
    const { logger, manager } = makeRuntime(values);
    manager.startMaintenance();
    const srv = await startStdioServer({ manager, logger });
    const shutdown = onShutdown(async () => {
      await manager.closeAll();
      await srv.close();
    });
    process.stdin.once('end', () => shutdown('stdin closed'));
    srv.closed.then(() => shutdown('transport closed'));
  },

  async token(values) {
    const file = resolveConfigPath(values.config);
    const key = values.admin ? 'adminToken' : 'authToken';
    if (values.rotate) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.server = { ...(raw.server || {}), [key]: newToken() };
      writeJsonPrivate(file, raw);
      console.error(values.admin
        ? `stored new admin token in ${file}; a running server picks it up via the admin UI \"reload\" or a restart`
        : `stored new MCP token in ${file}; restart the server (or reload in the admin UI) and update your agents`);
    }
    const config = loadConfig(values.config);
    if (!config.server[key]) {
      throw new ConfigError(`server.${key} is not set (use ${values.admin ? '--admin ' : ''}--rotate)`, file);
    }
    console.log(config.server[key]);
  },
};

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const fn = commands[cmd];
  if (!fn) {
    console.error(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  }
  try {
    await fn(values, rest);
    return undefined;
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : `error: ${err.message}`);
    if (process.env.PAMSSH_LOG_LEVEL === 'debug' && err.stack) console.error(err.stack);
    return 1;
  }
}
