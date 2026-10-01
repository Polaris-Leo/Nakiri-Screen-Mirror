# Nakiri Screen Mirror 部署文档

## WebRTC 连接诊断与画质说明

首页的“连接诊断”会分别显示 WebSocket 信令状态和浏览器间的 WebRTC/ICE 状态。信令显示 `connected` 只说明信令通道可用；只有 WebRTC 显示 `connected` 才表示媒体链路已建立。ICE 候选线路、实际分辨率、帧率和码率来自浏览器 `getStats()`，浏览器未提供相应字段时会显示“暂无数据”。

屏幕共享可选择均衡（1080p/30）、高清（1080p/60）、超清（1440p/60）和 4K（2160p/30）。这是采集目标和发送码率上限，不是保证值：浏览器、显示器、编码器、上行带宽或接收设备不支持时，实际画质会降低；不支持所选采集约束时会回退到均衡档。较高档位会增加 CPU/GPU、带宽和耗电。

Node.js 信令服务、Nginx 和 EdgeOne 只承载 WebSocket 信令，不转发视频/音频流。媒体由两台浏览器通过 WebRTC 尽可能直接传输。项目当前配置 STUN、未配置 TURN，因此严格 NAT、企业防火墙或 UDP 受限网络可能导致 ICE 失败；信令可连通并不代表 P2P 媒体一定可达。出现此类问题时，先查看诊断面板的 ICE 状态和候选线路，并跨不同网络验证；必要时另行部署 TURN 中继（此时媒体会经过 TURN）。

重连过程中信令状态会显示为 `reconnecting`，并显示已重试次数和最近错误。部署端的 `/healthz` 仍只是 HTTP 存活检查；要确认 WSS 握手和信令转发，请按下方 `WSS_URL=... bash scripts/deploy-docker.sh` 探测说明执行。

项目现在支持两种后端部署方式：

1. 推荐的新方案：腾讯云 EdgeOne 托管前端，阿里云 ECS Docker 运行 Node.js WebSocket 后端；
2. 兼容旧方案：Cloudflare Workers + Durable Objects。

本文重点说明 EdgeOne + 阿里云 Docker 方案。

新方案由两部分组成：

- 根目录的 React Router 前端，构建后是静态文件；
- `backend/` 下的 Node.js WebSocket 服务，负责 `/connect` 信令；
- `worker/` 下仍保留旧的 Cloudflare Worker 实现，不参与新方案部署。

前端部署到 EdgeOne Pages，信令服务继续运行在云服务器 Docker 中；信令域名可以通过 EdgeOne WebSocket 回源到云服务器，也可以直接使用 Nginx 暴露的 HTTPS 域名。两部分都需要 HTTPS，前端通过 `wss://` 连接信令服务。

## 腾讯云 EdgeOne Pages 直接部署

当前仓库可以直接从 GitHub 导入 EdgeOne Pages。EdgeOne Pages 负责构建和托管 React Router 前端，仓库中的 `backend/`、`docker-compose.yml` 和 `scripts/deploy-docker.sh` 不会在 Pages 构建环境中启动，信令后端仍需部署到云服务器。

### 1. 导入 GitHub 仓库

在 EdgeOne Pages 控制台创建项目，连接以下仓库：

```text
https://github.com/Polaris-Leo/Nakiri-Screen-Mirror
```

推荐构建配置：

```text
框架：React Router
Node.js：22.11.0
安装命令：npm install
构建命令：npm run build
输出目录：build/client
```

本项目已启用 SPA 和预渲染模式，构建产物位于 `build/client/`。如果使用 EdgeOne CLI，也可以在项目根目录执行：

```bash
npx edgeone pages deploy
```

### 2. 设置 EdgeOne 环境变量

在 EdgeOne Pages 项目的生产环境变量中设置：

```text
VITE_SIGNALING_URL=wss://signaling-server.unia.love/connect
```

如需部署预览环境，请同时在 Preview 环境配置相应的信令地址。`VITE_SIGNALING_URL` 必须在构建前设置，因为 Vite 会在构建阶段将它写入前端资源。

### 3. 绑定前端域名

例如将以下域名绑定到 EdgeOne Pages 项目：

```text
mirror.unia.love
```

最终通过以下地址访问前端：

```text
https://mirror.unia.love
```

### 4. 信令后端部署边界

EdgeOne Pages 不会执行本项目的 Docker Compose 服务。信令服务需要在云服务器上执行：

```bash
cd ~/Nakiri-Screen-Mirror
docker login docker.xuanyuan.run
bash scripts/deploy-docker.sh
```

