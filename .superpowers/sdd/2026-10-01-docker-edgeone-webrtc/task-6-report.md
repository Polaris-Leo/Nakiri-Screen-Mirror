# Task 6 — Selected WebRTC path and RTT diagnostics

## Commits

- **BASE:** `445e380bd210d657e5226896e29ed347e0b499e1` (verified before edits; matched expected base)
- **HEAD:** `24f3ea8d7b97812d316ac6ba5610dbe2a8533d5e`
- **Commit:** `feat: show selected WebRTC path and RTT`

## Files changed

- `app/services/webRTCStats.ts` — added optional `rttMs`; reads selected/nominated pair RTT, converts finite seconds to finite milliseconds, resolves the selected pair's local/remote candidate references, and only returns the existing safe local `candidateType` plus numeric media stats.
- `app/routes/home.tsx` — maps local relay to “TURN 中继”, known non-relay type to “direct”, displays RTT in ms when present, and uses “暂无数据” when either value is unavailable.
- `tests/frontend/webRTCStats.test.ts` — added direct, relay, unselected pair, absent pair/candidate, malformed RTT, and malformed media-number fixtures. Candidate fixture IP/port fields are present to exercise the normalization boundary; assertions ensure only sanitized fields are returned.

`tests/frontend/webRTC.test.ts` was not changed; its fake stats required no modifications.

## RED / GREEN and test attempts

1. **RED attempt before production edits:** ran the requested exact command `pnpm test -- tests/frontend/webRTCStats.test.ts`. It could not start because `pnpm` is not installed/available in this environment (PowerShell: command not recognized). Therefore no test failure/pass was observed for the new assertions before implementation.
2. **Post-implementation requested tests:** `pnpm test -- tests/frontend/webRTCStats.test.ts tests/frontend/webRTC.test.ts` failed for the same missing `pnpm` limitation.
3. **Supplemental direct Vitest attempt:** `node ..\..\node_modules\vitest\vitest.mjs run tests/frontend/webRTCStats.test.ts tests/frontend/webRTC.test.ts` failed during Vitest config startup with `spawn EPERM` from esbuild. Tests did not execute; no test pass is claimed.
4. **Requested typecheck:** `pnpm typecheck` could not start because `pnpm` is unavailable.
5. **Supplemental typecheck:** `node ..\..\node_modules\typescript\bin\tsc -p tsconfig.json --noEmit` completed successfully with no output (exit code 0).
6. **Patch whitespace check:** `git diff --check` completed successfully (exit code 0; Git emitted only a line-ending conversion warning for the test file).

## Privacy self-review

- Normalized output remains a fixed object containing dimensions, frame rate, bitrate, byte counters, local candidate type, and RTT only.
- Neither candidate address/port nor candidate objects, raw stats rows, SDP, or remote candidate values are returned or rendered.
- Candidate type and RTT come from the selected/nominated candidate-pair row and its referenced local candidate, not an arbitrary candidate row.
- The UI emits only “direct”/“TURN 中继” and numeric RTT, with “暂无数据” for unavailable diagnostics.
- Existing bitrate/frame/dimension fields and derivation are retained.

## Concerns

Automated Vitest execution remains unverified because `pnpm` is absent and direct Vitest startup is blocked by `spawn EPERM`. TypeScript no-emit and `git diff --check` succeeded; neither substitutes for the unrun test suite.

---

# Fix Round 1 — Review Findings

## Commit range

- **BASE:** `24f3ea8d7b97812d316ac6ba5610dbe2a8533d5e`
- **HEAD:** `2a213f1195c49b8bb718550ca3ee131b848cb8be` (fix implementation commit; report-only follow-up follows)

## Changes

- `app/routes/home.tsx`: labels only `host`, `srflx`, and `prflx` as `direct`; `relay` remains `TURN 中继`; unknown/absent values render `暂无数据`.
- `app/services/webRTCStats.ts`: the referenced remote candidate participates in determining whether path classification can be reported. Classification requires both referenced local and remote rows. RTT remains sourced from the selected pair, so it is retained even when the remote row is missing. No remote fields are copied to normalized output.
- `tests/frontend/homeDiagnostics.test.tsx`: regression coverage for an unknown candidate type rendering unavailable (not direct).
- `tests/frontend/webRTCStats.test.ts`: distinct missing-remote-row case; expects path classification unavailable and selected-pair RTT preserved, and checks normalized output for remote/address/port leakage.

## Test and verification attempts

Runtime test execution was not achieved; none of these attempts is a test pass or a test failure assertion:

1. **Before production edits**, `pnpm test -- tests/frontend/webRTCStats.test.ts tests/frontend/homeDiagnostics.test.tsx` — failed to start: `pnpm` is not recognized/available.
2. **Before production edits**, report's direct command `node ..\\..\\node_modules\\vitest\\vitest.mjs run tests/frontend/webRTCStats.test.ts tests/frontend/webRTC.test.ts` — failed during Vitest config startup with esbuild `spawn EPERM`.
3. **After production edits**, `pnpm test -- tests/frontend/webRTCStats.test.ts tests/frontend/homeDiagnostics.test.tsx` — failed to start: `pnpm` is not recognized/available.
4. **After production edits**, the same direct Vitest command — failed during Vitest config startup with esbuild `spawn EPERM`.
5. `pnpm typecheck` — failed to start: `pnpm` is not recognized/available.
6. `node ..\\..\\node_modules\\typescript\\bin\\tsc -p tsconfig.json --noEmit` — exit code 0, no output.
7. `git diff --check` — exit code 0; Git emitted a line-ending conversion warning for `tests/frontend/webRTCStats.test.ts`.

The requested pre-change red and post-change green behavior could not be observed because the test runner did not reach test execution. The source change is therefore not runtime-test-verified. No dependency installation or lockfile changes were attempted.

## Touched files

- `app/routes/home.tsx`
- `app/services/webRTCStats.ts`
- `tests/frontend/homeDiagnostics.test.tsx`
- `tests/frontend/webRTCStats.test.ts`
- `.superpowers/sdd/2026-10-01-docker-edgeone-webrtc/task-6-report.md`

## Privacy self-review

- The new missing-remote test uses an address fixture but asserts normalized output contains no address, port, remote-candidate, or fixture address strings; the exact normalized object includes only prior safe metrics, local candidate type (only when both refs resolve), and RTT.
- The remote row is used only as a presence requirement for path classification; its address, port, candidate type, and raw row are neither returned nor displayed.
- UI output continues to expose only the safe path label and numeric RTT.

## Remaining limitation

Release verification still needs the focused test command to run in an environment with pnpm and an executable esbuild child process. `tsc --noEmit` is a type-level check only and does not substitute for Vitest.
