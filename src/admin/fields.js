/**
 * Field metadata for the admin UI: one entry per config key, with label,
 * help text, defaults, examples and behaviour flags. A test checks that every
 * key in the zod schema (src/config.js) is described here.
 *
 * Field properties:
 *   key, label, type, help        required
 *   type: string | int | number | bool | enum | list | regexList | tags |
 *         secret | json | group | pamRef | stringOrList
 *   default / defaultText         value used when the field is left empty
 *   inherit                       config path a target field falls back to
 *   example, placeholder, unit ('ms' | 'min'), min, max, options (enum)
 *   required, restart (needs server restart), env (overriding env var),
 *   warn (always-visible caution), advanced (collapsed by default),
 *   fields (group children), picker ('agentKey')
 * Help text may use `backticks` for inline code.
 */

const LOOPBACK_NOTE = '只监听本机（127.0.0.1）时，只有本机进程能访问；改成 0.0.0.0 或内网 IP 会把 PAM 特权 shell 暴露给网络上持有令牌的任何人。';

export const SERVER_FIELDS = [
  {
    key: 'host', label: '监听地址', type: 'string', default: '127.0.0.1', restart: true,
    help: `HTTP 服务（MCP 接口和本管理页面）绑定的地址。${LOOPBACK_NOTE}`,
    example: '127.0.0.1',
    warn: '除非放在 TLS 反向代理和网络访问控制之后，否则保持 127.0.0.1。',
  },
  {
    key: 'port', label: '端口', type: 'int', default: 8765, min: 0, max: 65535, restart: true,
    help: 'HTTP 端口。0 表示由系统随机分配（仅测试用）。修改后需要同步更新各 agent 里的 MCP 地址。',
  },
  {
    key: 'path', label: 'MCP 路径', type: 'string', default: '/mcp', restart: true,
    help: 'Streamable HTTP MCP 端点的路径，必须以 `/` 开头。agent 配置的地址为 `http://<监听地址>:<端口><路径>`。不能使用 `/admin` 和 `/healthz`。',
    example: '/mcp',
  },
  {
    key: 'authToken', label: 'MCP 访问令牌', type: 'secret', env: 'PAMSSH_MCP_TOKEN',
    help: 'agent 调用 MCP 接口时必须携带 `Authorization: Bearer <令牌>`，至少 16 个字符。持有它就能在所有目标上执行命令，按密码对待。更换后已接入的 agent 需要同步更新。获取：`pamssh-mcp token`。',
    warn: '未设置时 MCP HTTP 接口拒绝所有请求（stdio 模式不需要）。',
  },
  {
    key: 'adminToken', label: '管理页面令牌', type: 'secret', env: 'PAMSSH_ADMIN_TOKEN',
    help: '登录本管理页面使用的令牌，至少 16 个字符，且必须与 MCP 访问令牌不同：这样 agent 即使拿到 MCP 令牌，也不能修改约束它的策略。获取：`pamssh-mcp token --admin`。更换后其他已登录的管理会话会被注销。',
    warn: '清空后管理页面将无法登录（需要在配置文件里重新设置）。',
  },
  {
    key: 'adminSessionMinutes', label: '管理登录有效期', type: 'number', default: 60, min: 1, max: 1440, unit: 'min',
    help: '管理页面登录后无操作多久自动退出（分钟）。另外，无论是否活动，登录最长保持 12 小时。',
  },
  {
    key: 'allowedHosts', label: '允许的 Host 头', type: 'list', default: [],
    help: '防 DNS rebinding：请求的 Host 头必须在此列表中。留空时：监听本机地址则只接受 localhost / 127.0.0.1 / [::1]；监听其他地址则不检查。通过域名或反向代理访问时需要填写，每行一个，可带端口。',
    example: 'pam-mcp.internal.example.com',
  },
  {
    key: 'allowedOrigins', label: '允许的浏览器来源', type: 'list', default: [],
    help: '带 Origin 头的请求（浏览器发起的跨站请求）只有在此列表中才放行；命令行 agent 不发送 Origin，不受影响。每行一个完整来源，不支持通配符。',
    example: 'https://console.example.com',
  },
  {
    key: 'mcpSessionIdleMinutes', label: 'MCP 会话空闲回收', type: 'number', default: 120, min: 1, unit: 'min',
    help: 'agent 与本服务之间的 MCP 会话多久无请求后回收（分钟）。只影响 MCP 连接本身，不会关闭 SSH 会话；agent 会自动重新初始化。',
  },
];

