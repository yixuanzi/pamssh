# Changelog

## Unreleased

- Admin web UI at `/admin` on `pamssh-mcp serve`, behind a separate `server.adminToken` (must differ from the MCP
  token): server-side sessions (HttpOnly, SameSite=Strict), CSRF checks, login lockout, strict CSP.
- Manage every config field in forms generated from field metadata with help text, defaults, examples, units,
  restart / env-override badges; live server-side validation (Chinese messages) and risk warnings per field.
- Config changes apply without restart (policy, targets, PAM servers, limits, tokens, audit, log level); sessions of
  removed targets are closed, live sessions with changed connection settings are flagged stale.
- Atomic saves with automatic backups (30 kept), conflict detection against manual edits, reload from disk, restore.
- Admin tools: policy tester, connection test, SSH agent key picker, gateway host key scan, sessions, audit log
  viewer, known host keys, live server log, raw JSON editor.
- CLI: `init` also creates an admin token; `token --admin [--rotate]`.
- Admin UI "终端" (terminal) tab: pick a target, create or attach to a session, run commands with live streamed
  output, history, Ctrl-C to interrupt, Ctrl-L to clear, and end the session. Commands go through the same policy
  checks and audit log as agent commands (actor `admin-ui`).
- Sessions record their origin (`agent`, `admin-ui`, `cli`); commands can be interrupted on request
  (`interrupted: true` in results and the audit log); `onOutput` streams output while a command runs.
- `audit.retentionDays` (default 30, 0 = keep forever): old audit entries are pruned at startup, every 6 hours and
  when retention is shortened; the admin audit page can prune on demand.
- Fix: `maxSessionsPerTarget` counted failed and disconnected sessions, which were never cleaned up, so a target
  could stay "full" with no live session. Now only sessions holding a login count; dead sessions are dropped after
  10 minutes; reviving one needs a free slot.
- Fix: a session logged out for idling (or dropped after failing) now reports RECONNECTED on the next command with
  the same name, so the agent knows its cwd/env are gone.

## 0.1.0

- Initial release.
- Streamable HTTP (stateful, bearer token, Host/Origin checks) and stdio MCP transports.
- Tools: `pam_list_targets`, `pam_exec`, `pam_open_session`, `pam_list_sessions`, `pam_close_session`.
- Authentication through the 1Password SSH agent (or any OpenSSH-compatible agent) with key pinning by
  fingerprint, public key, 1Password item title or `op://` reference.
- Persistent PTY shell sessions with a marker protocol (cwd/env persist, timeout → Ctrl-C recovery,
  auto-reconnect, idle logout); optional exec mode.
- Configurable PAM login template, host key pinning / trust-on-first-use, allow/deny command policy,
  JSONL audit log.
- CLI: `init`, `keys`, `targets`, `test`, `serve`, `stdio`, `token`.
- Mock PAM gateway for local development and end-to-end tests.
- Gateways with `AuthenticationMethods publickey,keyboard-interactive`: prompt-less keyboard-interactive rounds are
  answered automatically; rounds that ask for input (OTP, password) fail with the prompt text and nothing is sent.
- Multi-hop gateways that drop input typed before the target shell starts: wait for login output to settle
  (`shell.settleMs`) and re-send the idempotent prelude until the shell answers.
- Default `maxOutputChars` 20000 (fits MCP client token limits); `\r` progress output is collapsed.
