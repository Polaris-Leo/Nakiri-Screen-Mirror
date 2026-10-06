# 本地 WebRTC / NAT 穿透项目调研

> 本报告基于本机 `C:\Users\17855\Desktop\Code\WebRTC` 下四个仓库的 README、文档和少量实现文件。记录的是本地材料所述或代码所见，不是独立互通/性能测试；除明确标注“观察到的实现”外，不把推断写成项目承诺。没有复制这些仓库的源代码，也没有把它们引入本项目的运行时。

## 与 Nakiri Screen Mirror 的关系

当前产品是浏览器 WebRTC 屏幕共享：浏览器建立 PeerConnection，WebSocket 只负责交换配对和 SDP/ICE 信令；ICE 尽可能选浏览器间直连路径，无法直连时由浏览器以 TURN relay candidate 直接连接 coturn。EdgeOne 托管前端并代理 WebSocket 信令及凭据 API，Docker 运行 Node 信令/短期 TURN 凭据服务与 coturn；媒体不经过 EdgeOne。这里的 relay 是 WebRTC/TURN 媒体中继，不等同于应用自建的任意 TCP/UDP 隧道。

四个参考项目中，只有 Godot WebRTC Match Maker 明确围绕 WebRTC 信令与 TURN fallback 展开；其余 Go `p2p`、Linker 和 OpenP2P 都是独立网络隧道/代理或系统网络方案，不是能直接供浏览器调用的 WebRTC runtime library。它们最多提供可评估的架构模式。

## 1. Godot-WebRTC-Match-Maker

- **角色（文档所述）：** Godot WebRTC 插件、WebSocket Match Maker 信令服务及演示项目；README 也称 Match Maker 可被其他需要简单 WebRTC matchmaking 的应用单独使用。
- **观察到的方法（文档所述）：** Match Maker 将同一房间的 peer 配对，并转发 SDP 与 ICE candidate；WebRTC 优先直连，TURN 产生 relay candidates 并作为 fallback。文档建议不能直连时使用 TURN。该项目 README 明确将 Web export 标为不支持（C# 项目限制）。
- **可借鉴原则（推论）：** 将信令面与媒体面分离；信令服务负责配对/传递协商消息，ICE/TURN 由 WebRTC 栈负责尝试路径，TURN 用于兜底。这个责任划分与本项目浏览器+coturn架构一致，但不是复用其实现。
- **不兼容/风险：** 示例面向 Godot/C# 插件和自己的房间协议，不是浏览器 JS 库；README 标注 Web 平台不支持。不能据此假设项目的协议、身份/房间模型或具体实现能与本项目兼容。TURN 可达、运营商策略、成本和带宽也仍需在本项目环境实际验证。
- **许可证审查：** 本地 `LICENSE` 文件标识为 MIT License（文件第 1 行；README 也说仓库以 MIT 授权）。这只是记录文件内容，不构成法律意见或“可直接复用”的结论；任何代码复用仍需逐文件检查版权、第三方依赖和分发条件。
- **本地证据（路径均相对上述 `C:\Users\17855\Desktop\Code\WebRTC` source root）：** `Godot-WebRTC-Match-Maker/README.md`（项目组成、Web 支持和匹配/协商说明）；`Godot-WebRTC-Match-Maker/Documentation/Match Maker/GettingStartedWithMatchMaker.md`（Better connectivity，ICE/TURN fallback）；`Godot-WebRTC-Match-Maker/Documentation/Match Maker/TURNServer.md`（直连优先和 TURN）；`Godot-WebRTC-Match-Maker/LICENSE`（MIT License）。

## 2. `p2p`（go-gost）

