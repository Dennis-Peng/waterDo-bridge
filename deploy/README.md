# systemd 部署（可选，本机手动执行）

公开副本不包含私有运行账号、授权文件或已安装服务；**安装前 `startup=false`（未配置自启动）**，也不表示任何真实账号操作或整机重启已验证。以下操作必须由使用者在自己的主机终端执行，不由测试或发布流程执行。

[waterdo-bridge.service](<waterdo-bridge.service>) 是模板，**不能直接复制到 systemd**。先运行 [install-systemd.sh](<install-systemd.sh>)；它将 `@SERVICE_USER@`、`@SERVICE_GROUP@`、`@PROJECT_DIR@` 替换为经过验证的本机值，不需要修改源码。

## 前提

- Linux、systemd 255+，支持 `LoadCredentialEncrypted=`，并安装 `systemd-creds`、`systemd-analyze` 和 `getfacl`（通常来自 `acl` 包）。管理员权限仅用于安装准备、注册和服务管理，长期服务以普通用户运行。
- **`/usr/bin/node` 必须为 Node.js >=22**。unit 的 `ExecStart` 使用这个固定绝对路径，安装脚本也只检查它；shell 的 `PATH`、nvm 或其他自定义 Node 路径不会改变服务使用的程序。脚本固定工具 `PATH`，清除 `NODE_OPTIONS` / `NODE_PATH`，不接受命令、路径或秘密的参数/环境覆盖。
- **必须有可用的 TPM2**。注册固定使用 `host+tpm2` 与 PCR7，不降级到仅主机密钥，也不使用 `--with-key=auto`。请先自行确认 `systemd-creds has-tpm2` 的检测结果；仅安装工具不代表 TPM 可用。
- 从将运行服务的普通非 root 账号执行 `sudo`；账号及主组须可被 `id` 解析，且均不是 root。用户名/组名仅接受 ASCII 字母、数字、下划线和连字符（首字符为字母或下划线）。脚本使用 `SUDO_USER`，核对 sudo UID/GID 元数据，不硬编码任何本机身份。
- 该账号拥有 checkout 根目录及已由 `configure` 建立的私有目录；私有目录必须为 `0700`。脚本仅检查元数据，不读取授权内容，不自动 `chown` / `chmod` 私有目录。
- checkout、脚本、模板、CLI、私有目录及所有路径祖先不得是符号链接；绝对路径只接受 `[A-Za-z0-9_./-]`。不接受空格、`%`、换行、反斜杠、非 ASCII 字符、`..`、`.` 路径段或重复斜线。请使用规范路径执行 `sudo bash deploy/install-systemd.sh`，不要通过链接或 `./` / `../` 别名运行。脚本从自身路径推导 checkout，而不是接受环境中的项目目录。
- 系统目录必须是规范的非链接路径；已有 `/etc/credstore.encrypted` 必须 root 拥有且为 `0700`；临时文件只在 root 创建的 `/tmp/waterdo-systemd-install.*` 私有目录内生成，清理前重新检查固定前缀、`realpath`、所有权和权限。

## 安装与首次启动

在 checkout 根目录，以将运行服务的普通账号操作。不要把 Token、口令放入聊天、命令参数、环境变量或日志。

```bash
# 若尚未配置：交互输入授权和本地加密口令，不使用 sudo。
/usr/bin/node src/cli.mjs configure

# 仅准备系统服务并启用下次开机启动，不立即启动。
sudo bash deploy/install-systemd.sh

# 必须在重启主机前完成；以同一个普通账号交互解锁本地授权。
sudo -v
/usr/bin/node src/cli.mjs service-enroll

# 仅在注册明确成功后执行。
sudo systemctl enable --now waterdo-bridge.service
/usr/bin/node src/cli.mjs status --write
```

安装脚本在 root 私有临时目录中渲染 unit，并先运行 `systemd-analyze verify`，再以 root:root、`0644` 安装至固定 `/etc/systemd/system/waterdo-bridge.service`。它创建或核对固定凭据根目录，执行 `daemon-reload` 和 `enable`，**不执行 `start`、`restart` 或 `enable --now`**，不生成或读取 Token。安装后的 `enabled` 不等于当前运行成功；未完成注册就重启主机会使服务因缺少凭据而失败。若已有服务正在运行，安装脚本也不会替换该进程；维护现有部署需单独安排停机/重启，不要启动第二个 `serve`。

注册固定凭据名为 `waterdo-token`：加密文件位于 `/etc/credstore.encrypted/waterdo-token`，systemd 运行时目录固定为 `/run/credentials/waterdo-bridge.service`。应用只读取 systemd 提供的凭据，不接受任意环境路径或命令覆盖。checkout 内可持久写入的位置仅限私有目录（另外启用独立临时目录）；模板保留 `NoNewPrivileges=true`、`ProtectSystem=strict`、`PrivateTmp=true`、`ProtectHome=read-only`、`UMask=0077`、禁用 core dump、限制地址族以及空标准输入。监听保持回环地址，不放宽鉴权或沙箱。

部分 systemd 版本使用 root 拥有的凭据，并仅通过 **named-user ACL** 授予当前服务账号读取权。loader 接受这种严格 ACL（目录 `r-x`，文件 `r--`，组/其他用户无授权），不会把 ACL mask 对应的 `0550` / `0440` 当成普通组开放；额外用户、组授权或不安全元数据仍被拒绝。不要通过放宽权限来绕过校验。

## TPM / Secure Boot 变更与恢复边界

PCR7 绑定受 Secure Boot 状态及相关策略变化影响。调整 Secure Boot、部分固件/密钥变更、清除/更换 TPM、迁移主机或丢失主机密钥，都可能使旧凭据无法解密；不能保证升级或迁移后仍能无人值守启动。这里没有绕过 TPM 的自动恢复或明文回退。

保留自己的本地加密授权及解锁能力，并在上述变更前安排维护。注册拒绝覆盖已有凭据，并保留一次性 enrollment lock（失败也可能留下），防止并发或不确定结果覆盖账号/操作存储绑定。遇到失败不要盲目重试、删除凭据/锁或清空操作历史；先由管理员核查未决操作、已有绑定及失败原因，再制定显式恢复/轮换方案。重装脚本不会迁移账号、解密旧文件或替你完成恢复。

最终应由使用者核对 `status --write` 的实际模式和写入状态，并在自己的主机上验证重启后的服务状态。合成测试、unit 语法验证和 `enabled` 状态都不能代替真实部署验证。
