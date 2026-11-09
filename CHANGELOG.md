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
