# PrintGate

> CUPS 打印网关 + 微信小程序远程打印 + Vue3 管理台，Alpine 精简镜像。
> 本项目由旧版 `printbridge`（CUPS + cups-web 二进制 + 中转服务，镜像 2.79 GB）重构而来，
> 界面与后台全部重写，镜像体积与攻击面同时大幅收缩。

---

## 1. 这次重构做了什么

| 项目 | 旧版 printbridge | PrintGate |
| --- | --- | --- |
| 基础镜像 | Debian + LibreOffice + 自编译 cups-web 二进制 + ofd 转换器 | Alpine 3.20（约 570 MB，含中文字体与 qpdf） |
| Web 界面 | cups-web 内嵌 Go/Vue 混合页 + 中转服务的原生 HTML 后台（两套） | **单套 Vue3 + NaiveUI 管理台**，15 个功能页 |
| 管理入口 | cups-web（1180）+ 中转服务（3100）两个端口、两套登录 | 一个端口（8080）统一登录、统一权限 |
| 「小程序对接 / 中转对接」按钮 | 指向 `window.open("#wechat")` / `window.open("#config")`，未配置跳转地址 → 打开空白页（**本次已修复**） | 真实路由页面：`#/wechat`、`#/relay` |
| 管理员密码 | 明文存数据库 / 环境变量 `ADMIN_PASSWORD` | 首次部署向导设置，scrypt 加盐散列，可改密 |
| 防爆破 | 仅绑定码有内存计数，重启清零 | 登录 / 绑定码 / 二维码 全链路限流 + 持久化锁定 + 审计 |
| 打印机发现 | cups-web 内置逻辑，失效 | mDNS(Avahi) + CUPS 设备枚举 + 网段 IPP/RAW 并发探测 |
| 打印参数 | 十余项但前端交互分散 | 份数/色彩/单双面/纸张/方向/缩放/页码/多页合并/自定义参数 |
| 微信能力 | 仅 code2session 登录 + 扫码绑定 | 登录、扫码绑定管理员、**网页扫码登录**、用户审批/拉黑/提权 |
| 登录方式 | 只有管理员密码 | 管理员密码（可一键关闭）+ 微信扫码；扫码后按角色分流：管理员进管理台、普通用户进打印门户 |
| 普通用户网页 | 无 | 独立打印门户：上传打印、查看自己的记录、一键清空历史；进不了任何管理接口 |
| 用户资料 | 小程序里多个「微信用户」无法区分 | 登录后引导用微信头像+昵称补全（头像昵称填写能力），后台网页/小程序列表均按头像+昵称展示 |
| 中转 | 手写 frpc 配置 + 环境变量 | 后台可视化配置 frp、在线测试连通性、API Key 开放接口 |

---

## 2. 功能一览（管理台）

- **概览**：今日任务、累计完成、待处理、在线打印机、7 日趋势、服务健康、最近任务与操作流。
- **打印机**：队列卡片（状态/默认/任务数/URI）、测试页、暂停/恢复、停止接收、删除、驱动选项查看、备注。
- **历史清理**（打印机页右上角）：四项占用统计（任务记录 / CUPS 已完成作业 / 虚拟打印机落盘 / 源文件与扫描件），
  五类可选清理范围 + 保留天数（全部、1、3、7、30、90 天），一键清理并提示释放空间；
  被未完成任务引用的源文件自动跳过；「自动清理」开关按保留天数每小时清理任务、CUPS 与落盘文件，并写 `auto_cleanup` 审计。
- **自动扫描打印机**：mDNS + CUPS 枚举 + 网段探测（快速 631/9100，深度加 443/515），对设备做 IPP 握手识别真实型号与资源路径；
  扫描完自动询问「是否自动安装驱动」。
- **驱动中心**：推荐 / 本地驱动库 / 在线 OpenPrinting / 上传与直链下载，四种方式任选；`everywhere` 失败自动回退通用 PCL/PS 驱动。
- **发起打印**：一页四种模式 —— **标准打印**（拖拽上传 PDF/Office/图片）、**文字速印**（直接输入文字排版成 PDF）、
  **发票打印**（多图按每页 1/2/4 张合排）、**身份证打印**（正反两面居中合一张 A4，**上传后实时生成拼接打印预览**，
  正反面可**各自旋转 / 缩放**，随手拍的歪斜证件还能**一键自动矫正识别切割**——自动找出身份证、旋转摆正并裁掉背景）。
  参数含颜色（彩色/黑白分段）、双面、份数、纸张、介质类型、打印质量、进纸盒、缩放、页面范围、每页页数、
  **页面子集（全部/奇数/偶数/偶数倒序）**、**镜像打印**、**水印文字**与自定义 CUPS 参数；
  右栏实时预览、最近 5 条打印记录、打印机状态（队列数/型号/墨盒余量/已装纸张），
  驱动可选项由 `lpoptions -l` 上报，耗材与纸盒经 IPP `Get-Printer-Attributes` 读取。
