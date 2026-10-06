#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/healthz}"
WSS_URL="${WSS_URL:-}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-30}"
ENV_FILE="$PROJECT_ROOT/.env"
SECRET_FILE="$PROJECT_ROOT/secrets/turn_secret"

cd "$PROJECT_ROOT"

setup_error() {
  printf '错误：%s\n请参阅 docs/DEPLOYMENT.md 第 3 节手动配置。\n' "$1" >&2
  exit 1
}

resolve_value() {
  local variable="$1"
  local prompt="$2"
  local value="${!variable:-}"

  if [[ -z "$value" && -t 0 ]]; then
    read -r -p "$prompt" value || value=""
  fi
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    setup_error "$variable 必须是非空单行值。"
  fi
  printf -v "$variable" '%s' "$value"
}

secure_existing_secret_paths() {
  local require_secret="${1:-0}"
  local secrets_dir="$PROJECT_ROOT/secrets"
  local secret_links

  if [[ -L "$secrets_dir" ]]; then
    setup_error 'secrets 目录是符号链接；为避免修改外部路径，已停止。'
  fi
  if [[ ! -e "$secrets_dir" ]]; then
    [[ "$require_secret" == 0 ]] || setup_error 'secrets 目录不存在；请按 docs/DEPLOYMENT.md 第 3 节手动准备 secrets/turn_secret。'
    return 0
  fi
  [[ -d "$secrets_dir" ]] || setup_error 'secrets 路径不是目录，无法安全设置权限。'

  if [[ -L "$SECRET_FILE" ]]; then
    setup_error 'secrets/turn_secret 是符号链接；为避免修改外部路径，已停止。'
  fi
  if [[ -e "$SECRET_FILE" ]]; then
    [[ -f "$SECRET_FILE" ]] || setup_error 'secrets/turn_secret 不是普通文件，无法安全设置权限。'
    secret_links="$(stat -c '%h' -- "$SECRET_FILE")" || setup_error '无法检查 secrets/turn_secret 的硬链接状态。'
    [[ "$secret_links" == 1 ]] || setup_error 'secrets/turn_secret 有多个硬链接；为避免修改外部路径，已停止。'
    [[ -s "$SECRET_FILE" ]] || setup_error 'secrets/turn_secret 为空；请按 docs/DEPLOYMENT.md 第 3 节手动准备非空 Secret。'
  elif [[ "$require_secret" == 1 ]]; then
    setup_error 'secrets/turn_secret 不存在；现有 .env 不会自动生成或替换 Secret，请按 docs/DEPLOYMENT.md 第 3 节手动准备。'
  fi

  chmod 700 "$secrets_dir" || setup_error '无法设置 secrets 目录权限。'
  if [[ -e "$SECRET_FILE" ]]; then
    chmod 600 "$SECRET_FILE" || setup_error '无法设置 secrets/turn_secret 权限。'
  fi
}

