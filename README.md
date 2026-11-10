# pamssh-mcp

通过 **PAM 堡垒机** 在目标服务器上执行命令的 [MCP](https://modelcontextprotocol.io) Server。
认证走 **1Password SSH Agent**（私钥始终留在 1Password 里），并保持 **持久 SSH 会话**，
AI agent 可以像人在终端里一样连续工作：`cd`、`export` 等状态在多次调用之间保留。

```
Agent ──MCP (Streamable HTTP / stdio)──► pamssh-mcp ──SSH──► PAM 网关 ──► 目标主机
                                            │
                                            └─ agent 协议 ─► 1Password（Touch ID 授权签名）
```

- 登录串与终端里一致：`ssh <PAM用户>@<目标账号>@<目标主机>@<PAM网关>`，格式可配置
- 一次授权，长期复用：只在建立连接时签名一次，之后的命令不再弹窗
- 只暴露指定的那一把公钥，避免 `Too many authentication failures`
- 命令以明文写入 shell，PAM 录像 / 命令审计看到的就是真实命令
- 超时自动 Ctrl-C 并恢复会话；断线、远端 exit、网关空闲踢出后自动重连
- 安全默认：只监听 127.0.0.1、强制 Bearer Token、Host/Origin 校验、命令 allow/deny 护栏、本地 JSONL 审计、PAM 主机指纹 pin / TOFU
- 内置管理页面 `/admin`：用独立的管理令牌登录，在网页上管理全部配置（每个字段都有说明、默认值、示例和实时校验），保存后不重启即生效

原理、时序图和设计取舍见 [docs/design.md](docs/design.md)。

## 环境要求

- Node.js ≥ 20
- 1Password 桌面端 8，已开启 **设置 → 开发者 → 使用 SSH 代理**，PAM 个人密钥保存在 agent 允许的保管库中
- PAM 网关支持公钥认证，你的公钥已绑定到你的 PAM 个人账号
- 本服务必须运行在装有并已解锁 1Password 的那台机器上（agent socket 是本机的）

## 快速开始

```bash
npm install -g pamssh-mcp
```

**1. 生成配置**（`~/.config/pamssh-mcp/config.json`，权限 600，内含随机访问令牌）

```bash
pamssh-mcp init
```

**2. 找到 1Password 里的 PAM 密钥**（只读取公钥，不会弹窗）

```bash
pamssh-mcp keys
```

**3. 编辑配置**，填写 PAM 网关、个人账号、密钥和目标：

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 8765, "path": "/mcp", "authToken": "<init 生成>" },
  "pamServers": {
    "pam-prod": {
      "host": "pam.example.com",
      "port": 22,
      "user": "alice",                                  // 你的 PAM 个人账号
      "usernameTemplate": "{pamUser}@{account}@{host}", // 拼出 alice@root@10.0.0.11
      "identity": { "fingerprint": "SHA256:xxxx" },     // 或 { "comment": "1Password 条目标题" }
      "hostFingerprint": "SHA256:yyyy"                  // 可选：pin 网关主机指纹
    }
  },
  "targets": {
    "web-01": {
      "pam": "pam-prod",
      "host": "10.0.0.11",
      "account": "root",
      "description": "生产 Web 1 号机",
      "tags": ["prod", "web"]
    }
  }
}
```

**4. 验证登录**（第一次会弹出 1Password 授权）

```bash
pamssh-mcp targets       # 打印每个目标的实际登录串，可以和你在终端里用的对比
pamssh-mcp test web-01
```

**5. 启动服务**

```bash
pamssh-mcp serve          # 前台运行，Ctrl-C 退出
```

```bash
pamssh-mcp serve start    # 或者放到后台运行；开机自启见“作为后台服务运行”
```

同一用户同时只能运行一个服务实例：已有实例时，再次启动会提示它的 PID 和地址后退出。

**6. 接入 agent**

Claude Code：

```bash
claude mcp add --transport http pamssh http://127.0.0.1:8765/mcp --header "Authorization: Bearer $(pamssh-mcp token)"
```

或者在项目的 `.mcp.json` 中配置（令牌放在环境变量里）：

```json
{
  "mcpServers": {
    "pamssh": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer ${PAMSSH_MCP_TOKEN}" }
    }
  }
}
```

如果不需要常驻服务，也可以让 agent 用 stdio 方式直接拉起（会话随 agent 进程结束而结束）：

```bash
claude mcp add pamssh -- npx -y pamssh-mcp stdio
```

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `pam_list_targets` | 列出可用目标（id、账号、主机、描述、标签、已开会话），可按 `tag` 过滤 |
| `pam_exec` | 在目标上执行命令。参数：`target`、`command`、可选 `session`（默认 `default`）、`timeout_ms` |
| `pam_open_session` | 提前登录（提前触发 1Password 授权或检查权限）|
| `pam_list_sessions` | 列出当前持有的会话：状态、cwd、命令数、最后活动时间 |
| `pam_close_session` | 登出并释放特权会话。默认不调用，任务结束也保留会话供后续复用（免重新登录和 1Password 授权，保留 cwd/环境）；空闲会话由服务按 `idleTimeoutMinutes` 自动登出。只在用户明确要求，或确有必要（会话数已满需要新会话、shell 卡死需要重新登录）时关闭 |

**会话**：`pam_exec` 的 `session` 参数决定在哪个 shell 里执行。同名复用同一个 shell（`cd`、环境变量保留），新名字会建立一个独立的 PAM 登录：

```json
{ "target": "web-01", "session": "build", "command": "cd /srv/app && make" }
{ "target": "web-01", "session": "logs",  "command": "tail -n 200 /var/log/app.log" }
```

同一会话里的命令依次执行，需要并行或隔离环境时才开新会话（每个新会话都要一次登录和签名）。每个目标同时最多 `maxSessionsPerTarget` 个活动会话，满了需要复用或用 `pam_close_session` 关闭一个。登录失败或已断开的会话不占名额，10 分钟后自动清理；因空闲超时或断线重建的会话，下一次调用会标注 `RECONNECTED`。

`pam_exec` 的返回形如：

```
[exit=0 | 35ms | cwd=/var/log | session=web-01/default]
<stdout 与 stderr 合并后的输出>
```

如果会话被重建，头部会出现 `RECONNECTED`，提示 agent 之前的 cwd/环境变量已丢失。超长输出保留头部 30% 和尾部 70%，中间标注截断字数。

给 agent 的注意事项也写在了 MCP `instructions` 里：stdin 是 `/dev/null`，不要运行 vim/top/less 这类交互程序，改用 `top -b -n1`、`systemctl --no-pager`、`journalctl --no-pager -n 200` 等批处理参数。

## 配置参考

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `server.host` / `port` / `path` | `127.0.0.1` / `8765` / `/mcp` | HTTP 监听地址 |
| `server.authToken` | — | 必填，环境变量 `PAMSSH_MCP_TOKEN` 优先 |
| `server.adminToken` | — | 管理页面令牌，必须与 `authToken` 不同；不设置则管理页面关闭。环境变量 `PAMSSH_ADMIN_TOKEN` 优先 |
| `server.adminSessionMinutes` | `60` | 管理页面登录无操作多久过期（最长 12 小时）|
| `server.mcpSessionIdleMinutes` | `120` | agent 与本服务之间的 MCP 会话空闲回收时间（不影响 SSH 会话）|
| `server.allowedHosts` / `allowedOrigins` | `[]` | 绑定非回环地址或需要浏览器访问时配置 |
| `agentSocket` | 自动探测 | 优先级：配置 > `PAMSSH_AGENT_SOCK` > 1Password 默认位置 > `SSH_AUTH_SOCK` |
| `defaults.commandTimeoutMs` | `120000` | 单条命令超时，超时发送 Ctrl-C |
| `defaults.maxOutputChars` | `20000` | 单条命令最大返回字符数。Claude Code 默认单个 MCP 工具结果上限约 25k token，超过会转存文件，不建议调高 |
| `defaults.idleTimeoutMinutes` | `30` | 会话空闲多久自动登出（0 表示不回收）|
| `defaults.maxSessionsPerTarget` | `4` | 每个目标最多同时保持几个活动会话（只计已连接、正在连接或正在执行命令的；失败或断开的不占名额）|
| `policy.allow` / `policy.deny` | `[]` | 全局命令正则（多行模式）；目标上还可以再配一层 |
| `audit.enabled` / `audit.file` | `true` / `~/.config/pamssh-mcp/audit.jsonl` | 本地审计日志 |
| `audit.retentionDays` | `30` | 审计记录保留天数，服务启动时和每 6 小时清理一次过期记录；0 表示永久保留 |
| `hostKeys.file` / `trustOnFirstUse` | `known_hosts.json` / `true` | 未 pin 指纹时首次记录，之后变化即拒绝 |
| `pamServers.<id>.usernameTemplate` | `{pamUser}@{account}@{host}` | 可用占位符：`{pamUser}` `{account}` `{host}` `{pamHost}` `{target}` |
| `pamServers.<id>.identity` | — | `fingerprint` / `publicKey` / `comment`（1Password 条目标题）/ `opRef`（`op://…`，需要 1Password CLI），可组合 |
| `pamServers.<id>.readyTimeoutMs` | `90000` | 握手 + 认证超时，包括等待你点 1Password 授权的时间 |
| `pamServers.<id>.keepaliveIntervalMs` | `15000` | SSH keepalive，防止网关空闲断开 |
| `targets.<id>.mode` | `shell` | `shell`：持久 PTY，保留状态；`exec`：每条命令一个 exec 通道（需要网关支持），stderr 单独返回 |
| `targets.<id>.username` | — | 直接指定完整登录串，跳过模板 |
| `targets.<id>.shell.init` | `[]` | 登录后先执行的命令，如 `export LANG=C.UTF-8`、`cd /srv/app` |
| `targets.<id>.shell.settleMs` | `1500` | 登录输出静默多久后才初始化 shell（未识别到提示符时）；多跳网关登录慢时调大 |
| `targets.<id>.shell.readyTimeoutMs` | `30000` | 等待目标 shell 就绪的总时长 |

