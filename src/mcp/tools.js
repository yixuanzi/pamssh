import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UserError } from '../session-manager.js';
import { VERSION } from '../version.js';

const SESSION_DESC = 'Session name (default "default"). The same name reuses the same shell; a new name opens an independent '
  + 'shell (a separate PAM login), e.g. to run long tasks in parallel or keep environments apart. Commands in one session '
  + 'run one at a time. Each target allows a limited number of active sessions (maxSessions in pam_list_targets); '
  + 'close sessions you no longer need with pam_close_session.';

export const SERVER_INSTRUCTIONS = `\
pamssh-mcp runs shell commands on servers reached through a PAM (privileged access management) SSH gateway.
Authentication uses the operator's personal key in 1Password, so the first command on a target may wait for the
operator to approve a 1Password prompt.

Workflow:
1. pam_list_targets to see which targets (id, account, host, description) are available.
2. pam_exec with a target id and a POSIX shell command. The shell is persistent per (target, session):
   cd, exported variables and shell functions carry over between pam_exec calls.
3. pam_close_session when finished with a target to release the privileged login.

Rules for commands:
- stdin is /dev/null and there is no human at the terminal: never start interactive programs (vim, less, top,
  mysql without -e, sudo prompting for a password). Use batch flags instead (top -b -n1, systemctl --no-pager,
  journalctl --no-pager -n 200, git --no-pager).
- stdout and stderr are merged (shell mode). Output is truncated in the middle when very long; filter with
  grep/head/tail/awk.
- Do not run \`exit\`, \`logout\` or \`set -e\` at the top level: they end the PAM login (the next call opens a new
  one and cwd/env are lost). Use a subshell instead: ( set -e; step1; step2 ).
- Commands run with the privileges of the target account under PAM audit/recording. Be conservative with
  destructive operations and explain them before running.`;

function text(t) {
  return { content: [{ type: 'text', text: t }] };
}

function errorResult(err) {
  const msg = err instanceof UserError ? err.message : `Error: ${err.message}`;
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function formatExec(r) {
  const meta = [
    `exit=${r.exitCode ?? 'n/a'}`,
    r.signal ? `signal=${r.signal}` : null,
    `${r.durationMs}ms`,
    r.cwd ? `cwd=${r.cwd}` : null,
    `session=${r.target}/${r.session}`,
    r.timedOut ? 'TIMED OUT (Ctrl-C sent)' : null,
    r.truncated ? 'output truncated' : null,
    r.reconnected ? 'RECONNECTED: previous shell state (cwd/env) was lost' : null,
    r.sessionEnded ? 'SESSION ENDED: the remote shell exited; next call opens a new login' : null,
  ].filter(Boolean).join(' | ');
  let body = r.output.length ? r.output : '(no output)';
  if (r.stderr) body += `\n--- stderr ---\n${r.stderr}`;
  return `[${meta}]\n${body}`;
}

/**
 * Build an McpServer exposing the PAM tools. One instance is created per MCP
 * client session; all of them share the same SessionManager (and so the same
 * SSH sessions).
 */
export function createMcpServer(manager, { logger } = {}) {
  const server = new McpServer(
    { name: 'pamssh-mcp', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );

  const actorOf = (extra) => ({
    mcpSession: extra?.sessionId ?? null,
    client: server.server.getClientVersion()?.name ?? null,
  });

  server.registerTool('pam_list_targets', {
    title: 'List PAM targets',
    description: 'List the servers (targets) configured for PAM access: id, account, host, description, tags, and '
      + 'currently open sessions. Call this first to pick a target id for pam_exec.',
    inputSchema: {
      tag: z.string().optional().describe('Only return targets carrying this tag'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ tag }) => {
    try {
      return text(JSON.stringify(manager.listTargets({ tag }), null, 2));
    } catch (err) {
      return errorResult(err);
    }
  });

  server.registerTool('pam_exec', {
    title: 'Run shell command on PAM target',
    description: 'Run a shell command on a PAM-managed target over a persistent SSH session (cwd and environment '
      + 'persist between calls in the same session). Connects automatically on first use, which may require the '
      + 'operator to approve a 1Password prompt. Returns exit code, cwd and output (stdout+stderr merged). '
      + 'Non-interactive only: stdin is /dev/null.',
    inputSchema: {
      target: z.string().describe('Target id from pam_list_targets'),
      command: z.string().min(1).describe('POSIX shell command or multi-line script to run'),
      session: z.string().optional().describe(SESSION_DESC),
      timeout_ms: z.number().int().positive().max(3_600_000).optional()
        .describe('Kill the command (Ctrl-C) after this many milliseconds. Defaults to the target setting (120000).'),
    },
    annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async ({ target, command, session, timeout_ms: timeoutMs }, extra) => {
    try {
      const r = await manager.exec(target, command, { session, timeoutMs, actor: actorOf(extra) });
      return text(formatExec(r));
    } catch (err) {
      logger?.debug(`pam_exec failed: ${err.message}`);
      return errorResult(err);
    }
  });

  server.registerTool('pam_open_session', {
    title: 'Open PAM session',
    description: 'Log in to a target through the PAM gateway ahead of time (pam_exec does this automatically). '
      + 'Useful to surface the 1Password approval prompt early or to check access.',
    inputSchema: {
      target: z.string().describe('Target id from pam_list_targets'),
      session: z.string().optional().describe(SESSION_DESC),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async ({ target, session }) => {
    try {
      return text(JSON.stringify(await manager.openSession(target, session), null, 2));
    } catch (err) {
      return errorResult(err);
    }
  });

  server.registerTool('pam_list_sessions', {
    title: 'List PAM sessions',
    description: 'List open SSH sessions held by this server: target, session name, state, cwd, command count, '
      + 'last activity.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(JSON.stringify(manager.listSessions(), null, 2)));

  server.registerTool('pam_close_session', {
    title: 'Close PAM session',
    description: 'Log out of a target session and release the privileged PAM login.',
    inputSchema: {
      target: z.string().describe('Target id'),
      session: z.string().optional().describe(SESSION_DESC),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async ({ target, session }) => {
    try {
      const closed = manager.closeSession(target, session);
      return text(closed ? `closed ${target}/${session ?? 'default'}` : `no open session ${target}/${session ?? 'default'}`);
    } catch (err) {
      return errorResult(err);
    }
  });

  return server;
}
