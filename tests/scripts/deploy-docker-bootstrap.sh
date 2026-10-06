#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

make_fixture() {
  local root="$1"
  mkdir -p "$root/bin" "$root/scripts"
  cp "$repo_root/scripts/deploy-docker.sh" "$root/scripts/deploy-docker.sh"
  cat > "$root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$DOCKER_CALL_LOG"
case "$*" in
  "info"|"compose version"|"compose config --quiet"|"compose up -d --build --remove-orphans"|"compose ps") exit 0 ;;
  *) exit 99 ;;
esac
EOF
  cat > "$root/bin/openssl" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "rand -hex 32" ]] || exit 99
printf '%s\n' 'test-secret-not-production'
EOF
  cat > "$root/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$root/bin/docker" "$root/bin/openssl" "$root/bin/curl"
}

assert_contains() {
  grep -Fxq "$2" "$1" || { printf 'FAIL: expected line missing in %s\n' "$1" >&2; exit 1; }
}

assert_no_up() {
  if grep -Fxq 'compose up -d --build --remove-orphans' "$1"; then
    printf 'FAIL: Compose up was invoked unexpectedly\n' >&2
    exit 1
  fi
}

success="$fixture/success"
make_fixture "$success"
mkdir -p "$success/secrets"
chmod 755 "$success/secrets"
if ! output="$(
  cd "$success"
  PATH="$success/bin:$PATH" DOCKER_CALL_LOG="$success/docker.log" \
    TURN_EXTERNAL_IP=198.51.100.25 TURN_REALM=turn.example.net \
    ALLOWED_ORIGINS=https://mirror.example.net WSS_URL= \
    bash scripts/deploy-docker.sh 2>&1
)"; then
  printf 'FAIL: first-run deployment should pass with supplied values\n%s\n' "$output" >&2
  exit 1
fi
assert_contains "$success/.env" 'TURN_SECRET_FILE=./secrets/turn_secret'
assert_contains "$success/.env" 'TURN_EXTERNAL_IP=198.51.100.25'
assert_contains "$success/.env" 'TURN_REALM=turn.example.net'
assert_contains "$success/.env" 'TURN_URLS=turn:turn.example.net:3478?transport=udp,turn:turn.example.net:3478?transport=tcp'
assert_contains "$success/.env" 'ALLOWED_ORIGINS=https://mirror.example.net'
assert_contains "$success/.env" 'TURN_CREDENTIAL_TTL_SECONDS=3600'
assert_contains "$success/.env" 'TRUST_PROXY=false'
[[ "$(<"$success/secrets/turn_secret")" == 'test-secret-not-production' ]] || { printf 'FAIL: secret file content mismatch\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$success/secrets/turn_secret")" == 600 ]] || { printf 'FAIL: secret file mode is not 600\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$success/secrets")" == 700 ]] || { printf 'FAIL: secrets directory mode is not 700\n' >&2; exit 1; }
if [[ "$output" == *'test-secret-not-production'* ]]; then
  printf 'FAIL: secret appeared in captured output\n' >&2
  exit 1
fi
config_line="$(grep -nFx 'compose config --quiet' "$success/docker.log" | cut -d: -f1)"
up_line="$(grep -nFx 'compose up -d --build --remove-orphans' "$success/docker.log" | cut -d: -f1)"
[[ -n "$config_line" && -n "$up_line" && "$config_line" -lt "$up_line" ]] || { printf 'FAIL: Compose config must precede up\n' >&2; exit 1; }
cp "$success/.env" "$success/.env.expected"
cp "$success/secrets/turn_secret" "$success/secret.expected"
if ! (
  cd "$success"
  PATH="$success/bin:$PATH" DOCKER_CALL_LOG="$success/docker.log" \
    TURN_EXTERNAL_IP=198.51.100.25 TURN_REALM=turn.example.net \
    ALLOWED_ORIGINS=https://mirror.example.net WSS_URL= \
    bash scripts/deploy-docker.sh >/dev/null 2>&1
); then
  printf 'FAIL: second deployment should pass\n' >&2
  exit 1
fi
cmp -s "$success/.env.expected" "$success/.env" || { printf 'FAIL: second run changed .env\n' >&2; exit 1; }
cmp -s "$success/secret.expected" "$success/secrets/turn_secret" || { printf 'FAIL: second run changed secret\n' >&2; exit 1; }

missing="$fixture/missing"
make_fixture "$missing"
if (cd "$missing" && PATH="$missing/bin:$PATH" DOCKER_CALL_LOG="$missing/docker.log" WSS_URL= bash scripts/deploy-docker.sh </dev/null >/dev/null 2>&1); then
  printf 'FAIL: missing non-interactive values should be rejected\n' >&2
  exit 1
fi
[[ ! -e "$missing/.env" && ! -e "$missing/secrets/turn_secret" ]] || { printf 'FAIL: missing values created configuration\n' >&2; exit 1; }
assert_no_up "$missing/docker.log"

placeholders="$fixture/placeholders"
make_fixture "$placeholders"
cat > "$placeholders/.env" <<'EOF'
TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=203.0.113.10
TURN_REALM=turn.example.com
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_CREDENTIAL_TTL_SECONDS=3600
ALLOWED_ORIGINS=https://mirror.example.com
TRUST_PROXY=false
EOF
if (cd "$placeholders" && PATH="$placeholders/bin:$PATH" DOCKER_CALL_LOG="$placeholders/docker.log" WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>&1); then
  printf 'FAIL: example placeholders should be rejected\n' >&2
  exit 1
fi
assert_no_up "$placeholders/docker.log"

empty_secret="$fixture/empty-secret"
make_fixture "$empty_secret"
mkdir -p "$empty_secret/secrets"
: > "$empty_secret/secrets/turn_secret"
if (cd "$empty_secret" && PATH="$empty_secret/bin:$PATH" DOCKER_CALL_LOG="$empty_secret/docker.log" TURN_EXTERNAL_IP=198.51.100.25 TURN_REALM=turn.example.net ALLOWED_ORIGINS=https://mirror.example.net WSS_URL= bash scripts/deploy-docker.sh </dev/null >/dev/null 2>&1); then
  printf 'FAIL: an existing empty secret should be rejected\n' >&2
  exit 1
fi
[[ ! -s "$empty_secret/secrets/turn_secret" ]] || { printf 'FAIL: empty secret file was modified\n' >&2; exit 1; }
assert_no_up "$empty_secret/docker.log"

printf '%s\n' 'PASS: deploy Docker bootstrap regression harness'
