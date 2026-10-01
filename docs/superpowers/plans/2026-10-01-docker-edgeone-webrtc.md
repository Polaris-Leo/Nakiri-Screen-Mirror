# Docker + EdgeOne WebRTC 改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 A→B→C 顺序提升跨 NAT 连接成功率、改善 WebRTC 恢复，并将项目统一为 Docker + EdgeOne 部署。

**Architecture:** EdgeOne 托管前端并代理 WSS 信令和凭据 HTTP 请求到 Docker Node 服务；Docker Compose 运行 Node 信令/凭据服务和 coturn。Node 用 coturn REST HMAC 生成短期凭据，浏览器以 ICE 原生直连优先、TURN 兜底，并在失败时先尝试 ICE restart，再退回现有完整连接重建；最后整理本地参考项目并移除旧 Worker 部署。

**Tech Stack:** React 19、React Router 7、TypeScript、WebRTC、Node.js 20、`ws`、Docker Compose、coturn、EdgeOne、Vitest、pnpm。

**Spec:** `docs/superpowers/specs/2026-10-01-docker-edgeone-webrtc-design.md`

## Global Constraints

- 使用 Docker 部署 Node 信令与 coturn；EdgeOne 托管前端，并将 WebSocket 信令路径反向代理到 Docker 信令服务。
- TURN 长期共享密钥只保存在服务端；通过信令服务签发有时效的临时凭据。
- 保留 WebRTC 原生 ICE 路径选择，不增加自定义候选优先级或应用层数据隧道。
- coturn 开放 UDP/TCP 3478；可配置 TLS 监听（如 5349）及有限 UDP relay 端口范围。
- 不在浏览器中实现自定义 UDP/TCP 打洞、QUIC 隧道或虚拟网卡。
- 不引入 OpenP2P、go-gost/p2p 或 Linker 作为运行时依赖。
- TURN 流量直接访问 coturn 公网域名/IP，不经 EdgeOne HTTP/CDN 代理。
- Cloudflare Worker / Durable Object / Wrangler 不得继续作为运行时代码、生产配置或部署说明。
- 本地端到端网络测试不可用时，明确记录未实测；不能用单元测试代替公网验证。

---

## 文件责任图

- `backend/src/turnCredentials.ts`：纯 coturn REST 临时用户名/HMAC 凭据生成，便于确定性单测。
- `backend/src/server.ts`：Node HTTP 服务；保留 `/healthz`、WSS `/connect`，新增 `/api/turn-credentials`。
- `backend/src/protocol.ts`、`backend/src/signallingHub.ts`：Node 信令协议及房间转发边界；沿用 6 位房间 ID、64 KiB 消息上限。
- `app/config.ts`：前端信令 URL 与凭据 HTTP URL 的 EdgeOne 构造函数。
- `app/services/webRTC.ts`：获取 ICE 配置、构造 RTCPeerConnection、连接恢复与生命周期。
- `app/services/webRTCStats.ts`、`app/stores/webRTC.ts`、`app/routes/home.tsx`：候选质量读取、状态存储与诊断展示。
- `docker-compose.yml`、`deploy/coturn/turnserver.conf`、`deploy/coturn/entrypoint.sh`、`.env.example`：Node/coturn 服务定义、TURN 端口与非机密配置示例。
- `docs/DEPLOYMENT.md`、`README.md`：唯一的 Docker + EdgeOne 部署说明、端口/密钥/验证流程。
- `docs/WEBRTC-REFERENCE-RESEARCH.md`：参考项目适用性与路线图，不复制其源代码。
- `tests/backend/`、`tests/frontend/`：Node 协议/凭据/API 和浏览器 ICE/recovery 测试。

## A 阶段：Docker 信令与 TURN 兜底

### Task 1: 建立可测的 coturn REST 临时凭据生成器

**Files:**
- Create: `backend/src/turnCredentials.ts`
- Create: `tests/backend/turnCredentials.test.ts`