- **打印队列**：CUPS 实时队列（自动刷新），取消 / 挂起 / 恢复。
- **任务审批**：平台任务记录，逐单审批可开关，批量批准、拒绝、取消、失败重试、首页预览。
- **扫描仪**：SANE 设备枚举、分辨率/色彩/来源/页数、扫描到 JPEG/PNG/PDF、记录下载删除；
  自带排障分级（未装组件 / 未挂 USB / 缺驱动），页面直接给出对应的修复命令。
- **小程序用户**：待审批/已授权/已拒绝/已拉黑、授权、拉黑、提权为管理员、备注、删除。
- **小程序对接**：**接入参数的唯一维护入口** —— AppID、AppSecret、接入地址（BASE）、管理员 OpenID 白名单、
  三项策略开关（新用户审批 / 扫码登录 / 开发模式）集中一页；右栏常驻绑定二维码与接入进度，底部同屏接口文档。
  「系统设置」与「中转对接」只做状态展示并跳转，不再重复填写，避免两处保存互相覆盖。
- **中转对接**：**五步向导**（模式 → 域名/BASE → 云服务器 frps → nginx 片段 → 自检），自动生成 frps.toml / nginx 配置 / frpc.toml，
  支持「单端口 443（wss 复用，推荐）」与「独立端口 TCP」两种模式；自检会实跑 frpc 语法校验、进程状态、服务端连通、公网回连。
  同一页还有 API Key 管理与开放接口示例。
- **CUPS 后台**（运维分组）：容器内 CUPS 的「运维面板」—— 一眼看到 CUPS 版本、cupsd 进程 PID、
  服务地址、配置/日志/PPD 目录、队列与作业计数；三个页签：
  **队列与作业**（启用/停用、接收/拒收、设为默认、测试页、清空作业；作业挂起/继续/取消）、
  **配置**（在线改 `LogLevel`、`Browsing`、`WebInterface`、作业历史与重试等常用指令，保存前自动备份 `cupsd.conf.pg.bak`，
  取值走白名单校验，改完一键重启 CUPS；下方可查看 cupsd.conf 原文）、
  **日志**（error_log / access_log / page_log 分文件查看，可调行数）。所有操作写审计。
- **日志审计**：全量操作审计（筛选/分页/导出 CSV）、运行日志实时查看、登录失败记录与一键解锁。
- **系统状态**：版本、运行时长、内存/磁盘/负载、服务进程重启、数据占用、数据库备份。
- **系统设置**：打印默认值与限额、审批策略、安全（锁定阈值/会话时长/扫码登录/开发模式）、小程序、frp、数据保留与清理。

---

## 3. 快速开始

> 需要更细的部署说明（Compose/USB/AirPrint/**Nginx/Caddy/群晖反代**/**小程序三类合法域名**/备份恢复/升级回滚/排障）见
> **[docs/DEPLOY-GUIDE.md](docs/DEPLOY-GUIDE.md)**，本章只列最短路径。
>
> 已发布镜像（仅 arm64）：`docker.io/tomdfwe/printgate:2.2.0`
> `docker run -d --name printgate --restart unless-stopped -p 8080:8080 -p 631:631 -e TZ=Asia/Shanghai -v /opt/printgate/data:/data -v /opt/printgate/cups:/etc/cups tomdfwe/printgate:2.2.0`

### 3.1 Docker Compose（推荐）

```bash
docker compose up -d --build
# 打开 http://<主机IP>:8080
```

首次打开会进入**初始化向导**：设置管理员密码（≥8 位，含字母与数字）→ 自动登录后台。

### 3.2 纯 Docker

```bash
docker build --platform linux/amd64 -t printgate:alpine .

docker run -d --name printgate --restart unless-stopped \
  -p 8080:8080 -p 631:631 \
  -v printgate-data:/data \
  -v printgate-cups:/etc/cups \
  printgate:alpine
```

