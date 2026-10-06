# Task 7 — Sender ICE restart before rebuild

## Revision

- BASE: `e0beb24992349e2baa25e26ceddd325f0dcc6afa`
- Implementation commit / HEAD: `9cb037f` (`feat: restart ICE before rebuilding WebRTC peers`)
- Changed implementation/test paths: `app/services/webRTC.ts`, `tests/frontend/webRTC.test.ts`
- Store file unchanged; no diagnostic store field was needed.

## Red/test attempts

Added lifecycle coverage for restart-first offer creation/sending without a second PeerConnection, fallback on offer creation / local description / send failure, answer-timeout fallback and valid-answer cancellation, and simultaneous events/stale callbacks.

Attempted the required red command before implementation:

- `pnpm test -- tests/frontend/webRTC.test.ts` — **not run**: PowerShell reported `pnpm` is not recognized (`CommandNotFoundException`, exit 1). Re-attempted after adding the tests with the same result. The test runner never started; no red test result is claimed.
- `pnpm test -- tests/frontend/webRTC.test.ts tests/frontend/webRTCStats.test.ts` — **not run**: `pnpm` unavailable (`CommandNotFoundException`, exit 1).
- `pnpm test` — **not run**: `pnpm` unavailable (`CommandNotFoundException`, exit 1).
- `pnpm typecheck` — **not run**: `pnpm` unavailable (`CommandNotFoundException`, exit 1).
- `pnpm build` — **not run**: `pnpm` unavailable (`CommandNotFoundException`, exit 1).
- Supplemental `tsc --noEmit` — **not run**: `tsc` unavailable (`CommandNotFoundException`, exit 1). No dependencies were installed.
- `git diff --check` — passed before commit (no output, exit 0).

No test, typecheck, or build pass is claimed.

## Implementation and self-review

- Sender recovery first validates the current peer, stable signaling state, connected signaling status, and generation, then creates an offer with `createOffer({ iceRestart: true })`, applies it locally, and sends it through signaling. It does not call `restartIce()`.
- A single current-peer recovery lock prevents simultaneous failure callbacks from starting duplicate attempts. The connection-request generation and peer identity are checked after async offer steps and before rebuild so stale callbacks cannot close/replace a newer connection.
- If restart cannot be issued, fails at offer/local-description/send, or receives no answer within 10 seconds, the service falls back to closing and recreating the sender connection with its existing local stream. The timeout is cancelled by a valid applied answer, `connected`, and close/peer teardown.
- The disconnected grace timer remains 5 seconds. Existing ICE configuration fetch guards, existing diagnostics, candidate queue/flush handling, and media stats paths were left intact. Restart failures record only concise static diagnostics; no SDP, ICE candidates/addresses/ports, TURN secret, or raw stats are added to diagnostics or logs.

## Concerns / verification limits

The focused and full Vitest suites, project typecheck, and build could not be executed because `pnpm` and local dependencies are unavailable in this environment. The newly added tests therefore remain unexecuted here. This limitation should be resolved by running the required commands in an environment with the project dependencies and pnpm installed.

## Fix round 1 — durable recovery cancellation

- Reviewed BASE: `9cb037f5ee3f1423696f54d0a0f62ca7d4f34ffa`. Worktree initially included only the report commit `3a8acb7de4c10f1135c218a2dff8b7736c8c2493` above that implementation; code changes below are based on the exact reviewed implementation.
- Reproduction tests were added first: connected during a deferred `createOffer` (must neither send nor rebuild) and a valid answer during deferred `setLocalDescription` followed by rejection (must neither timeout nor rebuild). Both assert one original PeerConnection remains open; the connected case asserts it remains connected, and the answer case asserts the applied answer remains on that original peer.
- Required pre-production red attempt, from the isolated worktree: `pnpm test -- tests/frontend/webRTC.test.ts` — exit 1, PowerShell `CommandNotFoundException` (`pnpm` is not recognized). The tests could not be run to observe their failure.
- Production change adds a monotonically increasing recovery-attempt token. Clearing recovery invalidates it; both restart stages and the recovery continuation check peer identity, request generation, lock peer and token. These checks prevent a stale continuation from sending after cancellation, installing a new timeout, or falling back to rebuild. A failure event received during an in-flight attempt now sets `reconnectRequested` before the lock check, and the finishing attempt drains that queued request against the same peer.
- Post-test focused attempt: `pnpm test -- tests/frontend/webRTC.test.ts` — exit 1, `pnpm` unavailable.
- Focused lifecycle attempt: `pnpm test -- tests/frontend/webRTC.test.ts tests/frontend/webRTCStats.test.ts` — exit 1, `pnpm` unavailable.
- Typecheck attempt: `pnpm typecheck` — exit 1, `pnpm` unavailable. Standalone `tsc --noEmit` — exit 1, `tsc` unavailable. No dependency installation attempted.
- `git diff --check` — passed (exit 0; no output).
- Runtime test/typecheck limitation remains: both regression tests and type validation are unexecuted. No pass is claimed; run them in a provisioned pnpm/dependency environment.
- Fresh handoff review confirmed the attempt-token guards suppress stale offer sends, timer creation, and rebuilds after cancellation. Follow-up fix also guards the restart catch diagnostic, resets queued recovery on a valid answer, and restores the brief-required `restartIceAndRenegotiate(peerConnection): Promise<boolean>` signature. The valid-answer deferred-rejection test now asserts that no stale error diagnostic is written.
- Follow-up verification: `git diff --check` — passed (exit 0); test commands remain unavailable because `pnpm` is not installed. No tests/typecheck/build pass is claimed.

## Fix round 2 — suppress duplicate recovery requests

- Re-reviewed the latest finding against the source: `requestSenderRecovery()` set `reconnectRequested` before checking `recoveryAttemptPeer`, and the `finally` block drained the queued flag. A second event during deferred restart could therefore clear its answer timeout and trigger another offer. The connected-state branch already clears `reconnectRequested`; this was preserved and covered by an added test.
- Added deterministic regressions for a disconnected grace callback firing while `createOffer()` remains deferred (one createOffer/offer, no second attempt or rebuild before the answer deadline), and for duplicate failure followed by `connected` while createOffer is pending (no offer send or rebuild; healthy original peer remains open).
- Minimal fix: check the active peer lock before queuing a request and remove the unconditional `finally` queue drain. Later failures after the active lock has been cleared still set a new request and start recovery normally.
- Required focused test attempt `pnpm test -- tests/frontend/webRTC.test.ts` — exit 1, PowerShell `CommandNotFoundException` (`pnpm` unavailable); did not install dependencies. Tests remain unexecuted; no runtime pass claimed.
- `git diff --check` — passed after round 2 edits (exit 0, no output).
