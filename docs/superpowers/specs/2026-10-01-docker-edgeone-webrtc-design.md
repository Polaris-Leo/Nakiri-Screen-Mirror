# Docker + EdgeOne WebRTC 穿透与部署改造设计

## 状态与背景

架构方向已获用户确认；本规格待用户审阅。实施顺序为 A → B → C。当前应用由 React Router 前端、浏览器 WebRTC 和 WebSocket 信令组成。仓库内已有 `backend/` Node WebSocket 信令实现及 `docker-compose.yml`，但前端默认信令地址仍指向 Cloudflare Worker；另有 `worker/`、Durable Objects 与 Wrangler 配置。WebRTC ICE 配置仅含公共 STUN，没有 TURN。目标部署方式限定为 Docker + EdgeOne，不保留 Cloudflare 部署依赖。

## 目标

- 提升严格 NAT / 跨运营商环境下的连接成功率：优先 P2P 直连，失败时由 coturn 中继兜底。
- 使用 Docker 部署 Node 信令与 coturn；EdgeOne 托管前端，并将 WebSocket 信令路径反向代理到 Docker 信令服务。
- TURN 长期共享密钥只保存在服务端；通过信令服务签发有时效的临时凭据。
- 改善网络切换及抖动后的恢复，同时保留连接诊断能力。
- 以调研文档总结本地开源项目中可复用的思想，给出后续路线；不直接移植不适合浏览器的系统级隧道实现。
- 清除本项目的 Cloudflare Workers、Durable Objects、Wrangler 部署入口及相关文档引用。

## 非目标

- 不在浏览器中实现自定义 UDP/TCP 打洞、QUIC 隧道或虚拟网卡。
- 不引入 OpenP2P、go-gost/p2p 或 Linker 作为运行时依赖。
- 不更换 EdgeOne 产品，不承诺 EdgeOne 代替 TURN 媒体中继。
- 不改变投屏码和现有主要用户流程，不建设账号、计费或多租户平台。
- 不保证所有网络均可连接；UDP 完全封锁且 TCP/TLS TURN 也不可达的网络仍可能失败。

## 总体架构与数据流

1. EdgeOne 托管前端静态资源，并配置站点域名/源站规则，将 `/connect` WebSocket 请求转发到 Docker 信令服务；前端使用同域 WSS 地址。
2. Docker Compose 运行现有 Node 信令服务与 coturn。Node 服务承载房间信令和 TURN 临时凭据接口；coturn 只承载 WebRTC 媒体中继，不承担房间信令。
3. 浏览器建立连接前从 Node 服务取得短期 ICE 凭据，和 STUN/TURN URL 一起创建 `RTCPeerConnection`。ICE 继续根据候选优先级选择可用路径，优先直连，无法直连时使用 relay candidate。
4. WebRTC 统计将用于确认选中候选类型，并观测连接质量；敏感 ICE 地址和 TURN 凭据不写入持久日志。
5. TURN 流量直接访问 coturn 公网域名/IP，不经 EdgeOne HTTP/CDN 代理。EdgeOne 的 WebSocket 代理仅用于信令，不能当作 UDP/TURN 中继。

## A 阶段：Docker coturn 与短期凭据（最高优先级）

### 服务端

- Node 信令服务增加 HTTP 凭据接口（建议 `/api/turn-credentials`）并限制允许的前端 Origin；生产环境由 EdgeOne 将该路径代理到同一 Node 源站，避免浏览器跨域配置。
- 使用 coturn REST API 兼容的短期凭据：服务端密钥通过 Docker secret 或未纳入版本控制的环境变量提供；按过期时间生成 username，并用 HMAC-SHA1 计算 password。仅将短期 username/password 和 ICE server URL 返回浏览器。
- 凭据有明确短 TTL；接口进行输入校验、速率限制和安全日志处理。投屏码仅是短期配对标识，并非强身份认证，必须将其滥用风险写入部署文档。
- 环境变量、示例模板、默认值和错误处理明确区分生产密钥与本地测试值；仓库不包含真实密钥。

### coturn / Docker

- Compose 为信令与 TURN 配置独立服务、健康检查、重启策略和必要网络端口。
- coturn 开放 UDP/TCP 3478；可配置 TLS 监听（如 5349）及有限 UDP relay 端口范围。relay 范围必须同时映射/放通并与配置一致。
- 若主机位于 NAT 后，配置外部可达地址；部署文档列明安全组、防火墙、DNS、EdgeOne 代理模式和端口要求。
- TURN 用户鉴权使用短期 REST 凭据，禁止 anonymous/开放中继；尽可能限制 relay 带宽/并发并记录资源监控建议。

### 前端

- ICE server 配置由环境配置及凭据接口动态生成，保留可用于开发/测试的明示配置。
- 获取凭据失败时给出诊断状态；是否允许仅 STUN 继续作为降级路径需在实现阶段根据错误分类测试，不得误报 TURN 可用。
- 通过 `getStats()` 确认 selected candidate pair 的本地/远端 candidate type；测试覆盖 relay candidate 的解析与缺失 stats 时的安全降级。

## B 阶段：直连优先、路径观测与恢复

