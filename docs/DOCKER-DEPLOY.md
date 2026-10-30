# 🐳 PrintGate Docker 部署文档

> 版本：**2.2.2** ｜ 文档默认用 `tomdfwe/printgate:latest`（当前指向 2.2.2，digest 与 `:2.2.2` 相同）
>   
> 其他文档：[GitHub 首页](../README-GITHUB.md) ｜ [部署前必读](../DEPLOY.txt) ｜ [测试报告](TEST-REPORT.md)

---

## 目录

1. [镜像说明](#1-镜像说明)
2. [30 秒跑起来](#2-30-秒跑起来)
3. [三种部署形态](#3-三种部署形态)
4. [端口与数据卷](#4-端口与数据卷)
5. [环境变量](#5-环境变量)
6. [首次初始化](#6-首次初始化)
7. [自己构建镜像](#7-自己构建镜像)
8. [升级、回滚、备份](#8-升级回滚备份)
9. [公网访问与反向代理](#9-公网访问与反向代理)
10. [日常运维](#10-日常运维)
11. [故障排查](#11-故障排查)
12. [上线安全清单](#12-上线安全清单)

---

## 1. 镜像说明

| 项    | 值                                                                       |
| ---- | ----------------------------------------------------------------------- |
| 镜像   | `tomdfwe/printgate`                                                     |
| 标签   | **`latest`**（跟随最新正式版，本文默认）、`2.2.2`（固定版本，生产可锁定）、`edge`（Actions 手动构建，尝鲜）  |
| 架构   | **linux/arm64**（树莓派 / ARM NAS / Apple Silicon）；x86 见 [7.2](#72-多架构构建)   |
| 体积   | 约 594 MB（Hub 实测拉取约 146 MB）；`WITH_OFFICE=1` 再加约 50 MB                    |
| 基础镜像 | `node:22-alpine`，内置 CUPS、Avahi、sane、Ghostscript、中文字体（文泉驿）、frp           |
| 可选组件 | 默认**不含 frp**（内网穿透）：静态 Go 二进制会带入大量 CVE，需要时用 `--build-arg WITH_FRP=1` 重建，或挂载官方 frpc |
| 运行身份 | **root**（CUPS 需要写 `/etc/cups`、读 USB 设备）；容器内只有本应用进程                      |
| 默认入口 | `tini → /entrypoint.sh`，依次拉起 dbus → avahi → cupsd → PrintGate →（可选）frpc |
| 健康检查 | `curl -fsS http://127.0.0.1:8080/api/health`，30s 一次，启动宽限 25s            |

拉取：

```bash
docker pull tomdfwe/printgate:latest
```

国内拉取慢时，给 Docker 配镜像加速（`/etc/docker/daemon.json`，改完 `systemctl restart docker`）：

```json
{
  "registry-mirrors": ["https://docker.1ms.run", "https://docker.m.daocloud.io"]
}
```

> 注意：加速站只代理 Docker Hub，拉取的是同一个镜像，但**不要用加速站域名长期引用镜像**，部署文件里仍写 `tomdfwe/printgate:latest`。

---

## 2. 30 秒跑起来

### 2.1 docker compose（推荐）

```bash
mkdir -p /opt/printgate && cd /opt/printgate
cat > docker-compose.yml <<'YAML'
services:
  printgate:
    image: tomdfwe/printgate:latest
    container_name: printgate
    restart: unless-stopped
    ports:
      - "8080:8080"   # 管理台 / REST API / 小程序接口
      - "631:631"     # IPP / AirPrint
    environment:
      TZ: Asia/Shanghai
    volumes:
      - ./data:/data        # 数据库、上传件、扫描件、头像、frp 配置
      - ./cups:/etc/cups    # 打印队列（必须持久化，否则重启丢队列）
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 25s
YAML

docker compose up -d
docker compose logs -f      # 看到 "listening on 0.0.0.0:8080" 即就绪
```

浏览器打开 `http://<主机IP>:8080` → 设置管理员密码 → 完成。

### 2.2 一行 docker run

```bash
docker run -d --name printgate --restart unless-stopped \
  -p 8080:8080 -p 631:631 \
  -e TZ=Asia/Shanghai \
  -v /opt/printgate/data:/data \
  -v /opt/printgate/cups:/etc/cups \
  tomdfwe/printgate:latest
```

### 2.3 验证

```bash
curl -s http://127.0.0.1:8080/api/health
# {"ok":true,"app":"PrintGate","version":"2.2.2",...}

docker exec printgate lpstat -r      # scheduler is running
docker exec printgate lpstat -p      # 已添加的队列
```

---

## 3. 三种部署形态

| 形态                   | 适用场景                  | 关键差异                                                 |
| -------------------- | --------------------- | ---------------------------------------------------- |
| **A. 桥接（默认）**        | 云服务器、只做中转、打印机在别的机器上   | 端口映射即可，最省事；mDNS 广播不出去                                |
| **B. host 网络 + USB** | 家用 / 小办公室，USB 打印机插在本机 | `network_mode: host`，AirPrint 可被发现，需挂 `/dev/bus/usb` |
| **C. 连接外部 CUPS**     | 已有 CUPS 服务（NAS、别的容器）  | 用 `CUPS_SERVER` 指向外部 CUPS，本容器只跑 Web                  |

### A. 桥接模式（默认）

即上面的 [2.1](#21-docker-compose推荐)。补充建议：

```yaml
    # 需要虚拟打印机（9100 接收原始打印流）时再开，并在页面「打印机」里启用
    ports:
      - "8080:8080"
      - "631:631"
      - "9100:9100"
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
    # 弱机/长期运行建议加个上限，防止 LibreOffice 转换把机器拖死
    deploy:
      resources:
        limits: { memory: 1g }
```

### B. host 网络 + USB 打印机（AirPrint 完整可用）

```bash
cp docker/examples/docker-compose.host.yml /opt/printgate/docker-compose.yml
cd /opt/printgate && docker compose up -d
```

要点：

- `network_mode: host` 后**不要**再写 `ports`（会冲突），Web 直接监听宿主 `8080`
- 挂 `/dev/bus/usb`，并加 `device_cgroup_rules: ['c 189:* rmw']`
- 个别 ARM 平台 libusb 枚举不到设备时才需要 `privileged: true`（默认不加，权限越小越好）
- AirPrint 依赖 5353/UDP 组播，宿主防火墙别拦

### C. 连接已有的 CUPS

```bash
cp docker/examples/docker-compose.external-cups.yml /opt/printgate/docker-compose.yml
# 改里面的 CUPS_SERVER，例如 192.168.1.50:631
```

先在外部 CUPS 里装好驱动、添加并共享打印机；PrintGate 只负责 Web、用户、任务与预览。
  
注意：外部 CUPS 若与本容器不在同一网络，`CUPS_SERVER` 要写**容器可达**的地址（不能用 `localhost`，那指向容器自己）。

---

## 4. 端口与数据卷

### 端口

| 端口     | 用途                                | 是否必须 |
| ------ | --------------------------------- | ---- |
| `8080` | 管理台、REST API、小程序接口、扫码登录轮询         | ✅ 必须 |
| `631`  | CUPS：IPP 打印、AirPrint 发现、CUPS 内置后台 | 打印必需 |
| `9100` | 虚拟打印机接收器（页面里启用后才监听）               | 可选   |

> 631 暴露到公网前请确认 `docker/cupsd.conf` 的 `Allow` 规则；默认只放行内网段与本机管理。

### 数据卷

| 容器路径        | 内容                                                              | 丢了会怎样            |
| ----------- | --------------------------------------------------------------- | ---------------- |
| `/data`     | `printgate.db`（配置/用户/任务/审计）、`files/`、`scans/`、`avatars/`、`frp/` | 全部配置与历史丢失，需重新初始化 |
| `/etc/cups` | 打印队列、PPD、CUPS 配置                                                | 队列全没，需重新添加打印机    |

两个都要持久化。`/var/log/cups`、`/var/log/printgate` 可不挂（容器内已做 5MB 滚动截断）。

---

## 5. 环境变量

> **只决定首次启动的默认值**，之后以「系统设置」页里的值为准（数据库优先）。

| 变量                                  | 默认              | 说明                        |
| ----------------------------------- | --------------- | ------------------------- |
| `TZ`                                | `Asia/Shanghai` | 时区，影响任务时间、定时清理、趋势图分天      |
| `PORT`                              | `8080`          | Web 与 API 端口              |
| `PG_DATA_DIR`                       | `/data`         | 数据目录                      |
| `CUPS_SERVER`                       | `127.0.0.1:631` | 连接外部 CUPS 时修改             |
| `DEFAULT_PRINTER`                   | 空               | 首次启动的默认队列名                |
| `MAX_FILE_MB`                       | `200`           | 单文件上限                     |
| `MAX_COPIES`                        | `10`            | 单任务最大份数                   |
| `MAX_PAGES`                         | `200`           | 单任务最大页数                   |
| `APPROVE_NEW_USER`                  | `true`          | 小程序新用户是否需要审批              |
| `APPROVE_EACH_JOB`                  | `false`         | 是否逐单审批打印任务                |
| `ENABLE_QR_LOGIN`                   | `true`          | 允许微信扫码登录                  |
| `ENABLE_PASSWORD_LOGIN`             | `true`          | 允许管理员密码登录（与扫码不能同时关）       |
| `ENABLE_USER_REGISTER`              | `true`          | 允许普通用户自助注册；关掉后只能后台添加      |
| `HIDE_USER_ADVANCED`                | `false`         | 隐藏普通用户的详细打印设置             |
| `GUEST_MODE`                        | `false`         | 访客模式（仅查看，不允许打印）           |
| `LOGIN_MAX_FAIL` / `LOGIN_LOCK_MIN` | `5` / `15`      | 登录失败阈值与锁定时长               |
| `SESSION_HOURS`                     | `24`            | 会话有效期                     |
| `BIND_TOKEN_TTL_MIN`                | `10`            | 绑定码有效期（一码一人）              |
| `BIND_FAIL_ROTATE`                  | `50`            | 30 分钟内失败多少次自动换绑定码         |
| `RETENTION_DAYS` / `HISTORY_DAYS`   | `30` / `30`     | 上传件与历史的保留天数               |
| `TRUST_PROXY`                       | 未设置             | **反代之后才设 `true`**；公网直连不要开 |
| `PG_DEV_MODE`                       | 未设置             | 开发模式（模拟登录接口），生产禁止         |
| `PG_DEV_LOGIN_TOKEN`                | 未设置             | 开发模式口令，一旦设置必须带对才生效        |

示例：

```yaml
    environment:
      TZ: Asia/Shanghai
      MAX_FILE_MB: "300"
      APPROVE_NEW_USER: "true"
      ENABLE_USER_REGISTER: "false"   # 只允许管理员手工开号
      TRUST_PROXY: "true"             # 前面有 nginx 时才加
```

---

## 6. 首次初始化

1. **设管理员密码**：打开 `http://<主机IP>:8080` → 初始化页（≥8 位，含字母和数字）
2. **加打印机**：「打印机 → 添加」选驱动与连接方式；或用「驱动管理」扫描已连接设备一键添加
3. **设默认队列**：「系统设置 → 打印与文件」选默认打印机，保存
4. **小程序凭据**：「小程序对接」填 AppID / AppSecret / 接入地址（https 域名），保存后点「测试连通性」
5. **绑定管理员微信**：小程序 → 我的 → 扫码绑定，扫「小程序对接」页的绑定码（**一码一人，10 分钟过期**）
6. **开放给同事**：把网址发出去，让他们在登录页「普通用户」Tab 用用户名+密码注册。
   新账号默认**待审批，此时不能上传/打印**（能看自己的记录）；到「小程序用户 → 待审批」点「通过」后即可打印，
   门户 15 秒内自动解锁。通过后可用「高级打印」工作台的全部功能（标准/文字速印/发票合排/身份证），
   但只能操作自己的文件与任务，后台设置依然进不去。
   也可以由管理员在「小程序用户 → 添加用户」里直接建账号（账号密码或微信 OpenID 两种）

---

## 7. 自己构建镜像

### 7.1 单架构

```bash
git clone <本仓库> && cd printgate

# 先本地跑过测试再打包（可选）
cd server && npm i && cd ../web && npm i && cd ..

docker build -t printgate:dev .                        # 当前平台
docker build --build-arg WITH_OFFICE=1 -t printgate:office .   # 内置 LibreOffice
docker build --build-arg WITH_FRP=1 -t printgate:relay .       # 需要内网穿透时把 frpc 装回来
```

`--build-arg CACHEBUST=$(date +%s)` 可强制重编前端（前端产物在构建阶段生成）。

### 7.2 多架构构建

```bash
docker buildx create --name pg --use --bootstrap   # 首次需要
docker buildx build --platform linux/amd64,linux/arm64 \
  --provenance=false -t yourname/printgate:2.2.2 --push .
```

> 仓库已带 `.github/workflows/docker.yml`：推 `v*` tag 会自动构建双架构并推送 Docker Hub
>   
> （需配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 两个 Secret）。首次构建 15–25 分钟，
>   
> arm64 在 QEMU 下要编译 `better-sqlite3`。

### 7.3 离线部署（无外网环境）

```bash
# 有网的机器
docker pull tomdfwe/printgate:2.2.2
docker save tomdfwe/printgate:2.2.2 | gzip > printgate-2.2.2-arm64.tar.gz

# 拷到目标机
gunzip -c printgate-2.2.2-arm64.tar.gz | docker load
docker images | grep printgate
```

---

## 8. 升级、回滚、备份

### 升级

```bash
cd /opt/printgate

# 1) 先备份（数据库 + 队列，秒级）
tar czf backup-$(date +%F-%H%M).tar.gz ./data ./cups

# 2) 用 latest 时直接拉；锁了版本号则先改 tag 再拉
docker compose pull
docker compose up -d
docker compose logs -f --tail=50
```

数据卷不变，旧版本数据库首次启动会自动迁移，配置/用户/任务/队列都保留。
  
**升级后浏览器强制刷新一次**（前端资源带 hash，但 `index.html` 可能被缓存）。

### 回滚

```bash
# 用 latest 时没有「上一个版本」可回退，回滚靠固定 tag：
sed -i 's|image: tomdfwe/printgate:latest|image: tomdfwe/printgate:2.2.1|' docker-compose.yml
docker compose up -d
```

> 生产环境如果在意可回滚，建议一开始就用固定版本（如 `:2.2.2`），
>   
> 升级时改数字而不是依赖 `latest`；`latest` 适合个人自用、随时想拿最新修复的场景。

⚠️ 只有跨大版本（表结构变更）时，回滚需要配合备份恢复：

```bash
docker compose down
rm -rf ./data && tar xzf backup-2026-10-24-0200.tar.gz
docker compose up -d
```

### 备份与恢复

```bash
# 备份（建议加进 crontab，每天 3 点）
0 3 * * * cd /opt/printgate && tar czf /backup/printgate-$(date +\%F).tar.gz ./data ./cups

# 恢复
docker compose down
rm -rf ./data ./cups
tar xzf /backup/printgate-2026-10-24.tar.gz -C /opt/printgate
docker compose up -d
```

也可以在「系统设置 → 数据与维护」里直接下载数据库备份（仅 `.db`，不含上传文件）。

---

## 9. 公网访问与反向代理

小程序只接受 **https + 443**，所以公网使用必须有域名与 TLS。

### nginx 反代

```nginx
server {
  listen 443 ssl http2;
  server_name print.example.com;
  ssl_certificate     /etc/letsencrypt/live/print.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/print.example.com/privkey.pem;

  client_max_body_size 300m;      # 必须 ≥ 单文件上限，否则大文件 413

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;       # 大文件上传/转换慢，别用默认 60s
  }
}
```

容器要加 `TRUST_PROXY=true`，否则所有请求都被记成代理 IP（审计与限流都会失真）。

> **重要**：2.2.1 起服务会校验对端地址——请求直接从公网进来时**忽略** `X-Forwarded-For`。
>   
> 所以反代请与本服务**同机（127.0.0.1）或同内网/容器网络**；跨公网反代会导致所有人共用代理 IP 的限流额度。

### 内网穿透（无公网 IP）

「中转对接」页五步向导：选模式（tcp / wss 单端口 443 复用）→ 填域名与云服务器 → 生成 `frps.toml` →
  
把 nginx 片段放到云上 → 点「运行自检」，全绿后启用。frpc 由容器入口脚本守护，配置落在 `/data/frp`。

---

## 10. 日常运维

```bash
docker compose ps                 # 状态与健康
docker compose logs -f --tail=100 # 应用日志（启动/请求）
docker exec printgate lpstat -p   # 队列状态
docker exec printgate tail -50 /var/log/cups/error_log
docker exec printgate df -h /data # 磁盘
docker stats printgate            # CPU/内存
```

- **日志**：应用日志在容器 `/var/log/printgate/app.log`（超过 5MB 自动截断到 1MB），CUPS 在 `/var/log/cups`


- **清理**：默认自动清理 30 天前的文件/历史，可在「系统设置 → 数据与维护」改；「打印机 → 历史清理」可分类手动清
- **时间**：容器时间跟随 `TZ`；改了 `TZ` 要 `docker compose up -d` 重建生效
- **资源**：Office 转换（LibreOffice）是内存大户，1GB 内存的机器建议不开 `WITH_OFFICE`

---

## 11. 故障排查

| 现象 | 排查与处理 |
| --- | --- |
| 页面打不开 / 连接被拒 | `docker compose ps` 是否 Up；`docker logs` 有没有 `listening on`；宿主防火墙放行 8080；云服务器安全组 |
| 概览页「CUPS 打印服务 异常」 | `docker exec printgate lpstat -r`；看 `/var/log/cups/error_log`；常见原因是宿主已装 CUPS 占用 631 端口 |
| 打印机列表为空 | 队列没加（「打印机 → 添加」）；或外部 CUPS 里没设 Shared |
| USB 打印机识别不到 | 确认挂了 `devices: /dev/bus/usb`；ARM 平台加 `privileged: true`；`docker exec printgate sane-find-scanner` |
| iPhone / AirPrint 搜不到 | 改 `network_mode: host`；宿主放行 5353/udp；桥接模式不支持组播 |
| 上传 docx 提示「请先转 PDF」 | 默认镜像不含 LibreOffice，用 `--build-arg WITH_OFFICE=1` 重建 |
| 扫描页提示未安装 sane | 自定义构建里被裁剪了；官方镜像自带，`docker exec printgate scanimage -L` 自检 |
| 时间差 8 小时 | `TZ=Asia/Shanghai` 没设或没重建容器 |
| 反代后所有人共用一个 IP / 频繁被锁 | 加 `TRUST_PROXY=true`，并确认反代与本服务同机或同内网 |
| 小程序扫码登录 400 / 扫码白屏 | AppID/AppSecret 错；服务器出网 IP 不在微信白名单；必须是 https 且域名在「request 合法域名」 |
| 绑定码提示「不正确或已失效」 | 一码一人 + 10 分钟 TTL，用页面当前显示的码；倒计时归零会自动换新 |
| 普通用户登录后回到登录页 | 该微信「待审批」或「被拉黑」；到「小程序用户」放行/解除 |
| 磁盘占满 | 「系统设置 → 数据与维护」下调保留天数并「立即清理过期数据」；清理 `/data/spool` 虚拟打印机落盘 |
| 忘记管理员密码 | 若还开着扫码登录，用管理员微信扫码进后台改；否则只能删 `data/printgate.db` 重新初始化（丢数据） |
| x86 机器 `exec format error` | 镜像仅 arm64，用 `--platform linux/amd64` 自建或等 Actions 双架构 |

---

## 12. 上线安全清单

部署完成后逐项确认：

- [ ] 管理员密码已改（≥8 位，含字母数字），不是默认值
- [ ] `PG_DEV_MODE` **未开启**（开发模式会开模拟登录接口）
- [ ] 631 / 9100 没有裸奔在公网（用防火墙或安全组限制内网访问）
- [ ] 反代场景已加 `TRUST_PROXY=true`，直连场景**没有**开
- [ ] 已备份 `/data` 与 `/etc/cups`，并验证过能恢复
- [ ] 「允许普通用户自助注册」按需设置；不需要就关掉，改用后台添加
- [ ] 微信绑定码只在需要时生成，用完不必保留（10 分钟自动过期）
- [ ] `docker compose logs` / 审计日志里没有异常登录尝试

---

> 需要更细的功能说明与 API，见 [DEPLOY.txt](../DEPLOY.txt)；改动记录与每轮验证结果见 [TEST-REPORT.md](TEST-REPORT.md)。

## 网络扫描仪（一体机）怎么扫

镜像里已经装了 `sane` + `sane-utils` + `sane-airscan`（构建时可用 `WITH_AIRSCAN=0` 跳过）。
扫描不出来的 90% 情况是**容器和一体机不在同一个广播域**：桥接网络下 mDNS 过不来，`scanimage -L` 自然列不出设备。

### 方式 A（推荐，任何平台都能用）
1. 打开「扫描仪」页，页面顶部会提示当前网络模式
2. 在「网络扫描仪」里填：名称（如 `二楼一体机`）+ 一体机 IP（如 `192.168.1.50`，非标准端口写 `IP:8080`）
3. 点「探测」——会请求 `http://<IP>/eSCL/ScannerCapabilities`，通了会显示型号
4. 点「添加」——地址写入 `/data/sane.d/airscan.conf`，设备立刻出现在「扫描设备」下拉里

> 配置存在数据卷里，容器重建/升级都不会丢。

### 方式 B（仅 Linux）：host 网络
```yaml
services:
  printgate:
    network_mode: host
    # 删掉 ports 段；host 模式下 8080 / 631 直接占用宿主端口
```
host 模式下如果一体机在**同一网段**，`scanimage -L` 会自动发现，不必手填 IP。
macOS / Windows 的 Docker Desktop 不支持真正的 host 网络，请用方式 A。

### 排查命令
```bash
docker exec -e SANE_CONFIG_DIR=/data/sane.d:/etc/sane.d printgate scanimage -L   # 列出设备（必须带这个 env，否则看不到手填的网络扫描仪）
docker exec printgate scanimage --version # 版本与后端
docker exec printgate cat /data/sane.d/airscan.conf   # 看手写的设备地址
docker exec printgate ip -4 addr           # 容器 IP（判断是否和一体机同段）
```

## Office 文档（docx/xlsx/pptx）转换

主镜像**不内置** LibreOffice（否则镜像 167MB → 1.2GB）。两种开启方式：

**A. 运行时一键安装（推荐）**
管理台 →「系统设置」→ Office 转换组件 →「一键安装（约 400MB）」
- 有进度条：下载 / 安装 / 校验三段，显示已下载包数与已用时间，刷新页面也能接着看
- 内部先 `apk fetch -R` 把连同依赖在内的全部安装包**缓存到数据卷** `/data/office/pkgs`，
  再从本地包安装 —— 所以装一次就够：
  - 换镜像重建容器后，启动时若发现 `soffice` 不在、但数据卷有缓存，会**自动离线装回去**（约 30 秒，不需要联网，也不用再点按钮）
  - 设置页会显示「正在从数据卷恢复组件」的进度
- 不再需要时会自动清理：数据卷里多占约 200MB（安装包），点「清理缓存」可释放

**B. 构建时内置（离线环境）**
```bash
docker build --build-arg WITH_OFFICE=1 -t printgate:office .
```
镜像会大到约 1.2GB，但离线可用、重建不丢。

> PDF 打印不需要任何转换组件：上传 PDF 直接进 CUPS 队列，页数解析失败也只是少一个数字。