**Interfaces:**
- Produces `createTurnCredentials(secret: string, nowMs: number, ttlSeconds: number, subject: string): { username: string; credential: string; expiresAt: number }`.
- `username` 格式为 `${expiresAtUnixSeconds}:${subject}`；`credential` 是 UTF-8 username 的 HMAC-SHA1 结果经 Base64 编码；`expiresAt` 为 Unix 秒。
- Uses Node built-in `node:crypto`; do not add a runtime package.

- [ ] **Step 1: Add failing deterministic tests**

```ts
import { describe, expect, it } from "vitest";
import { createTurnCredentials } from "../../backend/src/turnCredentials";

describe("coturn REST credentials", () => {
  it("signs an expiring username with HMAC-SHA1 and Base64", () => {
    const result = createTurnCredentials("test-secret", 1_700_000_000_000, 3600, "nakiri");
    expect(result.username).toBe("1700003600:nakiri");
    expect(result.expiresAt).toBe(1_700_003_600);
    expect(result.credential).toBe("tfSatl2CG5j6lsrwR1sVqHhX7lw=");
  });

  it("rejects an empty secret, invalid TTL, or empty subject", () => {
    expect(() => createTurnCredentials("", 1_700_000_000_000, 3600, "nakiri")).toThrow();
    expect(() => createTurnCredentials("secret", 1_700_000_000_000, 0, "nakiri")).toThrow();
    expect(() => createTurnCredentials("secret", 1_700_000_000_000, 3600, "")).toThrow();
  });
});
```

The hard-coded expected Base64 HMAC value for this vector is `tfSatl2CG5j6lsrwR1sVqHhX7lw=`; do not compute expected values by calling the production function.

- [ ] **Step 2: Run the focused test and verify the missing module causes failure**

Run: `pnpm test -- tests/backend/turnCredentials.test.ts`
Expected: FAIL because `backend/src/turnCredentials.ts` does not exist.

- [ ] **Step 3: Implement the pure generator**

Use `createHmac` from `node:crypto`; validate non-empty secret/subject, positive finite TTL and finite timestamp; floor millisecond time to seconds, add TTL seconds, create `${expiry}:${subject}`, and return Base64 HMAC-SHA1 plus expiry. Do not log inputs or outputs.

- [ ] **Step 4: Run focused and backend build checks**

Run: `pnpm test -- tests/backend/turnCredentials.test.ts`
Expected: PASS.
Run: `pnpm --dir backend build`
Expected: PASS with generated `backend/dist` ignored by git.

- [ ] **Step 5: Commit the credential primitive**

```bash
git add backend/src/turnCredentials.ts tests/backend/turnCredentials.test.ts
git commit -m "feat: generate short-lived coturn credentials"
```

### Task 2: Expose bounded TURN credential endpoint from the Docker backend

**Files:**
- Modify: `backend/src/server.ts`
- Create: `backend/src/turnConfig.ts` if extracting parsing makes HTTP setup testable
- Create: `tests/backend/turnCredentialsRoute.test.ts`
- Modify: `.env.example` (create if absent)

**Interfaces:**
- `createSignallingServer(config: SignallingServerConfig): import("node:http").Server` returns an unbound server for production or ephemeral-port tests; config carries `turnSecret`, `turnUrls`, `turnCredentialTtlSeconds`, `allowedOrigins`, and `trustProxy`.
- `GET /api/turn-credentials` returns `{ iceServers: [{ urls: string[], username: string, credential: string }], expiresAt: number }`; use a fresh `crypto.randomUUID()` as the username subject suffix so the response does not encode an IP or room code.
- Configuration: `TURN_SECRET_FILE=/run/secrets/turn_secret`, comma-separated `TURN_URLS`, `TURN_CREDENTIAL_TTL_SECONDS` (default 3600, capped at 86400), `ALLOWED_ORIGINS`, `TRUST_PROXY` (default false). Read and trim the secret file once at startup; never accept the HMAC secret directly from a request or frontend environment.
- Requests from non-allowed browser origins are rejected when `ALLOWED_ORIGINS` is set; missing secret/URL returns 503 without exposing values. Rate limit per client address; trust forwarded client-IP headers only when `TRUST_PROXY=true` and the deployment explicitly places Node behind EdgeOne.