- 保留 WebRTC 原生 ICE 路径选择，不增加自定义候选优先级或应用层数据隧道。
- 扩展现有 stats 归一化信息，至少读取候选类型及可用的 RTT/收发码率；诊断只呈现必要的连接质量信息，不输出候选地址、凭据或完整 SDP。
- `disconnected` 先等待有限宽限期；恢复失败后，在协商状态允许且信令可用时尝试 ICE restart / offer-answer 更新。候选到达与远端描述设置顺序继续安全排队处理。
- ICE restart 或重新协商失败时，退回现有 sender PeerConnection 完整重建机制；防止并发恢复、过期 PeerConnection 回调和重复协商。
- 连接诊断区分 `checking`、`connected`、`disconnected`、`failed`，并显示所选 direct/relay 路径及可得的质量指标；不将单个瞬时 stats 采样当作故障结论。

## C 阶段：开源项目调研与分阶段路线

新增一份中文调研/路线文档，覆盖 `C:\Users\17855\Desktop\Code\WebRTC` 中的项目：

- `Godot-WebRTC-Match-Maker`：信令房间与 SDP/ICE 转发职责、直连优先和 TURN 兜底；注意其 Godot/C# 平台实现不能直接用作浏览器依赖。
- `p2p`（go-gost）：会合/DERP 中继保持可用、UDP 打洞成功后优先切换直连、端到端加密的分层思路；其 Go tunnel/gRPC/DERP 数据平面不属于本浏览器应用可直接移植的实现。
- `linker`：IPv6、UPnP、多种打洞、Mesh/服务器 relay 和路径策略；其系统级隧道与网络权限超出本项目范围。
- `openp2p`：直连、共享 relay、QUIC/KCP、加密和节点调度思想；其桌面/系统级代理架构非浏览器 WebRTC 库。

调研应注明来源仓库及观察到的具体模式、适用性、不可移植原因与许可证审查要求，不复制源代码。路线顺序固定为：A TURN 可达性与费用/质量基线；B ICE restart、观测及弱网优化；C 再评估多路径调度、质量自适应及隐私/安全增强，仅在数据证明有收益后立项。

## Cloudflare 移除范围

- 删除 `worker/` 工程、Durable Object/Wrangler 配置、只服务于该部署的测试/锁定依赖，以及介绍 Cloudflare 部署的旧设计规格和计划文档；保留由 Node backend 复用的通用协议测试或迁移到相应目录。
- 前端默认信令 URL、环境变量说明和生产部署示例改为 EdgeOne 域名与 Docker Node 源站。
- 更新 README、部署指南、Docker 文件和测试；移除旧 Cloudflare 部署说明，全文搜索确认不再把 Cloudflare 作为支持部署方式或生产依赖。
- 不改写 EdgeOne 产品控制台设置；文档给出所需的源站、WebSocket 转发及缓存绕过规则，并要求上线前验证账号/套餐、TLS、WebSocket Upgrade 和超时策略。

## 错误处理与安全

- 凭据接口拒绝非法请求、Origin 不匹配及超限请求；密钥缺失时返回服务端错误且不泄漏配置内容。
- WebSocket 信令继续校验房间 ID、消息格式和消息大小；上线前确认生产 Node backend 的协议校验和测试覆盖满足前端协议及安全约束。
- 不记录 HMAC secret、临时 password、完整 ICE candidate、SDP 或用户屏幕内容。
- coturn 不能作为匿名开放中继；设置临时凭据、端口/带宽限制、日志轮替和基本资源监控。
- EdgeOne 代理只覆盖信令和凭据 HTTP 请求；TURN DNS 必须解析到可直连的 coturn 公网地址，媒体端口不能指向普通 HTTP CDN 代理。

## 验收与验证

- 前端 WebSocket 信令及 TURN 凭据请求均通过 Docker Node 源站/EdgeOne 配置工作，不再依赖 Cloudflare Worker。
- Docker Compose 可解析；服务健康检查、信令连接、凭据签发和 coturn 鉴权在部署说明中可复现。
- 单元测试覆盖临时凭据生成/过期、错误密钥、请求限制、连接配置和候选类型 stats；WebRTC 恢复覆盖 ICE restart 成功及失败后完整重建。
- 运行根项目测试、类型检查和生产构建；运行 backend 类型检查/构建及 Compose 配置验证。
- 在可控公网环境完成端到端场景：同网直连、跨 NAT 直连、强制 relay、信令断线恢复、WebRTC 断线恢复。若无真实双端网络环境，标明未实测，不以单元测试替代。
- 对本项目执行 Cloudflare 关键标识扫描，确认活跃源码、部署配置及现行文档中无 Worker、Durable Objects、Wrangler 依赖。

## 风险与待实现约束

- Cloudflare Worker 当前承担生产默认信令，但现有 Docker backend 虽可完成基本房间转发，必须验证其消息协议、断线清理和并发行为与前端完全兼容后才能切换。
- Node 单实例内存房间状态意味着容器重启会断开房间；横向扩容需要粘性会话或共享状态，首阶段不擅自引入数据库/消息队列。
- TURN 会增加服务器带宽成本；必须测量 relay 比例、出口流量和峰值并发再规划容量。
- EdgeOne WebSocket 代理、超时和缓存规则需在真实站点验证；若当前配置不支持该入口，必须先明确调整 EdgeOne 源站规则，而不是绕回 Cloudflare。
- 浏览器 ICE restart 协商可能有 glare/竞态，实施时需使用事务/代次保护和单一协商发起方策略，失败可安全退回完整重建。
