# PrintGate 部署指南（含反代与小程序配置）

> 适用版本：**v2.1.0**
> 已发布镜像：`docker.io/tomdfwe/printgate:2.1.0`（**仅 linux/arm64**）
> 覆盖：快速开始、镜像加速、三种部署方式、**Nginx/Caddy/群晖反代**、**微信小程序全量配置**、打印机接入、备份恢复、升级回滚、安全加固、验收与排障。

> ### ⚠️ 阅读前必看：本文所有命令都是「单行」
> 多行 `\` 续行命令在 SSH / 网页终端里粘贴时，经常被换行吃掉字符（典型报错：`invalid reference format`、`Command 'ocker' not found`）。
> **请直接复制单行命令执行**；需要写进文件的内容（nginx / compose / daemon.json）会明确标注「写入文件」，别往终端里贴。

---

## 0. 先搞清楚五件事

**① 数据在哪？** 容器内 `/data`：数据库 `printgate.db`、上传件 `files/`、扫描件 `scans/`、头像 `avatars/`、驱动 `drivers/`、虚拟打印机落盘 `spool/`、frp 配置 `frp/`。打印机队列在 `/etc/cups`。

**② 什么情况会丢数据？** 只有一种：`docker run` **不挂卷**且删除容器。挂了卷之后 `stop` / `kill -9` / 主机断电都不丢（有自动化用例逐项验证）。

**③ 要开哪些端口？**

| 端口 | 用途 | 是否对外 |
| --- | --- | --- |
| 8080 | 管理台 + 全部 API（小程序也连这个） | 需要（或经 443 反代） |
| 631 | CUPS IPP，供 AirPrint / 其他电脑直连 | 局域网要，公网不建议 |
| 9100 | 虚拟打印机接收器（无实体打印机时自测） | 不需要 |

**④ 小程序要几个域名？** **3 个**（`request` / `uploadFile` / `downloadFile`），可填同一个 https 域名。详见第 7 章。

**⑤ 镜像是什么架构？** 目前只发布 **linux/arm64**（群晖 / 树莓派 / armbian / ARM 服务器原生运行）。
x86 机器拉下来会报警告并走 QEMU 模拟——**能跑但慢 3–5 倍**，内存建议 ≥2GB；长期在 x86 上使用请联系发布方补 amd64 多架构清单。

---

## 1. 快速开始（ARM 设备，5 分钟）

**第 1 步：建目录**（不建会让 `-v` 自动建成 root 拥有的空目录，后续备份容易漏）

```bash
mkdir -p /opt/printgate/data /opt/printgate/cups
```

**第 2 步：起容器**（单行，直接复制）

```bash
docker run -d --name printgate --restart unless-stopped -p 8080:8080 -p 631:631 -e TZ=Asia/Shanghai -v /opt/printgate/data:/data -v /opt/printgate/cups:/etc/cups tomdfwe/printgate:2.1.0
```

**第 3 步：看日志确认起来了**

```bash
docker logs -f printgate --tail=50
```

**第 4 步：浏览器打开** `http://<设备IP>:8080`

自动进入初始化向导 → 设密码（**≥8 位，必须同时含字母和数字**）→ 直接进入后台。

**第 5 步：确认健康**

```bash
curl -s http://127.0.0.1:8080/api/health
```

返回 `{"ok":true,"app":"PrintGate","version":"2.1.0",...}` 即正常。`docker ps` 会显示 `(healthy)`。

---

## 2. 镜像加速（国内必做）

### 2.1 实测数据

同一环境、同一镜像、每次清缓存后重新拉取，取稳定值：

| 镜像源 | 官方库镜像 | 个人仓库镜像 | 评价 |
| --- | --- | --- | --- |
| **docker.1ms.run** | 1.24s / 1.38s | ✅ 3.1s | **最快最稳，首选，支持任意仓库** |
| hub.rat.dev | 1.55s / 2.30s | 未测 | ✅ 备选 |
| dockerproxy.net | 6.4s / 10.2s | 未测 | ⚠️ 可用，慢约 5 倍 |
| docker.m.daocloud.io | 波动大（实测一次 27s） | ❌ **不在白名单** | **必须移除** |
| docker.xuanyuan.me | ❌ registry 报错 | ❌ | 移除 |
| mirror.ccs.tencentyun.com | ❌ 解析失败 | ❌ | 移除 |

