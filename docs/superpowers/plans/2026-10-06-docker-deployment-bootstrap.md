# One-click Docker Deploy and Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-run Docker deployment initialize safe local configuration, and provide a guarded upgrade command that fast-forwards the current branch before redeploying.

**Architecture:** Extend `scripts/deploy-docker.sh` to bootstrap `.env` and a file-backed random TURN secret only when needed, then keep its existing detached Compose deployment and health/WSS checks. Add `scripts/upgrade-docker.sh` as a source-update wrapper: require a clean worktree and configured upstream, run `git pull --ff-only`, then reuse the deploy script rather than duplicating deployment logic.

**Tech Stack:** Bash, Git, Docker Compose v2, OpenSSL, curl; no new runtime dependencies.

**Spec:** User-approved bootstrap design (2026-10-06), user-approved upgrade design (pull the current branch's upstream with fast-forward only, then reuse deployment), and the existing deployment contract in `docs/DEPLOYMENT.md` §3-4 and `.env.example`.

## Global Constraints

- Never put the TURN secret value in `.env`, command-line arguments, terminal output, or logs; Compose continues to mount it as a file-backed Docker secret.
- Generate the secret with `openssl rand -hex 32`; set the `secrets/` directory to mode `700` and the secret file to mode `600`.
- Never overwrite an existing `.env` or secret file. If an existing configuration is incomplete or still contains example placeholders, fail before changing Compose services and explain what to edit.
- If `.env` is absent and required values are unavailable in a non-interactive run, fail before Compose deployment; do not use `.env.example` placeholder values as live settings.
- Keep `docker compose up -d --build --remove-orphans`, health polling, optional `WSS_URL` probing, and failure-log behavior. Containers run detached; the script remains foreground to report health/probe results.
- The upgrade command requires a clean non-ignored Git worktree and configured upstream, uses only `git pull --ff-only`, and then calls the deploy script. Never stash, reset, switch branches, run `docker compose down`, or auto-rollback.
- The file-mode regression harness must run on a POSIX filesystem. Windows Git Bash `/tmp` maps to NTFS and reports child-process permission changes differently; run it under Linux/WSL with its fixture in native Linux `/tmp`, and do not weaken the mode-`600` assertion.
- Do not change `docker-compose.yml`, `.env.example`, credentials APIs, dependencies, or lockfiles. Tests must use fake `docker`, `openssl`, `curl`, and `git` commands; they must never contact Docker/Git remotes or deploy real services.

---

## File Responsibility Map

- `scripts/deploy-docker.sh`: first-run configuration collection, secret creation, no-clobber checks, Compose preflight, and existing detached deployment flow.
- `tests/scripts/deploy-docker-bootstrap.sh`: isolated shell regression harness for bootstrap behavior using fake executables.
- `scripts/upgrade-docker.sh`: clean-tree/upstream checks, fast-forward-only source update, then delegation to the deploy script.
- `tests/scripts/upgrade-docker.sh`: isolated shell regression harness for upgrade ordering and refusal conditions using fake Git/Docker commands.
- `docs/DEPLOYMENT.md`: document interactive bootstrap, environment-variable inputs, secret permissions, non-interactive failure behavior, upgrade preconditions, and the detached-container/foreground-status distinction.

### Task 1: Bootstrap configuration safely before detached deployment

**Files:**
- Modify: `scripts/deploy-docker.sh`
- Create: `tests/scripts/deploy-docker-bootstrap.sh`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- `bash scripts/deploy-docker.sh` remains the primary command. When `.env` is absent, `TURN_EXTERNAL_IP`, `TURN_REALM`, and `ALLOWED_ORIGINS` may be supplied in the process environment or prompted for on a TTY. If `TURN_URLS` is unset, derive `turn:<TURN_REALM>:3478?transport=udp,turn:<TURN_REALM>:3478?transport=tcp`; accept an explicit `TURN_URLS` override for custom TURN endpoints.
- First-run `.env` records `TURN_SECRET_FILE=./secrets/turn_secret`, the collected TURN/origin values, `TURN_CREDENTIAL_TTL_SECONDS` defaulting to `3600`, and `TRUST_PROXY` defaulting to `false`. The secret itself is generated only in `secrets/turn_secret`.
- Existing `.env` is parsed only as data (never sourced/evaluated) and is never rewritten. It must contain nonblank `TURN_SECRET_FILE`, `TURN_EXTERNAL_IP`, `TURN_REALM`, `TURN_URLS`, and `ALLOWED_ORIGINS`; `TURN_SECRET_FILE` must equal `./secrets/turn_secret`. `TURN_CREDENTIAL_TTL_SECONDS` and `TRUST_PROXY` may be omitted and left to Compose defaults. Require `ALLOWED_ORIGINS` explicitly despite Compose's `${ALLOWED_ORIGINS:-https://mirror.example.com}` fallback, so a blank/missing setting cannot silently use the example origin. Run `docker compose config --quiet` before `docker compose up`; reject the `.env.example` sentinel values (`203.0.113.10`, `turn.example.com`, and `https://mirror.example.com`) before service changes, including `turn.example.com` anywhere in `TURN_URLS`.
- `tests/scripts/deploy-docker-bootstrap.sh` stages a copy of the deployment script under `mktemp -d`, prepends fake executables to `PATH`, and verifies: supplied first-run values create `.env`; fake secret content is written only to the secret file with mode `600`; Compose config is invoked before `up`; the secret does not appear in captured output; a second run preserves `.env` and the secret; missing non-interactive values exit nonzero without invoking `up`; invalid existing `.env` cases are rejected before Compose config/up without modifying `.env` or secret bytes; and an existing valid config may omit optional TTL/TRUST_PROXY defaults.

- [ ] **Step 1: Add the failing shell regression harness**

Create `tests/scripts/deploy-docker-bootstrap.sh` with this fixture setup:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/scripts"
cp "$repo_root/scripts/deploy-docker.sh" "$fixture/scripts/deploy-docker.sh"
```

Create these fake executables, then run `chmod +x "$fixture/bin/docker" "$fixture/bin/openssl" "$fixture/bin/curl"`:

```bash
cat > "$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$DOCKER_CALL_LOG"
case "$*" in
  "info"|"compose version"|"compose config --quiet"|"compose up -d --build --remove-orphans"|"compose ps") exit 0 ;;
  *) exit 99 ;;
