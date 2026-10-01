# WebRTC 链路稳定性、连接诊断与媒体质量改造设计

## 背景与目标

当前项目已经能够通过 WebSocket 完成 WebRTC 信令交换，但存在四类问题：

1. 前端心跳发送的 `ping` 会被后端当作非法信令消息，导致 WebSocket 被关闭；
2. 前端只展示笼统的服务连接失败提示，无法区分 WebSocket、ICE、PeerConnection 和媒体状态；
3. 需要明确并验证服务器只负责信令隧道，不中转屏幕视频；
4. 屏幕采集没有清晰度和帧率选择，默认浏览器参数导致帧率和画面质量不稳定。

本次改造目标：

- 让 WebSocket 在短暂网络抖动后自动恢复，不因心跳协议冲突主动断开；
- 在页面中展示信令链路、ICE、PeerConnection 和媒体统计；
- 保持视频通过浏览器之间的 WebRTC PeerConnection 传输，Node.js/Nginx/EdgeOne 只处理信令；
- 提供可选的分辨率、帧率和码率档位，并在浏览器不支持时安全降级；
- 保持现有六位投屏码和 `/connect` 信令协议兼容。

## 架构边界

```text
浏览器 A（采集端）
  ├─ WebSocket：offer / answer / ICE / ping
  │       ↓
  │  Node.js + Nginx/EdgeOne：仅转发信令
  │       ↑
  └─ WebSocket：offer / answer / ICE / pong

浏览器 A ───────── WebRTC PeerConnection ───────── 浏览器 B（观看端）
                         屏幕视频/音频
```

服务器不得接收或转发 RTP/RTCP 视频数据。服务器只接受：

- `offer`
- `answer`
- `ice_candidate`
- 文本心跳 `ping`

服务器对文本 `ping` 返回 `pong`，其余不符合信令协议的消息仍以 `1008` 关闭连接。

## 方案设计

### 1. WebSocket 稳定性

前端 WebSocket 服务改为以下状态模型：

```text
disconnected → connecting → connected
                     ↓           ↓
                 reconnecting ← closed/error/heartbeat-timeout
```

重连策略：

- 使用指数退避：1、2、4、8、16 秒，最大 30 秒；
- 每次间隔加入 0~25% 随机抖动，避免多个客户端同时重连；
- 不设置 5 次硬上限，直到用户主动断开或页面卸载；
- 同一连接代次只允许一个重连定时器；
- 连接成功后清零重试计数，重新启动心跳；
- `ping` 未在 5 秒内收到 `pong` 时关闭当前连接并进入重连；
- 发送信令时，如果连接尚未建立，返回明确失败状态，不静默丢弃。

状态存储增加：

- `reconnectAttempts`
- `lastError`
- `lastConnectedAt`
- `lastDisconnectedAt`
- `currentUrl`

### 2. WebRTC 重连与连接诊断

WebRTC 状态存储增加：

- `connectionState`
- `iceConnectionState`
- `iceGatheringState`
- `signalingState`
- `role`：`sender` 或 `receiver`
- `peerId`
- `lastError`
- 当前媒体统计

当 PeerConnection 进入 `failed` 或 `disconnected`：

- 先等待信令连接恢复；
- 采集端保留本地 MediaStream；
- 尝试创建新的 PeerConnection 并重新发送 offer；
- 观看端等待新的 offer 并重新创建 answer；
- 多次失败后在诊断面板中给出明确原因，而不是只显示“服务器连接失败”。

诊断面板至少展示：

- 信令：已连接、连接中、重连中、失败；
- WebRTC：连接状态、ICE 状态、信令状态；
- 媒体：发送端或接收端、分辨率、FPS、码率；
- 网络：ICE 候选类型和当前候选对；
- 服务器媒体职责说明：视频流未经过信令服务器。

统计数据通过 `RTCPeerConnection.getStats()` 定时读取：