### 2.2 ⚠️ DaoCloud 白名单坑（最容易踩）

`docker.m.daocloud.io` 只代理白名单内的镜像（官方库 + 热门镜像）。拉**个人仓库**（如 `tomdfwe/printgate`）会直接报：

```
docker: Error response from daemon: error from registry: ... 镜像不在白名单. this image is not in the allowlist.
```

而且这是**硬错误**，Docker 不会自动 fallback 到列表里的下一个源——所以源列表里只要留着 daocloud，就可能把本来能用的源挡掉。**建议直接从列表移除。**

### 2.3 配置方法

**Linux**（写入 `/etc/docker/daemon.json`，勿直接贴终端）：

```json
{
  "registry-mirrors": [
    "https://docker.1ms.run/",
    "https://hub.rat.dev/",
    "https://dockerproxy.net/"
  ]
}
```

```bash
sudo systemctl restart docker && docker info | grep -A4 "Registry Mirrors"
```

**Docker Desktop（Windows/Mac）**：Settings → Docker Engine，填同样的 JSON，Apply & Restart。

**不想改全局配置**：用前缀直接拉（对个人仓库最实用）：

```bash
docker pull docker.1ms.run/tomdfwe/printgate:2.1.0
```

```bash
docker tag docker.1ms.run/tomdfwe/printgate:2.1.0 tomdfwe/printgate:2.1.0
```

之后照常 `docker run ... tomdfwe/printgate:2.1.0`。

### 2.4 三个注意点

1. **镜像源只加速拉取**（`docker pull`、构建时的 `FROM`）；**不加速 `docker push`** —— 推 Docker Hub 仍走 `registry-1.docker.io` 直连，国内常被阻断，需代理。
2. 源按顺序尝试，失败才换下一个，**别堆太多**，3 个足够。
3. 镜像源也帮不上「docker login」和「docker push」。

---

## 3. 部署方式一：Docker Compose（推荐）

适合要长期维护、经常升级的环境，交付包已带 `docker-compose.yml`。

```bash
mkdir -p /opt/printgate/data /opt/printgate/cups && cd /opt/printgate && unzip Printgate-最终版.zip && cd Printgate && docker compose up -d --build
```

要**直接用已发布镜像**（不本地构建）时，把 compose 里的 `build: .` 换成 `image: tomdfwe/printgate:2.1.0`。

`docker-compose.yml` 关键项（写入文件，勿直接贴终端）：

```yaml
services:
  printgate:
    build: .                    # 本地构建；用已发布镜像时改成 image: tomdfwe/printgate:2.1.0
    image: printgate:alpine
    container_name: printgate
    restart: unless-stopped
    ports:
      - "8080:8080"
      - "631:631"
      # - "9100:9100"           # 虚拟打印机接收器，自测时才开
    environment:
      TZ: Asia/Shanghai
      # TRUST_PROXY: "true"     # 放在 Nginx/Caddy 后面必须打开
    volumes:
      - ./data:/data             # ← 必须
      - ./cups:/etc/cups         # ← 强烈建议
    # AirPrint 需要 mDNS：改用 network_mode: host 并删掉 ports
    # USB 打印机/扫描仪：
    # devices:
    #   - /dev/bus/usb:/dev/bus/usb
```

---

## 4. 部署方式二/三

**纯 docker run**：见第 1 章。

**裸机 Node**（不用 Docker，适合已有 CUPS 的 Linux 服务器）：

```bash
cd Printgate/server && npm install
```

```bash
cd ../web && npm install && npm run build
```

```bash
cd ../server && PG_DATA_DIR=/var/lib/printgate PORT=8080 node src/index.js
```

前置：Node 22+、宿主机装 CUPS（`lpstat`/`lpadmin`/`lp`）、预览要 `pdftoppm`（poppler-utils）、Office 转换要 `libreoffice`。

