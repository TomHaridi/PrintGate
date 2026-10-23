#!/usr/bin/env bash
# 把本地 arm64 镜像推到镜像仓库（默认 Docker Hub）
#
# 用法：
#   bash tools/push-image.sh                     # 用默认 REPO/TAG
#   REPO=yourname/printgate TAG=2.0.0 bash tools/push-image.sh
#   SRC=printgate:arm64 PLATFORM=linux/arm64 bash tools/push-image.sh
#
# 前置：docker login（或用 docker login -u <user> --password-stdin < token.txt）
set -euo pipefail

REPO="${REPO:-}"
TAG="${TAG:-2.0.0}"
SRC="${SRC:-printgate:arm64}"
PLATFORM="${PLATFORM:-linux/arm64}"

# 1. 推断仓库名。注意：Docker 29 起 `docker info --format {{.Username}}` 已不再输出，
#    所以优先用显式 REPO / DOCKER_USER，其次只判断「是否登录过 Docker Hub」。
if [ -z "$REPO" ]; then
  if [ -n "${DOCKER_USER:-}" ]; then
    REPO="$DOCKER_USER/printgate"
  elif grep -q 'index.docker.io' "$HOME/.docker/config.json" 2>/dev/null; then
    echo "✗ 已登录 Docker Hub，但无法自动取用户名；请显式指定仓库："
    echo "  REPO=<用户名>/printgate bash $0"
    exit 1
  else
    echo "✗ 未登录 Docker Hub，请先执行：docker login（需用 Access Token）"
    exit 1
  fi
fi

# 2. 检查源镜像与架构
if ! docker image inspect "$SRC" >/dev/null 2>&1; then
  echo "✗ 本地没有镜像 $SRC"
  echo "  先构建：docker buildx build --platform $PLATFORM --provenance=false -t $SRC --load ."
  exit 1
fi
ARCH="$(docker image inspect "$SRC" --format '{{.Os}}/{{.Architecture}}')"
echo "源镜像 : $SRC ($ARCH)"
echo "目标   : $REPO:$TAG  和  $REPO:latest"

# 3. 打标签并推送
docker tag "$SRC" "$REPO:$TAG"
docker tag "$SRC" "$REPO:latest"
docker push "$REPO:$TAG"
docker push "$REPO:latest"

# 4. 回读远端清单做验证
echo
echo "=== 远端清单 ==="
docker buildx imagetools inspect "$REPO:$TAG" 2>/dev/null | head -20 || docker manifest inspect "$REPO:$TAG" >/dev/null

echo
echo "✓ 完成：docker pull $REPO:$TAG"
