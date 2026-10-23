# PrintGate —— Alpine 精简镜像（多阶段构建）
# 构建：docker build -t printgate:alpine .
# 运行：docker run -d -p 8080:8080 -p 631:631 -v printgate-data:/data --name printgate printgate:alpine
ARG NODE_TAG=22-alpine

# ---------- 1. 前端构建（Vue3 + NaiveUI） ----------
FROM node:${NODE_TAG} AS web
WORKDIR /build
# 改动前端后如需强制重编，传 --build-arg CACHEBUST=$(date +%s)
ARG CACHEBUST=0
COPY web/package.json web/package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com \
 && npm install --no-audit --no-fund
COPY web/ ./
RUN echo "cachebust=$CACHEBUST" && npm run build

# ---------- 2. 后端依赖（better-sqlite3 需要编译工具链） ----------
FROM node:${NODE_TAG} AS deps
WORKDIR /build
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache --no-progress python3 make g++
COPY server/package.json server/package-lock.json* ./
# musl 平台没有 better-sqlite3 预编译包，用基础镜像自带的 Node 头文件本地编译，
# 避免 node-gyp 去 unofficial-builds 下载（国内常常超时）
RUN npm config set registry https://registry.npmmirror.com \
 && npm_config_nodedir=/usr/local npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---------- 3. 运行镜像 ----------
FROM node:${NODE_TAG} AS runtime

# WITH_OFFICE=1 时内置 LibreOffice（writer/calc/impress），docx/xlsx/pptx 可直接上传转 PDF。
# 默认关闭：完整套件会显著增大镜像，只装三个排版组件 + common 已经小很多。
# 阶段内必须重新声明（全局 ARG 只对 FROM 行生效）
ARG WITH_OFFICE=0

LABEL org.opencontainers.image.title="PrintGate" \
      org.opencontainers.image.description="CUPS 打印网关 + 微信小程序中转 + Vue3 管理台" \
      org.opencontainers.image.version="2.4.9"

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=8080 \
    PG_DATA_DIR=/data \
    PG_LOG_DIR=/var/log/printgate