- [ ] **Step 1: Add route tests for valid response and invalid configuration**

Write the test in Vitest, following `tests/backend/server.test.ts`. Start the HTTP server on an ephemeral port through the exported `createSignallingServer(config)` test seam. Assert valid GET returns the exact JSON contract, missing secret and malformed URL return 503, non-GET returns 405, and a disallowed Origin returns 403. Assert the response contains only temporary credentials, never `TURN_SECRET`.

- [ ] **Step 2: Run the focused test and confirm the route is absent**

Run: `pnpm test -- tests/backend/turnCredentialsRoute.test.ts`
Expected: FAIL because `/api/turn-credentials` currently returns 404.

- [ ] **Step 3: Add configuration parsing, Origin policy and bounded rate limiting**

Add a pure config reader with defaults and validation. Use a fixed-window per-client in-memory limiter with a documented limit of 30 requests per 10 minutes; cap the map size and periodically remove expired buckets. Honor `X-Forwarded-For` only when `TRUST_PROXY=true`; otherwise use the socket remote address. Do not treat Origin as authentication. Return `Cache-Control: no-store` and JSON content type on all credential responses.

- [ ] **Step 4: Wire the endpoint without changing WebSocket behavior**

Refactor server creation to accept optional config and listener address for tests while preserving production `PORT`, `HOST`, `/healthz`, `maxPayload: 64 * 1024`, `/connect?id=<six digits>`, heartbeat ping/pong and room routing. Reject invalid path/method explicitly; do not log secret, password, full ICE credentials or candidate addresses.

- [ ] **Step 5: Run backend tests and build**

Run: `pnpm test -- tests/backend/turnCredentialsRoute.test.ts tests/backend/server.test.ts tests/backend/protocol.test.ts tests/backend/signallingHub.test.ts`
Expected: PASS.
Run: `pnpm --dir backend build`
Expected: PASS.

- [ ] **Step 6: Commit the HTTP endpoint**

```bash
git add backend/src/server.ts backend/src/turnConfig.ts tests/backend/turnCredentialsRoute.test.ts .env.example
git commit -m "feat: serve temporary TURN credentials"
```

### Task 3: Add coturn to Docker Compose with a closed relay policy

**Files:**
- Modify: `docker-compose.yml`
- Create: `deploy/coturn/turnserver.conf`
- Create: `tests/backend/dockerConfig.test.ts`
- Modify: `.env.example`
- Modify: `.gitignore` to exclude local `.env` and `secrets/` secret files
- Create: `deploy/coturn/entrypoint.sh` to render secret-bearing runtime config with mode 0600
- Modify: `docs/DEPLOYMENT.md` (TURN service/ports/secrets section only)

**Interfaces:**
- Service name: `coturn`; image pinned to an explicitly selected stable coturn release.
- Required deployment values: `TURN_SECRET_FILE` (path to local secret file, mounted as `/run/secrets/turn_secret`), `TURN_EXTERNAL_IP`, `TURN_REALM`, `TURN_URLS`; relay range `49160-49200/udp`; listener 3478/UDP and 3478/TCP; optional 5349/TCP TLS only when a certificate path is provided.
- Use a Compose file-backed secret for both Node and coturn. Node reads `/run/secrets/turn_secret`; `deploy/coturn/entrypoint.sh` reads the mounted secret and creates a mode-0600 runtime config before starting coturn. Never expose the long-term secret to frontend builds, command-line arguments, logs or version control.

- [ ] **Step 1: Add Compose configuration assertions**

