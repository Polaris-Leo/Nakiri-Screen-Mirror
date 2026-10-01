# WebRTC Stability and Quality Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make signaling resilient, expose WebRTC/media diagnostics, keep the server signaling-only, and add selectable screen-sharing quality presets with higher frame-rate targets.

**Architecture:** Keep the existing WebSocket signaling protocol and browser-to-browser WebRTC media path. Add explicit `ping`/`pong` control handling on the server, bounded-jitter infinite reconnects in the browser, and a diagnostics model fed by WebRTC state events plus `getStats()`. Quality presets are shared pure data used by capture constraints and RTP sender parameters.

**Tech Stack:** TypeScript, React Router, React, Zustand, Vitest, Node.js `ws`, WebRTC `RTCPeerConnection`/`getStats()`.

**Spec:** `docs/superpowers/specs/2026-10-01-webrtc-stability-quality-design.md`

## Global Constraints

- The server only handles `offer`, `answer`, `ice_candidate`, `ping`, and `pong`; it must never relay RTP/RTCP media.
- The existing six-digit room ID and `/connect` endpoint remain compatible.
- WebSocket reconnects use exponential backoff with 0–25% jitter and a 30-second maximum; there is no fixed retry-count limit.
- `ping` must return `pong` and must not be parsed as a signaling message.
- Quality presets are `balanced`, `hd`, `ultra`, and `4k`; default is `hd`.
- Unsupported capture constraints must fall back to `balanced` without preventing screen sharing.
- All new behavior requires a failing test before implementation and the full suite must remain green.

## Review Focus

- A browser heartbeat must not cause backend close code `1008`; cover in the backend protocol/server test (Task 1).
- A reconnect storm or stale socket must not create duplicate timers or mutate the current socket; cover in WebSocket lifecycle tests (Task 2).
- A browser that rejects 4K/60 constraints must still obtain a balanced stream; cover in media preset tests (Task 3).
- Missing or browser-specific `getStats()` fields must render as unavailable values, not throw; cover in stats normalization tests (Task 4).
- A viewer must not mistake the signaling server being healthy for WebRTC being connected; cover in diagnostics state/UI tests (Task 5).

### Task 1: Backend heartbeat control path

**Files:**
- Modify: `backend/src/protocol.ts`
- Modify: `backend/src/server.ts`
- Test: `tests/backend/protocol.test.ts`
- Test: `tests/backend/server.test.ts`

**Interfaces:**
- Produces `isControlMessage(raw: string | Uint8Array): "ping" | "pong" | null` in `backend/src/protocol.ts`.
- `server.ts` responds to `ping` with `pong`, ignores incoming `pong`, and passes all other payloads to `SignallingHub`.

- [ ] **Step 1: Write failing protocol tests**

  Add tests asserting `ping` and `pong` are recognized and arbitrary JSON/text is not recognized as a control message.

- [ ] **Step 2: Run the protocol tests and verify the expected failure**

  Run: `npx vitest run tests/backend/protocol.test.ts`

  Expected: FAIL because `isControlMessage` does not exist.

- [ ] **Step 3: Implement `isControlMessage` and server handling**

  In `server.ts`, convert the incoming raw payload to text once. Send `pong` directly for `ping`, return for `pong`, and call `hub.handleMessage` otherwise. Preserve the existing invalid-message close behavior.

- [ ] **Step 4: Add a server-level heartbeat regression test**

  Exercise the message dispatch boundary with a fake client and assert `ping` calls `send("pong")` without calling `close(1008)`.

- [ ] **Step 5: Run backend tests and build**

  Run: `npx vitest run tests/backend/protocol.test.ts tests/backend/server.test.ts`

  Run: `npm run build` from `backend/`.

  Expected: all targeted tests pass and TypeScript exits with code 0.

- [ ] **Step 6: Commit**

  ```bash
  git add backend/src/protocol.ts backend/src/server.ts tests/backend/protocol.test.ts tests/backend/server.test.ts
  git commit -m "fix: handle WebSocket heartbeat messages"
  ```

### Task 2: Resilient browser WebSocket lifecycle

**Files:**
- Modify: `app/services/webSocket.ts`
- Modify: `app/stores/webSocket.ts`
- Test: `tests/frontend/webSocket.test.ts`

**Interfaces:**
- `WebSocketState` remains `disconnected | connecting | connected | reconnecting`.
- Store adds `reconnectAttempts`, `lastError`, `lastConnectedAt`, `lastDisconnectedAt`, and `currentUrl`.
- `sendMessage<T>(message: WebSocketMessage<T>): boolean` returns `false` when no open socket is available.

- [ ] **Step 1: Extend fake socket tests for state and heartbeat**

  Add tests asserting close transitions to `reconnecting`, retry timers continue past five attempts, jittered delay is capped at 30 seconds, and an incoming `pong` clears the heartbeat timeout. Add a test asserting `sendMessage` returns `false` while disconnected.