后端监听 `127.0.0.1:8080`，然后通过 Nginx 将 `signaling-server.unia.love` 反向代理到该端口，并配置 WebSocket 升级。也可以将信令域名接入 EdgeOne 网站加速，在 EdgeOne 中开启 WebSocket 并将源站指向该云服务器。

浏览器最终连接的地址必须是：

```text
wss://signaling-server.unia.love/connect
```

EdgeOne 官方文档：

- [EdgeOne Pages React Router 部署](https://pages.edgeone.ai/document/framework-freact-router)
- [EdgeOne WebSocket 配置](https://cloud.tencent.com/document/product/1552/73071)

## 一、EdgeOne + 阿里云 Docker 快速部署

### 1. 构建前端

在项目根目录执行：

PowerShell：

```powershell
$env:VITE_SIGNALING_URL = "wss://signal.example.com/connect"
npm install
npm run typecheck
npm run build
```

Linux/macOS：

```bash
VITE_SIGNALING_URL=wss://signal.example.com/connect npm install
VITE_SIGNALING_URL=wss://signal.example.com/connect npm run typecheck
VITE_SIGNALING_URL=wss://signal.example.com/connect npm run build
```

将 `build/client/` 上传到 EdgeOne 静态站点。EdgeOne 需要将未知路径回退到 `/index.html`，并开启 HTTPS。

### 2. 部署阿里云 Docker 后端

将仓库上传到 ECS，在项目根目录执行：

```bash
docker login docker.xuanyuan.run
bash scripts/deploy-docker.sh
```

本项目 Dockerfile 使用轩辕镜像的 Node.js 基础镜像：

```text
docker.xuanyuan.run/library/node:20-alpine
```

由于该镜像仓库要求登录，首次部署或凭据失效后需要重新执行 `docker login docker.xuanyuan.run`。仅在 `/etc/docker/daemon.json` 中配置 `registry-mirrors` 不会自动替代 Dockerfile 中的镜像地址。

脚本会自动检查 Docker 和 Compose、构建镜像、启动服务、清理孤儿容器，并轮询健康检查。`/healthz` 只表示 HTTP 服务已启动，不代表公网 WSS 链路可用。当前健康响应还会标识 WebSocket 路径：

```json
{"status":"ok","service":"nakiri-signalling","websocket":{"path":"/connect","protocol":"websocket"}}
```

后端默认监听 `8080`，可通过 `PORT` 和 `HOST` 环境变量调整。

如果已经配置好 Nginx 或 EdgeOne 的公网域名，使用 `WSS_URL` 开启端到端 WebSocket 探针：

```bash
WSS_URL=wss://signaling-server.unia.love/connect bash scripts/deploy-docker.sh
```

该探针会在容器内创建两个临时 WebSocket 连接，验证 TLS、HTTP 101 升级、`/connect` 路径、6 位连接码和一条信令消息转发。探针通过后才会输出最终部署成功；未设置 `WSS_URL` 时只执行本机 HTTP 健康检查。

如果信令服务通过其他地址暴露，可以覆盖健康检查地址：

```bash
HEALTH_URL=http://127.0.0.1:18080/healthz bash scripts/deploy-docker.sh
```

脚本失败时会自动打印最近 100 行后端日志。也可以手动查看：

```bash
docker compose logs -f nakiri-signalling
```

如果服务器没有 Docker，可先按云厂商官方文档安装 Docker，再执行以上命令。

### 3. 配置 EdgeOne 信令回源

为 `signal.example.com` 配置 EdgeOne 站点或代理规则：

- 源站填写阿里云 ECS 公网 IP 或负载均衡地址；
- 源站端口映射到 Docker 的 `8080`；
- 开启 WebSocket；
- 配置 HTTPS 证书；
- 将 `/connect` 的 WebSocket 请求转发到后端；
- 将 `/healthz` 用作健康检查。

前端域名例如 `mirror.example.com`，信令域名例如 `signal.example.com`。不要把 `VITE_SIGNALING_URL` 设置成 `http://` 或 `ws://`，生产环境使用 `wss://`。

### 4. 多实例说明

当前 `backend/` 使用单实例内存保存 WebSocket 连接。单台 ECS 可以直接运行；如果部署多台 ECS 或多个容器，需要增加 Redis Pub/Sub 或改用阿里云负载均衡的会话保持，否则发送方和接收方落到不同实例时无法互相找到连接。

WebRTC 视频本身仍然由浏览器端 P2P 传输，Docker 后端主要承载信令消息。

## 二、准备工作

需要准备 Cloudflare 账号、已接入 Cloudflare 的域名、Node.js 20+，以及前端域名（如 `mirror.example.com`）和 Worker 信令域名（如 `signal.example.com`）。

## 三、部署 Cloudflare Worker（旧方案）

在本地或服务器执行：

```bash
cd worker
npm install
npx wrangler login
npm run deploy
```

也可以使用仓库约定的 pnpm：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm deploy
```

`worker/wrangler.toml` 已配置 `SignallingServer` Durable Object 和 SQLite 迁移。部署完成后，Wrangler 会输出类似：

```text
https://nakiri-screen-mirror-signaling.<your-subdomain>.workers.dev
```

WebSocket 地址为：

```text
wss://nakiri-screen-mirror-signaling.<your-subdomain>.workers.dev/connect?id=123456
```

生产环境推荐配置自定义域名。在 `worker/wrangler.toml` 末尾增加：

```toml
[[routes]]
pattern = "signal.example.com"
custom_domain = true
```

然后重新执行 `npm run deploy`。也可以在 Cloudflare 控制台的 **Workers & Pages → nakiri-screen-mirror-signaling → Settings → Domains & Routes** 中添加 Custom Domain。

## 四、构建前端（通用说明）

信令地址通过 `VITE_SIGNALING_URL` 配置。

PowerShell：

```powershell
$env:VITE_SIGNALING_URL = "wss://signal.example.com/connect"
npm install
npm run typecheck
npm run build
```

Linux/macOS：

```bash
VITE_SIGNALING_URL=wss://signal.example.com/connect npm install
VITE_SIGNALING_URL=wss://signal.example.com/connect npm run typecheck
VITE_SIGNALING_URL=wss://signal.example.com/connect npm run build
```

静态文件位于：

```text
build/client/
```

不设置 `VITE_SIGNALING_URL` 时，会回退到原来的 `wss://signaling.pexni.com/connect`。

## 四、部署到 Nginx

Ubuntu 示例：

```bash
sudo apt update
sudo apt install -y nginx
sudo mkdir -p /var/www/webrtc-screen-mirror
rsync -av --delete build/client/ user@your-server:/var/www/webrtc-screen-mirror/
```

创建 `/etc/nginx/sites-available/webrtc-screen-mirror`：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mirror.example.com;

    root /var/www/webrtc-screen-mirror;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

启用并检查：

```bash
sudo ln -s /etc/nginx/sites-available/webrtc-screen-mirror /etc/nginx/sites-enabled/webrtc-screen-mirror
sudo nginx -t
sudo systemctl reload nginx
```

配置 HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mirror.example.com
```

生产环境使用 `https://mirror.example.com` 访问。浏览器屏幕共享通常要求 HTTPS。

## 五、验证部署

1. 打开前端页面并查看开发者工具 Network 面板。
2. 确认 WebSocket 请求为 `wss://signal.example.com/connect?id=六位数字`。
3. 确认 WebSocket 握手返回 `101 Switching Protocols`。
4. 在第二台设备输入第一台设备显示的投屏码。
5. 允许屏幕共享权限并确认观看端出现画面。

当前 Worker 只处理 `/connect`，访问其他路径返回 404 是预期行为。

## 六、常见问题

### 页面打开但连接服务器失败

- 检查 `VITE_SIGNALING_URL` 是否正确；
- 确认使用 `wss://` 而不是 `ws://`；
- 检查 Worker 自定义域名、DNS 和证书；
- 确认前端和 Worker 已一起更新。

### 页面刷新后 404

检查 Nginx 或静态托管服务是否配置了 SPA fallback，将未知路径回退到 `/index.html`。

### 信令成功但 WebRTC 失败

先在同一局域网测试，并关闭可能拦截 UDP 的 VPN 或企业代理。项目目前只有 STUN，没有 TURN；严格 NAT 或 UDP 受限环境可能需要后续配置 TURN 服务。

### Worker 返回 400

投屏码必须是 6 位数字。缺失、长度错误或包含非数字字符的 `id` 会被拒绝。

## 七、更新流程

Worker 更新：

```bash
cd worker
npm install
npm run deploy
```

前端更新：

```bash
npm install
npm run typecheck
npm run build
rsync -av --delete build/client/ user@your-server:/var/www/webrtc-screen-mirror/
sudo systemctl reload nginx
```

修改 Worker 房间路由时，前端和 Worker 应一起发布，避免旧前端继续使用旧的固定房间模型。

## 八、安全注意事项

- 不要提交 Cloudflare API Token、密码或 TURN 凭据；
- 6 位投屏码只是临时标识，不是身份认证；
- 不要删除 `worker/wrangler.toml` 中已有的 Durable Object 迁移记录；
- 生产环境建议使用 Cloudflare Custom Domain，而不是直接依赖 `workers.dev`。

参考：[Cloudflare Workers Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Durable Objects 入门](https://developers.cloudflare.com/durable-objects/get-started/)。