Create a focused test (or extend a repository configuration test) that reads `docker-compose.yml` and verifies the `nakiri-signalling` and `coturn` services, secret interpolation, UDP/TCP 3478 mappings, and matching relay port range. Include checks that the tracked coturn template disables anonymous access and does not contain a literal secret, and that the entrypoint reads `/run/secrets/turn_secret` and adds `use-auth-secret` plus `static-auth-secret` to the runtime config.

- [ ] **Step 2: Run the focused config test and confirm coturn is absent**

Run: `pnpm test -- tests/backend/dockerConfig.test.ts`
Expected: FAIL because Compose has no `coturn` service.

- [ ] **Step 3: Add the coturn configuration**

Configure `listening-port=3478`, `fingerprint`, `lt-cred-mech`, `use-auth-secret`, `realm`, `external-ip`, bounded `min-port`/`max-port`, `no-cli`, and disable anonymous/legacy insecure modes. The entrypoint appends `static-auth-secret` from `/run/secrets/turn_secret` to a mode-0600 runtime copy; the checked-in config template never contains the secret. Do not commit generated TLS keys. The compose service must expose UDP and TCP listener ports plus only the chosen UDP relay range, restart unless stopped, and use a health check supported by the pinned image.

- [ ] **Step 4: Connect backend and coturn configuration**

Mount the same file-backed Compose secret at `/run/secrets/turn_secret` into the Node backend and coturn. Set `TURN_URLS` to direct coturn hostnames (`turn:turn.example.com:3478?transport=udp` and `turn:turn.example.com:3478?transport=tcp`). Use `.env.example` with `TURN_SECRET_FILE=./secrets/turn_secret` and `turn.example.com`; create the actual secret file locally under ignored `secrets/`.

- [ ] **Step 5: Verify Compose syntax and tests**

Run: `pnpm test -- tests/backend/dockerConfig.test.ts`
Expected: PASS.
Before Compose validation, create a local ignored secret and config using `node -e "require('node:fs').mkdirSync('secrets',{recursive:true});require('node:fs').writeFileSync('secrets/turn_secret',require('node:crypto').randomBytes(32))"` and `Copy-Item .env.example .env` in PowerShell. Run `docker compose config --quiet`.
Expected: exit 0 with local variables and secret file present; without them the command must fail closed with the missing value named.

- [ ] **Step 6: Commit coturn deployment**

```bash
git add docker-compose.yml deploy/coturn/turnserver.conf .env.example docs/DEPLOYMENT.md tests/backend/dockerConfig.test.ts
git commit -m "feat: deploy coturn with Docker"
```

### Task 4: Load dynamic ICE configuration in both WebRTC roles

**Files:**
- Modify: `app/config.ts`
- Create: `app/services/iceConfiguration.ts`
- Modify: `app/services/webRTC.ts`
- Modify: `app/stores/webRTC.ts`
- Create: `tests/frontend/iceConfiguration.test.ts`
- Modify: `tests/frontend/webRTC.test.ts`

**Interfaces:**
- `getTurnCredentialsUrl(signalingUrl: string): string` converts `wss:` to `https:` and `ws:` to `http:`, retaining the signaling host and replacing path with `/api/turn-credentials`.
- `fetchIceConfiguration(signalingUrl: string, fetcher = fetch): Promise<{ iceServers: RTCIceServer[]; warning?: string }>` derives `/api/turn-credentials` with `getTurnCredentialsUrl`, validates the response and falls back to the existing public STUN list with a user-visible warning.
- `WebRTCService.connect(to)` obtains validated ICE configuration before creating a new `RTCPeerConnection`; sender and receiver use the same path. No TURN secret is compiled into client assets.

- [ ] **Step 1: Add failing URL and endpoint-response tests**

Test `wss://signal.example.com/connect` maps to `https://signal.example.com/api/turn-credentials`; test `ws:` development maps to `http:`; test valid ICE JSON is returned; test HTTP failure, invalid JSON and empty URL arrays return STUN-only configuration with a warning.

- [ ] **Step 2: Run the focused test**

