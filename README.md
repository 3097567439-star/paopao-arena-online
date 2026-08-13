# 泡泡竞技场 v6.1 · 公网联机版

这是“泡泡竞技场”的公网远程联机版本，目标是让不同网络的朋友通过同一个 HTTPS 地址直接进入房间对战。

## 部署到 Render

仓库包含 `render.yaml`，推荐使用 Render Web Service 部署。

- Runtime: Node
- Start Command: `npm start`
- Health Check: `/health`
- Node.js: 18+

服务器会读取云平台提供的 `PORT` 并监听 `0.0.0.0`。客户端在 HTTPS 页面下会自动使用同域名的 `wss://.../ws`。

## 本地运行

```bash
npm start
```

然后打开：

```text
http://localhost:8080
```

## 公网验收

部署完成后：

1. 打开 Render 提供的 HTTPS 地址。
2. 访问 `/health`，应返回 `ok: true`。
3. 用两台处于不同网络的设备创建/加入同一房间。
4. 验证移动、放雷、爆炸、死亡和重新开局同步。