export const DEFAULTS_FIELDS = [
  {
    key: 'commandTimeoutMs', label: '命令超时', type: 'int', default: 120000, min: 1, unit: 'ms',
    help: '单条命令的最长运行时间（毫秒）。超时后发送 Ctrl-C，返回 exit=130，会话保持可用。agent 调用时可以用 `timeout_ms` 参数为单次命令单独指定（上限 1 小时）。',
    example: '300000（5 分钟）',
  },
  {
    key: 'maxOutputChars', label: '最大输出字符数', type: 'int', default: 20000, min: 1000,
    help: '单条命令返回给 agent 的最大字符数。超出时保留开头 30% 和结尾 70%，中间注明截断了多少字符。',
    warn: 'Claude Code 单个 MCP 工具结果上限约 25k token，超过会被转存为文件；不建议超过 20000。',
  },
  {
    key: 'idleTimeoutMinutes', label: 'SSH 会话空闲超时', type: 'number', default: 30, min: 0, unit: 'min',
    help: 'SSH 会话多久没有执行命令就自动登出（分钟），释放 PAM 特权登录。正在执行的命令不算空闲。0 表示永不自动登出。登出后下次调用会自动重新登录（约 10 秒，可能弹出 1Password 授权），cwd 和环境变量会丢失。',
  },
  {
    key: 'maxSessionsPerTarget', label: '每个目标最多会话数', type: 'int', default: 4, min: 1,
    help: '同一目标最多同时保持几个活动会话。agent 用 `pam_exec` 的 `session` 参数区分会话：同名复用同一个 shell，新名字建立一个独立的 PAM 登录（适合并行任务或隔离环境）。只有已连接、正在连接或正在执行命令的会话计入上限；登录失败或已断开的会话不占名额，保留 10 分钟供查看错误后自动清理。达到上限时新会话会被拒绝，需要复用已有会话或先关闭一个。',
  },
];

const POLICY_HELP_COMMON = '每行一个 JavaScript 正则表达式，以多行模式匹配整条命令（`^`、`$` 匹配每一行的行首、行尾）。';

export const POLICY_FIELDS = [
  {
    key: 'allow', label: '允许规则', type: 'regexList', default: [],
    help: `${POLICY_HELP_COMMON}非空时，命令必须匹配至少一条才能执行；留空表示不限制。建议用 \`^\\s*(ls|cat|grep)\\b\` 这种带 \`^\` 锚点的写法，否则 \`ls\` 会匹配到任何包含 ls 的命令。`,
    example: '^\\s*(ls|cat|head|tail|grep|df|free|uptime|ps)\\b',
  },
  {
    key: 'deny', label: '拒绝规则', type: 'regexList', default: [],
    help: `${POLICY_HELP_COMMON}匹配任意一条即拒绝，优先于允许规则。被拒绝的命令不会发往服务器，会记入审计日志。`,
    example: '(^|[;&|\\s])rm\\s+-[A-Za-z]*[rf][A-Za-z]*\\s+/(\\s|$)',
    warn: '这只是防止 agent 失误的护栏，不是安全边界：正则很容易被绕过。真正的边界是 PAM 授权和目标账号权限。',
  },
];

export const AUDIT_FIELDS = [
  {
    key: 'enabled', label: '启用审计日志', type: 'bool', default: true,
    help: '把每条命令的请求方、目标、登录串、命令、退出码和耗时追加写入 JSONL 文件。不记录命令输出（可能含敏感信息）。PAM 网关自身的录像仍是权威审计。',
  },
  {
    key: 'file', label: '审计文件路径', type: 'string', defaultText: '~/.config/pamssh-mcp/audit.jsonl',
    help: '审计日志位置，支持 `~` 和 `$HOME`。文件以 0600 权限创建。',
  },
];

