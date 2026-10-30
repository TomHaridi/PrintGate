# GitHub 发布操作手册（PrintGate）

> 参考 [hanxi/cups-web](https://github.com/hanxi/cups-web) 的仓库组织方式整理。
> 本文只讲「怎么把这份代码推到 GitHub 并发出第一个 Release」，仓库首页文档见
> [README-GITHUB.md](../README-GITHUB.md)。

---

## 0. 推送前检查清单

| 检查项 | 命令 / 做法 | 说明 |
| --- | --- | --- |
| 没有提交运行数据 | `git status --short` 里不应出现 `_data*/`、`_logs/`、`server/public/` | `.gitignore` 已覆盖 |
| 没有提交密钥 | 见下方扫描命令 | 微信 AppSecret、frp Token、Docker PAT 都不能进仓库 |
| 没有内置测试密码进生产路径 | 搜索 `LocalTest2026` | 只应出现在 `tools/` 测试脚本里 |
| 版本号一致 | `server/package.json`、`web/package.json`、`Dockerfile` LABEL | 三处必须相同，前端版本由后端 `package.json` 透出 |
| 截图是最新的 | `docs/screenshots/*.png` | 由 `tools/readme-shots.js` 生成 |
| 回归通过 | `bash tools/run-all.sh api` | 失败项只允许是「本机没有 CUPS」类环境问题 |

敏感串扫描（在项目根执行）：

```bash
grep -rIn --exclude-dir=node_modules --exclude-dir=_data* --exclude-dir=_logs \
  --exclude-dir=_shots --exclude-dir=public \
  -E "dckr_pat_[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|wx[0-9a-f]{16}|[A-Za-z0-9]{32}" \
  --include=*.js --include=*.json --include=*.md --include=*.yml .
```

命中的 `package-lock.json` integrity 哈希与前端构建产物属正常，人工过一眼即可。

---

## 1. 决定 README 用哪份

仓库里现在有两份：

- `README.md` —— 面向「已经跑起来的人」的技术说明（端口、模块、回归脚本）
- `README-GITHUB.md` —— 面向「第一次看到这个项目的人」的仓库首页（截图、特性、一键部署）

推荐把后者作为仓库首页：

```bash
git mv README.md docs/README-TECH.md     # 技术说明挪进 docs
cp README-GITHUB.md README.md            # 首页文档
```

若你希望首页直接展示技术细节，也可以反过来只保留 `README.md`，删掉 `README-GITHUB.md`。

---

## 2. 初始化仓库并首次推送

```bash
cd /path/to/printgate

git init -b main
git add -A
git commit -m "feat: PrintGate v2.2.2 —— CUPS 打印网关 + 微信小程序 + 普通用户门户"

# 方式 A：用 GitHub CLI（推荐，自动建远程）
gh repo create printgate --public --source=. --remote=origin --push

# 方式 B：先在网页建空仓库，再手动连接
git remote add origin https://github.com/<你的用户名>/printgate.git
git push -u origin main
```

> 用 HTTPS 推送时，密码位置要填 **Personal Access Token**（`repo` 权限），不是账号密码。
> 想省事就配 SSH：`ssh-keygen -t ed25519 -C you@example.com`，把公钥贴到 GitHub → Settings → SSH keys。

---

## 3. 打 tag 与发布 Release

```bash
# 版本号与 package.json / Dockerfile 保持一致
git tag -a v2.2.2 -m "v2.2.2: 普通用户门户 + 角色隔离 + 绑定码加固"
git push origin v2.2.2
```

然后在 GitHub 页面 **Releases → Draft a new release**：

| 字段 | 填法 |
| --- | --- |
| Tag | `v2.2.2`（Choose an existing tag） |
| Title | `v2.2.2 — 普通用户门户 / 绑定码加固` |
| Describe | 直接粘贴 `docs/TEST-REPORT.md` 第 22 轮摘要 + `docker pull tomdfwe/printgate:2.2.2` |
| Assets | 可选：`printgate-2.2.2-arm64.tar.gz`（`docker save` 出来的离线包） |

或命令行：

```bash
gh release create v2.2.2 --title "v2.2.2" --notes-file docs/RELEASE-2.2.2.md
```

---

## 4. 自动化多架构镜像（GitHub Actions）

仓库已带 `.github/workflows/docker.yml`：**推 `v*` tag 时自动构建 `linux/amd64` + `linux/arm64` 双架构镜像并推送 Docker Hub**。
当前手工只发了 arm64，这套流程正好补上 x86。

启用步骤：

1. 在 Docker Hub 生成 Access Token（权限 **Read & Write**）
2. GitHub 仓库 → **Settings → Secrets and variables → Actions**，新增：
   - `DOCKERHUB_USERNAME` = `tomdfwe`
   - `DOCKERHUB_TOKEN` = 上一步的 token
3. 推一个 tag（或到 Actions 页面手动 `Run workflow`）即可

首次构建约 15–25 分钟（arm64 在 QEMU 下要编译 `better-sqlite3`），之后走 GitHub Actions 缓存会快很多。

> Dockerfile 里 npm 用 npmmirror、apk 用阿里云镜像（为了国内构建快）。若 Actions 因镜像源变慢，
> 可在 workflow 里加 build-arg 覆盖，或临时注释掉那两行换回官方源。

---

## 5. Docker Hub 仓库描述

Hub 的 Overview 建议直接放 `README-GITHUB.md` 的前半部分（标题 + 徽章 + 一键 compose）。
最短可用版本：

```markdown
# PrintGate

CUPS 打印网关 + 微信小程序 + 普通用户打印门户。

## 快速开始

    docker run -d --name printgate --restart unless-stopped \
      -p 8080:8080 -p 631:631 -e TZ=Asia/Shanghai \
      -v /opt/printgate/data:/data -v /opt/printgate/cups:/etc/cups \
      tomdfwe/printgate:latest

打开 http://<主机IP>:8080 完成初始化。

- 架构：linux/arm64（amd64 由 GitHub Actions 产出）
- 源码与文档：https://github.com/tomdfwe/printgate
```

---

## 6. 仓库设置建议

| 项目 | 建议 |
| --- | --- |
| About | 描述 `CUPS 打印网关 + 微信小程序`，Topics：`cups` `printing` `airprint` `wechat-miniprogram` `vue3` `docker` `self-hosted` |
| Branch protection | `main` 禁止直接推送，至少要求 1 个 review（多人协作时） |
| Issues | 启用，用 `bug` / `enhancement` / `question` 三个标签 |
| Security | 开启 **Private vulnerability reporting**，README 里已提示安全问题走私聊 |
| Wiki / Discussions | 视需要开启，常见问题先放 README 的 FAQ |
| LICENSE | 已带 MIT；若要商业化闭源，发布前改掉 |

---

## 7. 后续版本节奏

```bash
# 1) 改代码 → 更新三处版本号 → 补 TEST-REPORT 一轮
# 2) 本地回归
bash tools/run-all.sh api
# 3) 提交 + 打 tag（会自动触发双架构构建）
git commit -am "fix: xxx"
git tag -a v2.2.2 -m "v2.2.2: 修复 xxx"
git push origin main --tags
# 4) 写 Release notes
gh release create v2.2.2 --generate-notes
```

---

## 附：镜像命名对照

| Tag | 内容 | 何时产生 |
| --- | --- | --- |
| `latest` | 最新正式版 | 打 `v*` tag 时自动 |
| `2.2.2` | 具体版本（不变，可长期引用） | 打 `v*` tag 时自动 |
| `2.2` | 次版本浮动 | 打 `v*` tag 时自动 |
| `edge` | 手动触发的构建，尝鲜用 | Actions `Run workflow` |