esac
EOF
cat > "$fixture/bin/openssl" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "rand -hex 32" ]] || exit 99
printf '%s\n' 'test-secret-not-production'
EOF
cat > "$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
```

Run the copied script with `PATH="$fixture/bin:$PATH"`, `DOCKER_CALL_LOG="$fixture/docker.log"`, `TURN_EXTERNAL_IP=198.51.100.25`, `TURN_REALM=turn.example.net`, `ALLOWED_ORIGINS=https://mirror.example.net`, and empty `WSS_URL`. Verify with `grep -Fxq` that `.env` has the supplied values and both derived TURN URLs; assert `cat "$fixture/secrets/turn_secret"` equals the fake value and `stat -c '%a'` reports `600`; compare the line numbers from `grep -nF 'compose config --quiet'` and `grep -nF 'compose up -d --build --remove-orphans'`; and assert the captured output does not contain the fake secret. Copy `.env` and the secret file to expected snapshots, rerun without changing them, and compare each pair with `cmp`. In a second empty fixture, run with stdin redirected from `/dev/null` and no required environment values; assert nonzero exit, no `.env`/secret creation, and no fake Compose `up` call. Seed a third fixture with the exact `.env.example` placeholders and assert rejection before fake `up`. In a fourth fixture with `.env` absent and a pre-existing empty `secrets/turn_secret`, assert nonzero exit, that the file remains empty, and that fake Compose `up` is not called.

- [ ] **Step 2: Run the harness to confirm RED**

Run: `bash tests/scripts/deploy-docker-bootstrap.sh`
Expected: FAIL because the current deployment script reaches Compose without bootstrapping `.env` or the file-backed secret.

- [ ] **Step 3: Implement first-run setup and preflight**

In `scripts/deploy-docker.sh`, add a function that resolves each required value from its environment variable first and prompts only for missing values when stdin is a TTY. Validate each value is nonempty and single-line. For a missing `.env`, create the default secret directory with `umask 077`; reuse a nonempty existing `secrets/turn_secret`, fail without modifying an existing empty file, or generate a new secret with `openssl rand -hex 32` only when the path does not exist. Write the `.env` through a mode-`600` temporary file in the project root and install it without replacing a `.env` created concurrently. Preserve a pre-existing `.env` unchanged. Before `up`, reject example sentinel values and run `docker compose config --quiet`; on any failure, print the manual setup location (`docs/DEPLOYMENT.md` §3) and exit without changing service state. Then continue through the existing `up -d`, health, optional WSS probe, and `compose ps` steps.

- [ ] **Step 4: Run the shell harness and syntax check**

Run: `bash tests/scripts/deploy-docker-bootstrap.sh`
Expected: PASS for first-run bootstrap, config-before-up ordering, `.env`/secret preservation, secret redaction, placeholder rejection, empty-secret preservation, and non-interactive failure-before-deploy cases.
Run: `bash -n scripts/deploy-docker.sh tests/scripts/deploy-docker-bootstrap.sh`
Expected: exit 0 with no syntax diagnostics.

- [ ] **Step 5: Document setup behavior and run project checks**

Update `docs/DEPLOYMENT.md` §3-4 to show `bash scripts/deploy-docker.sh` as the first-run path, list the three prompted inputs and environment-variable equivalents, explain that `.env`/secret are never overwritten, and state that Compose containers are detached while the script stays attached for health/WSS results. Include the exact non-interactive preparation command sequence already documented: copy `.env.example`, set real TURN values, create `secrets/turn_secret` with `openssl rand -hex 32`, and set permissions `700`/`600`.

Run: `npm test`
Expected: all existing Vitest files pass.
Run: `npm run typecheck`
Expected: exit 0.
Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 6: Commit the reviewed deployment bootstrap**