# Read a Compose .env assignment as plain data; never source or evaluate it.
read_dotenv_value() {
  local key="$1"
  DOTENV_VALUE="$(awk -v key="$key" '
    {
      line = $0
      sub(/\\r$/, "", line)
      if (line ~ /^[[:space:]]*#/ || line ~ /^[[:space:]]*$/) next
      equals = index(line, "=")
      if (!equals) next
      name = substr(line, 1, equals - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != key) next
      value = substr(line, equals + 1)
      sub(/[[:space:]]+#.*$/, "", value)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      if (length(value) >= 2 && ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") || (substr(value, 1, 1) == "\047" && substr(value, length(value), 1) == "\047"))) {
        value = substr(value, 2, length(value) - 2)
      }
      found = 1
    }
    END { if (found) print value }
  ' "$ENV_FILE")"
}

validate_existing_env() {
  local key
  for key in TURN_SECRET_FILE TURN_EXTERNAL_IP TURN_REALM TURN_URLS ALLOWED_ORIGINS; do
    read_dotenv_value "$key"
    if [[ -z "${DOTENV_VALUE//[[:space:]]/}" ]]; then
      setup_error ".env 中的 $key 必须是非空值；服务尚未更改。"
    fi
    if [[ "$DOTENV_VALUE" == *'$'* ]]; then
      setup_error ".env 中的 $key 不得包含美元符号，以避免 Docker Compose 变量插值；服务尚未更改。"
    fi
  done

  read_dotenv_value TURN_SECRET_FILE
  [[ "$DOTENV_VALUE" == './secrets/turn_secret' ]] || setup_error '.env 中 TURN_SECRET_FILE 必须为 ./secrets/turn_secret。'
  read_dotenv_value TURN_URLS
  [[ "$DOTENV_VALUE" != *turn.example.com* ]] || setup_error '.env 中 TURN_URLS 仍包含 .env.example 示例主机名。'

  read_dotenv_value TURN_EXTERNAL_IP
  [[ "$DOTENV_VALUE" != '203.0.113.10' ]] || setup_error '.env 仍包含 .env.example 示例值，请替换为真实配置。'
  read_dotenv_value TURN_REALM
  [[ "$DOTENV_VALUE" != 'turn.example.com' ]] || setup_error '.env 仍包含 .env.example 示例值，请替换为真实配置。'
  read_dotenv_value ALLOWED_ORIGINS
  [[ "$DOTENV_VALUE" != 'https://mirror.example.com' ]] || setup_error '.env 仍包含 .env.example 示例值，请替换为真实配置。'
}

bootstrap_env() {
  if [[ -e "$ENV_FILE" ]]; then
    secure_existing_secret_paths 1
    return 0
  fi

  resolve_value TURN_EXTERNAL_IP '请输入 TURN 主机公网 IP：'
  resolve_value TURN_REALM '请输入 TURN Realm：'
  resolve_value ALLOWED_ORIGINS '请输入允许的前端 Origin：'
  if [[ -z "${TURN_URLS+x}" ]]; then
    TURN_URLS="turn:${TURN_REALM}:3478?transport=udp,turn:${TURN_REALM}:3478?transport=tcp"
  fi
  TURN_CREDENTIAL_TTL_SECONDS="${TURN_CREDENTIAL_TTL_SECONDS:-3600}"
  TRUST_PROXY="${TRUST_PROXY:-false}"
  for variable in TURN_URLS TURN_CREDENTIAL_TTL_SECONDS TRUST_PROXY; do
    value="${!variable}"
    if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
      setup_error "$variable 必须是单行值。"
    fi
  done

  umask 077
  secure_existing_secret_paths
  mkdir -p "$PROJECT_ROOT/secrets"
  secure_existing_secret_paths
  if [[ -e "$SECRET_FILE" ]]; then
    [[ -s "$SECRET_FILE" ]] || setup_error 'secrets/turn_secret 已存在但为空，未作修改。'
  else
    if ! (set -o noclobber; openssl rand -hex 32 > "$SECRET_FILE") 2>/dev/null; then
      setup_error '无法创建 secrets/turn_secret。'
    fi
    if [[ ! -s "$SECRET_FILE" ]]; then
      rm -f "$SECRET_FILE"
      setup_error 'OpenSSL 未生成有效的 TURN Secret。'
    fi
    chmod 600 "$SECRET_FILE"
  fi

  local temp_env
  temp_env="$(mktemp "$PROJECT_ROOT/.env.tmp.XXXXXX")" || setup_error '无法创建临时环境文件。'
  chmod 600 "$temp_env"
  cat > "$temp_env" <<EOF
TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=$TURN_EXTERNAL_IP
TURN_REALM=$TURN_REALM
TURN_URLS=$TURN_URLS
TURN_CREDENTIAL_TTL_SECONDS=$TURN_CREDENTIAL_TTL_SECONDS
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
TRUST_PROXY=$TRUST_PROXY
EOF
  if ! ln "$temp_env" "$ENV_FILE" 2>/dev/null; then
    rm -f "$temp_env"
    if [[ -e "$ENV_FILE" ]]; then
      return 0
    fi
    setup_error '无法安全安装 .env。'
  fi
  rm -f "$temp_env"
}

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' '错误：未找到 docker，请先安装 Docker。' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf '%s\n' '错误：Docker 引擎未运行，无法部署。' >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' '错误：未找到 Docker Compose 插件。' >&2
  exit 1
fi

bootstrap_env
validate_existing_env
unset TURN_SECRET_FILE TURN_EXTERNAL_IP TURN_REALM TURN_URLS TURN_CREDENTIAL_TTL_SECONDS ALLOWED_ORIGINS TRUST_PROXY

if grep -Eq '^[[:space:]]*TURN_EXTERNAL_IP[[:space:]]*=[[:space:]]*"?203\.0\.113\.10"?[[:space:]]*(#.*)?$' "$ENV_FILE" \
  || grep -Eq '^[[:space:]]*TURN_REALM[[:space:]]*=[[:space:]]*"?turn\.example\.com"?[[:space:]]*(#.*)?$' "$ENV_FILE" \
  || grep -Eq '^[[:space:]]*ALLOWED_ORIGINS[[:space:]]*=[[:space:]]*"?https://mirror\.example\.com"?[[:space:]]*(#.*)?$' "$ENV_FILE"; then
  setup_error '.env 仍包含 .env.example 示例值，请替换为真实配置。'
fi

if ! docker compose config --quiet; then
  setup_error 'Docker Compose 配置检查失败；服务尚未更改。'
fi

if [[ -z "$WSS_URL" && -t 0 ]]; then
  read -r -p '请输入公网 WSS 地址（留空跳过，例如 wss://signaling-server.unia.love/connect）: ' WSS_URL || WSS_URL=""
fi

printf '%s\n' '[1/4] 构建并启动 Nakiri Screen Mirror 信令服务...'
docker compose up -d --build --remove-orphans

printf '%s\n' "[2/4] 等待健康检查：$HEALTH_URL"
for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if command -v curl >/dev/null 2>&1 && curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; then
    break
  fi
  if (( attempt == MAX_ATTEMPTS )); then
    printf '%s\n' '错误：健康检查超时，最近日志如下：' >&2
    docker compose logs --tail=100 nakiri-signalling >&2
    exit 1
  fi
  sleep 2
done

if [[ -n "$WSS_URL" ]]; then
  printf '%s\n' "[3/4] 检查真实的 WebSocket 信令链路：$WSS_URL"
  docker compose exec -T nakiri-signalling node dist/probe.js "$WSS_URL"
else
  printf '%s\n' '[3/4] 未设置 WSS_URL，跳过外部 WebSocket 最终检查。' >&2
fi

printf '%s\n' '[4/4] 部署成功，当前容器状态：'
docker compose ps