- [ ] **Step 2: Run the WebSocket tests and verify the expected failures**

  Run: `npx vitest run tests/frontend/webSocket.test.ts`

  Expected: FAIL on the new state, retry, and return-value assertions.

- [ ] **Step 3: Implement reconnect state and diagnostics**

  Replace the five-attempt stop condition with exponential delay plus random jitter, set `reconnecting` before scheduling, and update the store on every state/error transition. Keep the connection-generation guard and ensure only one reconnect timer exists.

- [ ] **Step 4: Implement reliable heartbeat handling**

  Keep the existing 15-second interval and 5-second timeout, but treat the backend `pong` as the only success signal. Clear heartbeat timers on every close and manual disconnect.

- [ ] **Step 5: Make send failures observable**

  Return a boolean from `sendMessage`; callers can use it to surface signaling-unavailable diagnostics instead of silently dropping messages.

- [ ] **Step 6: Run the WebSocket tests**

  Run: `npx vitest run tests/frontend/webSocket.test.ts`

  Expected: all lifecycle tests pass.

- [ ] **Step 7: Commit**

  ```bash
  git add app/services/webSocket.ts app/stores/webSocket.ts tests/frontend/webSocket.test.ts
  git commit -m "feat: make WebSocket reconnect resilient"
  ```

### Task 3: Screen quality presets

**Files:**
- Create: `app/media.ts`
- Modify: `app/routes/home.tsx`
- Test: `tests/frontend/media.test.ts`

**Interfaces:**
- `ScreenQuality = "balanced" | "hd" | "ultra" | "4k"`.
- `SCREEN_QUALITY_PRESETS` exposes `{ label, width, height, frameRate, maxBitrate }` for every quality.
- `getDisplayMediaConstraints(quality: ScreenQuality): DisplayMediaStreamOptions` returns video constraints and keeps audio enabled.
- `applyVideoTrackQuality(track: MediaStreamTrack, quality: ScreenQuality): Promise<ScreenQuality>` applies constraints and returns the applied quality, falling back to `balanced` when constraints are rejected.

- [ ] **Step 1: Write failing preset and fallback tests**

  Assert exact preset values: balanced 1920×1080/30/6 Mbps, hd 1920×1080/60/10 Mbps, ultra 2560×1440/60/14 Mbps, and 4k 3840×2160/30/20 Mbps. Assert rejected 4K constraints retry balanced.

- [ ] **Step 2: Run media tests to verify the expected failure**

  Run: `npx vitest run tests/frontend/media.test.ts`

  Expected: FAIL because `app/media.ts` does not exist.

- [ ] **Step 3: Implement the pure presets and constraint helpers**

  Keep the preset object immutable. Use `width`, `height`, and `frameRate` ideal/max constraints, set `audio: true`, and set `track.contentHint = "detail"` when supported.

- [ ] **Step 4: Add the quality selector to the screen-share form**

  Store the selected quality locally with default `hd`; show the four labels before submission. Pass the selected quality to `getDisplayMedia`, apply the fallback helper to the video track, and pass the resulting quality to the WebRTC sender configuration.

- [ ] **Step 5: Run media tests and typecheck**

  Run: `npx vitest run tests/frontend/media.test.ts`

  Run: `npm run typecheck`.

  Expected: tests pass and typecheck exits with code 0.

- [ ] **Step 6: Commit**

  ```bash
  git add app/media.ts app/routes/home.tsx tests/frontend/media.test.ts
  git commit -m "feat: add selectable screen sharing quality"
  ```

### Task 4: WebRTC renegotiation and stats model

**Files:**
- Modify: `app/services/webRTC.ts`
- Modify: `app/stores/webRTC.ts`
- Test: `tests/frontend/webRTC.test.ts`
- Test: `tests/frontend/webRTCStats.test.ts`

**Interfaces:**
- `WebRTCStats` contains optional `width`, `height`, `framesPerSecond`, `bitrate`, `bytesSent`, `bytesReceived`, and `candidateType`.
- Store adds `role`, `peerId`, `iceConnectionState`, `iceGatheringState`, `signalingState`, `lastError`, `stats`, and `setDiagnostics(...)`.
- `normalizeWebRTCStats(report: RTCStatsReport, role: "sender" | "receiver"): WebRTCStats` is a pure exported helper.
- `WebRTCService.setQuality(quality: ScreenQuality): Promise<void>` updates video sender encoding parameters.

- [ ] **Step 1: Write failing stats and sender-parameter tests**

  Add fake reports for outbound and inbound RTP, assert width/height/FPS/bytes/bitrate extraction, assert missing fields produce `undefined`, and assert `setQuality("hd")` sets max bitrate 10 Mbps, max frame rate 60, and maintain-resolution.

- [ ] **Step 2: Run WebRTC tests to verify the expected failures**

  Run: `npx vitest run tests/frontend/webRTC.test.ts tests/frontend/webRTCStats.test.ts`

  Expected: FAIL because the diagnostics model and stats helper do not exist.