```bash
git add scripts/deploy-docker.sh tests/scripts/deploy-docker-bootstrap.sh docs/DEPLOYMENT.md docs/superpowers/plans/2026-10-06-docker-deployment-bootstrap.md
git commit -m "feat: bootstrap Docker deployment configuration"
```

### Task 2: Upgrade from the current branch's upstream safely

**Depends on:** Task 1, because the upgrade wrapper delegates configuration validation and deployment to `scripts/deploy-docker.sh`.

**Files:**
- Create: `scripts/upgrade-docker.sh`
- Create: `tests/scripts/upgrade-docker.sh`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- `bash scripts/upgrade-docker.sh` runs from any working directory by resolving its own project root.
- It requires `git` and Docker Compose deployment prerequisites, a named current branch, a configured upstream, and an empty `git status --porcelain`. Ignored `.env` and `secrets/` remain untouched and do not make the tree dirty.
- On a valid checkout, run exactly `git pull --ff-only`; call `bash "$PROJECT_ROOT/scripts/deploy-docker.sh"` only if the pull succeeds. Do not hard-code a branch or remote.
- Never stash, reset, switch branches, run `docker compose down`, or automatically roll back. A failed pull must not run Compose; a later deployment failure is reported without rewriting Git history.
- `tests/scripts/upgrade-docker.sh` copies both scripts into a temporary fixture, prepends fake `git`, `docker`, and `curl`, and verifies the successful order `git pull --ff-only` before Compose config/up; it also verifies dirty-tree, missing-upstream, and failed-pull cases stop before Compose deployment.

- [ ] **Step 1: Add the failing upgrade wrapper harness**

Create a test fixture under `tests/scripts/upgrade-docker.sh`. Use `mktemp -d` with an `EXIT` cleanup trap, copy both production scripts under the fixture's `scripts/`, and put fake commands first on `PATH`. The fake `git` must answer `branch --show-current`, `rev-parse --abbrev-ref --symbolic-full-name @{u}`, and `status --porcelain` from environment-controlled fixture values; on `pull --ff-only`, append `git-pull` to a shared call log and exit with `$FAKE_GIT_PULL_STATUS`. The fake `docker` appends `docker:$*` to the same log and succeeds for `info`, `compose version`, `compose config --quiet`, `compose up -d --build --remove-orphans`, and `compose ps`; fake `curl` exits zero. Seed `.env` and a test secret under the fixture so the delegated deploy path does not invoke bootstrap. Assert the clean/upstream/success case logs `git-pull` before `docker:compose config --quiet` and before `docker:compose up -d --build --remove-orphans`. Then assert each of these cases exits nonzero and has no Docker `up` entry: dirty status, absent upstream, and failed `git pull --ff-only`.

- [ ] **Step 2: Run the upgrade harness to confirm RED**

Run: `bash tests/scripts/upgrade-docker.sh`
Expected: FAIL because `scripts/upgrade-docker.sh` does not exist yet.

- [ ] **Step 3: Implement the guarded fast-forward wrapper**

Create `scripts/upgrade-docker.sh` with `#!/usr/bin/env bash` and `set -Eeuo pipefail`. Resolve `PROJECT_ROOT` from `BASH_SOURCE[0]`, `cd` there, and fail with a concise actionable error if `git` is missing, `git branch --show-current` is empty, `git rev-parse --abbrev-ref --symbolic-full-name '@{u}'` fails, or `git status --porcelain` is nonempty. Run `git pull --ff-only`; on nonzero status, exit immediately. Only then run `bash "$PROJECT_ROOT/scripts/deploy-docker.sh"` and return its status. Never invoke `docker compose down` or any Git command that discards local work.

- [ ] **Step 4: Run both deployment-script harnesses and syntax checks**

Run: `bash tests/scripts/deploy-docker-bootstrap.sh`
Expected: PASS for bootstrap behavior.
Run: `bash tests/scripts/upgrade-docker.sh`
Expected: PASS for pull ordering and refusal conditions.
Run: `bash -n scripts/deploy-docker.sh scripts/upgrade-docker.sh tests/scripts/deploy-docker-bootstrap.sh tests/scripts/upgrade-docker.sh`
Expected: exit 0 with no syntax diagnostics.

- [ ] **Step 5: Document upgrade preconditions and run project checks**

Update `docs/DEPLOYMENT.md` with `bash scripts/upgrade-docker.sh`, stating it fast-forwards the current branch's configured upstream, refuses dirty or detached/untracked-upstream checkouts, reuses the deployment script, and does not stop services before rebuilding. State that `.env` and `secrets/` are ignored, the update is not automatic rollback, and the deploy script still waits for health/WSS results while containers stay detached.

Run: `npm test`
Expected: all existing Vitest files pass.
Run: `npm run typecheck`
Expected: exit 0.
Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 6: Commit the upgrade wrapper**

```bash
git add scripts/upgrade-docker.sh tests/scripts/upgrade-docker.sh docs/DEPLOYMENT.md
git commit -m "feat: add Docker upgrade script"
```

**Non-goals:** No systemd/Windows service, no process-level `nohup` mode, no public-IP auto-discovery network call, no EdgeOne/DNS/firewall provisioning, no automatic overwrite or rotation of existing secrets, and no automatic rollback.
