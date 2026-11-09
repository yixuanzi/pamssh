const cache = new Map();

function compile(src) {
  let re = cache.get(src);
  if (!re) {
    re = new RegExp(src, 'm');
    cache.set(src, re);
  }
  return re;
}

/**
 * Evaluate a command against policy layers (global first, then target).
 * - any `deny` match rejects the command;
 * - every layer with a non-empty `allow` list requires at least one match.
 *
 * This is a guardrail against agent mistakes, not a security boundary: regexes
 * are easy to get around. Real authorization is the PAM gateway's RBAC and
 * the privileges of the target account.
 */
export function checkPolicy(command, layers) {
  for (const layer of layers) {
    for (const src of layer?.deny ?? []) {
      if (compile(src).test(command)) {
        return { allowed: false, reason: `command matches deny rule /${src}/` };
      }
    }
  }
  for (const layer of layers) {
    const allow = layer?.allow ?? [];
    if (allow.length && !allow.some((src) => compile(src).test(command))) {
      return { allowed: false, reason: 'command does not match any allow rule for this target' };
    }
  }
  return { allowed: true };
}
