# Docker + EdgeOne 部署指南

本项目唯一支持的生产部署架构：EdgeOne Pages 托管前端静态资源，EdgeOne 将信令和 TURN 凭据 API 回源到 Docker Compose 中的 Node.js 服务；同一 Compose 项目运行 coturn。Node.js、EdgeOne 只处理 WebSocket 信令/凭据，不承载媒体。浏览器之间的 WebRTC 尽可能直连；需要中继时，媒体由浏览器直接访问 coturn 公网地址，绝不经 EdgeOne HTTP/CDN 代理。

生产默认信令 URL 为 `wss://signaling-server.unia.love/connect`。这是部署在 EdgeOne 代理域名上的 Docker 信令路径。构建预览或 staging 可通过 `VITE_SIGNALING_URL` 覆盖；该值在前端构建时写入资源。TURN 长期共享密钥不得注入前端。

## 1. EdgeOne Pages 前端

在 EdgeOne Pages 创建项目并连接仓库。构建配置：

```text
框架：React Router
Node.js：22.11.0
安装命令：npm install
构建命令：npm run build
输出目录：build/client
```

本项目启用 SPA/预渲染，未知客户端路由应回退到 `/index.html`。在 Pages 的 Production 构建环境设置：

```text
VITE_SIGNALING_URL=wss://signaling-server.unia.love/connect
```

Preview 环境也应明确配置对应的 EdgeOne/Docker 测试信令地址。绑定前端 HTTPS 域名，例如 `mirror.unia.love`。如改动 `VITE_SIGNALING_URL`，必须重新构建前端。

## 2. EdgeOne 回源规则

将 `signaling-server.unia.love` 配置为 EdgeOne 站点/加速域名，源站为 Docker 主机公网 IP 或负载均衡地址。EdgeOne 到 Node 服务的源站端口为 `8080`（如在源站前放置 Nginx，也只作为本架构内部反向代理实现细节）。配置 HTTPS 证书并确认 Upgrade/Connection 头、WebSocket 超时和连接保持行为可用。

配置以下规则，源站均为同一 Docker Node 服务：

| 匹配路径 | 方法/类型 | 处理 |
| --- | --- | --- |
| `/connect` | WebSocket | 启用 WebSocket，代理到 Node 的 `/connect`，保留 `id` 查询参数，不缓存 |
| `/api/turn-credentials` | HTTPS HTTP API | 代理到 Node 同路径，透传浏览器 Origin，不缓存（缓存规则设为绕过/禁用，不能缓存临时凭据） |
| `/healthz` | HTTP | 可供源站健康检查使用；不作为 WSS 端到端验证的替代 |

WSS 前端地址为 `wss://signaling-server.unia.love/connect`；TURN 地址不能指向该 EdgeOne 域名。

## 3. Docker Compose、环境与长期密钥

首次部署时，在仓库根目录运行引导脚本：

```bash
bash scripts/deploy-docker.sh
```

首次运行会在终端提示输入 TURN 主机公网 IP（`TURN_EXTERNAL_IP`）、TURN Realm（`TURN_REALM`）和允许的前端 Origin（`ALLOWED_ORIGINS`）。非交互运行时，可先通过同名环境变量提供这三项；缺少任一必填值会在启动服务前失败。未设置 `TURN_URLS` 时会按 Realm 生成 UDP/TCP 3478 地址，也可通过 `TURN_URLS` 环境变量指定自定义端点。`TURN_CREDENTIAL_TTL_SECONDS` 默认 `3600`，`TRUST_PROXY` 默认 `false`。

首次配置会新建 `.env` 和 `secrets/turn_secret`；长期 Secret 只写入文件，不写入 `.env`、终端或日志。已有 `.env` 不会被读取为 shell 代码、覆盖或改写；已有非空 Secret 会复用，不会替换。示例占位值或 Compose 配置错误会在服务状态变更前拒绝部署。若需非交互地预先准备配置，使用以下命令并编辑 `.env` 填入真实值：

```bash
cp .env.example .env
# 编辑 .env：设置真实 TURN_EXTERNAL_IP、TURN_REALM、TURN_URLS、ALLOWED_ORIGINS、TRUST_PROXY
mkdir -p secrets
chmod 700 secrets
(umask 077; openssl rand -hex 32 > secrets/turn_secret)
chmod 600 secrets/turn_secret
```

确认 `TURN_SECRET_FILE=./secrets/turn_secret` 指向上述文件。`TURN_URLS` 的主机名必须是 TURN 主机自身的公网 DNS 名称，解析到 coturn 公网 IP；DNS 记录须为 DNS-only/直连，不能使用 EdgeOne/CDN 代理。`TURN_EXTERNAL_IP` 应为该 coturn 主机公网地址。请在真实值生效后再开放服务。

