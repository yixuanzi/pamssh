import { resolveTarget } from '../config.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Advice for a config that is already valid: risky or surprising settings.
 * Returns [{ path: string[], level: 'warn' | 'info', message }].
 */
export function lintConfig(cfg) {
  const out = [];
  const warn = (path, message) => out.push({ path, level: 'warn', message });
  const info = (path, message) => out.push({ path, level: 'info', message });
  const s = cfg.server;

  if (!LOOPBACK.has(s.host)) {
    warn(['server', 'host'], `监听在非本机地址 ${s.host}：网络上任何持有令牌的人都能获得 PAM 特权 shell。请确保有 TLS 反向代理和网络访问控制。`);
  }
  if (!s.authToken) warn(['server', 'authToken'], '未设置 MCP 访问令牌：HTTP MCP 接口会拒绝所有请求。');
  if (!s.adminToken) warn(['server', 'adminToken'], '未设置管理令牌：保存后将无法再登录管理页面。');
  for (const o of s.allowedOrigins) {
    if (o.includes('*')) warn(['server', 'allowedOrigins'], `"${o}" 含通配符，不受支持：来源需要逐个精确列出。`);
    else if (!/^https?:\/\/[^/]+$/.test(o)) warn(['server', 'allowedOrigins'], `"${o}" 不是完整来源（形如 https://host:port，不带路径）。`);
  }

  const d = cfg.defaults;
  if (d.idleTimeoutMinutes === 0) warn(['defaults', 'idleTimeoutMinutes'], '空闲超时为 0：特权登录会一直保持到服务重启。');
  if (d.maxOutputChars > 25000) warn(['defaults', 'maxOutputChars'], '超过 25000 字符的结果可能超出 Claude Code 单个工具结果的大小上限。');
  if (d.commandTimeoutMs > 30 * 60_000) info(['defaults', 'commandTimeoutMs'], '默认命令超时超过 30 分钟：失控的命令会长时间占用会话。');

  if (!cfg.audit.enabled) warn(['audit', 'enabled'], '审计日志已关闭：本地不会留下 agent 执行过的命令记录。');
  if (cfg.audit.retentionDays === 0) info(['audit', 'retentionDays'], '审计记录永久保留，文件会一直增长。');
  else if (cfg.audit.retentionDays < 7) info(['audit', 'retentionDays'], `只保留 ${cfg.audit.retentionDays} 天：出问题后可能来不及追溯。`);
  if (!cfg.policy.deny.length && !cfg.policy.allow.length) {
    info(['policy', 'deny'], '全局策略为空：没有任何命令护栏（目标上仍可单独配置）。');
  }
  lintRegexes(cfg.policy, ['policy'], info);

  const pamIds = Object.keys(cfg.pamServers);
  const used = new Set();
  for (const t of Object.values(cfg.targets)) used.add(t.pam);
  for (const [id, p] of Object.entries(cfg.pamServers)) {
    const base = ['pamServers', id];
    if (!p.identity || Object.keys(p.identity).length === 0) {
      warn([...base, 'identity'], '没有指定登录密钥：会把 SSH agent 里的所有密钥依次尝试，密钥较多时网关可能报“认证失败次数过多”。');
    }
    if (p.identity?.opRef) info([...base, 'identity', 'opRef'], '使用 op:// 引用需要本机安装并登录 1Password CLI（op）。');
    if (!p.hostFingerprints.length && !cfg.hostKeys.trustOnFirstUse) {
      warn([...base, 'hostFingerprint'], '既没有固定网关指纹，又关闭了“首次连接时信任”：连接会被拒绝。');
    } else if (!p.hostFingerprints.length) {
      info([...base, 'hostFingerprint'], '未固定网关指纹，将在首次连接时记录。固定指纹更安全。');
    }
    if (!used.has(id) && pamIds.length > 1) info(base, '没有目标使用这个 PAM 服务器。');
    if (p.readyTimeoutMs < 20000) info([...base, 'readyTimeoutMs'], '登录超时较短：需要在 1Password 里手动批准时可能来不及。');
  }

  const seen = new Map();
  for (const [id, t] of Object.entries(cfg.targets)) {
    const base = ['targets', id];
    const rt = resolveTarget(cfg, id);
    const dupKey = `${t.pam}|${t.host}|${t.account}`;
    if (seen.has(dupKey)) info(base, `与目标 "${seen.get(dupKey)}" 的网关、主机、账号完全相同。`);
    else seen.set(dupKey, id);
    if (t.mode === 'exec') info([...base, 'mode'], 'exec 模式需要网关支持 exec 请求；很多 PAM 网关只允许交互 shell，失败时改回 shell。');
    if (!t.description) info([...base, 'description'], '建议填写描述：agent 会根据描述选择目标。');
    if (rt.idleTimeoutMinutes === 0) warn([...base, 'idleTimeoutMinutes'], '空闲超时为 0：此目标的特权登录不会自动释放。');
    if (rt.maxOutputChars > 25000) warn([...base, 'maxOutputChars'], '超过 25000 字符的结果可能超出 Claude Code 单个工具结果的大小上限。');
    if (t.mode === 'exec' && t.shell.init.length) info([...base, 'shell', 'init'], '初始化命令只在 shell 模式下执行。');
    lintRegexes(t.policy, [...base, 'policy'], info);
    if (/\s/.test(rt.username)) warn(base, `登录串 "${rt.username}" 含空白字符，网关很可能无法解析。`);
  }
  return out;
}

function lintRegexes(policy, base, info) {
  policy.allow.forEach((src, i) => {
    if (!src.startsWith('^') && !src.startsWith('(^')) {
      info([...base, 'allow', String(i)], `允许规则 /${src}/ 没有 ^ 锚点：只要命令里任何位置出现就会放行。`);
    }
  });
}

/** Login strings each target will use, for previews. */
export function previewTargets(cfg) {
  return Object.keys(cfg.targets).map((id) => {
    const t = resolveTarget(cfg, id);
    return {
      id,
      pam: t.pam,
      username: t.username,
      ssh: `ssh ${t.username}@${t.pamServer.host}${t.pamServer.port !== 22 ? ` -p ${t.pamServer.port}` : ''}`,
      mode: t.mode,
    };
  });
}
