#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v git >/dev/null 2>&1; then
  printf '%s\n' 'Error: git is required to upgrade this checkout.' >&2
  exit 1
fi

if ! current_branch="$(git branch --show-current)" || [[ -z "$current_branch" ]]; then
  printf '%s\n' 'Error: upgrade requires a named current branch; detached HEAD is not supported.' >&2
  exit 1
fi

if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  printf '%s\n' 'Error: current branch has no configured upstream.' >&2
  exit 1
fi

if ! working_tree="$(git status --porcelain)"; then
  printf '%s\n' 'Error: unable to inspect the Git working tree.' >&2
  exit 1
fi
if [[ -n "$working_tree" ]]; then
  printf '%s\n' 'Error: working tree is not clean; commit or otherwise preserve your changes before upgrading.' >&2
  exit 1
fi

if ! git pull --ff-only; then
  printf '%s\n' 'Error: fast-forward update failed; deployment was not started.' >&2
  exit 1
fi

exec bash "$PROJECT_ROOT/scripts/deploy-docker.sh"