> 树莓派 / ARM NAS 构建：`docker buildx build --platform linux/arm64 -t printgate:alpine .`

### 3.3 本地 127.0.0.1 验证（不做任何外网上传）

```bash
docker run -d --name printgate-test \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:631:631 \
  -v "$PWD/testdata:/data" printgate:alpine
# 浏览器打开 http://127.0.0.1:8080
```

不装 Docker、直接在本机跑（需 Node 22+，Windows/macOS 均可；打印相关功能依赖 CUPS，Windows 上只有界面与上传链路可用）：

```bash
cd server && npm install            # better-sqlite3 需要编译器/预编译包
cd ../web && npm install && npm run build   # 产物输出到 server/public
cd ../server && PG_DATA_DIR=../_data PORT=8080 node src/index.js
```

没有实体打印机时，在「打印机」页点 **创建虚拟打印机**：
PrintGate 会在容器内 127.0.0.1:9100 启动接收器并建立 `PrintGate-Virtual` 队列（raw），
打印结果落在数据卷 `spool/` 目录，可用来验证「上传 → 队列 → 提交 → 落盘」全链路。

---

## 4. 首次部署与微信绑定流程

1. 打开 8080 → 设置管理员密码（写入 SQLite，scrypt 加盐散列）。
2. 「打印机」→ 自动扫描或手动添加（网络打印机建议 `ipp://IP/ipp/print` + `everywhere` 免驱）。
3. 「小程序对接」→ 填 AppID / AppSecret → 保存 → 测试连通性。
4. 小程序端接入（「小程序对接」页集中维护参数，见页面内「接口文档」）：
   - `POST /api/mp/login`（`wx.login` 的 code 换 token），新用户默认 `pending`；
   - 在「小程序用户」审批，或让管理员微信扫「绑定管理员微信」里的二维码（`POST /api/mp/bind`）；
5. 绑定成功后可在登录页切到「扫码登录」：网页生成二维码（`printgate://login?ticket=...`），
   小程序扫 → 确认 → 网页自动登录（仅 `approved` 且 `role=admin` 的微信可用）。
6. 如需公网访问：打开「中转对接」按向导走五步（推荐单端口 443），复制片段到云服务器 → 自检通过 → 保存并启用
   （自动生成 `/data/frp/frpc.toml` 并重启客户端，详见第 7 节）。

---

## 5. 打印链路

```
小程序 / 后台页面
   │  POST /api/mp/files 或 /api/files        （落盘 /data/files + 页数校验）
   ▼
PrintGate 服务
   │  任务入库（tasks），按 approveEachJob 决定 pending / approved
   ▼
CUPS（容器内 cupsd）
   │  lp -d <queue> -n <copies> -o media/sides/print-color-mode/...
   ▼
打印机（ipp / ipps / socket / usb）
```

- PDF 页数由 `pdfinfo` 统计，超过「单任务最大页数」直接拒收；Office 文档需要镜像内置 LibreOffice。
- 失败原因会写回任务记录（`error`）并在「任务审批」显示，可一键重试。

---

## 6. 自动扫描打印机 + 驱动自动安装

原版按钮无响应的根因是发现逻辑依赖 cups-web 内部接口，二进制内跳转链接又只会 `window.open("#wechat")`。
PrintGate 重写为三条独立通道，全部在本机执行、结果可直接添加：

1. **mDNS / AirPrint**：`avahi-browse -artp _ipp._tcp,_ipps._tcp,_printer._tcp`，解析 TXT 里的型号；
2. **CUPS 设备枚举**：`lpinfo -v`（dnssd://、ipp://、usb://）；
3. **网段主动探测**：并发探测 631(IPP)、9100(RAW)，深度模式额外探测 443(IPPS)、515(LPD)，
   并对 631/443 做真实 `Get-Printer-Attributes` 握手。

握手带来三个实际好处（也是「扫到了却用不了」的根因）：

- **识别真实型号**：从 `printer-make-and-model` / `printer-device-id` 拿到型号与 PDL（PCL / PostScript），
  不再显示「未知型号」，驱动推荐才有依据；
- **自动校准资源路径**：依次尝试 `/ipp/print`、`/ipp/printer`、`/` 等，避免队列建好却 404；
- **区分「有 IPP 服务」与「真免驱」**：只有声明 PWG Raster / URF 才算 IPP Everywhere。

### 扫描范围（重要）