完整示例见 [examples/config.example.json](examples/config.example.json)。以上每个字段在管理页面里都有更详细的说明。

## 管理页面

`pamssh-mcp serve` 同时提供管理页面：`http://127.0.0.1:8765/admin`。

**登录**：使用管理令牌（`server.adminToken`），与给 agent 用的 MCP 令牌分开，这样 agent 即使拿到 MCP 令牌也无法修改约束它的策略。

```bash
pamssh-mcp token --admin            # 查看管理令牌
```

```bash
pamssh-mcp token --admin --rotate   # 生成 / 更换管理令牌（旧配置没有时用它启用管理页面）
```

令牌只在登录时提交一次，换成服务端会话（HttpOnly、SameSite=Strict Cookie），不会保存在浏览器里。连续输错 5 次锁定 15 分钟。

**功能**

| 页面 | 内容 |
| --- | --- |
| 概览 | 服务地址、SSH agent 状态、会话数、需重启的修改、配置检查结果（点击直达对应字段）、接入命令 |
| 目标 | 增删改、复制、重命名；登录命令实时预览；策略测试（用未保存的草稿检查一条命令会不会被放行）；连接测试（真实登录一次）|
| PAM 服务器 | 网关地址、PAM 账号、登录串模板及使用它的目标预览；从 SSH agent（1Password）列表里选择登录密钥；读取并固定网关主机指纹 |
| 全局设置 | HTTP 服务、默认值、全局策略、审计、指纹校验、SSH agent、日志级别 |
| 会话 | 当前保持的 SSH 会话（来源：agent / 管理页面 / CLI）、空闲剩余时间、使用旧配置的会话；可以关闭或在终端中打开 |
| 终端 | 选定目标，新建或接入一个会话，像终端一样逐条执行命令并实时查看输出；`↑`/`↓` 历史、`Ctrl-C` 中断、`Ctrl-L` 清屏，可手动结束会话 |
| 审计日志 | 按目标、事件、关键词筛选；显示保留期限，可立即清理过期记录 |
| 主机指纹 | 首次连接记录和配置中固定的指纹，可删除记录 |
| 服务日志 | 实时查看最近 1000 条日志 |
| 配置文件 | 直接编辑完整 JSON，校验后应用到草稿 |
| 备份 | 每次保存前自动备份（保留 30 份），查看差异并一键恢复；手工改文件后从磁盘重新加载 |

