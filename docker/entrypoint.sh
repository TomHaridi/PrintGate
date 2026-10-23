#!/bin/bash
# PrintGate 容器入口：CUPS + Avahi + PrintGate 服务 + frp 守护
set -u

TZ="${TZ:-Asia/Shanghai}"
export TZ

log() { echo "[entrypoint] $*"; }

# ---------- 1. 基础环境 ----------
ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime 2>/dev/null || true
mkdir -p /data/files /data/scans /data/frp /data/spool /var/log/printgate /var/log/cups /run/cups /run/dbus /var/spool/cups
chmod 755 /run/cups 2>/dev/null || true
rm -f /run/cups/cupsd.pid 2>/dev/null || true

# 日志限长，避免长期运行把磁盘写满
for f in /var/log/printgate/app.log /var/log/printgate/frpc.log; do
  if [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    tail -c 1048576 "$f" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
  fi
done

# 若 /etc/cups 被空目录 bind-mount 覆盖，先用镜像内的基线配置补齐
if [ -d /etc/cups-baseline ]; then
  for f in cups-files.conf cupsd.conf mime.convs mime.types snmp.conf client.conf printers.conf; do
    if [ ! -f "/etc/cups/$f" ] && [ -f "/etc/cups-baseline/$f" ]; then
      cp "/etc/cups-baseline/$f" "/etc/cups/$f" 2>/dev/null || true
      log "补齐缺失的 CUPS 配置：$f"
    fi
  done
fi
mkdir -p /etc/cups/ppd /etc/cups/ssl /etc/cups/interfaces
chmod 700 /etc/cups/ssl 2>/dev/null || true

# 让容器内的 root（PrintGate 以 root 通过 unix socket 调用 lpadmin）具备 CUPS 管理权限
if [ -f /etc/cups/cups-files.conf ]; then
  if grep -q '^SystemGroup' /etc/cups/cups-files.conf; then
    sed -i 's/^SystemGroup.*/SystemGroup sys root lpadmin wheel/' /etc/cups/cups-files.conf
  else
    echo 'SystemGroup sys root lpadmin wheel' >> /etc/cups/cups-files.conf
  fi
fi

# CUPS / 系统日志目录权限（cupsd 以 root 启动后降权读取）
chown -R root:lp /var/log/cups 2>/dev/null || true
chmod 755 /var/log/cups 2>/dev/null || true

# ---------- 2. dbus + avahi（AirPrint 广播 / mDNS 发现） ----------
if command -v dbus-daemon >/dev/null 2>&1; then
  if ! dbus-daemon --system --fork 2>/dev/null; then
    log "WARN: dbus 启动失败，AirPrint 广播与网络打印机发现将不可用"
  elif ! avahi-daemon --daemonize --no-chroot 2>/dev/null; then
    log "WARN: avahi 启动失败（可能是容器缺少 D-Bus 或权限）"
  else
    log "avahi/dbus 已启动（AirPrint 广播就绪）"
  fi
fi

# ---------- 2b. 扫描组件（sane）自检 ----------
# 扫描是可选能力，缺组件只提示不阻断；真正的原因（没装 / 没挂 USB / 没驱动）由接口分级给出
if command -v scanimage >/dev/null 2>&1; then
  log "扫描组件就绪：$(scanimage --version 2>/dev/null | head -1)"
  if [ -d /dev/bus/usb ]; then
    log "USB 总线已挂载（/dev/bus/usb），USB 扫描仪可被识别"
  else
    log "WARN: 未挂载 /dev/bus/usb，USB 扫描仪不可见（用 --device /dev/bus/usb 挂载）"
  fi
  if [ -f /etc/sane.d/airscan.conf ]; then
    log "检测到 airscan 配置，网络扫描仪（eSCL）可用"
  fi
else
  log "WARN: 未找到 scanimage，扫描功能不可用（镜像需安装 sane-utils，见 Dockerfile/compose 注释）"
fi

# Office 转换组件状态（可选能力，缺失只提示）
if command -v libreoffice >/dev/null 2>&1 || command -v soffice >/dev/null 2>&1; then
  log "Office 转换已启用：$( (libreoffice --version 2>/dev/null || soffice --version 2>/dev/null) | head -1)"
else
  log "Office 转换未启用：docx/xlsx/pptx 上传会提示先转 PDF（构建时加 --build-arg WITH_OFFICE=1 可开启）"
fi

# ---------- 3. CUPS 守护 ----------
(
  fast_fails=0
  while true; do
    start_ts=$SECONDS
    /usr/sbin/cupsd -f >/dev/null 2>&1
    rc=$?
    uptime=$((SECONDS - start_ts))
    if [ "$uptime" -lt 5 ]; then fast_fails=$((fast_fails + 1)); else fast_fails=0; fi
    if [ "$fast_fails" -ge 5 ]; then
      log "ERROR: cupsd 连续 ${fast_fails} 次启动即退出，请检查 /var/log/cups/error_log"
      break
    fi
    log "cupsd 退出（rc=$rc，存活 ${uptime}s），2 秒后重启"
    sleep 2
  done
) &
CUPS_WATCH_PID=$!

# 等待 cupsd 就绪（最长 25 秒）
for _ in $(seq 1 25); do
  if lpstat -r 2>/dev/null | grep -qi running; then log "CUPS 已就绪"; break; fi
  sleep 1
done

# 存量队列统一使用 Ghostscript 渲染 PDF，规避 Poppler 卡单问题
(
  for p in $(lpstat -e 2>/dev/null); do
    cur=$(lpoptions -p "$p" -l 2>/dev/null | grep '^pdftops-renderer' | head -1)
    if ! echo "$cur" | grep -q 'gs'; then
      lpoptions -p "$p" -o pdftops-renderer=gs >/dev/null 2>&1 || true
    fi
  done
) &

# ---------- 4. frp 客户端守护 ----------
(
  while true; do
    enabled=0
    [ -f /data/frp/enabled ] && enabled=$(cat /data/frp/enabled 2>/dev/null || echo 0)
    if [ "$enabled" = "1" ] && [ -f /data/frp/frpc.toml ] && command -v frpc >/dev/null 2>&1; then
      if ! pgrep -x frpc >/dev/null 2>&1; then
        log "启动 frpc"
        frpc -c /data/frp/frpc.toml >> /var/log/printgate/frpc.log 2>&1 &
      fi
    elif pgrep -x frpc >/dev/null 2>&1; then
      pkill -x frpc 2>/dev/null || true
      log "frp 已关闭"
    fi
    sleep 5
  done
) &
FRP_WATCH_PID=$!

# ---------- 4b. 运行期日志轮转（保留最后 2 MB，避免长期运行写满磁盘） ----------
(
  while true; do
    sleep 1800
    for f in /var/log/printgate/app.log /var/log/printgate/frpc.log; do
      [ -f "$f" ] || continue
      size=$(stat -c%s "$f" 2>/dev/null || echo 0)
      if [ "$size" -gt 5242880 ]; then
        if tail -c 2097152 "$f" > "$f.tmp" 2>/dev/null; then
          mv "$f.tmp" "$f"
          echo "[entrypoint] 已轮转日志 $f（原 ${size} 字节）"
        fi
      fi
    done
  done
) &
LOG_WATCH_PID=$!

# ---------- 5. PrintGate 服务 ----------
log "启动 PrintGate 服务（:${PORT:-8080}）"
cd /app || exit 1
node src/index.js >> /var/log/printgate/app.log 2>&1 &
APP_PID=$!
# 同步输出到容器日志，方便 docker logs 查看
tail -F -n 0 /var/log/printgate/app.log 2>/dev/null &
TAIL_PID=$!

cleanup() {
  log "收到退出信号，停止子进程"
  kill "$APP_PID" "$TAIL_PID" 2>/dev/null || true
  pkill -x frpc 2>/dev/null || true
  /usr/sbin/cupsd -t >/dev/null 2>&1 || true
  kill "$CUPS_WATCH_PID" "$FRP_WATCH_PID" "$LOG_WATCH_PID" 2>/dev/null || true
  pkill -x cupsd 2>/dev/null || true
  sleep 1
  exit 0
}
trap cleanup TERM INT

wait "$APP_PID"
log "PrintGate 服务已退出，容器结束"
cleanup