# cups: 打印服务；cups-filters/ghostscript: 格式转换与 PDF 过滤；
# avahi/dbus: mDNS 发现(AirPrint)；poppler-utils: PDF 页数/预览；frp: 内网穿透
# font-wqy-zenhei: 中文列印（文字速印、水印）；qpdf: 水印叠加（--overlay 支持重复到每一页）
# 扫描：sane(后端与驱动库) + sane-utils(scanimage/sane-find-scanner) + sane-network(网络扫描仪)
#       —— 这两个包在 community 仓库，基础镜像默认只有 main，必须先启用 community 再装，
#          否则 apk 找不到包，镜像里就没有 scanimage，扫描页会一直提示「未安装 sane」
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && cp /etc/apk/repositories /tmp/repos.main \
 && sed 's|/main$|/community|' /tmp/repos.main >> /etc/apk/repositories \
 && rm -f /tmp/repos.main \
 && apk update --no-progress \
 && apk upgrade --no-progress \
 && apk add --no-cache --no-progress \
      cups cups-client cups-filters ghostscript \
      avahi avahi-tools dbus \
      sane sane-utils \
      poppler-utils \
      font-wqy-zenhei qpdf \
      tini bash curl tzdata \
 && rm -rf /var/cache/apk/* /tmp/* /var/tmp/* \
 && mkdir -p /var/log/printgate /var/log/cups /run/cups /data /app \
 && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# frp（内网穿透客户端）：默认安装，但不用 Alpine 仓库里那版 0.65.0。
# 0.65.0 内嵌的 golang.org/x/crypto 0.37 / x/net 0.39 带一批 high/critical CVE，
# 这里直接装官方最新 release（0.71.1 已升级这些模块）。
# 完全不需要穿透的场景可以用 --build-arg WITH_FRP=0 构建更小的镜像。
ARG WITH_FRP=1
ARG FRP_VERSION=0.71.1

# unzip 包长期带 CVE-2008-0888（Alpine 6.0-r16 至今未修复），不再安装；
# 改用 busybox 自带的 unzip applet —— 驱动页从 .zip 里解 PPD 的功能不受影响。
RUN ln -sf /bin/busybox /usr/local/bin/unzip && unzip -v 2>&1 | head -1

# 可选后端：网络扫描仪需要 sane-airscan（AirScan / eSCL / WSD），共享扫描需要 sane-network。
# 这两个包并非每个 Alpine 版本都有，装不上时跳过，不影响 USB 扫描仪
RUN apk add --no-cache --no-progress sane-airscan \
    || echo "sane-airscan 不可用（该 Alpine 版本未提供），网络一体机需另想办法" ; \
    apk add --no-cache --no-progress sane-network \
    || echo "sane-network 不可用（该 Alpine 版本未提供），跳过 net: 后端"

# 安装官方 frpc 二进制（Alpine 仓库的 0.65.0 内嵌旧版 x/crypto、x/net，带高危 CVE）
ARG TARGETARCH
RUN if [ "$WITH_FRP" = "1" ]; then \
      set -eux; \
      apk add --no-cache --no-progress --virtual .frp-dl curl tar; \
      curl -fsSL --retry 3 -o /tmp/frp.tgz \
        "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${TARGETARCH}.tar.gz"; \
      tar -xzf /tmp/frp.tgz -C /tmp; \
      install -m 0755 "/tmp/frp_${FRP_VERSION}_linux_${TARGETARCH}/frpc" /usr/local/bin/frpc; \
      rm -rf /tmp/frp.tgz "/tmp/frp_${FRP_VERSION}_linux_${TARGETARCH}"; \
      apk del .frp-dl; \
      frpc -v; \
    else \
      echo "未安装 frp（WITH_FRP=0）：需要穿透时改用 --build-arg WITH_FRP=1"; \
    fi

# 扫描组件是可选能力但必须可自检：缺 scanimage 时直接让构建失败，避免上线后才发现
RUN command -v scanimage >/dev/null 2>&1 \
 && scanimage --version 2>/dev/null | head -1 \
 || (echo "构建失败：未找到 scanimage，请确认 sane-utils 已安装（需要 community 仓库）" && exit 1)

# Office 转换（可选）：只装 writer/calc/impress（docx/xlsx/pptx → PDF），不装 base/draw/math，
# 中文渲染依赖镜像内已有的文泉驿字体。构建：docker build --build-arg WITH_OFFICE=1 .
RUN if [ "$WITH_OFFICE" = "1" ]; then \
      apk add --no-cache --no-progress libreoffice-common libreoffice-writer libreoffice-calc libreoffice-impress \
      && libreoffice --version 2>/dev/null | head -1 ; \
    else \
      echo "未启用 Office 转换（WITH_OFFICE=0）：docx/xlsx/pptx 上传会提示先转 PDF"; \
    fi

# 文泉驿只有 TTC 集合，pdfkit 不能直接读；构建期用 fontforge 拆成单个 TTF，之后卸掉 fontforge。
# 这样运行镜像里只有一份 11MB 的 TTF，不额外背 40MB 的转换工具。
RUN apk add --no-cache --no-progress fontforge \
 && mkdir -p /usr/share/fonts/printgate \
 && fontforge -lang=ff -c 'Open("/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc(WenQuanYi Zen Hei)"); Generate("/usr/share/fonts/printgate/wqy-zenhei.ttf")' >/dev/null 2>&1 \
 && apk del fontforge \
 && rm -rf /var/cache/apk/* \
 && ls -l /usr/share/fonts/printgate/

# 保存一份 CUPS 基线配置：/etc/cups 常被 bind-mount 覆盖，入口脚本用它补齐缺失文件
RUN cp -a /etc/cups /etc/cups-baseline
COPY docker/cupsd.conf /etc/cups/cupsd.conf
COPY docker/cupsd.conf /etc/cups-baseline/cupsd.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 运行时用不到 npm / npx / corepack：删掉可减少约 18MB 并消除 npm 依赖树里的 CVE
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && rm -rf /usr/share/man /usr/share/doc /tmp/* /var/tmp/*

WORKDIR /app
COPY --from=deps /build/node_modules ./node_modules
COPY server/ ./
COPY --from=web /server/public ./public

# 8080 管理台/API；631 IPP+AIRPRINT；9100 虚拟打印机接收器（可选）
EXPOSE 8080 631 9100

VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
