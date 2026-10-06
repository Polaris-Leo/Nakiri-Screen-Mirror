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
  "info"|"compose version"|"compose up -d --build --remove-orphans"|"compose ps") exit 0 ;;
  "compose config --quiet")
    if [[ "${CHECK_SECRET_MODES:-0}" == 1 ]]; then
      [[ "$(stat -c '%a' "$CONFIG_CHECK_ROOT/secrets")" == 700 ]] || { printf '%s\n' 'FAIL: secrets directory mode was not 700 at Compose config time' >&2; exit 1; }
      [[ "$(stat -c '%a' "$CONFIG_CHECK_ROOT/secrets/turn_secret")" == 600 ]] || { printf '%s\n' 'FAIL: secret file mode was not 600 at Compose config time' >&2; exit 1; }
    fi
    exit 0
    ;;
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
chmod 755 "$success/secrets"
chmod 644 "$success/secrets/turn_secret"
if ! (
  cd "$success"
  PATH="$success/bin:$PATH" DOCKER_CALL_LOG="$success/docker.log" \
    CONFIG_CHECK_ROOT="$success" CHECK_SECRET_MODES=1 \
    TURN_EXTERNAL_IP=198.51.100.25 TURN_REALM=turn.example.net \
    ALLOWED_ORIGINS=https://mirror.example.net WSS_URL= \
    bash scripts/deploy-docker.sh
); then
  printf 'FAIL: existing-configuration deployment should tighten secret modes before Compose config\n' >&2
  exit 1
fi
[[ "$(stat -c '%a' "$success/secrets")" == 700 ]] || { printf 'FAIL: existing secrets directory mode is not 700\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$success/secrets/turn_secret")" == 600 ]] || { printf 'FAIL: existing secret file mode is not 600\n' >&2; exit 1; }
cmp -s "$success/.env.expected" "$success/.env" || { printf 'FAIL: existing-configuration run changed .env bytes\n' >&2; exit 1; }
cmp -s "$success/secret.expected" "$success/secrets/turn_secret" || { printf 'FAIL: existing-configuration run changed secret bytes\n' >&2; exit 1; }

symlink_secret="$fixture/symlink-secret"
make_fixture "$symlink_secret"
mkdir -p "$symlink_secret/secrets"
printf '%s\n' 'external-test-secret' > "$fixture/external-secret"
chmod 644 "$fixture/external-secret"
ln -s "$fixture/external-secret" "$symlink_secret/secrets/turn_secret"
cat > "$symlink_secret/.env" <<'EOF'
TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
ALLOWED_ORIGINS=https://mirror.example.net
EOF
if (cd "$symlink_secret" && PATH="$symlink_secret/bin:$PATH" DOCKER_CALL_LOG="$symlink_secret/docker.log" WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>"$symlink_secret/error.log"); then
  printf 'FAIL: an existing symlink secret should be rejected\n' >&2
  exit 1
fi
grep -Fq '符号链接' "$symlink_secret/error.log" || { printf 'FAIL: symlink rejection should explain the unsafe path\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$symlink_secret/secrets")" == 755 ]] || { printf 'FAIL: symlink rejection changed directory mode\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$fixture/external-secret")" == 644 ]] || { printf 'FAIL: symlink rejection changed external file mode\n' >&2; exit 1; }
[[ "$(<"$fixture/external-secret")" == 'external-test-secret' ]] || { printf 'FAIL: symlink rejection changed external file bytes\n' >&2; exit 1; }
assert_no_up "$symlink_secret/docker.log"
if grep -Fxq 'compose config --quiet' "$symlink_secret/docker.log"; then
  printf 'FAIL: symlink rejection reached Compose config\n' >&2
  exit 1
fi

permission_failure="$fixture/permission-failure"
make_fixture "$permission_failure"
mkdir -p "$permission_failure/secrets"
printf '%s\n' 'permission-failure-test-secret' > "$permission_failure/secrets/turn_secret"
printf '%s\n' 'fixture-only-config=1' > "$permission_failure/.env"
chmod 755 "$permission_failure/secrets"
chmod 644 "$permission_failure/secrets/turn_secret"
cat > "$permission_failure/bin/chmod" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAIL_PERMISSION_CHANGE:-0}" == 1 ]]; then
  printf '%s\n' 'simulated chmod failure' >&2
  exit 1
fi
exec /usr/bin/chmod "$@"
EOF
chmod +x "$permission_failure/bin/chmod"
if (cd "$permission_failure" && PATH="$permission_failure/bin:$PATH" FAIL_PERMISSION_CHANGE=1 DOCKER_CALL_LOG="$permission_failure/docker.log" WSS_URL= bash scripts/deploy-docker.sh >"$permission_failure/output.log" 2>&1); then
  printf 'FAIL: a secrets permission failure should abort deployment\n' >&2
  exit 1