- [ ] **Step 3: Implement state event propagation**

  On every PeerConnection state change, update connection, ICE, gathering, and signaling states. Record the active role and peer ID. Preserve pending ICE candidates and the existing offer/answer behavior.

- [ ] **Step 4: Implement stats polling**

  Add a single interval while a peer connection is active. Read `outbound-rtp` for sender and `inbound-rtp` for receiver, calculate bitrate from byte deltas, normalize candidate type from the selected candidate pair, and stop polling on close.

- [ ] **Step 5: Implement quality-aware sender encoding**

  Locate the video sender and apply the selected preset to `RTCRtpSender.getParameters().encodings[0]`; set `degradationPreference` when supported and ignore unsupported optional fields without failing the connection.

- [ ] **Step 6: Implement automatic renegotiation after recoverable failure**

  Retain the local stream and peer ID when the connection becomes `disconnected` or `failed`. Once signaling is connected, create a fresh PeerConnection and send a new offer from the sender. Ensure stale PeerConnections cannot update the active store.

- [ ] **Step 7: Run WebRTC tests and typecheck**

  Run: `npx vitest run tests/frontend/webRTC.test.ts tests/frontend/webRTCStats.test.ts`

  Run: `npm run typecheck`.

  Expected: all targeted tests pass and typecheck exits with code 0.

- [ ] **Step 8: Commit**

  ```bash
  git add app/services/webRTC.ts app/stores/webRTC.ts tests/frontend/webRTC.test.ts tests/frontend/webRTCStats.test.ts
  git commit -m "feat: add WebRTC diagnostics and recovery"
  ```

### Task 5: Connection diagnostics UI

**Files:**
- Modify: `app/routes/home.tsx`
- Modify: `app/stores/webSocket.ts`
- Modify: `app/stores/webRTC.ts`
- Test: `tests/frontend/homeDiagnostics.test.tsx` (or the repository's established component-test location)

**Interfaces:**
- Render a compact diagnostics panel from the two stores; it must not derive transport status from `remoteStream` alone.
- Display the signaling state, WebRTC/ICE/signaling states, role/peer ID, candidate type, actual resolution/FPS/bitrate, and the text “视频流不经过信令服务器”。

- [ ] **Step 1: Write failing rendering tests**

  Render the home screen with a connected WebSocket and failed ICE state, then assert both statuses and the server-boundary text are visible. Render unavailable stats and assert the UI shows `暂无数据` rather than throwing.

- [ ] **Step 2: Run UI tests to verify the expected failure**

  Run: `npx vitest run tests/frontend/homeDiagnostics.test.tsx`

  Expected: FAIL because the diagnostics panel is not rendered.

- [ ] **Step 3: Implement the diagnostics panel and status copy**

  Keep the panel visible during active negotiation and after failure. Keep the existing reconnect button, but show the latest error and retry count next to it. Do not hide useful diagnostic information just because the video element is not connected.

- [ ] **Step 4: Run UI tests and typecheck**

  Run: `npx vitest run tests/frontend/homeDiagnostics.test.tsx`

  Run: `npm run typecheck`.

  Expected: all assertions pass and typecheck exits with code 0.

- [ ] **Step 5: Commit**

  ```bash
  git add app/routes/home.tsx app/stores/webSocket.ts app/stores/webRTC.ts tests/frontend/homeDiagnostics.test.tsx
  git commit -m "feat: show signaling and WebRTC diagnostics"
  ```

### Task 6: Deployment documentation and end-to-end verification

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Modify: `README.md` if the user-facing behavior summary is stale
- Test: existing full test suite and manual browser/server checks

**Interfaces:**
- Document that `/healthz` is liveness only and that `WSS_URL=... bash scripts/deploy-docker.sh` is the end-to-end signaling probe.
- Document that the Node.js server, Nginx, and EdgeOne do not carry media; only WebSocket signaling traverses them.
- Document the quality presets and the browser/device fallback behavior.

- [ ] **Step 1: Update deployment and troubleshooting documentation**

  Add the heartbeat requirement, WebSocket upgrade requirement, P2P media boundary, quality settings, and diagnostics interpretation.

- [ ] **Step 2: Run the complete automated verification**

  Run: `npm test -- --run`

  Run: `npm run typecheck`

  Run: `npm run build`

  Run from `backend/`: `npm run build`

  Expected: all tests pass and all builds exit with code 0.

- [ ] **Step 3: Run the local end-to-end probe**

  Start the backend and run:

  ```bash
  node backend/dist/server.js
  node backend/dist/probe.js ws://127.0.0.1:8080/connect
  ```

  Expected: the probe opens two connections and confirms one signaling message is routed.

- [ ] **Step 4: Perform production manual acceptance**

  Verify `wss://signaling-server.unia.love/connect` through Nginx/EdgeOne, interrupt and restore the network path, select each quality preset, and inspect the diagnostics panel and browser `webrtc-internals`.

- [ ] **Step 5: Commit documentation and final changes**

  ```bash
  git add docs/DEPLOYMENT.md README.md
  git commit -m "docs: explain WebRTC diagnostics and media path"
  ```
