# apm-watch

轻量桌面监控（Datadog 的“小切片”）：HTTP(S) 接口可用性、TLS 证书到期、简易
APM（请求延迟/错误率），全部本地运行 —— SQLite 存储、终端 TUI 或 Web 单页
实时状态与历史曲线、桌面通知 + 可选 webhook/邮件告警。

Node v22.5+（零运行时依赖，仅用一个内置模块：`node:sqlite` / `node:crypto` /
`node:tls`）。

## 功能

- **HTTP(S) 探测**：状态码断言 + 响应体关键字（`bodyIncludes`）断言，返回
  状态码/延迟，超时（默认 5s）与连接失败记为 `error`。可选
  `latencyThresholdMs`：超过阈值的慢响应（但状态断言通过）记为 `warn`——黄色，
  不再伪装成健康绿。每个目标按 state 快照历史计算**时间加权可用率**
  （uptime%，warn 计为在线，与 Datadog 口径一致），显示在 Web 表格、导出
  JSON 与 HTML 状态页。
- **TLS 证书扫描**：通过 `tls.connect` 拉取真实服务器证书链，报告剩余天数；
  也支持纯 PEM 文件检查（`inspectPemChain` / tls 配置中的 `pemFile`），
  适合离线或无法直连的证书文件。
- **简易 APM**：Demo 服务（`apm-watch demo`）POST span 到本地 collector，
  计算 p50/p95 与错误率并落库、上曲线。
- **调度**：cron 风格网格，每项 check 独立间隔，30s–5m 可配，慢任务不重叠。
- **告警**：桌面通知（`notify-send`）+ webhook（POST JSON）+ 邮件 SMTP（纯手写
  客户端，支持 AUTH PLAIN / STARTTLS），重复告警按 `repeatIntervalSeconds` 去重。
- **UI**：
  - `tui`：终端面板（绿/黄/红 + latency sparkline + APM p50/p95 与错误率 sparkline）
  - `web`：单页（状态表格 + 三层曲线：latency / TLS 剩余天数 / APM p50/p95
    + 错误率曲线，阈值虚线；每个被监控目标一条独立彩色折线 + 图例，多目标
    不再合并成一条误导性的曲线）
- **存储**：SQLite（`node:sqlite`，WAL）。`states`（状态快照）、`metrics`
  （时间序列）、`events`（告警/审计）、`meta`（监控器自述：进程启动时刻、最近
  一次 check 时间、本轮最差状态）。引擎后台任务按 `store.retentionDays`
  （默认 7 天）自动裁剪旧数据，长跑不涨内存/磁盘。
- **监控器自健康**：引擎每轮 tick 把 `uptimeSince`/`lastCheckAt`/当前最差状态
  写入 store，Web 顶栏、TUI 表头、`export` 的 JSON 与 HTML 状态页统一展示
  “up 时长 / 上次检查 / monitor 状态”。
- **`export`**：导出当前健康状态为 JSON（`--out file.json`）或**自包含 HTML 状态页**
  （`--out status.html`，零依赖单文件，可直接扔到静态托管/CDN）。

## 快速开始

```bash
npm install   # 无第三方依赖，实际上不需要安装
npm start     # 默认 run（web UI）
node bin/apm-watch.js demo
node bin/apm-watch.js run --ui tui
```

## 命令行

```
apm-watch run [--ui tui|web] [--ui-port PORT] [--apm-port PORT] [--config FILE]
apm-watch demo [--collect-addr http://localhost:PORT] [--interval MS]
apm-watch once [--config FILE]
apm-watch export [--config FILE] [--out FILE]
apm-watch serve [--config FILE] [--port PORT]
apm-watch --version | -V
```

`once` 跑一遍所有 check 并逐条打印结果，退出码按最差状态给出：`0` 全部
ok、`1` 有 warn（如慢响应/证书临近到期）、`2` 有 error —— 可以直接挂到
cron / CI 当冒烟检查。加 `--json` 则把结果（含 `exit_code` 与每个 check 的
`target`/`kind`/`status`/`latency_ms`/`status_code`/`days_remaining`/`detail`，
其中 `status_code` 仅 http、`days_remaining` 仅 tls，其余为 `null`）作为单个
JSON 文档打到 stdout，engine 日志走 stderr，方便脚本解析。`--version` 打印
版本号并退出（不带则默认启动 `run`，别和 `run` 子命令混淆）。

## 配置

默认读取 CWD 下 `apm-watch.json`（或 `.apm-watch.json`）。缺省时使用空配置。

