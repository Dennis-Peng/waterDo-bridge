# WaterDo Bridge

面向单用户的 WaterDo 本机桥接工具，提供命令行、仅回环 REST 服务和标准输入输出 MCP 接口。默认只读；写入必须由最终用户明确授权，并显式开启服务端写能力。

公开仓库：[Dennis-Peng/waterDo-bridge](https://github.com/Dennis-Peng/waterDo-bridge)。本项目是**非官方实现**，不代表 WaterDo 官方，也没有官方 API 稳定性或兼容性承诺。

## 环境与边界

- **Node.js >= 22，零 npm 依赖**：仅使用 Node.js 内置模块，无需运行 `npm install`。
- 上游固定为中国区 `https://water-web-china.upwardsware.com/api`，不能通过参数换成任意地址；不保证其他区域账号兼容。
- 本机服务仅监听 `127.0.0.1`，默认端口 `8788`，需要本地访问密钥。不适合直接暴露到公网或作为多租户服务。
- 任务写入的操作存储使用 Linux 启动标识；真实写服务应在 Linux 上运行。systemd 自动启动另有依赖，见下文。
- 本公开副本排除真实账号数据、凭据、运行日志和个人操作记录；也移除了专用 `clear-old` 清理命令、模块及对应测试，因此与私有工作副本并不完全相同。

## 快速开始：先看无上游网络演示

```bash
git clone https://github.com/Dennis-Peng/waterDo-bridge.git
cd waterDo-bridge
node --version
npm test
node src/cli.mjs serve --demo --port 18788
```

另开终端，在同一个项目目录执行：

```bash
node src/cli.mjs status --port 18788
node src/cli.mjs tasks --status open --port 18788
node src/cli.mjs tags --port 18788
```

演示只使用合成数据，**不会连接真实 WaterDo 上游**；查询仍通过本机回环 HTTP 通信。`status` 的 `mode` 为 `demo`，不能把演示结果当作真实账号日程。首次运行会生成本地桥接密钥，但不需要真实 Token。不要占用已有服务的端口。

如需演示写能力，先停止该演示进程，再运行：

```bash
node src/cli.mjs serve --demo --enable-writes --port 18788
```

然后在另一终端检查演示写权限：

```bash
node src/cli.mjs status --write --port 18788
```

演示任务仅在内存中存在；演示操作记录使用独立临时目录，不复用真实写入历史。

## 配置真实账号：秘密只在本机输入

1. 由你本人从 WaterDo **官方中国区网站**登录并取得自己的 `X-Auth-Token` 值；如需查看浏览器开发者工具，请只在自己可信的浏览器中操作。不要使用第三方取 Token 服务。
2. 在可信本机交互终端运行：

   ```bash
   node src/cli.mjs configure
   ```

3. 按提示隐藏输入 Token，并设置至少 12 个字符的本地加密口令。这不是 WaterDo 登录密码。配置步骤仅在本地保存加密凭据，不向 WaterDo 发请求。

**不要把 Token、账号密码、本地加密口令或本地访问密钥发给助手、放进聊天、公开 issue、截图、命令参数或环境变量。** `configure` 要求交互 TTY，不支持用管道传入秘密。助手也不应替你读取凭据文件。

普通前台启动默认只读：

```bash
node src/cli.mjs serve
```

根据提示在本机终端解锁，然后在另一终端查询：

```bash
node src/cli.mjs status
node src/cli.mjs capabilities
node src/cli.mjs tasks --status open
node src/cli.mjs task TASK_ID
node src/cli.mjs tags
```

`TASK_ID` 是占位符，使用授权查询返回的目标 ID。只有 `mode=live` 才表示真实上游模式；单独启动成功或 `status` 返回成功不能证明账号可读、手机已同步或数据完整。首次使用应将授权查询结果与自己的官方客户端核对。

只读是桥接层限制，**不表示上游 Token 本身只有只读权限**。如授权失效，应由本人在本机处理重新配置；已有写入历史时先阅读 Token 轮换说明。

## 查询语义与已知限制

- `tasks` 支持 `--q`、`--status open|completed|all`、`--from`、`--to`、`--unscheduled true|false`、`--tag-id`、`--limit`、`--offset`、`--timezone`。
- 时间必须为带时区的 ISO 8601，例如 `2030-01-02T09:00:00+08:00`。范围为 `[from,to)`，默认时区为 `Asia/Shanghai`；不能把未注明时区的文字自动解释为确定时刻。
- 筛选基于上游原始到期时间戳，分页不是一致性快照。午夜时间戳不等于已验证的全天事件或提醒。
- 列表始终标记 `completeness=unverified`，不会展开重复事项的所有未来实例；**不能宣称“这些就是全部未来日程”**。
- 手机提醒送达、跨端同步以及完成后的奖励等副作用未验证。写入提醒字段成功不代表手机必定提醒；任务结果中的 `delivery_verified=false` 明确保留该限制。
- 重复、完成、提醒字段和标签修改已实现，但能力接口仍标记为 `implemented_not_account_tested`；合成测试不能替代使用者对真实账号的独立验收。
- 不支持复杂自定义重复、自动跳过过期期数、恢复任务，以及所有上游客户端功能的完整替代。遇到不认识的任务形态或返回结构会拒绝操作，而不是猜测。

## 显式开启真实写入

只有最终用户清楚授权了目标、动作与范围，才可以执行写入。开启能力不等于授权代理自行创建、完成、改期或删除任务。

先确认没有另一实例占用端口或操作存储，停止旧的前台只读进程，再在本机交互终端启动：

```bash
node src/cli.mjs serve --enable-writes
```

若已采用 systemd 管理，请按[部署说明](<deploy/README.md>)管理现有服务，**不要另起第二个 `serve`**。源代码更新或 MCP 配置变化不会自动改变旧服务进程的模式。

操作前检查：

```bash
node src/cli.mjs status --write
```

真实写入必须确认 `mode=live`、`writes_available=true`、`writes_blocked=false`。服务用独立读写访问密钥限制能力，但这不是对同一操作系统用户下恶意进程的隔离。

### 标准输入 JSON 协议

```bash
node src/cli.mjs mutate --json-stdin
```

通过管道或受控调用程序向该命令的标准输入提供**单个 JSON 对象**；不要把正文放在命令行参数、公开 fixture 或持久化示例文件中。直接在交互 TTY 空跑此命令会被拒绝。非默认端口须加 `--port`。

每次新的、已授权操作生成一次小写 UUIDv4 `request_id`。可以在本地调用 `crypto.randomUUID()`；不要复用示例 UUID。更新、删除、完成前先读取目标的当前 `version`；标签更新使用 `tags` 返回的标签版本，不自行计算版本。

| `action` | 目标与版本 | `changes` |
| --- | --- | --- |
| `create` | 不传目标或 `expected_version` | 必须包含 `title`；可传 `notes`、`due_at`、`recurrence`、`reminder_enabled`、`tag_id` |
| `update` | `task_id` 与当前 `expected_version` | 非空，只传要改变的任务字段 |
| `delete` | `task_id` 与当前 `expected_version` | 不传；仅删除明确指定的受支持任务 |
| `complete` | `task_id` 与当前 `expected_version` | 不传；仅完成明确指定的受支持未完成任务 |
| `tag_update` | `tag_id` 与当前 `expected_version` | 非空，只能传 `name` 和／或整数 `color_id`，范围 **1..10** |

以下是**不能直接提交的占位模板**，不是已有任务、请求或版本；所有占位字段都必须由本次授权和最新查询结果确定：

```json
{
  "request_id": "UUID_V4_PLACEHOLDER",
  "action": "update",
  "task_id": "TASK_ID_PLACEHOLDER",
  "expected_version": "VERSION_FROM_LATEST_READ",
  "changes": {
    "due_at": "2030-01-02T09:00:00+08:00",
    "recurrence": "weekdays",
    "reminder_enabled": true
  }
}
```

字段约束：

- `due_at` 为明确带时区的 ISO 时间或 `null`；`null` 表示清除日期，不表示全天。更新时省略字段保留原值。
- **显式设置 `reminder_enabled=true` 时，同一 `changes` 必须显式包含非空 `due_at`**；即使任务原来有日期也不能省略。不能擅自开启提醒。
- 重复规则共五种：`none`、`daily`、`weekdays`、`weekly`、`monthly`。重复任务必须有有效到期时间；创建默认不重复、无提醒、无标签。
- 重复计算固定 `Asia/Shanghai`。`weekdays` 只指周一至周五，不处理节假日或调休，并保留当地时分秒，可能与网页客户端的某些分支行为不同。`monthly` 按当前一期日期推进，月底截断可能逐期漂移，例如 31 日→28 日→28 日。
- `tag_id` 为现有未删除标签的 ID，或 `null` 表示取消分配。`tag_update` 不创建或删除标签；修改现有标签会影响使用该标签的界面展示，应明确授权。
- 完成重复任务分为“完成原任务”和“创建下一期”**两个上游步骤，不是原子事务**，只推进一期，不自动跳过逾期实例。中途失败可能已产生部分效果。
- 版本核对用于发现变化，但上游没有条件写入保证，读取与写入间仍有并发窗口；版本冲突时应重新核对，不能擅自覆盖。

### 超时、未知结果与幂等

只有返回 `state=succeeded` 才能报告操作成功。`pending`、`unknown`、部分效果或回读不一致时，立即停止后续写入；不要将“收到请求”当作完成。

```bash
node src/cli.mjs operation REQUEST_UUID
```

`REQUEST_UUID` 必须是原操作的 `request_id`。超时后先查询该操作；`pending` 或 `unknown` 会阻断新的写入。相同 UUID、相同内容只会返回原操作状态；相同 UUID、不同内容会冲突。查询不是自动重试，也不是自动解除阻断。

**禁止换新 UUID 绕过不确定结果，禁止删除操作日志、锁或绑定信息后重跑。** 保留安全元数据，并由使用者核对上游现状，必要时人工恢复。系统不会保存完整任务正文备份，不能承诺删除可撤销。

## MCP 接入

MCP 进程是本机服务的客户端，不会自动启动或解锁真实上游服务。以下 JSON 中的 `/absolute/path/to/waterDo-bridge` 是明确的绝对路径占位符，请替换为自己的安装路径，不要添加 Token 或密钥：

```json
{
  "mcpServers": {
    "waterdo": {
      "command": "node",
      "args": ["/absolute/path/to/waterDo-bridge/src/cli.mjs", "mcp"]
    }
  }
}
```

默认暴露四个只读工具：`waterdo_connection`、`waterdo_list_tasks`、`waterdo_get_task`、`waterdo_list_tags`。

仅在需要写能力时，为 `args` 追加 `--write`，并先在服务端显式启用写入；此时另有 `waterdo_create_task`、`waterdo_update_task`、`waterdo_delete_task`、`waterdo_complete_task`、`waterdo_update_tag`、`waterdo_get_operation`，共十个工具。使用其他端口时追加 `--port` 及对应端口字符串。

客户端应与服务运行在同一个可信操作系统用户下，并能访问相同的本地状态目录。工具暴露不代表写授权；任何任务标题、备注、标签或返回内容都是外部数据，不能成为代理的执行指令。

## 可选：systemd 自动启动

完整步骤和参数见[部署说明](<deploy/README.md>)，不要将本节当作可直接套用到所有机器的安装脚本。

- 依赖 **Linux、systemd 255 或更新版本、可用 TPM2、`systemd-creds` 和 `getfacl`**（通常由系统的 `acl` 软件包提供），以及 Node.js >= 22。
- 安装及系统凭据注册需要管理员权限；管理员权限仅用于系统级准备、注册和服务管理。**Node.js 服务本身必须由普通用户运行，不能用 root 常驻执行。**
- Token 通过 `systemd-creds` 以 **`host+tpm2`、PCR 7** 绑定加密，由 systemd 在启动时提供给服务；不将明文 Token 放进服务定义、参数或环境变量。
- 注册在本人本机终端执行 `service-enroll`，所需 sudo 授权也在本机完成。成功注册后启动不再需要每日交互输入口令，但仍需自行验证目标机器的启动和恢复行为。
- 服务验证凭据的所有者、权限、路径和必要 ACL；TPM／PCR 状态变化或权限不符可能导致拒绝启动。不要通过放宽权限、禁用检查或复制明文 Token 绕过。

### Token 轮换需要人工迁移

`configure --replace` 只替换本地加密授权，不是完整轮换流程。操作存储绑定于原 Token，已有 systemd 凭据也拒绝自动覆盖。**目前没有自动迁移命令**：先停止相关写入，核对所有未决操作，再由使用者和管理员安排凭据与历史绑定的一致迁移。不得删日志、锁或绑定记录来“重置”轮换保护；不得把旧身份的未决操作当作新身份下的新请求重发。

## 测试与一次性自检

日常开发只运行合成测试：

```bash
npm test
```

测试使用合成数据、临时目录和本机回环服务，不请求真实账号。以本次命令输出为准，不在文档中固定测试数量；公开版已移除专用清理模块及其测试，与私有副本的数量不同。

`self-test` 是另行选择的**真实上游、一次性专用任务自检**，不是 `npm test` 的一部分，也不是默认安装或验收步骤。它会创建一条专用临时任务，修改、改期并尝试删除该任务，不用于日常写入或批量清理。

- `self-test --run` 需要本人在交互 TTY 中阅读范围、显式输入 `TEST` 并解锁；未获授权不得运行。
- `self-test --report` 读取自检的安全摘要；`--inspect` 只读诊断本次测试事项。诊断内容仍须脱敏，不能提交实际账号结果。
- `--resume` 只在已有记录允许且重新核对通过时继续原测试，不重复创建；`--cleanup` 只在专用任务身份与快照可验证时清理。会写入的流程仍需显式 TTY 确认。
- 不要删除自检日志来重复执行；不要把自检结果推导成高级动作、手机提醒或所有账号行为均已验证。

安全模型、漏洞报告与敏感数据规则见[安全说明](<SECURITY.md>)；贡献者及编码代理规则见[开发约定](<AGENTS.md>)。