- **角色（文档所述）：** Go P2P tunnel host/library，为 GOST plugin 建立端到端隧道；其 API 面向 `net.Conn`/Tunnel stream，不是浏览器媒体 API。
- **观察到的方法：** README 描述 stub 与 DERP relay 模式；relay 建立后尝试 STUN/UDP hole punching，建立 KCP + smux 直连承载新 tunnel，同时保留 relay 作为 fallback；对称 NAT 可永久留在 relay。README 还写明 IPv6 候选处理及数据层端到端加密。`internal/host/direct.go` 的实现注释和代码描述 relay 上交换候选，使用 STUN/UDP socket 与 KCP + smux 建立 direct session，并让新流优先使用 direct、relay 留作 fallback；这是 Go 原始 socket 路径，不是 WebRTC ICE API。
- **可借鉴原则（推论）：** 会合/控制通道可以持续帮助协商或保持 fallback；直连优化不应先牺牲可靠性；不同路径状态应可观测，并通过真实统计判断直连成功率。适用于未来“评估什么”的思路，而非把 DERP、KCP 或 smux 加进浏览器。
- **不兼容/风险：** 这是 Go 端点/隧道、gRPC 控制面、DERP relay、原始网络 socket 的系统级数据面。浏览器不能照搬其任意 UDP/TCP hole punching、underlay 或 gRPC stream；ICE restart/路径切换须仍由浏览器 WebRTC 标准栈管理。它与本项目也有不同身份密钥、部署和信任边界。
- **许可证审查：** 仓库 `LICENSE` 文件标识 MIT License（第 1 行），README 末尾也标注 MIT。仅陈述文件内容，不是法律意见；代码再利用仍须单独审查来源、依赖和适用条件。
- **本地证据（路径均相对上述 source root）：** `p2p/README.md`（项目定位、DERP/打洞、IPv6、加密及限制）；`p2p/internal/host/direct.go`（relay 上交换候选、STUN/UDP 打洞、KCP + smux direct 与 relay fallback；实现注释/代码）；`p2p/LICENSE`（MIT License）。

## 3. Linker

- **角色（文档所述）：** 多平台自托管隧道/组网系统，覆盖虚拟网卡、端口转发、Socks5、mesh 与 relay 等场景；并非浏览器 WebRTC SDK。
- **观察到的方法：** README 将 IPv6 直连、UPnP/NAT-PMP/端口映射、TCP/UDP 打洞、Mesh 节点中继和服务器多 relay 列为连接方式。`TransportUdpP2PNAT.cs` 描述同时打开式 UDP 打洞，并按 IPv4/IPv6 endpoint 尝试；`PortMappingUpnpService.cs` 可见 UPnP SOAP 查询端口映射的实现。这里列出的是项目材料/实现路径，不代表每个网络条件都成功。
- **可借鉴原则（推论）：** 先按网络能力评估可用路径、准备兜底路径，并按真实成功率/延迟与资源代价观察策略效果；区分路径建立机制和隧道承载层。对于本项目，这些只构成待评估的设计模式，不等于要在网页中自行实现。
- **不兼容/风险：** Linker 是自主维护客户端/服务端、操作系统 socket、虚拟网卡/路由和端口映射的网络系统；权限、部署拓扑、穿透策略均超出浏览器 sandbox 和 WebRTC API 的可移植边界。UPnP 还依赖受控 LAN/router 能力，不能视为普遍可用或安全默认。
- **许可证审查：** 本地 `LICENSE` 文件开头明确 GNU General Public License, Version 3 (GPL-3.0)；但 README 的 License badge 标示 MIT 并链接至外部 MIT 页面。两处标识不一致，本报告仅记录观察到的差异，不判断其法律适用性或作法律意见；如考虑复用代码，须先作专项 license/依赖审查。
- **本地证据（路径均相对上述 source root）：** `linker/README.md`（模式列表与用途）；`linker/src/linker.tunnel/transport/TransportUdpP2PNAT.cs`（UDP 同时打开及候选尝试）；`linker/src/linker.upnp/PortMappingUpnpService.cs`（UPnP 映射查询）；`linker/LICENSE`（GNU GPL v3 文本）。仓库中的 `linker/src/linker.web/README.md` 仅说明 UI 翻译，不将其误认为浏览器 WebRTC runtime。

## 4. OpenP2P