容器默认是**桥接网络**，只能看到 Docker 内网（如 `172.17.0.0/24`），收不到局域网的 mDNS 广播。
因此「扫描范围」可以填真实局域网网段（如 `192.168.1.0/24`，支持多个、逗号分隔），保存后快速扫描也会用它。
界面会检测到容器网段时给出提示；仍扫不到时可直接用「手动探测」输入打印机 IP。

### 驱动自动安装

扫描完成后自动弹出「发现打印机，是否自动安装驱动？」，按以下顺序给每台设备选驱动：

1. 本地驱动库里型号匹配的 PPD；
2. IPP Everywhere 免驱（PWG Raster / URF）；
3. 按 `device-id` 的 PDL 选通用驱动（PCL 6 → `pxlmono/pxlcolor`，PCL 5 → HP LaserJet，PostScript → Generic PS）；
4. 兜底 RAW。

若 `everywhere` 建队列失败（老机型不返回 IPP 属性），服务端会**自动回退**到 PCL/PostScript 通用驱动并在结果里注明。
驱动不理想时可对单台「更换驱动…」，驱动库提供四类入口：

- **推荐**：给出理由与置信度，并可切换备选；
- **本地驱动库**：`lpinfo -m` 全量列表 + 已导入的自定义 PPD，支持按型号搜索；
- **在线驱动库**：OpenPrinting 官方 PPD 镜像（按型号检索，或只选厂商浏览全部机型），一键导入；
- **上传 / 直链**：上传 `.ppd` / `.ppd.gz` / `.tar.gz` / `.zip`（自动解包找 PPD），或填 PPD 直链下载。
  下载有大小上限、超时、跳转次数限制，并默认拒绝内网地址（SSRF 防护，可用
  `PG_ALLOW_PRIVATE_DRIVER_URL=1` 放开）。

导入的驱动统一存放在数据卷 `drivers/` 下，可在驱动库里删除。

---

## 6.6 扫描仪（SANE）启用与排障

镜像里已经装好 `sane`（后端与驱动库）+ `sane-utils`（`scanimage` / `sane-find-scanner`）+ `sane-network`，
**不需要再手工安装**；真正需要你做的是把设备「送进容器」：

| 设备类型 | 需要做的事 |
| --- | --- |
| USB 扫描仪 | 启动时把 USB 总线挂进容器：`--device /dev/bus/usb`（compose 里放开 `devices` 段注释） |
| 网络一体机（eSCL / AirScan） | 与容器同网段即可自动发现；跨网段或需广播发现时改用 `network_mode: host`；也可在 `/etc/sane.d/airscan.conf` 手写设备地址 |
| 老机型 / 特殊协议 | 容器内 `apk add sane-airscan`（网络扫描）；USB 机型需对应后端（epson2、canon、genesys…），Alpine 的 `sane` 已含常用后端 |

容器内自检：

```bash
docker exec printgate scanimage --version     # 组件版本（没有就是镜像没装上）
docker exec printgate sane-find-scanner       # USB 总线层面有没有看到设备（查挂载/权限）
docker exec printgate scanimage -L            # SANE 认到的设备（查驱动）
```

管理台「扫描仪」页会按三种情况给不同提示，不用猜：

1. **`未安装扫描组件（sane）`** —— 镜像构建时没装上（通常是没启用 community 仓库），按页面提示安装 `sane sane-utils`；
2. **`未发现扫描仪：USB 需要挂载…`** —— 组件正常但设备没进容器，按提示加 `--device /dev/bus/usb`；
3. **`USB 上能看到设备，但 SANE 没有匹配到驱动`** —— `sane-find-scanner` 有结果、`scanimage -L` 没有，属于驱动缺失，走上面的老机型一列。

扫描失败也会翻译成人话（设备忙 / 馈纸器没纸 / 权限不足 / 参数不支持 / 设备已断开），不再直接抛 SANE 原始报错。

---

## 6.5 单端口 443 部署（frp wss 复用，小程序可用）

微信小程序只接受 **https + 已备案域名 + 443**，所以即使只有一台 N1，也建议把 443 作为唯一公网入口。
链路：`小程序 → 云:443(nginx) → frps:7000 → frpc(N1) → PrintGate:8080 → 内网打印机`。
打印机的 631 / 9100 全程不暴露（容器出站访问）。

「中转对接」向导选「单端口 443」后，按提示填域名 / 服务端 / Token，页面会生成三段配置：