```jsonc
{
  "http": [
    { "name": "api", "url": "https://example.com/health", "method": "GET",
      "timeoutMs": 5000,
      "latencyThresholdMs": 400,
      "assert": { "statusCode": 200, "bodyIncludes": "ok" } }
  ],
  "tls": [
    { "name": "my-site", "host": "example.com", "port": 443, "warnDaysBefore": 30 },
    // 本地证书文件检查（离线/无法直连时）：
    // { "name": "bundled-cert", "pemFile": "./cert-bundle.pem", "warnDaysBefore": 30 },
    // 自签/内网证书请配合：
    // "rejectUnauthorized": false, "servername": "my-host"
  ],
  "apm": { "collect": true, "errorRateThreshold": 0.05, "latencyThresholdMs": 500 },
  "scheduler": { "httpIntervalSeconds": 30, "tlsIntervalSeconds": 300, "apmIntervalSeconds": 60 },
  "notifications": {
    "desktop": true,
    "repeatIntervalSeconds": 3600,
    "webhook": { "url": "https://example.com/hook" },
    "email": { "host": "smtp.example.com", "port": 587, "secure": false,
               "user": "u", "pass": "p", "from": "a@x.com", "to": "b@x.com" }
  },
  "ui": { "mode": "web", "port": 8787, "historySeconds": 86400 },
  "store": { "path": "apm-watch.db", "retentionDays": 7 }
}
```

环境变量覆盖（用 secret）：
`APMW_NOTIFY_WEBHOOK_URL`、`SMTP_HOST/SMTP_FROM/SMTP_TO/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS`。

无效的 scheduler 间隔会被自动钳制到 [30, 300]s。

启动时会先做**配置校验**（`lib/validate.js`）：`http`/`tls` 写成了对象而非数组、
HTTP 条目缺少 `url`、TLS 条目既无 `host` 也无 `pemFile`、端口/超时/告警阈值非法、
scheduler 间隔无法解析等都会在启动时立刻报出可读错误并退出，而不是静默跑一个
什么都不检查的监控。`validateConfig(cfg)` 返回错误列表，`assertValidConfig(cfg)`
在 CLI 启动路径上抛出并中止。

## 测试

```bash
npm test             # 全部 78 项测试（node --test，含本地 mock SMTP/webhook 告警通道、
                     #   STARTTLS 升级、web/TUI UI、可用率、监控器自健康、端到端 AC1–AC5）
npm run test:memory  # 24h 模拟，断言 RSS < 200MB
```

测试使用本地 mock 服务器（HTTP + openssl 生成的自签证书，含已过期/负数天）、
本地 mock SMTP 服务器（验证完整信封 + AUTH PLAIN + 错误路径）、mock webhook
接收端，以及一个真实的 3 级证书链（root→int→leaf）验证链序。

## 演示：三状态 + 证书 + APM

```bash
# 1) 起 fixture：一个 200、一个 404、一个挂起 + 一个 15 天到期的自签 TLS
#    自动生成 examples/e2e-config.json（写入实际端口）
node examples/e2e-server.js &

# 2) 起监控
node bin/apm-watch.js run --config examples/e2e-config.json --ui web

# 3) 注入 APM demo 流量（另一个终端）
node bin/apm-watch.js demo --collect-addr http://127.0.0.1:8787/apm/agent/trace
```

Web UI：http://127.0.0.1:8787/ ；状态下 ok-svc→绿色、missing-svc（断言 404）→绿色、
hang-svc→红色、cert-soon→黄色（15d < 30d 阈值），APM 曲线显示 p50/p95。

TUI 模式同样可用（自带独立 APM 上报端口，默认 `--apm-port 8789`）：

```bash
node bin/apm-watch.js run --config examples/e2e-config.json --ui tui --apm-port 8789
node bin/apm-watch.js demo --collect-addr http://127.0.0.1:8789/apm/agent/trace
```

## 里程碑覆盖

| 里程碑 | 内容 | 验证 |
|---|---|---|
| M1 | check + 存储 + 调度 | `engine`/`store`/`scheduler` 测试 |
| M2 | UI + 证书告警 | `tui`/`web`，`engine` 中 `warnDaysBefore` 告警 |
| M3 | 告警全渠道 + APM | `notify`/`smtp`，`apm` collector + 曲线 |

## 目录结构

```
bin/apm-watch.js     # CLI 入口（run/demo/once/export/serve）
lib/check-http.js    # HTTP 探测
lib/check-tls.js     # 证书链扫描/解析
lib/validate.js      # 配置校验（fail-fast）
lib/apm.js           # APM collector（HTTP span 接收 + 百分位）
lib/availability.js  # 时间加权可用率（uptime%，warn 计为在线）
lib/demo-agent.js    # 模拟上报服务
lib/scheduler.js     # cron 网格
lib/store.js         # SQLite 存储
lib/notify.js        # 桌面/webhook
lib/smtp.js          # 手写 SMTP 客户端
lib/ui-server.js     # Web 单页 + JSON API
lib/ui-tui.js        # 终端 TUI
lib/config.js        # 配置加载 + env 覆盖
lib/stats.js         # 百分位工具
test/                # node:test 测试 + fixture 助手
```