export const HOSTKEY_FIELDS = [
  {
    key: 'file', label: '主机指纹库路径', type: 'string', defaultText: '~/.config/pamssh-mcp/known_hosts.json',
    help: '首次连接时记录的 PAM 网关主机指纹存放位置（JSON 格式，与 ~/.ssh/known_hosts 无关）。',
  },
  {
    key: 'trustOnFirstUse', label: '首次连接时信任', type: 'bool', default: true,
    help: '没有在 PAM 服务器上固定指纹时：开启则首次连接自动记录网关指纹，以后指纹变化即拒绝（与 ssh 的 StrictHostKeyChecking=accept-new 相同）；关闭则必须先固定指纹才能连接。',
  },
];

export const MISC_FIELDS = [
  {
    key: 'agentSocket', label: 'SSH Agent 套接字', type: 'string',
    defaultText: '自动探测：PAMSSH_AGENT_SOCK → 1Password 默认位置 → SSH_AUTH_SOCK',
    help: '用来签名的 SSH agent。macOS 上 1Password 的位置是 `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`，Linux 是 `~/.1password/agent.sock`。一般留空即可；也可以在单个 PAM 服务器上覆盖。',
  },
  {
    key: 'logLevel', label: '日志级别', type: 'enum', default: 'info', env: 'PAMSSH_LOG_LEVEL',
    options: [
      { value: 'error', label: 'error（仅错误）' },
      { value: 'warn', label: 'warn（警告及以上）' },
      { value: 'info', label: 'info（常规）' },
      { value: 'debug', label: 'debug（排查连接问题）' },
    ],
    help: '服务日志详细程度，保存后立即生效。排查登录问题时用 debug。',
  },
];

export const GLOBAL_SECTIONS = [
  { id: 'server', path: ['server'], title: 'HTTP 服务', help: 'MCP 接口与管理页面的监听和访问控制。标记“需重启”的字段保存后要重启 `pamssh-mcp serve` 才生效。', fields: SERVER_FIELDS },
  { id: 'defaults', path: ['defaults'], title: '默认值', help: '所有目标共用的默认值，目标上可以单独覆盖。保存后对下一条命令生效。', fields: DEFAULTS_FIELDS },
  { id: 'policy', path: ['policy'], title: '全局命令策略', help: '作用于所有目标，先于目标自己的策略检查。', fields: POLICY_FIELDS },
  { id: 'audit', path: ['audit'], title: '审计日志', help: '本地命令审计。', fields: AUDIT_FIELDS },
  { id: 'hostKeys', path: ['hostKeys'], title: '主机指纹校验', help: '防中间人：校验 PAM 网关的 SSH 主机密钥。', fields: HOSTKEY_FIELDS },
  { id: 'misc', path: [], title: 'SSH Agent 与日志', help: '', fields: MISC_FIELDS },
];

export const IDENTITY_FIELDS = [
  {
    key: 'fingerprint', label: '公钥指纹', type: 'string', picker: 'agentKey',
    help: '用哪一把密钥登录（推荐用指纹指定）。格式 `SHA256:...`，可点“从 SSH Agent 选择”或运行 `pamssh-mcp keys` 查看。',
    example: 'SHA256:pV2Lw1yU0cN3c9eQyq8tWlq5oJm2r0e0bqgk3J1sZ8E',
  },
  {
    key: 'comment', label: '密钥标题', type: 'string',
    help: '按 1Password 中 SSH 密钥条目的标题匹配（agent 把标题作为公钥注释）。改标题会导致匹配失败，所以更推荐用指纹。',
    example: 'PAM SSH Key',
  },
  {
    key: 'publicKey', label: '完整公钥', type: 'string', advanced: true,
    help: '整行 OpenSSH 公钥 `ssh-ed25519 AAAA... 注释`，按公钥内容精确匹配。',
  },
  {
    key: 'opRef', label: '1Password 引用', type: 'string', advanced: true,
    help: '`op://保管库/条目/public key` 形式的引用，连接前用 1Password CLI（`op read`）读取公钥再匹配。需要安装并登录 `op`。',
    example: 'op://Private/PAM SSH Key/public key',
  },
];