1. **frps.toml**（云服务器）
   ```toml
   bindPort = 7000
   auth.method = "token"
   auth.token = "换成随机长串"
   proxyBindAddr = "127.0.0.1"   # 隧道端口只给本机 nginx
   ```
   要点：**不要加 `transport.tls.force = true`** —— TLS 由 nginx 终结，frps 收明文即可，加了会把 nginx 转来的连接拒掉。
2. **nginx 片段**（云服务器）：`listen 443 ssl`，`location /~!frp` 做 Upgrade 转发到 `127.0.0.1:7000`，
   `location /` 反代到 `127.0.0.1:<remotePort>`，并设置 `client_max_body_size`（默认 1m 会把上传拦成 413）。
3. **frpc.toml**（自动写入数据卷 `frp/frpc.toml`）：`transport.protocol = "wss"` + `transport.tls.enable = true`，
   `serverAddr` 填域名、`serverPort = 443`，默认路径 `/~!frp` 与 nginx 片段一致。

配套两件事：

- 容器加 `TRUST_PROXY=true`，否则审计里记录的全是 nginx 的内网地址，防爆破也会把所有人当成同一个 IP；
- 云安全组只放行 443（7000 只在本机被 nginx 访问）。

向导第 5 步的自检会实际校验：本机服务、打印机就绪、frpc 语法（`frpc verify`）、客户端进程、服务端 7000 连通、
BASE 是否为 https 域名、以及从公网地址回连 `/api/health`。全绿再启用最稳。

> 实测记录：本机用 `nginx:alpine`（自签证书）+ `frps 0.65` + PrintGate 容器跑通了整条链路，
> 经 `https://<nginx>/api/health` 返回 `{"ok":true}`，并通过该隧道上传中文名 PDF 成功。

---

## 7. 安全设计

- **管理员密码**：scrypt(N=16384,r=8,p=1) + 16 字节随机盐；兼容旧版明文密码，首次登录后自动升级。
- **防爆破**：登录失败按 IP 计数入库，达阈值（默认 5 次）锁定（默认 15 分钟），返回剩余次数；
  绑定码、二维码轮询、扫码确认、API Key 各自独立限流；全局 `/api` 每分钟 900 次上限。
- **绑定码（v2.1.1）**：32 位 hex（128 bit 随机）、定时安全比较、**一码一人 + 默认 10 分钟 TTL**，
  绑定成功或到期即换新；全站 30 分钟内失败 50 次强制换码。评估与实测见
  [SECURITY-BIND-CODE](docs/SECURITY-BIND-CODE.md)。
- **转发头**：`TRUST_PROXY=true` 只在请求确实来自本机/内网反代时采信 `X-Forwarded-For`，
  公网直连场景自动忽略该头，避免伪造 IP 绕过锁定与限流。
- **角色隔离（v2.2.0）**：扫码登录按角色签发不同会话——管理员 `scope=admin`，普通用户 `scope=miniapp`。
  普通用户会话调 `/api/*` 管理接口一律 401/403；被拉黑后 `whoami` 与扫码立即 403，令牌不复活。
  密码登录与扫码登录不能同时关闭（服务端强制校验），避免把自己锁在门外。
- **会话**：JWT HS256，密钥首次启动随机生成并持久化，默认 24 小时；`Authorization: Bearer`。
- **二维码票据**：24 字节随机、120 秒过期、一次性使用（`used` 标记），确认者必须是已授权管理员。
- **最小暴露面**：CUPS 内置 Web 界面关闭（`WebInterface No`），管理级 IPP 操作仅限本机；
  631 只放行局域网打印，管理操作全部走 PrintGate。
- **审计**：登录、改密、打印、审批、打印机增删、设置变更、扫码、API Key 等全部留痕，可导出 CSV。
- **生成内容防注入**（第九轮加固，详见 [TEST-REPORT](docs/TEST-REPORT.md)）：
  - `frpc.toml`：`frpServer` / `frpToken` 先做格式与字符集白名单，写入前再按 TOML basic string 转义。
    否则一个带引号与换行的 Token 就能塞进额外的 `[[proxies]]`，等于把容器任意端口经 frps 转发到公网。
  - 审计 CSV：所有单元格先中和 `= + - @` 等公式前缀再转义引号。
    多处审计会原样记录文件名，管理员用 Excel/WPS 打开导出文件时会执行公式。
  - JWT 校验显式锁定 `algorithms: ['HS256']`，不依赖库的默认算法集合。