**字段说明**：每个字段都标注了含义、默认值（或继承自哪个全局值）、示例、取值范围、时间单位换算（如 `300000` 显示为 `= 5 分钟`），以及“必填”“需重启生效”“被环境变量覆盖”等标记；有风险的设置会显示提醒。“隐藏字段说明”按钮可以收起说明。

**编辑与保存**：所有修改先进入草稿，边改边由服务端校验，错误和建议直接显示在对应字段下，底部栏显示修改数量和校验状态（`⌘/Ctrl + S` 保存）。保存时：

- 写入前自动备份；文件以 600 权限原子写入
- 编辑期间如果配置文件被别人或手工修改过，会拒绝保存并提示重新加载，不会覆盖对方的修改
- 保存后立即应用，不需要重启：策略、超时、目标、PAM 服务器、审计、日志级别、令牌等对下一条命令生效；已删除目标的会话会被关闭；连接参数变了的会话标记为“使用旧配置”，关闭后按新配置重连
- 只有 `server.host` / `port` / `path` 需要重启，页面会提示

**终端**：在“终端”页选择目标，新建会话（独立 PAM 登录，可能弹出 1Password 授权）或接入已有会话（例如 agent 正在用的 `default`，接入后的 `cd`/`export` 会影响 agent）。命令通过和 agent 相同的持久 shell 执行：输出实时显示，结束后显示退出码，当前目录和环境变量在会话内保留。与 agent 一样，每条命令都经过命令策略检查并记入审计（来源记为“管理页面”），stdin 为 `/dev/null`，不支持 vim、top、less 等交互程序。`结束会话` 会退出远端 shell、释放 PAM 登录。