systemd 单元（写入 `/etc/systemd/system/printgate.service`）：

```ini
[Unit]
Description=PrintGate
After=network.target cups.service
Wants=cups.service

[Service]
Type=simple
WorkingDirectory=/opt/printgate/server
Environment=PG_DATA_DIR=/var/lib/printgate
Environment=PORT=8080
Environment=PG_LOG_DIR=/var/log/printgate
Environment=TRUST_PROXY=true          # 若前置 Nginx
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

---

## 5. 反向代理（重点）

小程序要求 **https 合法域名**，所以只要用小程序就必须有反代 + 证书。

### 5.1 Nginx（最常用）

写入 `/etc/nginx/conf.d/printgate.conf`：

```nginx
server {
    listen 80;
    server_name print.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name print.example.com;

    ssl_certificate     /etc/letsencrypt/live/print.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/print.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 上传体积上限：必须 ≥ 后台「单文件上限」（默认 200MB）
    client_max_body_size 512m;
    client_body_timeout 300s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    # 不让代理缓存接口响应（否则改设置不生效）
    location /api/ { add_header Cache-Control "no-store"; }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**配套必须做的事**：给容器加 `TRUST_PROXY=true`。否则三件事会坏：
审计日志所有 IP 都是 `127.0.0.1`；登录失败锁定按「一个 IP」计数，会把全公司人一起锁；扫码登录的 IP 绑定失效。

证书（Let's Encrypt）：

```bash
sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d print.example.com
```

### 5.2 Caddy（自动 HTTPS，最省事）

写入 `/etc/caddy/Caddyfile`：

```caddy
print.example.com {
    encode gzip
    request_body { max_size 512MB }
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Forwarded-Proto {scheme}
    }
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

同样记得给容器加 `TRUST_PROXY=true`。

### 5.3 群晖 DSM 反代

1. 控制面板 → 登录门户 → 高级 → **反向代理服务器** → 新增；
2. 来源 `https://print.example.com:443`，目标 `http://127.0.0.1:8080`（或容器 IP:8080）；
3. 自定义标题头：新增 `X-Forwarded-Proto` = `https`、`X-Forwarded-For` = `$remote_addr`；
4. 容器加 `TRUST_PROXY=true`；
5. DSM 里给该域名配好证书。

### 5.4 只开 443 一个端口：frp wss 模式

设备在客户内网、服务器在云上时，用 frp 复用 443：
后台「中转对接」页填 frp 服务端地址/端口/Token/远程端口/对外地址，模式选 **wss**；云上 nginx 把 `location /~!frp` 转发到 frps 的 7000（页面会生成片段）；公网只放行 443。

### 5.5 反代自检

```bash
curl -sI https://print.example.com/api/health | head -5
```

```bash
docker logs printgate --tail=20 | grep -i audit
```

第二条应能看到**真实客户端 IP**（不是 127.0.0.1），否则就是 `TRUST_PROXY` 没生效。

---

## 6. 微信小程序配置（重点）

### 6.1 小程序侧（4 步）

**1. 导入项目**
微信开发者工具 → 导入交付包里的 `miniprogram/`（裁剪版无此目录则跳过整章）。

**2. 设置服务端地址**
小程序 → 「我的 → 服务地址」→ 填 `https://print.example.com`（不要带结尾 `/`，不要带 `/api`）。
地址存在本地存储，换设备要重新填；要预置可改 `miniprogram/utils/config.js` 的 `DEFAULT_BASE`。

**3. 配置合法域名**（微信公众平台 → 开发管理 → 开发设置 → 服务器域名）

| 域名类型 | 填什么 | 为什么 |
| --- | --- | --- |
| **request 合法域名** | `https://print.example.com` | 登录、列表、打印提交 |
| **uploadFile 合法域名** | `https://print.example.com` | 上传要打印的 PDF/图片 |
| **downloadFile 合法域名** | `https://print.example.com` | 下载头像/预览图 |

三者都要填，必须是 **https + 已备案域名**。小程序没有 WebSocket，不需要 socket 域名。
**本地联调/体验版**：开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS 版本及 HTTPS 证书」，即可用 `http://<内网IP>:8080` 联调。

**4. 上传 → 提交审核 → 发布**
多人试用可先把测试号加为「体验成员」用体验版，不必正式审核。

### 6.2 服务端侧（3 步）

**1. 填小程序凭据**：后台「微信对接」页 → AppID + AppSecret → 保存 → 点「测试连接」，返回「凭据有效」即可。密钥保存后只显示掩码；留空表示不修改，点「清除密钥」才清空。

**2. 填接入地址**：同一页的「接入地址」填 `https://print.example.com`（生成二维码/链接用）。该字段与设置页共用同一套校验：含空格、引号、尖括号、反斜杠一律拒绝。

**3. 绑定管理员**：后台生成绑定码/二维码 → 手机小程序「我的」扫码绑定 → 该微信即成管理员，可审批任务、管打印机、扫网页二维码登录后台。

### 6.3 扫码登录

设置页开启「扫码登录」+ 已配 AppID/Secret 后，网页登录页出现扫码入口。
票据 **120 秒有效、单次使用，且绑定创建者的 IP**（换 IP 一律按失效处理，防票据被抢登）。

### 6.4 本地联调（开发模式）

| 开关 | 作用 |
| --- | --- |
| 后台设置「开发模式」或 `PG_DEV_MODE=true` | 启用 `/api/mp/dev-login`，可模拟任意 openid 登录 |
| `PG_DEV_LOGIN_TOKEN=<口令>` | 设置后 dev-login 还必须带对口令 |

安全限制：**dev-login 只接受内网/回环来源**，公网直连一律 404；生产环境请务必关闭开发模式。

---

## 7. 打印机接入

「打印机」页四种方式任选：

| 方式 | 操作 |
| --- | --- |
| 局域网扫描 | 点「扫描」→ 选网段或填 CIDR → 勾选设备 → 一键添加（免驱失败会自动回退 PCL/PS） |
| 手动添加 | 填设备 URI：`ipp://192.168.1.50/ipp/print`、`socket://192.168.1.50:9100`、`lpd://…`、`dnssd://…`（`file://` 被禁止） |
| USB | 容器挂 `/dev/bus/usb` 后，设备下拉里选 `usb://…` |
| 虚拟打印机 | 「创建虚拟打印机」→ 容器内起 127.0.0.1:9100 接收器，落盘到 `data/spool/vjob-*.dat` |

**外部 CUPS**：CUPS 跑在容器外（如 NAS 宿主机）时，在「系统设置 → CUPS 服务地址」填 `192.168.1.10:631` —— 该设置**真实生效**。配错时页面会明确报「无法连接 CUPS：…」，而不是笼统的「打印机不存在」。

---

## 8. 环境变量全表

> 环境变量只作为**首次启动**写入数据库的默认值，之后以管理台设置为准。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听端口/地址 |
| `PG_DATA_DIR` / `PG_LOG_DIR` | `/data` / `/var/log/printgate` | 数据目录、日志目录 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `TRUST_PROXY` | 关 | 放 Nginx/Caddy 后**必须设 true** |
| `PG_DEV_MODE` | 关 | 启用 dev-login；生产必须关 |
| `PG_DEV_LOGIN_TOKEN` | 空 | 设置后 dev-login 需带口令 |
| `PG_ALLOW_PRIVATE_DRIVER_URL` | 关 | 允许从内网地址下载驱动 |
| `PG_AUTO_CLEAN_MS` | `3600000` | 自动清理间隔（ms） |
| `PG_CJK_FONT` | 空 | 指定中文字体文件路径 |
| `CUPS_SERVER` | `127.0.0.1:631` | 外部 CUPS 地址 |
| `DEFAULT_PRINTER` | 空 | 默认队列 |
| `MAX_FILE_MB` / `MAX_COPIES` / `MAX_PAGES` | `200` / `10` / `200` | 单文件/份数/页数上限 |
| `LOGIN_MAX_FAIL` / `LOGIN_LOCK_MIN` / `SESSION_HOURS` | `5` / `15` / `24` | 登录失败次数/锁定时长/会话小时 |
| `APPROVE_NEW_USER` / `APPROVE_EACH_JOB` / `ENABLE_QR_LOGIN` / `GUEST_MODE` | `true` / `false` / `true` / `false` | 新用户审批 / 逐单审批 / 扫码登录 / 访客模式（开=新用户免审批） |
| `RETENTION_DAYS` / `HISTORY_DAYS` / `AUDIT_RETENTION_DAYS` | `30` / `30` / `180` | 文件保留 / 历史（任务·队列·落盘）保留 / 审计保留天数 |
| `WX_APPID` / `WX_SECRET` / `ADMIN_OPENIDS` | 空 | 小程序凭据、管理员 OpenID（逗号分隔） |
| `FRP_SERVER_ADDR` / `FRP_SERVER_PORT` / `FRP_TOKEN` / `FRP_REMOTE_PORT` | 空 / `7000` / 空 / `3100` | frp 穿透 |
| `FRP_MODE` / `FRP_DOMAIN` / `RELAY_PUBLIC_URL` | `tcp` / 空 / 空 | wss 模式与对外地址 |

---

## 9. 后台设置项语义（容易混的几个）

| 设置 | 实际行为 |
| --- | --- |
| **历史保留天数** | 自动清理「任务记录 / CUPS 已完成作业 / 虚拟打印机落盘」的天数 |
| **文件保留天数** | 自动清理「源文件 / 扫描件 / 预览缓存」的天数 |
| **审计保留天数** | 审计日志轮转天数，0 = 永久 |
| 自动清理 | 每小时跑一次，顺带轮转登录尝试记录（≥30 天） |
| 访客模式 | 开启后**新注册小程序用户直接通过审批** |
| 逐单审批 | 开启后每个打印任务都要管理员放行才投递；审批接口是原子的，并发只有一次生效 |
| 数据库备份 | 下载的是 `VACUUM INTO` 生成的一致快照，不会因备份期间写入而撕裂 |

---

## 10. 备份与恢复

### 10.1 备份什么

```
data/（printgate.db、files/、scans/、avatars/、spool/、drivers/、frp/）
cups/（printers.conf，打印机队列）
```

### 10.2 两种方式

**A. 后台一键备份**（不停服）：「系统设置 → 备份数据库」下载得到的是完整快照。

**B. 整目录备份**（推荐做定时任务）：

```bash
docker compose stop
```

```bash
tar czf /backup/printgate-$(date +%F-%H%M).tar.gz -C /opt/printgate data cups
```

```bash
docker compose start
```

每天 3 点执行、保留 14 天（写入 `crontab -e`）：

```cron
0 3 * * * cd /opt/printgate/Printgate && docker compose stop && tar czf /backup/pg-$(date +\%F).tar.gz data cups && docker compose start && find /backup -name 'pg-*.tar.gz' -mtime +14 -delete
```

### 10.3 恢复

```bash
docker compose stop
```

```bash
rm -rf data cups
```

```bash
tar xzf /backup/printgate-2026-10-23-1200.tar.gz -C /opt/printgate
```

```bash
docker compose start
```

恢复后不需要重新初始化；管理员密码、用户、任务、打印机队列都在。

### 10.4 崩溃后会看到什么

| 情况 | 结果 |
| --- | --- |
| `kill -9` / 断电 | 已提交数据不丢（WAL 自动恢复），启动时对账 |
| 打印途中崩溃 | 该任务标为**失败**「服务重启导致打印中断，请重新打印」——不会假装成功 |
| 新建打印机 30 秒内崩溃 | 队列按本地配置**自动重建** |
| 删容器但卷还在 | 数据完整，重新 `up -d` 即可 |
| 删容器且**没挂卷** | 全丢，无法恢复 |

---

## 11. 升级与回滚

**本地构建版**：

```bash
cd /opt/printgate/Printgate && tar xzf /path/Printgate-新版本.zip -C /tmp && rsync -a --exclude data --exclude cups --exclude node_modules /tmp/Printgate/ ./ && docker compose build --build-arg CACHEBUST=$(date +%s) && docker compose up -d
```

**用已发布镜像**：

```bash
docker pull tomdfwe/printgate:2.1.0 && docker compose up -d --force-recreate
```

要点：
- `data/` 与 `cups/` 不要动；库结构由程序启动时自动迁移；
- 升级前先备份；
- 回滚：保留旧 tag，`docker tag <旧tag> printgate:alpine && docker compose up -d`（新版本若已迁移库结构，回滚前务必先备份）。

---

## 12. 安全加固清单（上线前逐条过）

- [ ] 管理员密码 ≥12 位（接口只要求字母+数字，强度靠自己）
- [ ] **开发模式已关闭**（devMode 关、未设 `PG_DEV_MODE`）；dev-login 已限内网
- [ ] 反代后已设 `TRUST_PROXY=true`
- [ ] 公网只放 443；`631`、`9100` 不对外
- [ ] 小程序三类合法域名只配了你自己这一个域名
- [ ] 已开启「新用户需审批」（除非确实要访客模式）
- [ ] 把关场景开启「逐单审批」
- [ ] 绑定码不外传；怀疑泄露就重新生成
- [ ] 定期看「日志 → 登录尝试」
- [ ] API Key 只发给必要第三方，用完吊销（支持过期字段）
- [ ] 备份文件权限 600，不放 Web 可访问目录

---

## 13. 健康检查与上线验收

```bash
curl -s http://127.0.0.1:8080/api/health
```

容器内置 HEALTHCHECK，`docker ps` 会显示 `(healthy)`。

**验收脚本**（在交付包 `tools/` 里，解压即跑）：

```bash
PG_BASE=https://print.example.com PG_PASS=<密码> bash tools/run-all.sh api
```

```bash
PG_BASE=https://print.example.com PG_PASS=<密码> node tools/cups-e2e.js
```

```bash
PG_BASE=https://print.example.com PG_PASS=<密码> node tools/hunt12.js
```

```bash
PG_IMAGE=printgate:alpine PG_PORT=18090 PG_PASS=Persist2026 node tools/persistence-e2e.js
```

**5 分钟人工确认**：后台能打开 → 打印机页能看到队列并打出测试页 → 上传 PDF 打印任务 `done` → 小程序扫码登录并打印成功 → 系统页 CUPS/日志正常 → `docker compose restart` 后打印机和历史都还在。

---

## 14. 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 粘贴命令报 `invalid reference format` / `Command 'ocker' not found` | 多行 `\` 续行被终端换行吃掉字符 | 用本文的**单行命令** |
| 拉取报「镜像不在白名单 / not in the allowlist」 | 用了 DaoCloud 公共源，个人仓库不在白名单 | 从镜像源列表移除 `docker.m.daocloud.io`；或 `docker pull docker.1ms.run/tomdfwe/printgate:2.1.0` 后打 tag |
| 拉取超时 / 连接失败 | 镜像源不可用或需代理 | 换第 2 章表格里的源；`docker info \| grep -A4 Mirrors` 确认已生效 |
| `Conflict. The container name "/printgate" is already in use` | 上一次失败/中断留下的同名容器占用了名字 | `docker rm -f printgate` 后重建（只删容器，不删镜像和数据）；若它正在运行，`docker start printgate` 即可 |
| 启动警告 platform 不匹配（arm64 on amd64） | 镜像只有 arm64，x86 走 QEMU 模拟 | ARM 设备可忽略；x86 长期使用请补 amd64 版本 |
| 页面 500、提示前端资源缺失 | 镜像里没有前端产物 | `docker compose build --build-arg CACHEBUST=$(date +%s)` |
| 登录后跳回登录页 | 令牌过期 / 改密码后其他设备失效 | 重新登录；改密码会让旧会话失效，属预期 |
| 「请求过于频繁」 | 限流（登录 20 次/分、全局 900 次/分） | 等 1 分钟；确认 `TRUST_PROXY=true`，否则全站共用一个 IP 计数 |
| 打印机页报 `无法连接 CUPS` | CUPS 地址配错 / cupsd 没起 | `docker exec printgate lpstat -r`；核对「CUPS 服务地址」 |
| 报 `attributes-natural-language ... Bad naturalLanguage value "en-"` | **打印机固件 bug**（部分 Canon 机型把 IPP 语言标记返回成非法的 `en-`），CUPS 拒收 | 改用 `socket://打印机IP:9100` 添加（RAW 最稳）；或在打印机网页把语言改成英文；或升级打印机固件 |
| 报「连不上打印机」 | 容器与打印机不在同一网段 / 打印机 IP 变了 | 确认 `docker exec printgate ping <打印机IP>` 通；核对端口（IPP 631、RAW 9100） |
| 报「打印机要求认证」 | 机型开了 IPP 访问控制 | 在打印机网页关闭访问控制，或改用 socket 端口 |
| 打印返回 503「CUPS 服务未就绪」 | CUPS 连不上（此时连「打印机是否存在」都无法判断） | 同上；CUPS 恢复后重试 |
| 打印返回 400「打印机不存在」 | 队列名拼错或队列已删 | 从列表重新选 |
| 审批时返回 409「已被其他管理员处理」 | 有人先放行了（防重复打印的原子保护） | 正常现象，刷新列表即可 |
| 小程序登录失败 | AppID/Secret 错、域名未配、代码未发布 | 「微信对接 → 测试连接」；核对三类合法域名 |
| 小程序上传/预览失败 | 只配了 request 域名 | 补 `uploadFile` 与 `downloadFile` 域名 |
| 扫码登录一直「未扫描」 | 扫码的微信不是已授权管理员 | 先在小程序完成「扫码绑定管理员」 |
| 扫码提示「二维码已失效」 | 超过 120 秒、已用过，或换了网络/IP | 刷新二维码，用同一网络轮询 |
| dev-login 返回 404 | 开发模式未开，或来源不是内网 | 开 devMode；从局域网访问；需要公网联调请用 frp/反代 |
| 上传 docx 提示先转 PDF | 镜像未启用 LibreOffice | `docker compose build --build-arg WITH_OFFICE=1` |
| 中文打印成方块 | 缺中文字体 | 官方镜像内置；裸机可设 `PG_CJK_FONT` |
| 磁盘越用越大 | 历史未清理 | 「打印机 → 历史与存储」设定保留天数并立即清理 |
| 改设置重启后失效 | 改的是环境变量 | 环境变量只在首次启动生效，之后在管理台改 |

排障三件套：

```bash
docker logs --tail=200 printgate
```

```bash
docker exec printgate tail -n 200 /var/log/printgate/app.log
```

```bash
docker exec printgate sh -c 'lpstat -r; lpstat -p; df -h /data'
```

---

## 15. 目录结构

```
Printgate/
├── Dockerfile / docker-compose.yml
├── docker/            # cupsd.conf / entrypoint.sh（内置 CUPS 守护与 frp 拉起）
├── server/            # Node 服务端（src/ 含路由、CUPS 封装、渲染、清理、迁移）
├── web/               # Vue3 + NaiveUI 管理台
├── miniprogram/       # 微信小程序（可选裁剪）
├── docs/
│   ├── DEPLOY-GUIDE.md   ← 本文件
│   └── TEST-REPORT.md
├── tools/             # 回归/验收脚本
└── README.md
```

---

## 附：最短路径（4 条单行命令）

```bash
mkdir -p /opt/printgate/data /opt/printgate/cups
```

```bash
docker pull docker.1ms.run/tomdfwe/printgate:2.1.0 && docker tag docker.1ms.run/tomdfwe/printgate:2.1.0 tomdfwe/printgate:2.1.0
```

```bash
docker run -d --name printgate --restart unless-stopped -p 8080:8080 -p 631:631 -e TZ=Asia/Shanghai -v /opt/printgate/data:/data -v /opt/printgate/cups:/etc/cups tomdfwe/printgate:2.1.0
```

```bash
docker logs -f printgate --tail=30
```

然后：浏览器 `http://<设备IP>:8080` 设密码 → 打印机页扫描或创建虚拟打印机 → 需要小程序时按第 5、6 章配反代与域名。