export const PAM_FIELDS = [
  {
    key: 'host', label: '网关地址', type: 'string', required: true,
    help: 'PAM / 堡垒机的 SSH 地址（域名或 IP），即 `ssh user@...@<这里>` 最后一个 @ 之后的部分。',
    example: 'pam.example.com',
  },
  { key: 'port', label: '网关端口', type: 'int', default: 22, min: 1, max: 65535, help: 'PAM 网关的 SSH 端口。' },
  {
    key: 'user', label: 'PAM 个人账号', type: 'string', required: true,
    help: '你在 PAM 系统里的个人用户名，对应登录串模板中的 `{pamUser}`。你的公钥必须已绑定到这个账号。',
    example: 'alice',
  },
  {
    key: 'usernameTemplate', label: '登录串模板', type: 'string', default: '{pamUser}@{account}@{host}',
    help: '拼出发给网关的 SSH 用户名。占位符：`{pamUser}` PAM 个人账号，`{account}` 目标账号，`{host}` 目标主机，`{pamHost}` 网关地址，`{target}` 目标 ID。必须和你在终端里 `ssh` 时用的格式一致，下方会实时预览。',
    example: '{pamUser}@{account}@{host}',
  },
  {
    key: 'hostFingerprint', label: '固定网关指纹', type: 'stringOrList',
    help: '固定 PAM 网关的 SSH 主机指纹（`SHA256:...`，每行一个，可填多个以便轮换）。固定后只接受这些指纹，比“首次连接时信任”更安全。可以点“获取主机指纹”读取当前指纹。',
    example: 'SHA256:Xk3bq9Zr0tH5yNw2LcVd8sFfP1aMeU4oGiJ7nQ6vR2A',
  },
  {
    key: 'identity', label: '登录密钥', type: 'group',
    help: '从 SSH agent（1Password）里选出用于此网关的那一把公钥，可以组合多个条件（需同时满足）。不填时会把 agent 里所有密钥依次尝试，密钥多时网关可能因“认证失败次数过多”断开。',
    fields: IDENTITY_FIELDS,
  },
  {
    key: 'agentSocket', label: 'SSH Agent 套接字', type: 'string', advanced: true,
    defaultText: '继承全局设置',
    help: '只对这个网关使用另一个 SSH agent。一般留空。',
  },
  {
    key: 'readyTimeoutMs', label: '登录超时', type: 'int', default: 90000, min: 1, unit: 'ms',
    help: 'TCP 连接、握手、认证全过程的最长时间（毫秒），包括等待你在 1Password 里点批准的时间。',
  },
  {
    key: 'keepaliveIntervalMs', label: '心跳间隔', type: 'int', default: 15000, min: 0, unit: 'ms',
    help: 'SSH 层心跳间隔（毫秒），防止空闲连接被网关或防火墙断开。0 表示不发心跳。',
  },
  {
    key: 'keepaliveCountMax', label: '心跳失败上限', type: 'int', default: 4, min: 1,
    help: '连续多少次心跳无响应就判定连接已断（断线判定时间约为 间隔 × 次数）。',
  },
  {
    key: 'algorithms', label: 'SSH 算法', type: 'json', advanced: true,
    help: '直接传给 ssh2 的 `algorithms` 选项（JSON 对象），用于兼容只支持旧算法的网关。一般留空。',
    example: '{ "serverHostKey": ["ssh-rsa"] }',
  },
];

export const SHELL_FIELDS = [
  {
    key: 'init', label: '初始化命令', type: 'list', default: [],
    help: '每次登录成功后先执行的命令，每行一条，例如设置语言或进入工作目录。会出现在 PAM 录像里。',
    example: 'export LANG=C.UTF-8\ncd /srv/app',
  },
  {
    key: 'term', label: 'TERM', type: 'string', default: 'dumb',
    help: '申请伪终端时的终端类型。`dumb` 能让大多数程序关闭颜色和分页，一般不用改。',
  },
  { key: 'cols', label: '终端列数', type: 'int', default: 250, min: 1, help: '伪终端宽度。较宽可以减少 ps、表格类输出被折行。' },
  { key: 'rows', label: '终端行数', type: 'int', default: 50, min: 1, help: '伪终端高度（行）。只影响按屏幕高度分页或排版的程序，一般不用改。' },
  {
    key: 'readyTimeoutMs', label: 'Shell 就绪超时', type: 'int', default: 30000, min: 1, unit: 'ms',
    help: '登录后等待目标 shell 可用的总时长（毫秒）。多跳网关、MOTD 很长时可以调大。',
  },
  {
    key: 'settleMs', label: '登录输出静默时间', type: 'int', default: 1500, min: 1, unit: 'ms',
    help: '没有识别到提示符时，登录输出静默多久才开始初始化 shell（毫秒）。多跳网关会丢弃目标 shell 启动前收到的输入，网关登录很慢时调大。',
  },
];

