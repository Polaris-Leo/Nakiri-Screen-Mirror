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