- **传输**：容器不内置 TLS，公网部署请在前置 Nginx/Caddy 上启用 HTTPS（小程序要求 https 域名）。
- **真实客户端 IP**：默认只认连接对端地址，`X-Forwarded-For` 一律忽略——否则伪造该头就能绕过登录锁定与限流。
  若部署在 Nginx/Caddy 等可信反代之后，给容器加 `TRUST_PROXY=true`，此时取 XFF 最后一跳作为客户端 IP
  （务必让反代覆盖或追加该头，不要把应用直接暴露在公网又开启此开关）。

> 说明：容器内 `cupsd` 需要 root 才能监听 631 并管理队列，PrintGate 与 CUPS 同容器运行，
> 因此进程以 root 启动；应用侧所有外部命令均通过 `execFile` 参数数组调用、不经 shell，
> 并对队列名、页码、参数做白名单校验。若需要严格非 root，可将 CUPS 拆为独立容器并把 631 指向它。

---

## 8. 从旧版迁移

把旧数据卷（含 `remote-print.db` 与 `uploads/`）挂到新容器 `/data` 后首次启动，服务会自动：

- 读取 `remote-print.db`（只读）：迁移管理员密码、微信 AppID/Secret、管理员 OpenID、绑定码、限额、审批开关；
- 迁移用户（openid / 角色 / 状态）与历史上传文件、打印任务（路径自动改写到 `/data`）；
- 写入标记 `legacyMigrated`，不会重复导入。

旧版 `cups-web.db` 里的 API Key 无法迁移（哈希不可逆），请在新后台「中转对接」重新生成。
打印机队列保存在 `/etc/cups`，把旧容器的 `/etc/cups` 挂载过来即可保留。

---

## 9. 已知限制

- **Office 文档**：默认镜像不含 LibreOffice（体积原因）。构建时加 `--build-arg WITH_OFFICE=1`
  即内置 writer/calc/impress（docx/xlsx/pptx → PDF，约 +90MB，中文渲染用镜像内的文泉驿字体）；
  未开启时上传会明确提示，设置页也提供「重新检测」与安装指引。
- **USB 扫描仪 / 网络扫描仪**：已内置 `sane` + `sane-utils`（scanimage）+ `sane-network`；
  USB 扫描仪仍需 `--device /dev/bus/usb` 挂载，网络一体机（eSCL/AirScan）建议加装 `sane-airscan`
  （镜像构建时会尝试安装，该 Alpine 版本没有时自动跳过，可在容器内手动 `apk add sane-airscan`）。
- **USB 打印机**：需要 `--device /dev/bus/usb`，并使用 `/etc/cups` 持久化 PPD。
- **AirPrint 广播**：桥接网络下 mDNS 跨网段不可达，建议 Linux 主机使用 `network_mode: host`。
- **扫码登录**：二维码内容为 `printgate://login?ticket=...`，小程序需自行解析（示例见「小程序对接 → 接口文档」）。
- **墨盒/纸盒**：依赖打印机自身通过 IPP 上报 `marker-levels` / `media-ready`；虚拟打印机与部分老机型不上报，
  页面会显示"未上报"而不是报错。
- **水印与文字速印**：依赖镜像内置的文泉驿正黑（已包含），支持中英文混排；水印固定为斜向浅色平铺，
  不支持自定义角度/颜色。

---

## 10. 目录结构

```
printgate/
├─ Dockerfile                 多阶段：web 构建 / 后端依赖 / Alpine 运行时
├─ docker-compose.yml
├─ docker/
│  ├─ entrypoint.sh           CUPS + Avahi + PrintGate + frp 守护
│  └─ cupsd.conf              A4/AirPrint 修复、最小暴露面
├─ server/                    Node.js 服务（Express + better-sqlite3）
│  ├─ src/
│  │  ├─ index.js  config.js  db.js  security.js  middleware.js
│  │  ├─ cups.js   discover.js  scan.js  system.js  pdf.js
│  │  ├─ wechat.js  migrate.js  converter.js  vprinter.js
│  │  └─ routes/   auth / mp / printers / print / users / settings / system / apikeys
│  └─ public/                 前端构建产物（vite 输出）
└─ web/                       Vue3 + NaiveUI + Vite
   └─ src/  views/  layouts/  api.js  router.js  store.js
```

---

## 11. 测试与验证

