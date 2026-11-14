# 11 — APM-Watch: 接口 + 证书 + 轻 APM 桌面监控

## 定位
Datadog（$3.4B+）的轻切片：单应用/小团队的人间监控——接口可用性、TLS 证书到期、
简要 APM（请求延迟/错误）桌面显示。母市场 Datadog 三亿级。

## 主要痛点
- Datadog 贵，小团队只想要「关键 endpoint 活着 + 证书不过期 + 慢在哪」
- 不信任云端监控（内部 API 不想外露）
- 需要桌面小面板 + 简单告警，不给 DevOps 玩具全家桶

## 功能需求
1. Checker 引擎：
   - HTTP(S) endpoint 探测：状态码/延迟/响应体关键词（断言）
   - TLS 证书：到期日扫描（解析 chain，报告剩余天数）
   - 简易 APM：可选服务端点（受监控进程开启 agent 上报 latency/error 计数 → 本地收）
2. 调度：cron 网格（每 30s–5m 可配置）
3. 告警：桌面通知（desktop notification）+ webhook（可选）+ 邮件 SMTP（可选）
4. UI：终端 TUI 或 Web 单页（实时状态：绿/黄/红 + 历史曲线）
5. 存储：SQLite（metric + 事件 + 状态快照）
6. `--export` JSON 远程健康状态（供简单 status page）

## 非目标
- 分布式 tracing / 全链路
- 日志监控、指标仓储
- 移动 app

## 技术栈
- Node v22（主要）或 Python 3.14 均可
- check 引擎：undici / httpx
- TLS 证书：node tls / Python ssl、cryptography
- 存储：better-sqlite3 / SQLite
- 桌面通知：node-notifier / libnotify
- 测试：本地起 mock 服务器（http + 自签证书）

## 低算力守则
见全局（本工具就是 cron/ping/SQLite 的典型场景）。

## AC
1. 监控 3 个 fixture 服务（一个 200、一个 404、一个无响应）：状态准确显示
2. 自签测试证书到期日在倒计时显示正确
3. 证书在 N 天内到期触发告警（可配置阈值）
4. APM：注入 agent 的 demo 服务上报 latency 并展示在第 p50/p95
5. TUI/UI 显示实时状态与历史（曲线）
6. 长时间运行（24h 模拟）资源占用 < 200MB
7. 测试 + README

## Phases
- P0: checker（HTTP + 证书）+ SQLite 存储 + 调度
- P1: UI（TUI/web）+ 历史曲线
- P2: 告警（桌面/邮件/webhook）+ APM 上报
- P3: status page export

## 里程碑
M1: check + 存储 + 调度（MVP）
M2: UI + 证书告警
M3: 告警全渠道 + APM

## 变现
- 开源免费，Pro = 多服务器/告警渠道/审计