令牌在页面里默认隐藏，需要时点“显示”（会记一条日志）。管理接口也可以用 `Authorization: Bearer <管理令牌>` 从脚本调用。

## 作为后台服务运行

| 命令 | 作用 |
| --- | --- |
| `pamssh-mcp serve` | 前台运行 |
| `pamssh-mcp serve start` | 后台启动（已安装用户服务时通过服务管理器启动），等服务就绪后打印 PID、地址和日志路径 |
| `pamssh-mcp serve stop` | 停止正在运行的实例：先关闭 SSH 会话（释放 PAM 登录）再退出；20 秒内没退出则强制结束 |
| `pamssh-mcp serve restart` | 停止后重新启动，沿用上次的 `--config` / `--host` / `--port` / `--log-level` |
| `pamssh-mcp serve status` | 是否在运行（未运行时退出码为 3）、是否已安装用户服务 |
| `pamssh-mcp serve install` | 安装并启动用户级服务，登录后自动运行；可带 `--config` / `--host` / `--port` / `--log-level`，重复执行即更新 |
| `pamssh-mcp serve uninstall` | 停止服务并移除用户级服务 |

**唯一实例**：同一用户（同一个配置目录）同时只能运行一个 `serve`。已有实例时，`serve` 提示后以退出码 1 退出，`serve start` 提示后以 0 退出；`stdio` 模式不受限制。`stop` / `restart` / `status` 对任何方式启动的实例都有效（前台、后台、服务）。

**用户级服务**：不需要管理员权限，运行在你的登录会话里，这样才能访问 1Password SSH agent 并弹出授权（系统级服务如 LaunchDaemon、Windows 服务做不到）。

| 平台 | 实现 | 位置 |
| --- | --- | --- |
| macOS | LaunchAgent：登录时启动，崩溃后自动重启，`serve stop` 正常停止后不会被拉起 | `~/Library/LaunchAgents/io.github.pamssh-mcp.plist` |
| Windows | 任务计划程序：当前用户登录时执行 `serve start`，在后台无窗口运行 | 任务 `pamssh-mcp` |

- 后台实例的日志：macOS `~/Library/Logs/pamssh-mcp.log`，Windows `%LOCALAPPDATA%\pamssh-mcp\pamssh-mcp.log`，Linux `~/.local/state/pamssh-mcp/pamssh-mcp.log`。
- 服务里记录的是安装时 `node` 和 `pamssh-mcp` 的绝对路径：升级 Node（例如 nvm 切换版本）或重装到别的位置后，重新执行一次 `pamssh-mcp serve install`。
- 服务使用配置文件里的令牌，不会带上当前终端里的 `PAMSSH_MCP_TOKEN` / `PAMSSH_ADMIN_TOKEN`。
- 安装时已有手工启动的实例在运行，它会保持不变；执行 `pamssh-mcp serve restart` 后改由服务运行。
- Linux 没有内置安装命令，`serve start` / `stop` / `restart` 可用；需要自启时可以在 systemd 用户单元里执行 `pamssh-mcp serve`。
- 设置了 `PAMSSH_MCP_HOME`（或 `XDG_CONFIG_HOME`）时，实例锁、服务名都按该目录区分，可以为另一套配置单独运行和安装一个实例。

手工配置 LaunchAgent 可参考 [examples/launchd/io.github.pamssh-mcp.plist](examples/launchd/io.github.pamssh-mcp.plist)。

## 安全须知

