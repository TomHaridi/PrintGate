# 镜像隐私审计报告

> 审计对象：Docker Hub `tomdfwe/printgate` 全部已发布标签
> 审计时间：2026-10-24 ｜ 工具：`tools/image-privacy-audit.js` ｜ 明细：[`_logs/image-privacy-audit.json`](../_logs/image-privacy-audit.json)

## 一、结论

**7 个已发布镜像均未发现隐私数据泄漏。**

- 没有任何业务数据库（`printgate.db`）、上传文件、扫描件、头像；
- 没有日志残留（唯一日志是 Alpine 安装包时的 `/var/log/apk.log`）；
- 没有密钥、Token、管理员口令散列、真实 AppSecret；
- `/data` 卷在镜像里是**空目录**（业务数据只在运行时挂载的卷里）；
- 镜像 `ENV` 里没有任何密钥类变量。

命中的 15–18 处「敏感串」全部是**代码键名、格式模板与界面占位符**，逐条见第四节。

## 二、审计方法

对每个标签做两步，全程不启动容器（`docker create` + `docker export` 展平 rootfs，避免 QEMU 起 arm64 的开销）：

1. **文件清单层**：扫描整棵树，命中即报警的规则包括
   `*.db / *.db-wal / *.sqlite`、`*.log`、`.env`、`*.pem / *.key / id_rsa`、`.git/`、`_data*/`、`_logs*/`、`cupsd.pid`、`printers.conf`、`/etc/passwd|shadow`。
2. **内容层**：抽取 `app/src`、`app/public`、`app/package.json`、`data`、`etc/cups`、`root`、`home`、`tmp`，
   用正则匹配：Docker PAT、GitHub Token、微信 AppID、私钥、AWS Key、scrypt 散列、本机测试口令（`LocalTest2026`/`PrintGate2026`）、
   测试账号昵称（财务-李敏 等）、示例域名、`adminPassHash`、`bindToken`。
3. 额外核对：镜像 `Config.Env` 与 `Labels` 是否夹带密钥；`/data` 是否为空。

复现：

```bash
node tools/image-privacy-audit.js 2.2.2 2.2.1 2.2.0 2.1.1 2.1.0 2.0.1 2.0.0
```

## 三、逐版本结果

| 标签 | 体积 | 文件清单命中 | 内容命中 | `/data` |
| --- | --- | --- | --- | --- |
| `2.2.2` | 566 MB | 7（全部为 Alpine 基础文件） | 18（键名/模板/占位符） | 空 |
| `2.2.1` | 566 MB | 同上 | 18 | 空 |
| `2.2.0` | 566 MB | 同上 | 18 | 空 |
| `2.1.1` | 575 MB | 同上 | 18 | 空 |
| `2.1.0` | 575 MB | 同上 | 15 | 空 |
| `2.0.1` | 551 MB | 同上 | 15 | 空 |
| `2.0.0` | 551 MB | 同上 | 15 | 空 |

> 2.1.x/2.2.x 比 2.0.x 多 3 处，是新增功能代码里的 `bindToken` 变量名，不是数据。

## 四、命中项逐条解释

### 4.1 「可疑文件」——全部来自 Alpine 基础镜像

| 文件 | 说明 |
| --- | --- |
| `etc/passwd`、`etc/shadow` | 系统账号（root、lp、sane 等），无我方账号 |
| `usr/bin/passwd` | 系统命令 |
| `etc/ssl/cert.pem`、`etc/ssl1.1/cert.pem` | CA 根证书包 |
| `usr/lib/avahi/service-types.db` | Avahi 内置服务类型库（DNS-SD 标准数据） |
| `var/log/apk.log` | 构建期 `apk add` 的安装记录，例如：`(1/3) Installing libatomic`，无主机名与用户信息 |

审计脚本按「文件名」判定，未区分基础镜像自带文件；人工核对后确认均与本项目数据无关。

