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
 * Returns { allowed, reason?, layer?, rule? } where layer is the index into
 * `layers` that decided and rule the matching (or missing) pattern.
 *
 * This is a guardrail against agent mistakes, not a security boundary: regexes
 * are easy to get around. Real authorization is the PAM gateway's RBAC and
 * the privileges of the target account.
 */
export function checkPolicy(command, layers) {
  for (const [li, layer] of layers.entries()) {
    for (const src of layer?.deny ?? []) {
      if (compile(src).test(command)) {
        return { allowed: false, reason: `command matches deny rule /${src}/`, layer: li, rule: src, kind: 'deny' };
      }
    }
  }
  const matched = [];
  for (const [li, layer] of layers.entries()) {
    const allow = layer?.allow ?? [];
    if (!allow.length) continue;
    const hit = allow.find((src) => compile(src).test(command));
    if (!hit) {
      return { allowed: false, reason: 'command does not match any allow rule for this target', layer: li, rule: null, kind: 'allow' };
    }
    matched.push({ layer: li, rule: hit });
  }
  return { allowed: true, matched };
}
