# Nakiri Screen Mirror Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加固 Nakiri Screen Mirror 的信令安全、房间隔离、WebSocket/WebRTC 生命周期和生产配置，同时保持现有投屏流程不变。

**Architecture:** Worker 根据 6 位投屏码选择 Durable Object 房间，并在边界校验连接和信令消息。前端服务负责可取消的 WebSocket 重连、WebRTC 协商、ICE 排队和媒体轨道释放；信令地址通过 Vite 环境变量配置。

**Tech Stack:** React 19, React Router 7, TypeScript, Zustand, WebRTC, Cloudflare Workers, Durable Objects, Wrangler, pnpm, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-webrtc-hardening-design.md`

## Global Constraints

- 保持现有“打开页面、输入 6 位投屏码、开始屏幕共享”的用户流程。
- 不引入 TURN 服务供应商或新的运行时依赖。
- 保留现有 `new_sqlite_classes` Durable Object 迁移格式。
- Worker 允许的信令类型只有 `offer`、`answer`、`ice_candidate`。
- Worker 单条消息大小上限为 64 KiB。
- 前端配置使用 `VITE_SIGNALING_URL`，并保留当前信令域名作为默认值。
- 测试使用 Vitest；测试代码放在根目录 `tests/`，不把测试依赖加入生产运行时依赖。

## Review Focus

- 不同投屏码必须进入不同 Durable Object，且不能因为客户端伪造 `from` 而冒充其他连接；测试归入 Task 1。
- 非法 JSON、未知消息类型、非法目标 ID 和超大消息不能广播或让 Worker 未处理异常；测试归入 Task 1。
- 旧 WebSocket 的 `onclose` 不能关闭或重连新连接，主动断开不能触发重连；测试归入 Task 2。
- Remote Description 之前到达的 ICE Candidate 必须保留并在正确时机添加；测试归入 Task 3。
- 断开投屏必须停止本地媒体轨道，且旧 PeerConnection 不能被复用；测试归入 Task 3。

### Task 1: Harden Worker room routing and signalling protocol

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/durable/signalling.ts`
- Create: `worker/src/signallingProtocol.ts`
- Create: `tests/worker/signallingProtocol.test.ts`
- Modify: `package.json` to add the `test` script and Vitest dev dependency
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: `Request` URL `/connect?id=<six digits>` and Durable Object binding `SIGNALLING_SERVER`.
- Produces: 400 for invalid IDs, room-specific Durable Object selection, validated forwarding of `offer`, `answer`, and `ice_candidate` messages.

- [ ] **Step 1: Extract the pure Worker validation boundary and write failing tests**

  Define the intended `isRoomId(value: string | null): boolean` and `parseSignallingMessage(message: string | ArrayBuffer): ValidatedSignallingMessage | null` interfaces in `worker/src/signallingProtocol.ts`. Test invalid/missing IDs, invalid JSON, unknown type, invalid `to`, over-64 KiB messages, and valid parsing. Add an index handler test using a small fake binding to assert `idFromName(roomId)` is called with the room ID.

- [ ] **Step 2: Run the Vitest focused target and verify the new tests fail for the intended missing behavior**

  Run `pnpm test -- tests/worker/signallingProtocol.test.ts`. Expected result: the new tests fail because the validation helpers and room-specific behavior do not exist yet.

- [ ] **Step 3: Implement room-specific routing in `worker/src/index.ts`**

  Validate `id` with `/^\d{6}$/`, use `env.SIGNALLING_SERVER.idFromName(id)`, and preserve the existing `/connect` and 404 behavior.

- [ ] **Step 4: Implement bounded protocol parsing in `worker/src/signallingProtocol.ts` and use it in `worker/src/durable/signalling.ts`**

  Export the pure parser for tests. In the Durable Object, catch malformed input, close invalid sockets with a policy/protocol code, and forward only validated messages to sockets returned by `getWebSockets(msg.to)`.

- [ ] **Step 5: Run the focused Worker tests and verify they pass**

  Run `pnpm test -- tests/worker/signallingProtocol.test.ts`.

- [ ] **Step 6: Run Worker type checking**

  Run `cd worker; pnpm exec tsc --noEmit` and fix only errors caused by this task.

### Task 2: Make the WebSocket client lifecycle deterministic

**Files:**
- Modify: `app/services/webSocket.ts`
- Create: `tests/frontend/webSocket.test.ts`

**Interfaces:**
- Consumes: existing `connect(url)`, `reconnect()`, `disconnect()`, `sendMessage()`, and handler registration API.
- Produces: one active connection generation, no reconnect after manual disconnect, and safe sends only while `OPEN`.

- [ ] **Step 1: Write failing tests for manual disconnect, stale close, and unsafe send**

  Assert that manual disconnect cancels timers and does not schedule a reconnect; a stale previous socket close does not replace or reconnect the current socket; `sendMessage` is a no-op unless the socket is `OPEN`.