以文件型 Docker Secret 将同一主机密钥挂载给 Node 和 coturn：Node 从 `/run/secrets/turn_secret` 生成短期 HMAC 凭据，coturn 启动脚本在容器内创建受限权限的运行配置。密钥文件和 `.env` 已被忽略，不要提交、记录到日志、放进镜像/命令行或设置为 `VITE_*`。

脚本会在部署前运行 `docker compose config --quiet`，随后以 `docker compose up -d --build --remove-orphans` 启动容器。容器在后台 detached 运行；部署脚本本身保持前台运行，等待健康检查并按需执行公网 WSS 探针，再显示容器状态。`/healthz` 只表示 Node HTTP 服务存活。该命令会更改本机 Compose 服务状态，不是只读验证；仅在明确要部署/更新服务时运行：

```bash
WSS_URL=wss://signaling-server.unia.love/connect bash scripts/deploy-docker.sh
```

只验证已运行服务的公网 WSS 路由而不触发部署时，可在仓库根目录对现有容器运行同一探针：

```bash
docker compose exec -T nakiri-signalling node dist/probe.js wss://signaling-server.unia.love/connect
```

该容器内探针命令要求目标 Compose 服务已运行；探针会使用临时 peer ID 交换一条测试信令，不会执行 Compose 部署/重建。也可查看 `docker compose logs -f nakiri-signalling` 与 `docker compose logs -f coturn`，不得让日志输出 Secret 或短期凭据。

### 安全组/主机防火墙端口

- `8080/TCP`：Node 源站端口，仅允许 EdgeOne 回源地址或受控负载均衡访问；不要将其当作浏览器公网 WSS 入口。
- `3478/UDP` 和 `3478/TCP`：coturn TURN/STUN listener，浏览器直连。
- `49160–49200/UDP`：Compose 配置的 coturn relay 端口范围，必须完整允许入站/出站并与安全组及主机防火墙一致。
- `5349/TCP` 未在当前 Compose 中发布；仅在配置 coturn TLS 证书及相应选项后才可开放。

不要为 TURN 媒体开放 EdgeOne 代理端口或将媒体端口映射到 CDN。只向必要来源开放管理/SSH 端口。

### Secret 轮换

准备新的高熵随机值写入受限权限的 Secret 文件，安排维护窗口后更新该文件并重建/重启 `nakiri-signalling` 与 `coturn`，确认两者均已读取同一新密钥，再用新临时凭据验证。重启会使既有短期凭据失效，因此应考虑凭据 TTL 和现有会话；不要同时保留或记录旧密钥。轮换后确认旧凭据不再可用、日志与镜像中无密钥，并按组织安全策略销毁旧副本/备份。

## 4. 部署验证

1. 在浏览器 Network 面板确认 `wss://signaling-server.unia.love/connect?id=<六位数字>` 经 EdgeOne 返回 `101 Switching Protocols`，两端输入同一码可交换信令。
2. 请求 `https://signaling-server.unia.love/api/turn-credentials`，确认返回短期 ICE 用户名/密码且响应不缓存；核对响应/日志中没有长期 Secret。
3. 同一网络测试媒体直连并观察诊断信息/`getStats()`。再用不同运营商或网络的两台设备测试跨网络连接。
4. 在受控测试客户端将 `RTCPeerConnection` 的 `iceTransportPolicy` 临时设置为 `relay`，验证候选对显示 relay 且媒体可用；此项是测试配置，不要作为默认生产策略。
5. 验证 coturn DNS 直接解析到 coturn 公网地址，且 UDP/TCP 3478 与 UDP 49160–49200 从外网可达。信令连通不代表 TURN 或 WebRTC 媒体必然可达。

## 故障排查

- 页面能开但 WSS 失败：检查 `VITE_SIGNALING_URL` 是否为 `wss://.../connect`、EdgeOne WebSocket 开关/源站/Upgrade 及 TLS，并确认 `id` 查询参数未丢失。
- TURN 凭据请求失败或被复用：确认 `/api/turn-credentials` 路由到 Node、缓存已禁用、Origin 与 `.env` 一致、Secret 文件存在且权限正确。
- 信令成功而 ICE 失败：检查 coturn 公网 DNS 是否直连而非代理、`TURN_EXTERNAL_IP`、3478 UDP/TCP 和 relay UDP 端口范围/防火墙；通过诊断区分直连与 relay。
- 前端路径刷新 404：在 EdgeOne Pages 配置 SPA fallback 到 `/index.html`。