Run: `pnpm test -- tests/frontend/iceConfiguration.test.ts`
Expected: FAIL because the credential URL and ICE loader do not exist.

- [ ] **Step 3: Implement safe ICE configuration loading**

Keep the current two public STUN URLs as the fallback. Validate that each server has a string or non-empty string-array `urls`, and that credential responses carry string username/credential. Never include API response bodies in user-facing errors or logs. Return only the validated servers and a concise warning on downgrade.

- [ ] **Step 4: Make PeerConnection creation asynchronous and attach diagnostics**

In `WebRTCService.connect`, await `fetchIceConfiguration(getSignalingBaseUrl())` before `new RTCPeerConnection({ iceServers })`; if the PC has become obsolete during the await, do not attach handlers or overwrite the active connection. Store the STUN-only warning in `lastError` and clear it after a valid response. Preserve existing candidate buffering, sender quality, media cleanup and stats polling.

- [ ] **Step 5: Test both sender and receiver paths and run typecheck**

Extend fake fetch/PeerConnection tests to assert the generated RTCConfiguration contains the returned TURN server for both an explicit sender connect and an incoming receiver offer. Assert credential-fetch failure leaves STUN-only connection possible and reports warning.

Run: `pnpm test -- tests/frontend/iceConfiguration.test.ts tests/frontend/webRTC.test.ts tests/frontend/config.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit dynamic ICE integration**

```bash
git add app/config.ts app/services/iceConfiguration.ts app/services/webRTC.ts app/stores/webRTC.ts tests/frontend/iceConfiguration.test.ts tests/frontend/webRTC.test.ts
git commit -m "feat: use temporary TURN ICE configuration"
```

### Task 5: Make Docker + EdgeOne the sole deployment and remove old Worker files

**Files:**
- Modify: `app/config.ts`, `tests/frontend/config.test.ts`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `.gitignore`
- Delete: `worker/` (entire Worker/Wrangler project)
- Delete: `tests/worker/`
- Delete: `docs/superpowers/specs/2026-10-01-webrtc-hardening-design.md`
- Delete: `docs/superpowers/plans/2026-10-01-webrtc-hardening.md`
- Modify: `docs/superpowers/specs/2026-10-01-webrtc-stability-quality-design.md` to remove its single obsolete Cloudflare deployment non-goal while preserving the applicable WebRTC stability/quality history
- Preserve: `docs/superpowers/plans/2026-10-01-webrtc-stability-quality.md`; its `workers` reference describes agentic plan execution, not Cloudflare deployment

**Interfaces:**
- Frontend production signaling uses the EdgeOne-proxied Docker WSS endpoint through `VITE_SIGNALING_URL`; keep a non-Cloudflare EdgeOne example value and never silently fall back to the old third-party endpoint.
- Compose backend remains the authoritative implementation for `/connect`, `/healthz`, and `/api/turn-credentials`.
- Remove the `/worker` ignore entries once that directory is deleted; do not remove unrelated ignores.

- [ ] **Step 1: Add regression assertions for the EdgeOne deployment default**

Change `tests/frontend/config.test.ts` to assert the documented EdgeOne Docker signal URL, preservation of query parameters, and that empty configuration does not return `workers.dev`, `cloudflare`, or the old `signaling.pexni.com` URL.

- [ ] **Step 2: Run the config test and establish current failure**

Run: `pnpm test -- tests/frontend/config.test.ts`
Expected: FAIL because the current default is `wss://signaling.pexni.com/connect`.

- [ ] **Step 3: Switch the frontend default and build-time settings**

Set the production default to the documented EdgeOne-proxied Docker endpoint from `docs/DEPLOYMENT.md`; keep `VITE_SIGNALING_URL` override for staging/preview. Ensure `buildSignalingUrl` still adds the six-digit `id` exactly once.

- [ ] **Step 4: Rewrite current deployment guidance**