export const TARGET_FIELDS = [
  {
    key: 'pam', label: 'PAM 服务器', type: 'pamRef',
    help: '通过哪个 PAM 网关登录。只配置了一个 PAM 服务器时可以留空。',
  },
  {
    key: 'host', label: '目标主机', type: 'string', required: true,
    help: '目标资产在 PAM 中的主机名 / IP / 资产名，对应登录串模板中的 `{host}`。',
    example: '10.0.0.11',
  },
  {
    key: 'account', label: '目标账号', type: 'string', required: true,
    help: 'PAM 授权你使用的目标账号（由 PAM 代为登录），对应 `{account}`。建议给 agent 用权限最小的账号。',
    example: 'deploy',
  },
  {
    key: 'description', label: '描述', type: 'string', default: '',
    help: '会通过 `pam_list_targets` 展示给 agent，写清楚用途、注意事项，agent 会据此选择目标。',
    example: '生产 Web 1 号机，应用目录 /srv/app，只读排查',
  },
  {
    key: 'tags', label: '标签', type: 'tags', default: [],
    help: '用逗号或空格分隔。agent 可以按标签筛选目标（`pam_list_targets` 的 tag 参数）。',
    example: 'prod, web',
  },
  {
    key: 'mode', label: '执行模式', type: 'enum', default: 'shell',
    options: [
      { value: 'shell', label: 'shell：持久交互 shell（推荐）' },
      { value: 'exec', label: 'exec：每条命令一个 exec 通道' },
    ],
    help: '`shell`：一个长期保持的伪终端 shell，cd / export 在调用之间保留，stdout 和 stderr 合并，几乎所有 PAM 网关都支持。`exec`：每条命令单独执行，不保留状态，stderr 单独返回，需要网关支持 exec 请求（很多 PAM 不支持）。',
  },
  {
    key: 'commandTimeoutMs', label: '命令超时', type: 'int', min: 1, unit: 'ms', inherit: 'defaults.commandTimeoutMs',
    help: '覆盖全局默认的单条命令超时（毫秒）。',
  },
  {
    key: 'maxOutputChars', label: '最大输出字符数', type: 'int', min: 1000, inherit: 'defaults.maxOutputChars',
    help: '覆盖全局默认的单条命令最大返回字符数。',
  },
  {
    key: 'idleTimeoutMinutes', label: 'SSH 会话空闲超时', type: 'number', min: 0, unit: 'min', inherit: 'defaults.idleTimeoutMinutes',
    help: '覆盖全局默认的空闲自动登出时间（分钟），0 表示永不。',
  },
  {
    key: 'maxSessions', label: '最多会话数', type: 'int', min: 1, inherit: 'defaults.maxSessionsPerTarget',
    help: '覆盖全局默认的每目标活动会话上限（只计已连接、正在连接或正在执行命令的会话）。',
  },
  {
    key: 'policy', label: '命令策略', type: 'group',
    help: '只作用于这个目标，在全局策略之后检查（两层都要通过）。',
    fields: POLICY_FIELDS,
  },
  {
    key: 'shell', label: 'Shell 设置', type: 'group',
    help: '仅 shell 模式使用。',
    fields: SHELL_FIELDS,
  },
  {
    key: 'username', label: '完整登录串（覆盖模板）', type: 'string', advanced: true,
    help: '直接指定发给网关的 SSH 用户名，忽略 PAM 服务器的登录串模板。只在个别目标格式特殊时使用。',
    example: 'alice@deploy@10.0.0.11',
  },
];

export const FIELD_META = {
  globalSections: GLOBAL_SECTIONS,
  pamFields: PAM_FIELDS,
  targetFields: TARGET_FIELDS,
  idPattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  idHelp: 'ID 只能包含字母、数字、点、下划线和连字符，且以字母或数字开头。agent 通过 ID 选择目标，建议简短有意义，如 web-01。',
  placeholders: ['pamUser', 'account', 'host', 'pamHost', 'target'],
};