- 这个服务等于把 **PAM 特权 shell** 交给了持有令牌的调用方。保持监听 `127.0.0.1`，令牌只放在环境变量或密钥管理里，泄露后用 `pamssh-mcp token --rotate` 轮换。
- 管理令牌能修改策略和目标，权限高于 MCP 令牌：不要交给 agent，也不要和 MCP 令牌设成同一个（配置校验会拒绝）。
- allow/deny 正则只是防止 agent 失误的护栏，不是安全边界。真正的边界是 PAM 授权和目标账号权限，建议给 agent 用权限最小的目标账号。
- 审计日志不记录命令输出；PAM 网关自己的录像仍是权威审计。本地审计默认只保留 30 天（`audit.retentionDays`），需要长期留存时先归档或调大天数。
- 1Password 授权建议设为“每个新应用都需要批准”，并设置合适的记住时长。

## 本地调试：mock PAM 网关

仓库附带一个模拟网关：按 `user@account@host` 解析登录串，用公钥验签，然后在本机真实 PTY 里起一个 shell 充当“目标主机”。可以用它在没有真实 PAM 的情况下走通 1Password 授权的全流程：

```bash
# 用 1Password 里的公钥启动（pamssh-mcp keys 可以看到公钥）
node examples/mock-pam-server.js --port 2222 --authorized-key "ssh-ed25519 AAAA... PAM Key"
# 也可以模拟不支持 exec 的网关
node examples/mock-pam-server.js --authorized-keys ~/.ssh/id_ed25519.pub --no-exec
```

然后把配置里的 PAM 网关指向 `127.0.0.1:2222`。它会给出本机真实 shell，只在本机调试时使用。

## 开发

```bash
npm install
npm test          # 单元测试 + 端到端（需要 ssh-agent / ssh-keygen / script / bash）
```

端到端测试用真实的 `ssh-agent` 代替 1Password，经过 mock PAM 网关和真实 PTY shell，再通过 MCP SDK 客户端走 Streamable HTTP 调用全部工具。

### 发布到 npm

```bash
npm pack --dry-run      # 检查要发布的文件
npm version patch       # 或 minor / major
npm publish --access public
```

`prepublishOnly` 会先跑测试。如果要用组织 scope（如 `@your-org/pamssh-mcp`），修改 `package.json` 的 `name`。

> 安装时 npm 可能提示 `ssh2` / `cpu-features` 的安装脚本被拦截：那是可选的原生加速模块，不安装时 ssh2 会自动使用纯 JS 实现，功能不受影响。

## 常见问题

**每次连接都弹 1Password？** 在 1Password → 设置 → 开发者里调整授权记住时长。另外，会话保持期间不会重新签名，只有新建会话或重连时才会再签。

**`no key in the SSH agent matches identity`？** 错误信息会列出 agent 当前提供的所有公钥，对照修改 `identity`。注意 1Password 的 agent 只暴露允许保管库中的密钥（默认是 Personal/Private，可以用 `~/.config/1Password/ssh/agent.toml` 调整）。

**`PAM authentication failed`？** 依次检查：1Password 是否点了批准；公钥是否绑定到了 `user` 对应的 PAM 账号；`pamssh-mcp targets` 打印的登录串，和你在终端里能登录成功的那条命令是否一致。

**1Password 已经批准了，还是 `PAM authentication failed`？** 部分网关要求“公钥 + keyboard-interactive”两步认证。没有提示问题的第二步会自动通过；如果报错里出现 `asked for keyboard-interactive input ("Verification code: ")` 之类的提示，说明网关要求 OTP，当前版本不会代答。可以用 `PAMSSH_SSH_DEBUG=1 PAMSSH_LOG_LEVEL=debug pamssh-mcp test <target>` 查看完整的认证过程。

**`remote side did not become a usable POSIX shell`？** 多跳网关（跳板机 → 录像 → 目标）可能丢弃目标 shell 启动前收到的输入，程序会等待登录输出稳定后再初始化，失败时自动重发。如果网关登录特别慢，可以调大目标的 `shell.settleMs` / `shell.readyTimeoutMs`。其他情况（下同）： 说明登录后网关没有直接进入目标的 shell，比如弹出了资产选择菜单、二次认证，或者目标不是 POSIX shell（例如网络设备）。错误信息里附带了网关最后输出的内容，据此调整 `usernameTemplate`，或确认该网关支持直连目标的登录格式。

## License

MIT