fi
grep -Fq '无法设置 secrets 目录权限' "$permission_failure/output.log" || { printf 'FAIL: permission failure should provide a useful error\n' >&2; exit 1; }
if grep -Fxq 'compose config --quiet' "$permission_failure/docker.log"; then
  printf 'FAIL: permission failure reached Compose config\n' >&2
  exit 1
fi
assert_no_up "$permission_failure/docker.log"

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

existing_missing_dir="$fixture/existing-missing-dir"
make_fixture "$existing_missing_dir"
cat > "$existing_missing_dir/.env" <<'EOF'
TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
ALLOWED_ORIGINS=https://mirror.example.net
EOF
if (cd "$existing_missing_dir" && PATH="$existing_missing_dir/bin:$PATH" DOCKER_CALL_LOG="$existing_missing_dir/docker.log" WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>"$existing_missing_dir/error.log"); then
  printf 'FAIL: existing .env without secrets directory should be rejected\n' >&2
  exit 1
fi
grep -Fq 'secrets' "$existing_missing_dir/error.log" || { printf 'FAIL: missing directory should give setup guidance\n' >&2; exit 1; }
[[ ! -e "$existing_missing_dir/secrets" ]] || { printf 'FAIL: existing .env run created a secrets directory\n' >&2; exit 1; }
assert_no_up "$existing_missing_dir/docker.log"
if grep -Fxq 'compose config --quiet' "$existing_missing_dir/docker.log"; then
  printf 'FAIL: missing directory reached Compose config\n' >&2
  exit 1
fi

existing_missing_secret="$fixture/existing-missing-secret"
make_fixture "$existing_missing_secret"
mkdir -p "$existing_missing_secret/secrets"
cat > "$existing_missing_secret/.env" <<'EOF'
TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
ALLOWED_ORIGINS=https://mirror.example.net
EOF
if (cd "$existing_missing_secret" && PATH="$existing_missing_secret/bin:$PATH" DOCKER_CALL_LOG="$existing_missing_secret/docker.log" WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>"$existing_missing_secret/error.log"); then
  printf 'FAIL: existing .env without secret file should be rejected\n' >&2
  exit 1
fi
grep -Fq 'turn_secret' "$existing_missing_secret/error.log" || { printf 'FAIL: missing secret should give setup guidance\n' >&2; exit 1; }
[[ ! -e "$existing_missing_secret/secrets/turn_secret" ]] || { printf 'FAIL: existing .env run generated a secret\n' >&2; exit 1; }
assert_no_up "$existing_missing_secret/docker.log"
if grep -Fxq 'compose config --quiet' "$existing_missing_secret/docker.log"; then
  printf 'FAIL: missing secret reached Compose config\n' >&2
  exit 1
fi

existing_empty_secret="$fixture/existing-empty-secret"
make_fixture "$existing_empty_secret"
mkdir -p "$existing_empty_secret/secrets"
: > "$existing_empty_secret/secrets/turn_secret"
cat > "$existing_empty_secret/.env" <<'EOF'
TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
ALLOWED_ORIGINS=https://mirror.example.net
EOF
if (cd "$existing_empty_secret" && PATH="$existing_empty_secret/bin:$PATH" DOCKER_CALL_LOG="$existing_empty_secret/docker.log" WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>"$existing_empty_secret/error.log"); then
  printf 'FAIL: existing .env with empty secret should be rejected\n' >&2
  exit 1
fi
grep -Fq 'turn_secret' "$existing_empty_secret/error.log" || { printf 'FAIL: empty secret should give setup guidance\n' >&2; exit 1; }
[[ ! -s "$existing_empty_secret/secrets/turn_secret" ]] || { printf 'FAIL: empty secret file was modified\n' >&2; exit 1; }
assert_no_up "$existing_empty_secret/docker.log"
if grep -Fxq 'compose config --quiet' "$existing_empty_secret/docker.log"; then
  printf 'FAIL: empty secret reached Compose config\n' >&2
  exit 1
fi

