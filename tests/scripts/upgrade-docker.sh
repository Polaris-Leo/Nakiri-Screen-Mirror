#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UPGRADE_SCRIPT="$SOURCE_ROOT/scripts/upgrade-docker.sh"
DEPLOY_SCRIPT="$SOURCE_ROOT/scripts/deploy-docker.sh"

if [[ ! -f "$UPGRADE_SCRIPT" ]]; then
  printf 'FAIL: expected upgrade wrapper at %s\n' "$UPGRADE_SCRIPT" >&2
  exit 1
fi

FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/scripts" "$FIXTURE/bin" "$FIXTURE/secrets"
cp "$UPGRADE_SCRIPT" "$DEPLOY_SCRIPT" "$FIXTURE/scripts/"
cat > "$FIXTURE/.env" <<'EOF'
TURN_SECRET_FILE=./secrets/turn_secret
TURN_EXTERNAL_IP=198.51.100.25
TURN_REALM=turn.fixture.test
TURN_URLS=turn:turn.fixture.test:3478?transport=udp,turn:turn.fixture.test:3478?transport=tcp
ALLOWED_ORIGINS=https://mirror.fixture.test
EOF
printf 'fixture-only-secret\n' > "$FIXTURE/secrets/turn_secret"

export CALL_LOG="$FIXTURE/calls.log"
export FAKE_GIT_BRANCH="main"
export FAKE_GIT_UPSTREAM="origin/main"
export FAKE_GIT_STATUS=""
export FAKE_GIT_PULL_STATUS=0
: > "$CALL_LOG"

cat > "$FIXTURE/bin/git" <<'FAKE_GIT'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$*" in
  'branch --show-current') printf '%s\n' "${FAKE_GIT_BRANCH:-}" ;;
  'rev-parse --abbrev-ref --symbolic-full-name @{u}')
    [[ -n "${FAKE_GIT_UPSTREAM:-}" ]] || exit 1
    printf '%s\n' "$FAKE_GIT_UPSTREAM"
    ;;
  'status --porcelain') printf '%s' "${FAKE_GIT_STATUS:-}" ;;
  'pull --ff-only')
    printf '%s\n' git-pull >> "$CALL_LOG"
    exit "${FAKE_GIT_PULL_STATUS:-0}"
    ;;
  *) printf 'unexpected fake git invocation: %s\n' "$*" >&2; exit 90 ;;
esac
FAKE_GIT
cat > "$FIXTURE/bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'docker:%s\n' "$*" >> "$CALL_LOG"
case "$*" in
  'info'|'compose version'|'compose config --quiet'|'compose up -d --build --remove-orphans'|'compose ps') exit 0 ;;
  *) printf 'unexpected fake docker invocation: %s\n' "$*" >&2; exit 91 ;;
esac
FAKE_DOCKER
cat > "$FIXTURE/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
exit 0
FAKE_CURL
chmod +x "$FIXTURE/bin/git" "$FIXTURE/bin/docker" "$FIXTURE/bin/curl"
export PATH="$FIXTURE/bin:$PATH"
export WSS_URL=""
export MAX_ATTEMPTS=1

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
reset_case() { : > "$CALL_LOG"; }
run_upgrade() { (cd / && bash "$FIXTURE/scripts/upgrade-docker.sh"); }

reset_case
run_upgrade || fail 'clean checkout upgrade should succeed'
line_number() { grep -nFx "$1" "$CALL_LOG" | cut -d: -f1; }
pull_line="$(line_number git-pull)"
config_line="$(line_number 'docker:compose config --quiet')"
up_line="$(line_number 'docker:compose up -d --build --remove-orphans')"
[[ -n "$pull_line" && -n "$config_line" && -n "$up_line" ]] || fail 'success path omitted expected Git or Compose calls'
(( pull_line < config_line && config_line < up_line )) || fail 'pull, config, and up were not ordered correctly'

reset_case
FAKE_GIT_STATUS=' M tracked.txt' run_upgrade >/dev/null 2>&1 && fail 'dirty checkout should be rejected'
! grep -q '^docker:compose up ' "$CALL_LOG" || fail 'dirty checkout reached Docker Compose up'

reset_case
FAKE_GIT_UPSTREAM='' run_upgrade >/dev/null 2>&1 && fail 'missing upstream should be rejected'
! grep -q '^docker:compose up ' "$CALL_LOG" || fail 'missing upstream reached Docker Compose up'

reset_case
FAKE_GIT_PULL_STATUS=1 run_upgrade >/dev/null 2>&1 && fail 'failed pull should fail the upgrade'
! grep -q '^docker:' "$CALL_LOG" || fail 'failed pull invoked Docker'

printf '%s\n' 'PASS: upgrade wrapper order and refusal cases'
