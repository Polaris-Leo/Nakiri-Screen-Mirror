#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/healthz}"
WSS_URL="${WSS_URL:-}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-30}"

cd "$PROJECT_ROOT"

if ! command -v docker >/dev/null 2>&1; then
	printf '%s\n' "错误：未找到 docker，请先安装 Docker。" >&2
	exit 1
fi

if ! docker info >/dev/null 2>&1; then
	printf '%s\n' "错误：Docker 引擎未运行，无法部署。" >&2
	exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
	printf '%s\n' "错误：未找到 Docker Compose 插件。" >&2
	exit 1
fi

if [[ -z "$WSS_URL" && -t 0 ]]; then
	read -r -p "请输入公网 WSS 地址（留空跳过，例如 wss://signaling-server.unia.love/connect）: " WSS_URL || WSS_URL=""
fi

printf '%s\n' "[1/4] 构建并启动 Nakiri Screen Mirror 信令服务..."
docker compose up -d --build --remove-orphans

printf '%s\n' "[2/4] 等待健康检查：$HEALTH_URL"
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
	if command -v curl >/dev/null 2>&1 && curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; then
		break
	fi
	if (( attempt == MAX_ATTEMPTS )); then
		printf '%s\n' "错误：健康检查超时，最近日志如下：" >&2
		docker compose logs --tail=100 nakiri-signalling >&2
		exit 1
	fi
	sleep 2
done

if [[ -n "$WSS_URL" ]]; then
	printf '%s\n' "[3/4] 检查真实的 WebSocket 信令链路：$WSS_URL"
	docker compose exec -T nakiri-signalling node dist/probe.js "$WSS_URL"
else
	printf '%s\n' "[3/4] 未设置 WSS_URL，跳过外部 WebSocket 最终检查。" >&2
fi

printf '%s\n' "[4/4] 部署成功，当前容器状态："
docker compose ps