- 发送端优先读取 `outbound-rtp`；
- 接收端优先读取 `inbound-rtp`；
- 使用 `framesPerSecond`、`frameWidth`、`frameHeight`、`bytesSent`、`bytesReceived`；
- 兼容浏览器缺少字段的情况，显示“暂无数据”而不是报错。

### 3. 媒体质量档位

新增统一质量配置：

```ts
type ScreenQuality = "balanced" | "hd" | "ultra" | "4k";
```

默认档位为 `hd`：

| 档位 | 目标分辨率 | 目标帧率 | 目标最大码率 |
| --- | ---: | ---: | ---: |
| balanced | 1920×1080 | 30 FPS | 6 Mbps |
| hd | 1920×1080 | 60 FPS | 10 Mbps |
| ultra | 2560×1440 | 60 FPS | 14 Mbps |
| 4k | 3840×2160 | 30 FPS | 20 Mbps |

采集端行为：

- 将目标宽度、高度和帧率传给 `getDisplayMedia`；
- 成功采集后对视频轨道调用 `applyConstraints`；
- 设置 `contentHint = "detail"`，优先保持文字和桌面细节；
- 对对应 `RTCRtpSender` 设置 `maxBitrate`、`maxFramerate` 和 `degradationPreference = "maintain-resolution"`；
- 如果浏览器拒绝约束，自动退回 `balanced`，不阻断投屏；
- 质量选择只影响新建或重新协商的投屏连接。

质量选择器放在投屏提交区域，连接建立后展示当前实际统计值，避免将目标值误认为实际输出值。

### 4. 服务端协议与安全边界

后端保留现有 64 KiB 最大消息限制和六位连接码校验，并增加：

- `ping`/`pong` 控制消息处理；
- 健康接口继续只表示 HTTP 进程存活，并明确标注 WebSocket 路径；
- 非信令消息拒绝并记录可诊断日志；
- 不新增视频数据转发接口，不保存媒体流。

## 文件与模块边界

- `backend/src/server.ts`：心跳控制消息和 HTTP 健康响应；
- `backend/src/protocol.ts`：消息类型和控制消息判断；
- `app/services/webSocket.ts`：重连、心跳、错误状态和发送结果；
- `app/services/webRTC.ts`：重协商、媒体约束、发送器参数和统计采集；
- `app/stores/webSocket.ts`：信令诊断状态；
- `app/stores/webRTC.ts`：WebRTC 和媒体统计状态；
- `app/config.ts` 或新增 `app/media.ts`：质量档位定义；
- `app/routes/home.tsx`：质量选择器和诊断面板；
- `tests/backend/`：心跳和协议测试；
- `tests/frontend/`：重连状态、质量配置和统计归一化测试；
- `docs/DEPLOYMENT.md`：补充稳定性检查和服务器不转发视频的说明。

## 测试与验收标准

自动化测试：

- 后端收到 `ping` 返回 `pong`，不会关闭连接；
- 后端仍拒绝非法 JSON 和未知信令类型；
- 重连退避有最大间隔、无固定次数上限，并正确清理旧定时器；
- WebRTC 质量档位生成正确的采集约束和发送器参数；
- 统计归一化能处理缺失字段；
- 全量现有测试保持通过。

手工验收：

1. 关闭并恢复 Nginx/EdgeOne 或临时断网，页面能进入重连并自动恢复；
2. 页面能分别显示 WebSocket、ICE、PeerConnection 和媒体状态；
3. 浏览器开发者工具显示视频连接为 PeerConnection，服务器仅出现信令请求；
4. 切换四档质量后，实际分辨率和帧率在诊断面板中可观察；
5. 在不支持 4K/60 FPS 的设备上自动降级且仍能完成投屏；
6. 两台跨网络设备至少验证一次直连，无法直连时明确显示 ICE 失败原因。

## 非目标

- 本次不引入 TURN 服务；没有 TURN 时，严格 NAT/企业网络仍可能无法建立 P2P；
- 本次不把视频流改为服务器转发或录制；
- 本次不引入账号系统或长期设备状态存储。