- **角色（文档所述）：** Go 实现的 P2P 私有/共享网络、端口转发和系统级代理/组网工具；提供桌面、移动等平台构建/集成入口，不是浏览器 WebRTC 库。
- **观察到的方法：** README 声称支持 TCP/UDP punching、UPnP、IPv6、共享 relay 节点及 QUIC；其 RoadMap 的 KCP 项目同时写着“currently support Quic only”又标为完成，存在文档内部不一致。源码 `core/p2ptunnel.go` 描述按 NAT/link mode 协商后进行 UDP underlay 握手；`core/underlay_quic.go` 有 QUIC listener/dial 实现，而 `core/p2ptunnel.go` 的 KCP listen/dial 分支目前是注释掉的代码，故本报告不把 KCP 视作经源码确认的现行能力。README 还称共享节点调度考虑带宽、ping、稳定性和服务时长。上述能力/性能陈述是项目文档或代码观察，未由本报告复测。
- **可借鉴原则（推论）：** Relay 资源/节点选择可把带宽、时延、稳定性作为测量维度；有共享 relay 的模式也应与隐私、信任、滥用和公平性一起评估。若未来考虑更复杂策略，先收集当前 direct/relay 路径与用户体验数据，而不是承诺实现共享中继或特定传输协议。
- **不兼容/风险：** 其网络节点、应用端口转发、Go socket、UPnP 和 QUIC/KCP underlay 不是网页可直接调用的接口。共享节点意味着第三方转发/调度信任问题；README 对加密和调度的描述不是本项目安全保证。浏览器的网络权限及可用传输由 WebRTC/浏览器实现限制。
- **许可证审查：** 本地 `LICENSE` 文件标识 MIT License（第 1 行）。仅记录识别结果，不提供法律意见或许可结论；代码复用仍应检查所有文件的版权、依赖及其各自许可证。
- **本地证据（路径均相对上述 source root）：** `openp2p/README.md`（产品角色、共享网络、声称支持能力及调度/安全描述）；`openp2p/core/p2ptunnel.go`（按 NAT/underlay 处理连接）；`openp2p/core/underlay_quic.go`（QUIC transport 调用）；`openp2p/LICENSE`（MIT License）。`openp2p/app/README.md` 记录 Android app 构建依赖，亦非浏览器库说明。

## 跨项目模式：仅供评估

以下是参考仓库展现的思路，不是当前产品范围、已承诺能力或下一版实现清单：

- **共享 relay / relay 节点选择：** 与单租户 coturn/TURN 模型在运维、身份、安全和成本上不同；需要先定义信任/滥用模型并评估维护负担。
- **direct-path upgrade：** 在 relay 建立连接后尝试升级到直连，是一些自定义隧道可用的模式；浏览器场景需先确认原生 ICE 的协商、路径切换和媒体连续性能力是否足够，不另造自定义隧道。
- **IPv6 / UPnP / NAT-PMP：** 可作为未来连接结果分析的网络维度或外部方案假设；浏览器不应承诺自行映射路由器端口，也不能假定用户网络允许这些能力。
- **QUIC / KCP：** 参考系统的 underlay 选择，非浏览器 WebRTC 实现要求；是否需要任何额外传输应由浏览器限制、标准 API、可测收益和安全审查共同决定。

**本项目明确不把上述模式当作实现承诺。** 当前浏览器仍走原生 WebRTC ICE：直连优先、coturn TURN fallback。信令/EdgeOne 不承担媒体 relay。

## A → B → C 实施与测量路线

### A — TURN 可达性与基线（本轮已实现，仍待线上/真实网络验证）

已完成的 Tasks 1–5 建立 Docker coturn、Node 短期 TURN 凭据接口、浏览器动态 ICE 配置及 Docker + EdgeOne 部署路径，并移除旧 Worker 部署入口。现有部署指南列出检查信令、TURN 临时凭据、同网/跨网直连与强制 relay 的步骤。下一步测量并记录 TURN 实际可达率、relay 占比、出口带宽/成本、连接延迟和失败场景；真实公网/两端网络验证尚属于待完成工作，不可用单元测试替代。

### B — ICE 路径观测与恢复（实现已完成，自动化/公网测量仍待验证）

已完成的 Tasks 6–7 增加 direct/relay 路径统计与断连后的 ICE restart/失败重建恢复机制，并保留隐私约束。接下来在具备依赖的环境运行完整测试、类型检查与构建；再以网络切换、抖动/丢包、断开恢复等受控场景，测量路径识别准确性、恢复成功率/耗时、重连导致的媒体中断及错误/重复协商情况。不得把未执行或没有环境的验证记为通过。

### C — 基于证据评估后续优化（调研本任务完成；后续方案未承诺）

本任务（Task 8）完成本地项目比较与模式归纳。剩余 Task 9 负责当前 Docker + EdgeOne 部署验证及可用真实网络条件下的连接测试。待 A/B 结果形成基线后，再评估是否值得立项多路径/质量自适应、隐私或安全增强；只有测量证明收益、且符合浏览器 API/部署能力后才设计实施。共享 relay、direct-path upgrade、IPv6/UPnP 与 QUIC/KCP 均只作为待评估模式，不是既定路线或承诺。