Update README and `docs/DEPLOYMENT.md` so Docker + EdgeOne is the only supported deployment path. Include EdgeOne Pages build settings, EdgeOne WebSocket origin route, `/api/turn-credentials` HTTP origin route with cache disabled, Docker Compose launch, `.env` setup, required security-group ports, coturn public DNS (not EdgeOne proxy), temporary-secret rotation, health/WSS probes and same-network/cross-network/forced-relay checks. Remove obsolete Cloudflare instructions, the standalone Nginx deployment alternative, and claims of multiple supported paths; describe Nginx only if it is an internal reverse-proxy implementation detail within the Docker + EdgeOne deployment.

- [ ] **Step 5: Remove retired implementation and historical Cloudflare deployment docs**

Delete `worker/`, `tests/worker/`, and old Cloudflare-specific spec/plan documents listed above. Remove only obsolete `.gitignore` worker entries and Worker-only project dependencies after checking lockfile ownership. Preserve the root `pnpm-lock.yaml` optional `wrangler` peer metadata declared by `@react-router/dev`; it is not an installed deployment dependency. Do not delete the newly approved Docker + EdgeOne design spec or the current implementation plan while they are needed for the work.

- [ ] **Step 6: Search for active Cloudflare deployment references**

Run PowerShell search over active code and docs, excluding `.git`, `node_modules`, `build`, and the approved design/plan records that describe this migration:

```powershell
Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\.git\\|\\node_modules\\|\\build\\|docs\\superpowers\\specs\\2026-10-01-docker-edgeone-webrtc-design\.md$|docs\\superpowers\\plans\\2026-10-01-docker-edgeone-webrtc\.md$' -and $_.Name -ne 'pnpm-lock.yaml' } | Select-String -Pattern 'workers\.dev|wrangler|Durable Object|Cloudflare Workers|Cloudflare Worker' | Select-Object Path,LineNumber,Line
```

Expected: no active source, deployment file, README or current deployment guide references. The two approved planning artifacts may describe the deletion objective.

- [ ] **Step 7: Run frontend/backend regression checks and commit the migration**

Run: `pnpm test`
Expected: PASS with all Worker-only tests removed and backend equivalents retained.
Run: `pnpm typecheck`
Expected: PASS.
Run: `pnpm --dir backend build`
Expected: PASS.

```bash
git add -A
git commit -m "refactor: make Docker and EdgeOne the only deployment"
```

---

## B 阶段：直连优先、可观测与恢复

### Task 6: Extend WebRTC stats with selected path and round-trip time

**Files:**
- Modify: `app/services/webRTCStats.ts`
- Modify: `app/routes/home.tsx`
- Modify: `tests/frontend/webRTCStats.test.ts`
- Modify: `tests/frontend/webRTC.test.ts` only if its fake stats needs the new fields

**Interfaces:**
- Extend `WebRTCStats` with `rttMs?: number` and selected `candidateType?: string` (retain existing field name).
- `normalizeWebRTCStats(report, role)` follows selected/nominated candidate-pair IDs and resolves local/remote candidates; candidate addresses and SDP are never returned.

- [ ] **Step 1: Add stats fixtures for direct, relay and missing candidate records**

Test selected candidate pair with `localCandidateId`, `remoteCandidateId`, `currentRoundTripTime`, local type `host` and `relay`; include missing selected-pair/candidate rows and malformed optional numeric values.

- [ ] **Step 2: Run the focused stats test and verify failures**

Run: `pnpm test -- tests/frontend/webRTCStats.test.ts`
Expected: FAIL for RTT and remote candidate parsing expectations.

- [ ] **Step 3: Normalize only selected-pair metrics**

Resolve `candidate-pair` by selected/nominated state, then referenced local and remote candidate rows. Convert `currentRoundTripTime` seconds to milliseconds, accept finite numbers only, and preserve current bitrate/frame/video dimensions behavior. Unknown candidate data yields `undefined`.

- [ ] **Step 4: Display safe connection-path diagnostics**

