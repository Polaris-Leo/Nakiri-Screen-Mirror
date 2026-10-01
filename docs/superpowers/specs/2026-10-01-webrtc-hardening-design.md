# Nakiri Screen Mirror 稳定性与安全加固设计

## 背景

项目当前由 React Router 前端、浏览器 WebRTC 和 Cloudflare Worker + Durable Object 信令服务组成。现有实现可以完成基本投屏，但存在单 Durable Object 承载全部房间、信令消息缺少校验、WebSocket 重连竞态、本地媒体轨道未释放、ICE Candidate 早到处理不足以及生产配置硬编码等问题。

## 目标

- 保持现有“打开页面、输入 6 位投屏码、开始屏幕共享”的用户流程；
- 让每个投屏码对应独立的 Durable Object 房间；
- 拒绝非法连接参数和信令消息，避免异常输入导致 Worker 出错；
- 在网络抖动、主动断开和 PeerConnection 失败时正确清理并恢复；
- 断开投屏后释放屏幕、麦克风和摄像头轨道；
- 允许通过 `VITE_SIGNALING_URL` 配置不同环境的信令地址；
- 用可自动验证的测试覆盖关键协议和生命周期行为。

## 非目标

- 本次不引入 TURN 服务供应商或新的外部基础设施；
- 本次不重做页面视觉设计；
- 本次不增加账号系统、房间持久化或复杂权限模型；
- 不迁移 Durable Object 的既有迁移格式，避免未经验证影响线上 namespace。

## 设计

### 1. Durable Object 房间分片

Worker 从 `/connect?id=<roomId>` 读取并校验 6 位数字投屏码，使用 `idFromName(roomId)` 获取对应的 Durable Object。不同投屏码进入不同对象，同一投屏码内的连接仍由同一对象协调。

当前固定的 `default` 对象将被移除。现有 `SignallingServer` 类和 `new_sqlite_classes` 迁移保留不变。

### 2. 信令协议校验

允许的消息类型为 `offer`、`answer` 和 `ice_candidate`。Worker 对每条消息执行以下检查：

- 文本消息必须是合法 JSON；
- 消息大小不得超过 64 KiB；
- `type` 必须是允许的字符串；
- `to` 必须是 6 位数字；
- 服务端始终覆盖客户端提供的 `from`，使用连接建立时保存的 ID；
- 非法消息关闭当前 WebSocket，不广播给其他客户端。

Worker 对缺失或非法的房间 ID 返回 400；未知路径仍返回 404。

### 3. WebSocket 生命周期

客户端服务增加主动关闭标记和连接代次，避免旧连接的 `onclose` 影响新连接。只有异常关闭且当前连接仍属于本次连接代次时才安排重连。

发送消息前必须确认 WebSocket 为 `OPEN`。重连继续使用指数退避和最大尝试次数，手动断开后不再自动重连。心跳计时器和重连计时器在关闭时统一清理。

### 4. WebRTC 生命周期与 ICE

`WebRTCService` 保存本地 `MediaStream`，关闭 PeerConnection 时停止全部本地轨道并清空引用。

收到远端 ICE Candidate 但尚未设置 Remote Description 时，将 Candidate 暂存；完成 Remote Description 后按顺序添加。ICE 添加失败和 offer/answer 协商失败进入统一错误处理，不产生未处理 Promise rejection。

已关闭或失败的 PeerConnection 不复用。连接状态进入 `failed` 或 `closed` 时清理对应资源。

### 5. 前端配置与隐私

信令地址从 `import.meta.env.VITE_SIGNALING_URL` 读取，默认值保留当前域名以兼容现有部署。构造 WebSocket URL 时追加 `id` 查询参数。

投屏码不再永久写入 localStorage，改为 sessionStorage，使浏览器会话结束后生成新码。移除 root layout 中的第三方统计脚本，减少非必要外部依赖。

### 6. 测试与验证

新增测试覆盖：

- Worker 房间分片使用投屏码而不是固定名称；
- 非法 ID、非法 JSON、未知消息类型和过大消息会被拒绝；
- 合法消息会覆盖 `from` 并只广播给目标 ID；
- WebSocket 主动断开不会触发重连；
- WebRTC 早到 ICE Candidate 会排队，设置 Remote Description 后再添加；
- 关闭 WebRTC 会停止本地媒体轨道；
- 前端配置读取 `VITE_SIGNALING_URL`。

验证命令至少包括：

```bash
pnpm typecheck
pnpm build
cd worker
pnpm exec tsc --noEmit
```

## 风险与兼容性

- 生产环境如果仍有旧前端连接到固定 `default` Durable Object，部署 Worker 后旧客户端可能无法与新房间模型互通；前后端应一起发布。
- 投屏码仍然是短数字标识，不是身份认证凭据；本次仅降低误连接和协议攻击风险，不提供强认证。
- 没有 TURN 时，严格 NAT 网络中的 WebRTC 连接仍可能失败；本次只保留后续增加 TURN 的配置边界。
- Cloudflare Durable Object 迁移配置不做结构性升级，避免改变已有存储 namespace。