- [ ] **Step 2: Run `pnpm test -- tests/frontend/webSocket.test.ts` and verify the focused tests fail for the intended lifecycle behavior**

- [ ] **Step 3: Implement connection generation and explicit manual-close state**

  Ensure event handlers capture the generation they belong to, stale events are ignored, and close/reconnect timers are cleared consistently.

- [ ] **Step 4: Guard outgoing messages and preserve heartbeat behavior**

  Check `readyState === WebSocket.OPEN` before sending. Keep the existing heartbeat interval and exponential backoff limits unless a test requires a targeted change.

- [ ] **Step 5: Run `pnpm test -- tests/frontend/webSocket.test.ts`, then run the frontend type check**

  Run the focused test target, then `pnpm typecheck`.

### Task 3: Make WebRTC negotiation and media cleanup robust

**Files:**
- Modify: `app/services/webRTC.ts`
- Modify: `app/routes/home.tsx`
- Create: `tests/frontend/webRTC.test.ts`

**Interfaces:**
- Consumes: existing `connect(to)`, `handleOffer(peerId, offer)`, and `close()` methods plus the existing Zustand stores.
- Produces: queued ICE candidates, guarded async negotiation, local stream ownership, cleanup on close/failure, and no reuse of failed/closed connections.

- [ ] **Step 1: Write failing tests for ICE queueing, stream cleanup, and stale connection reuse**

  Assert that candidates received before Remote Description are queued and later added; `close()` stops every local track; a failed/closed peer connection is replaced rather than reused.

- [ ] **Step 2: Run `pnpm test -- tests/frontend/webRTC.test.ts` and verify the focused tests fail for the intended missing behavior**

- [ ] **Step 3: Add local stream ownership and cleanup**

  Add a `setLocalStream(stream)` boundary used by `home.tsx`; stop all local tracks and clear the reference in `close()` and failure cleanup.

- [ ] **Step 4: Add ICE candidate queueing and async error handling**

  Queue candidates until `remoteDescription` exists, flush them after `setRemoteDescription`, and catch offer/answer/candidate errors without leaving rejected Promises.

- [ ] **Step 5: Guard PeerConnection reuse and failure states**

  Reuse only non-failed, non-closed connections. On failed/closed state, clear the connection and relevant stores.

- [ ] **Step 6: Run `pnpm test -- tests/frontend/webRTC.test.ts`, then run the frontend type check**

### Task 4: Remove persistent room identity and hard-coded external frontend dependencies

**Files:**
- Modify: `app/stores/auth.ts`
- Modify: `app/routes/home.tsx`
- Modify: `app/root.tsx`
- Create: `app/config.ts`
- Create: `tests/frontend/config.test.ts`

**Interfaces:**
- Consumes: `VITE_SIGNALING_URL` and existing auth store API.
- Produces: session-scoped room ID storage, configurable WebSocket endpoint, and no third-party tracker injection.

- [ ] **Step 1: Write failing tests for session-scoped storage and `VITE_SIGNALING_URL` resolution**

  Assert that the auth persistence uses session storage semantics and that the URL builder appends `?id=` or `&id=` correctly without duplicating query separators.

- [ ] **Step 2: Run `pnpm test -- tests/frontend/config.test.ts` and verify the focused tests fail for the intended configuration behavior**

- [ ] **Step 3: Replace localStorage persistence with sessionStorage persistence**

  Preserve the existing Zustand state shape so the page flow remains unchanged.

- [ ] **Step 4: Read and compose the configurable signaling URL**

  Use `import.meta.env.VITE_SIGNALING_URL` with the current production URL as fallback, and append the room ID via `URL`/`URLSearchParams` rather than string concatenation.

- [ ] **Step 5: Remove the third-party statistics script from `app/root.tsx`**

- [ ] **Step 6: Run `pnpm test -- tests/frontend/config.test.ts`, then run `pnpm typecheck`**

### Task 5: Full verification and deployment documentation

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Modify: `README.md` only if it needs a short link to the deployment document

**Interfaces:**
- Consumes: final Worker route, frontend environment variable, build output, and deployment commands.
- Produces: reproducible deployment instructions for Cloudflare Worker/Durable Object and static frontend hosting.

- [ ] **Step 1: Write the deployment document**

  Document prerequisites, Worker deployment, custom domain setup, `VITE_SIGNALING_URL`, static hosting/Nginx, HTTPS, verification, updates, and troubleshooting. State that Worker and frontend should be released together when changing room routing.

- [ ] **Step 2: Run the complete validation suite**

  Run:

  ```bash
  pnpm typecheck
  pnpm build
  cd worker
  pnpm exec tsc --noEmit
  ```

  Also run `pnpm test`. Expected result: all tests pass, type checks pass, and the production build completes.

- [ ] **Step 3: Inspect the final diff and verify no secrets or unintended generated files are included**

- [ ] **Step 4: Commit the implementation as a focused change**

  Use a message such as `feat: harden WebRTC signalling and lifecycle`.
