import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ConfigError, exampleConfig, loadConfig, resolveConfigPath } from './config.js';
import { listAgentIdentities } from './agent.js';
import { createLogger } from './logger.js';
import { resolveAgentSocket } from './paths.js';
import { SessionManager } from './session-manager.js';
import { startHttpServer } from './mcp/http-server.js';
import { startStdioServer } from './mcp/stdio-server.js';
import { VERSION } from './version.js';

const HELP = `pamssh-mcp ${VERSION}
MCP server that runs shell commands on PAM-managed hosts through persistent SSH
sessions, authenticating with your key in the 1Password SSH agent.

Usage: pamssh-mcp <command> [options]

Commands:
  init                 Create a config file with a fresh access token
  keys                 List keys in the SSH agent (1Password) with fingerprints
  targets              List configured targets and their PAM login strings
  test <target>        Log in to a target and run a check command
  serve                Start the Streamable HTTP MCP server
  stdio                Run the MCP server over stdio (spawned by an agent)
  token                Print the HTTP access token (--rotate to replace it)

Options:
  -c, --config <file>  Config file (default: $PAMSSH_MCP_CONFIG or ~/.config/pamssh-mcp/config.json)
      --host <addr>    serve: bind address (default from config, 127.0.0.1)
  -p, --port <n>       serve: port (default from config, 8765)
      --command <cmd>  test: command to run (default: id; hostname; pwd)
      --session <name> test: session name
      --socket <path>  keys: SSH agent socket to query
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
  rotate: { type: 'boolean' },
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
    writeJsonPrivate(file, exampleConfig({ authToken: newToken() }));
    console.log(`Created ${file} (mode 600)

Next steps:
  1. pamssh-mcp keys              # find your PAM key in 1Password (fingerprint / title)
  2. Edit ${file}:
       pamServers.*  -> PAM gateway host, your PAM user, identity (key fingerprint or title),
                        usernameTemplate matching your gateway's login format
       targets.*     -> target host + account as granted to you in PAM
  3. pamssh-mcp test <target>      # approve the 1Password prompt
  4. pamssh-mcp serve`);
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

  async serve(values) {
    const { config, logger, manager } = makeRuntime(values);
    const port = values.port !== undefined ? Number(values.port) : undefined;
    const http = await startHttpServer({ config, manager, logger, host: values.host, port });
    const agent = resolveAgentSocket(config.agentSocket);
    logger.info(`pamssh-mcp ${VERSION} listening on ${http.url}`);
    logger.info(`config: ${config.file}`);
    logger.info(`SSH agent: ${agent.path} (${agent.source})`);
    logger.info(`targets: ${Object.keys(config.targets).join(', ') || '(none)'}`);
    logger.info(`connect an agent, e.g.: claude mcp add --transport http pamssh ${http.url} --header "Authorization: Bearer $(pamssh-mcp token)"`);
    onShutdown(async (sig) => {
      logger.info(`${sig}: closing SSH sessions`);
      await manager.closeAll();
      await http.close();
    });
  },

  async stdio(values) {
    const { logger, manager } = makeRuntime(values);
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
    if (values.rotate) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.server = { ...(raw.server || {}), authToken: newToken() };
      writeJsonPrivate(file, raw);
      console.error(`stored new token in ${file}; restart the server and update your agents`);
    }
    const config = loadConfig(values.config);
    if (!config.server.authToken) throw new ConfigError('server.authToken is not set (use --rotate)', file);
    console.log(config.server.authToken);
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
