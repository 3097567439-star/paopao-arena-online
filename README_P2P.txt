泡泡竞技场 v7.1 · P2P线路剖析版
================================

用途：
- 当前战斗仍走 Render WebSocket，不用于评价战斗手感。
- v7.1 专门测你们两台设备之间的 WebRTC P2P 线路质量。

新增诊断：
- 服务器 RTT
- P2P 应用层当前 / 平均 / 最低 / P95 RTT
- WebRTC candidate-pair 底层 RTT
- 抖动（RTT 标准差）
- 无重传 DataChannel 探测丢包
- 本地 / 远端 ICE candidate 类型
- UDP / TCP / TURN relay 协议
- 浏览器 Network Information 提示（浏览器支持时）

测试步骤：
1. 覆盖上传 index.html、server.js、package.json 到 GitHub。
2. 等 Render 自动部署，/health 显示 version=v7.1。
3. 两人加入同一房间，不必开始游戏也可测速。
4. 保持连接 30～60 秒。
5. 点击联机状态，或大厅中的“查看 P2P 线路剖析”。
6. 你（蜂窝流量）和另一位玩家（家庭 Wi-Fi）分别截图诊断面板。

判断：
- 平均 <=60ms、低抖动、低丢包：优先纯 P2P。
- 60~110ms：配合预测通常可用。
- >150ms / P95 很高 / 抖动或丢包明显：值得测试广州 TURN 中继。