Show `direct` when selected local candidate type is non-relay, `TURN 中继` when `relay`, RTT when available, and “暂无数据” otherwise. Never display candidate IP/port or raw stats report.

- [ ] **Step 5: Run frontend tests and typecheck**

Run: `pnpm test -- tests/frontend/webRTCStats.test.ts tests/frontend/webRTC.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit path diagnostics**

```bash
git add app/services/webRTCStats.ts app/routes/home.tsx tests/frontend/webRTCStats.test.ts tests/frontend/webRTC.test.ts
git commit -m "feat: show selected WebRTC path and RTT"
```

### Task 7: Attempt ICE restart before rebuilding a failed sender connection

**Files:**
- Modify: `app/services/webRTC.ts`
- Modify: `app/stores/webRTC.ts` only if a recovery-attempt diagnostic field is necessary
- Modify: `tests/frontend/webRTC.test.ts`

**Interfaces:**
- Add private `restartIceAndRenegotiate(peerConnection: RTCPeerConnection): Promise<boolean>`; it returns true only after an ICE-restart offer is sent successfully over an open signaling socket. Generate that offer with `createOffer({ iceRestart: true })` rather than calling both `restartIce()` and `createOffer()` (which can schedule duplicate negotiation).
- Add one sender-only recovery generation/lock and a 10-second ICE-restart answer timeout so old callbacks cannot restart or close a newer PeerConnection and an unanswered restart cannot hang forever.
- Keep the current full reconnection as fallback, and keep the existing disconnected grace window.

- [ ] **Step 1: Add failing tests for restart-first and fallback behavior**

Extend `FakePeerConnection` so `createOffer(options)` records the options and can reject on demand; track offer sends. Assert a failed sender with open signaling calls `createOffer({ iceRestart: true })` and sends an offer without constructing a second PC; assert offer/setLocalDescription/send failure causes exactly one fresh PC; assert stale callbacks and simultaneous failed/disconnected events do not create duplicate recovery.

- [ ] **Step 2: Run the focused lifecycle tests**

Run: `pnpm test -- tests/frontend/webRTC.test.ts`
Expected: FAIL because recovery currently closes and replaces the PC immediately.

- [ ] **Step 3: Implement guarded ICE restart negotiation**

Before creating a new PeerConnection, verify the existing PC is current and signaling state is `stable`; create the offer with `{ iceRestart: true }`, set that local description, and send the `offer`. Do not also call `restartIce()`, which can schedule a competing `negotiationneeded` event. Return false and capture a concise diagnostic if any stage fails. Do not close a connection after the restart offer was accepted for signaling.

- [ ] **Step 4: Preserve reconnect and offer/answer failure behavior**

On signaling reconnection, attempt recovery only once per generation. If restart cannot be issued, or no valid answer returns within 10 seconds, close and fully recreate the sender PeerConnection with the existing local stream. Cancel the timeout when a valid answer is applied or the connection reaches `connected`; clear timers and locks on `close()`. Reuse existing queued ICE handling for incoming answer/candidates.

- [ ] **Step 5: Run focused lifecycle tests and complete project checks**

Run: `pnpm test -- tests/frontend/webRTC.test.ts tests/frontend/webRTCStats.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.
Run: `pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit ICE recovery**

```bash
git add app/services/webRTC.ts app/stores/webRTC.ts tests/frontend/webRTC.test.ts
git commit -m "feat: restart ICE before rebuilding WebRTC peers"
```

---

## C 阶段：开源调研与实施闭环

### Task 8: Publish the local WebRTC/NAT traversal project comparison

**Files:**
- Create: `docs/WEBRTC-REFERENCE-RESEARCH.md`
- Modify: `README.md` to link the research and current deployment guide

**Interfaces:**
- The report covers the four local repositories `Godot-WebRTC-Match-Maker`, `p2p`, `linker`, `openp2p`.
- Each project entry contains its role, observed method, reusable principle, incompatibility/risks, and license-review note; do not copy source code.
- End with the approved A→B→C implementation and measurement roadmap.

- [ ] **Step 1: Draft the comparison from the inspected repository materials**

For each repository record the README/source file evidence consulted and separate documented project capability from inference. Include that Godot Match Maker is a WebRTC signaling example with TURN fallback, Go `p2p`/DERP and the Linker/OpenP2P systems are not browser runtime libraries. Mention shared relays, direct-path upgrade, IPv6/UPnP and QUIC/KCP only as patterns to assess, not promises to implement.

- [ ] **Step 2: Verify the report has no unsupported claims or copied source**

Check each capability against the local repository README/docs; note project license identifiers as found in each repository's LICENSE file, without giving legal advice. Where the license file cannot be found, explicitly record that verification is still required before code reuse.

- [ ] **Step 3: Run documentation formatting and commit**

Run: `git diff --check`
Expected: no whitespace errors.

```bash
git add docs/WEBRTC-REFERENCE-RESEARCH.md README.md
git commit -m "docs: compare local WebRTC traversal projects"
```

### Task 9: Validate the Docker + EdgeOne cutover and record deployment evidence

**Files:**
- Modify: `docs/DEPLOYMENT.md` only for verified findings
- Modify: `README.md` only for final command/link corrections
- No new smoke-test scripts; reuse the existing `backend` probe and project test suites

- [ ] **Step 1: Run all automated validation**

Run: `pnpm test`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS.
Run: `pnpm build`
Expected: PASS.
Run: `pnpm --dir backend build`
Expected: PASS.
Run: `docker compose config --quiet`
Expected: exit 0 with real deployment variables supplied outside version control.

- [ ] **Step 2: Validate the public Docker/EdgeOne signaling route**

With the existing EdgeOne/Docker endpoint `signaling-server.unia.love` and `.env` configured, run the existing `backend` WSS probe via `WSS_URL=wss://signaling-server.unia.love/connect bash scripts/deploy-docker.sh` (use the repository's PowerShell deployment equivalent on Windows if needed). Confirm HTTP 101 and one test signal reaches the correct peer; report the endpoint as untested if its DNS or credentials are unavailable.