本地（Docker Desktop / linux-amd64）已完成多轮回归，全部通过：

- 端到端 **44/44**、破坏性自测 **97/97**、绕过与竞态 **29/29**、浏览器逐页 **25/25**、首次部署 **11/11**、交互级 **14/14**；
- 扫描与驱动 **35/35**（配 `mock-ipp.js` 假设备）、扫描抽屉 **14/14**、中转与自检 **23/23**、中转向导 **15/15**；
- 历史清理后端 **35/35**（范围隔离 / 幂等 / 并发 / CUPS 保留天数 / 自动清理审计）、清理弹窗 **12/12**；
- 深度猎杀 **59/59**（配置注入 / 令牌安全 / 打印参数 / 并发 / 输入模糊 / 权限 / CSV 注入）；
- 全站巡检 **14/14**（12 个页面逐个打开，零 console 报错、零 4xx、无横向溢出）；
- 覆盖鉴权越权、伪造令牌、参数注入、并发打印、票据一次性、防爆破锁定、服务重启、移动端布局；
- 另用旧数据卷验证了迁移（用户/任务/文件/小程序凭据全部保留）。

测试脚本与问题清单见 [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md)。脚本随包提供在 `tools/` 目录，
一条命令即可跑完整回归（脚本会自动适配目录布局，直接用交付包解压出来的目录也能跑）：

```bash
PG_BASE=http://127.0.0.1:8080 PG_PASS=<管理员密码> bash tools/run-all.sh api     # 14+ 套接口用例
PG_BASE=http://127.0.0.1:8080 PG_PASS=<管理员密码> bash tools/run-all.sh static  # 小程序静态检查
PG_BASE=http://127.0.0.1:8080 PG_PASS=<管理员密码> bash tools/run-all.sh ui      # 浏览器端到端
# UI 套件需要 puppeteer-core，未装在 server/node_modules 时用 NODE_PATH 指过去
```

打印链路（上传 → 提交 → CUPS 队列 → 落地出的纸）用 `tools/cups-e2e.js` 验证，
跑在装了 CUPS 的机器/容器上即可（无实体打印机时用「虚拟打印机」接收器落盘）：

```bash
PG_BASE=http://127.0.0.1:8080 PG_PASS=<密码> node tools/cups-e2e.js
# 从宿主机操作容器内的实例（用来读落盘文件内容）：
PG_BASE=http://127.0.0.1:18080 PG_PASS=<密码> PG_EXEC="docker exec <容器名>" node tools/cups-e2e.js
```

`tools/` 里的小程序检查脚本（`check-wxml` / `mp-page-test` / `mp-prefs-test` / `mp-wiring-check` / `mp-contract-check`）
需要包内有 `miniprogram/`；若交付包已裁剪掉小程序源码，它们会打印「跳过」并以 0 退出，不影响其余套件。

`tools/hunt12.js` 是上线前验收专用：自动扫描路由声明做**授权矩阵**（匿名令牌 / 普通用户令牌逐个打受保护接口），
并回归设备 URI、队列名、密钥回显、路径包含等校验点。

> 改了前端后重建镜像：`docker build --build-arg CACHEBUST=$(date +%s) -t printgate:alpine .`
> 换了镜像必须重建容器，否则容器仍挂在旧镜像上（界面上会看不到新功能）。

---

## 12. 常见问题

| 现象 | 排查 |
| --- | --- |
| 打印机列表为空、提示 CUPS 未就绪 | `docker logs printgate` 看 cupsd 是否起来；`/var/log/cups/error_log` 有具体原因 |
| 添加 IPP 队列失败 | 确认 URI 为 `ipp://IP:631/ipp/print`，容器能访问该 IP；驱动优先选 `everywhere` |
| 任务一直排队 | 打印机离线 / 队列被暂停 / 驱动不匹配；到「打印机」恢复队列并查看 `lpstat -p` |
| 打印出来是空白或乱码 | 需要对应型号的 PPD 或驱动；RAW 队列只适用于已支持该 PCL/PS 的打印机 |
| 小程序登录报 AppSecret 无效 | 后台「小程序对接 → 测试连通性」，确认 AppID 与 Secret 属于同一小程序 |
| 扫码登录提示不是管理员 | 先用小程序扫「绑定管理员微信」的二维码完成绑定 |
| 忘记后台密码 | 停容器 → 删除数据卷里的 `printgate.db`（会丢配置与任务记录）→ 重新初始化 |
