# Changelog

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