bootstrap_symlink="$fixture/bootstrap-symlink"
make_fixture "$bootstrap_symlink"
mkdir -p "$bootstrap_symlink/secrets"
printf '%s\n' 'external-bootstrap-secret' > "$fixture/external-bootstrap-secret"
chmod 644 "$fixture/external-bootstrap-secret"
ln -s "$fixture/external-bootstrap-secret" "$bootstrap_symlink/secrets/turn_secret"
if (cd "$bootstrap_symlink" && PATH="$bootstrap_symlink/bin:$PATH" DOCKER_CALL_LOG="$bootstrap_symlink/docker.log" TURN_EXTERNAL_IP=198.51.100.25 TURN_REALM=turn.example.net ALLOWED_ORIGINS=https://mirror.example.net WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>"$bootstrap_symlink/error.log"); then
  printf 'FAIL: first-run symlink secret should be rejected\n' >&2
  exit 1
fi
grep -Fq '符号链接' "$bootstrap_symlink/error.log" || { printf 'FAIL: first-run symlink rejection should identify unsafe path\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$fixture/external-bootstrap-secret")" == 644 ]] || { printf 'FAIL: first-run symlink rejection changed external mode\n' >&2; exit 1; }
[[ "$(<"$fixture/external-bootstrap-secret")" == 'external-bootstrap-secret' ]] || { printf 'FAIL: first-run symlink rejection changed external bytes\n' >&2; exit 1; }
assert_no_up "$bootstrap_symlink/docker.log"
if grep -Fxq 'compose config --quiet' "$bootstrap_symlink/docker.log"; then
  printf 'FAIL: first-run symlink rejection reached Compose config\n' >&2
  exit 1
fi

bootstrap_symlink_dir="$fixture/bootstrap-symlink-dir"
make_fixture "$bootstrap_symlink_dir"
mkdir -p "$fixture/external-secrets-dir"
printf '%s\n' 'external-dir-secret' > "$fixture/external-secrets-dir/turn_secret"
chmod 711 "$fixture/external-secrets-dir"
chmod 644 "$fixture/external-secrets-dir/turn_secret"
ln -s "$fixture/external-secrets-dir" "$bootstrap_symlink_dir/secrets"
if (cd "$bootstrap_symlink_dir" && PATH="$bootstrap_symlink_dir/bin:$PATH" DOCKER_CALL_LOG="$bootstrap_symlink_dir/docker.log" TURN_EXTERNAL_IP=198.51.100.25 TURN_REALM=turn.example.net ALLOWED_ORIGINS=https://mirror.example.net WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>"$bootstrap_symlink_dir/error.log"); then
  printf 'FAIL: first-run symlink secrets directory should be rejected\n' >&2
  exit 1
fi
grep -Fq '符号链接' "$bootstrap_symlink_dir/error.log" || { printf 'FAIL: symlink directory rejection should identify unsafe path\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$fixture/external-secrets-dir")" == 711 ]] || { printf 'FAIL: symlink directory rejection changed external directory mode\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$fixture/external-secrets-dir/turn_secret")" == 644 ]] || { printf 'FAIL: symlink directory rejection changed external file mode\n' >&2; exit 1; }
assert_no_up "$bootstrap_symlink_dir/docker.log"

bootstrap_hardlink="$fixture/bootstrap-hardlink"
make_fixture "$bootstrap_hardlink"
mkdir -p "$bootstrap_hardlink/secrets"
printf '%s\n' 'external-hardlink-secret' > "$fixture/external-hardlink-secret"
chmod 644 "$fixture/external-hardlink-secret"
ln "$fixture/external-hardlink-secret" "$bootstrap_hardlink/secrets/turn_secret"
if (cd "$bootstrap_hardlink" && PATH="$bootstrap_hardlink/bin:$PATH" DOCKER_CALL_LOG="$bootstrap_hardlink/docker.log" TURN_EXTERNAL_IP=198.51.100.25 TURN_REALM=turn.example.net ALLOWED_ORIGINS=https://mirror.example.net WSS_URL= bash scripts/deploy-docker.sh >/dev/null 2>"$bootstrap_hardlink/error.log"); then
  printf 'FAIL: first-run hardlink secret should be rejected\n' >&2
  exit 1
fi
grep -Fq '硬链接' "$bootstrap_hardlink/error.log" || { printf 'FAIL: hardlink rejection should identify unsafe path\n' >&2; exit 1; }
[[ "$(stat -c '%a' "$fixture/external-hardlink-secret")" == 644 ]] || { printf 'FAIL: first-run hardlink rejection changed external mode\n' >&2; exit 1; }
[[ "$(<"$fixture/external-hardlink-secret")" == 'external-hardlink-secret' ]] || { printf 'FAIL: first-run hardlink rejection changed external bytes\n' >&2; exit 1; }
assert_no_up "$bootstrap_hardlink/docker.log"

# Existing .env files are data, not shell code: required compose inputs must
# be present and nonblank before even `docker compose config` is invoked.
make_existing_env_case() {
  local name="$1"
  local content="$2"
  local root="$fixture/existing-$name"
  make_fixture "$root"
  mkdir -p "$root/secrets"
  printf '%s\n' 'fixture-secret-bytes' > "$root/secrets/turn_secret"
  printf '%s' "$content" > "$root/.env"
  cp "$root/.env" "$root/.env.expected"
  cp "$root/secrets/turn_secret" "$root/secret.expected"
  if (cd "$root" && PATH="$root/bin:$PATH" DOCKER_CALL_LOG="$root/docker.log" WSS_URL= bash scripts/deploy-docker.sh >"$root/output.log" 2>&1); then
    printf 'FAIL: invalid existing .env case %s should be rejected\n' "$name" >&2
    exit 1
  fi
  if grep -Eq '^compose (config --quiet|up )' "$root/docker.log" 2>/dev/null; then
    printf 'FAIL: invalid existing .env case %s reached Compose config/up\n' "$name" >&2
    exit 1
  fi
  cmp -s "$root/.env.expected" "$root/.env" || { printf 'FAIL: invalid case %s changed .env bytes\n' "$name" >&2; exit 1; }
  cmp -s "$root/secret.expected" "$root/secrets/turn_secret" || { printf 'FAIL: invalid case %s changed secret bytes\n' "$name" >&2; exit 1; }
}

valid_required_env='TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
TURN_URLS=turn:turn.example.net:3478?transport=udp
ALLOWED_ORIGINS=https://mirror.example.net
'
make_existing_env_case missing-allowed-origins "${valid_required_env%ALLOWED_ORIGINS=*}"
make_existing_env_case blank-allowed-origins 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
TURN_URLS=turn:turn.example.net:3478?transport=udp
ALLOWED_ORIGINS=
'
make_existing_env_case missing-turn-urls 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
ALLOWED_ORIGINS=https://mirror.example.net
'
make_existing_env_case blank-turn-urls 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
TURN_URLS=
ALLOWED_ORIGINS=https://mirror.example.net
'
make_existing_env_case mismatched-secret-path "${valid_required_env/\/secrets\/turn_secret/\/tmp\/other-secret}"
make_existing_env_case stale-turn-urls "${valid_required_env/turn:turn.example.net:3478?transport=udp/turn:turn.example.com:3478?transport=udp}"
make_existing_env_case single-quoted-external-ip 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP='"'"'203.0.113.10'"'"'
TURN_REALM=turn.example.net
TURN_URLS=turn:turn.example.net:3478?transport=udp
ALLOWED_ORIGINS=https://mirror.example.net
'
make_existing_env_case single-quoted-turn-realm 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM='"'"'turn.example.com'"'"'
TURN_URLS=turn:turn.example.net:3478?transport=udp
ALLOWED_ORIGINS=https://mirror.example.net
'
make_existing_env_case single-quoted-allowed-origin 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
TURN_URLS=turn:turn.example.net:3478?transport=udp
ALLOWED_ORIGINS='"'"'https://mirror.example.com'"'"'
'
make_existing_env_case quoted-empty-allowed-origins 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
TURN_URLS=turn:turn.example.net:3478?transport=udp
ALLOWED_ORIGINS=""
'
make_existing_env_case commented-allowed-origins 'TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.example.net
TURN_URLS=turn:turn.example.net:3478?transport=udp
# ALLOWED_ORIGINS=https://mirror.example.net
'

optional_defaults="$fixture/existing-optional-defaults"
make_fixture "$optional_defaults"
mkdir -p "$optional_defaults/secrets"
printf '%s\n' 'fixture-secret-bytes' > "$optional_defaults/secrets/turn_secret"
printf '%s' "$valid_required_env" > "$optional_defaults/.env"
if ! (cd "$optional_defaults" && PATH="$optional_defaults/bin:$PATH" DOCKER_CALL_LOG="$optional_defaults/docker.log" WSS_URL= bash scripts/deploy-docker.sh >"$optional_defaults/output.log" 2>&1); then
  printf 'FAIL: valid existing config should accept omitted optional TTL/TRUST_PROXY defaults\n' >&2
  exit 1
fi
if grep -Eq '^(TURN_CREDENTIAL_TTL_SECONDS|TRUST_PROXY)=' "$optional_defaults/.env"; then
  printf 'FAIL: validating existing .env should not rewrite optional defaults into it\n' >&2
  exit 1
fi
grep -Fxq 'compose config --quiet' "$optional_defaults/docker.log" || { printf 'FAIL: valid config did not reach Compose config\n' >&2; exit 1; }
grep -Fxq 'compose up -d --build --remove-orphans' "$optional_defaults/docker.log" || { printf 'FAIL: valid config did not deploy\n' >&2; exit 1; }

printf '%s\n' 'PASS: deploy Docker bootstrap regression harness'
