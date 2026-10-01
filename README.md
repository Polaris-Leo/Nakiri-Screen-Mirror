# Nakiri Screen Mirror

基于 WebRTC 的浏览器屏幕共享工具。WebSocket 仅交换连接信令，屏幕媒体由浏览器通过 WebRTC 直接传输；Docker Compose 运行 Node.js 信令/TURN 凭据服务与 coturn，EdgeOne Pages 托管前端并代理信令及凭据 API。

## 特性

- 通过六位投屏码连接屏幕共享端与观看端。
- WebRTC 媒体优先直连，必要时使用 coturn TURN 中继。
- 服务端按需签发短期 TURN 凭据；长期共享密钥仅保存在 Docker 主机的 file-backed Secret。
- 屏幕采集质量选项、连接诊断与信令重连。

## 部署

唯一支持的生产部署路径是 Docker + EdgeOne：EdgeOne Pages 发布静态前端，EdgeOne 将 WSS `/connect` 与不缓存的 HTTPS `/api/turn-credentials` 代理到 Docker Node 服务；TURN 媒体由浏览器直接连接 coturn，不经过 EdgeOne。

详细的 Pages 构建设置、EdgeOne 回源规则、Compose/.env、安全组端口、密钥轮换及验证步骤见[部署指南](docs/DEPLOYMENT.md)。生产默认信令地址为 `wss://signaling-server.unia.love/connect`；构建预览或 staging 时仍可通过 `VITE_SIGNALING_URL` 覆盖。

> 六位投屏码不是身份凭据。生产环境请替换 `.env.example` 中的示例域名/IP，并妥善保护 TURN Secret。