### 4.2 内容命中的敏感串

| 命中 | 出现位置 | 实际内容 | 是否泄漏 |
| --- | --- | --- | --- |
| 口令散列 `scrypt$16384$8$1$` | `app/src/security.js` | **生成模板**：`` `scrypt$16384$8$1$${salt}$${key}` ``，salt/key 是变量 | 否 |
| `adminPassHash`（2 处） | `security.js`、`routes/auth.js` | 读取设置的**键名** | 否 |
| `bindToken`（7–10 处） | 多个路由 | 设置项**键名**（绑定码） | 否 |
| 微信 AppID `wx1234567890abcdef` | `app/public/assets/Wechat-*.js` | 输入框 **placeholder 示例值**，非真实 AppID | 否 |
| 示例域名 `print.example.com` | 前端产物 + `routes/relay.js`、`settings.js` | 表单占位符与报错文案里的示例 | 否 |
| 测试口令 / 昵称 / openid | — | **零命中**（镜像不含 `tools/`，`.dockerignore` 已排除） | — |

### 4.3 镜像元数据

```
org.opencontainers.image.title=PrintGate
org.opencontainers.image.description=CUPS 打印网关 + 微信小程序中转 + Vue3 管理台
org.opencontainers.image.version=<tag>
```

`ENV` 只有 `TZ / NODE_ENV / PORT / PG_DATA_DIR / PG_LOG_DIR`，无密钥。

## 五、为什么镜像里不会有业务数据

1. Dockerfile 只 `COPY server/ ./` 与前端产物 `public/`，不复制仓库根目录；
2. `.dockerignore` 排除了 `data`、`cups`、`*.log`、`_shots`、`tools`、`node_modules`、`.git`；
3. 数据库固定在 `/data`（`PG_DATA_DIR`），运行时由卷提供，镜像内该目录为空；
4. 所有密钥（微信 AppSecret、frp Token、管理员口令散列）都写在**运行时数据库**的 `settings` 表里，不进镜像。

## 六、清理旧镜像的实测结论（重要）

把 `2.2.2` 标签重新指向新构建后，实测**旧层仍可被匿名按 digest 拉取**：

```
docker pull tomdfwe/printgate@sha256:f6a3d85c8bcf4eb55f8327c0e95017dfc0d21fb3910bccfe8ff5cab8d2e88b3e
→ Status: Downloaded（成功）
```

也就是说：**改标签只能让旧镜像"不可按名字拉取"，不能删除镜像本身**。
真正删除必须走 Docker Hub 的删除接口（需要 Delete 权限），删掉最后一个 tag 引用后由后台 GC 回收 blob。

## 七、如果仍要清理旧镜像

当前 Docker Hub PAT 只有 **Read & Write** 权限，实测删除接口返回：

```
DELETE /v2/repositories/tomdfwe/printgate/tags/2.2.2/  →  403 insufficient scope
```

要彻底删除旧标签（连同 blob），需要：

1. 在 Docker Hub → Account Settings → Personal access tokens 新建一个带 **Delete** 权限的 Token；
2. 用它替换本机登录：`docker login -u tomdfwe`（密码填新 Token）；
3. 我可以用它批量删除指定标签，或你在网页端 Repository → Tags 里逐个删除。

可选折中（无需 Delete 权限）：把旧标签**重新指向新构建**，旧层就不再能通过任何标签拉取——
但这会让 `2.2.2` 这个名字对应到新代码，语义上不严谨，仅建议在确需立刻止损时使用。

## 八、后续建议

- 每次发版前跑一遍本审计：`node tools/image-privacy-audit.js <新 tag>`，非零退出即阻断发布；
- 生产部署务必挂卷 `-v /opt/printgate/data:/data`，不要把数据写回镜像；
- 仓库里不要放 `.env`、真实 AppSecret、PAT；`.gitignore` 已覆盖常见项。