- [ ] **Step 3: Validate coturn credentials and ports from a real network**

Request a short-lived credential over HTTPS and confirm no response/log exposes `TURN_SECRET`. With two devices on distinct networks, test direct candidate selection and a forced-relay test using browser ICE policy `relay` in a temporary test-only browser configuration; verify the candidate pair is relay and media works. Verify UDP listener and configured relay range are reachable from outside the host. Record unavailable real-network scenarios as not tested.

- [ ] **Step 4: Verify Cloudflare deployment removal without scanning approved planning history**

Repeat Task 5's active-source/docs scan. Confirm the Worker tree, worker tests, Wrangler config, old Cloudflare deployment procedure and obsolete deployment specs/plans are absent. Verify only the newly approved architecture/implementation planning artifacts retain migration context.

- [ ] **Step 5: Review final diff and commit evidence corrections**

Run: `git diff --check`
Expected: clean.
Run: `git status --short`
Expected: only intentional final documentation corrections before committing.

```bash
git add README.md docs/DEPLOYMENT.md
git commit -m "docs: finalize Docker EdgeOne deployment validation"
```

## Final acceptance checklist

- Docker Compose runs the Node signaling and closed-auth coturn services with documented ports and secret handling.
- Frontend sends signaling and credential requests to the EdgeOne-proxied Docker service; no Worker/Wrangler runtime remains.
- Short-lived TURN credentials work without exposing the long-term secret; STUN-only fallback is visible and never represented as relay success.
- Existing direct WebRTC behavior remains; selected path and RTT are safely observable; ICE restart is attempted before complete sender rebuild.
- Root tests, typecheck/build, backend build and Compose validation pass; real EdgeOne/coturn checks are reported separately from automated checks.
- Research report compares the local projects and offers a useful follow-up route without importing unrelated tunnel runtimes.
