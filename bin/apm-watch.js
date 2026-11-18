#!/usr/bin/env node
// apm-watch entrypoint: `run`, `demo`, `once`, `export`, `serve`, `tui`.

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, httpLatencyThresholds, httpTimeoutMs, httpAssertStatusCodes, httpAssertBodyIncludes, httpIntervalSeconds, tlsWarnDaysBefore, tlsTimeoutMs, tlsPort, tlsIntervalSeconds, schedulerIntervals, uiHistorySeconds, notificationsDesktop, notificationsWebhookEnabled, notificationsEmailEnabled } from '../lib/config.js';
import { assertValidConfig } from '../lib/validate.js';
import { Store } from '../lib/store.js';
import { Engine, retentionDays } from '../lib/engine.js';
import { createUiServer } from '../lib/ui-server.js';
import { Tui } from '../lib/ui-tui.js';
import { startDemoAgent } from '../lib/demo-agent.js';
import { exportStatus, renderStatusPage, aggStatus, countStatuses } from '../lib/export.js';
import { availability } from '../lib/availability.js';

const VERSION = '1.0.0';
export const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

function usage() {
  console.log(`apm-watch v${VERSION}
Usage:
  apm-watch run [--ui tui|web] [--ui-port PORT] [--apm-port PORT] [--config FILE]
  apm-watch demo [--collect-addr http://localhost:PORT] [--interval MS]
  apm-watch once [--config FILE]
  apm-watch export [--config FILE] [--out FILE]
  apm-watch serve [--config FILE] [--port PORT]

Commands:
  run     start the full monitor (checks + store + UI + alerts)
  demo    run a simulated APM demo service reporting to a collector
  once    run each check a single time and print results
          (exit 0 = all ok, 1 = any warn, 2 = any error — cron/CI friendly)
  export  write current status as JSON for a status page
  serve   start only the web UI over an existing store

Flags:
  --config FILE   config file path (default ./apm-watch.json)
  --json          once: print results as JSON (for scripts/CI)
  --version, -V   print version and exit
`);
}

function parseArgs(argv) {
  const args = { _: [], unknown: [], missing: [] };
  // A value-consuming flag given at the very end of argv (no following token)
  // is a typo'd command line, not a request for the default: `demo --collect-addr`
  // must not silently post to the default endpoint. Record it so flagErrors()
  // can fail fast.
  const valueFlags = new Set(['--config', '--ui', '--ui-port', '--port', '--out', '--collect-addr', '--apm-port', '--interval']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      const v = argv[++i];
      if (v === undefined) { args.missing.push(a); continue; }
      if (a === '--config') args.config = v;
      else if (a === '--ui') args.ui = v;
      else if (a === '--out') args.out = v;
      else if (a === '--collect-addr') args.collectAddr = v;
      else if (a === '--ui-port') args.uiPort = Number(v);
      else if (a === '--port') args.port = Number(v);
      else if (a === '--apm-port') args.apmPort = Number(v);
      else if (a === '--interval') args.interval = Number(v);
    }
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-V') args.version = true;
    else if (a.startsWith('--')) args.unknown.push(a);
    else args._.push(a);
  }
  return args;
}

// Numeric flags must be well-formed integers in their domain — a typo'd
// --ui-port must fail with a readable message, not a raw RangeError thrown
// from server.listen(), and demo --interval must not silently fall back.
function flagErrors(args) {
  const errs = [];
  // A value-consuming flag with no value (trailing at end of argv) is a
  // typo'd command line — fail fast instead of silently using the default.
  for (const f of args.missing || []) {
    errs.push(`${f} expects a value`);
  }
  for (const [name, v] of [['--ui-port', args.uiPort], ['--port', args.port], ['--apm-port', args.apmPort]]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 65535)) {
      errs.push(`${name} expects an integer port in [0, 65535], got ${JSON.stringify(v)}`);
    }
  }
  if (args.interval !== undefined && (!Number.isInteger(args.interval) || args.interval < 1)) {
    errs.push(`--interval expects a positive integer (ms), got ${JSON.stringify(args.interval)}`);
  }
  // A typo'd --ui must not silently run the monitor with no UI at all (neither
  // cmdRun branch fires) — fail fast so the operator sees the mistake.
  if (args.ui !== undefined && !['web', 'tui'].includes(args.ui)) {
    errs.push(`--ui expects "web" or "tui", got ${JSON.stringify(args.ui)}`);
  }
  // demo posts spans to the collector endpoint; a malformed --collect-addr
  // would make every POST fail ("agent post failed" on repeat) while the
  // process cheerfully runs forever — validate the URL shape up front.
  if (args.collectAddr !== undefined) {
    let u;
    try { u = new URL(args.collectAddr); } catch { u = null; }
    if (!u || !['http:', 'https:'].includes(u.protocol) || !u.hostname) {
      errs.push(`--collect-addr expects an http(s) URL, got ${JSON.stringify(args.collectAddr)}`);
    }
  }
  return errs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A typo'd flag must not silently fall back to the default config and run
  // checks against it — surface it so cron/CI authors catch mistakes.
  for (const u of args.unknown) {
    console.error(`[apm-watch] unknown flag "${u}" ignored (see --help)`);
  }
  // A malformed numeric flag must fail fast with a readable message instead of
  // a raw server.listen() RangeError (or a silent default in demo --interval).
  const badFlags = flagErrors(args);
  if (badFlags.length) {
    console.error(`[apm-watch] invalid flag value:`);
    for (const e of badFlags) console.error(`  ${e}`);
    usage();
    process.exit(2);
  }
  if (args.help) { usage(); return; }
  if (args.version) { console.log(VERSION); return; }
  const cmd = args._[0] || 'run';

  switch (cmd) {
    case 'run': return cmdRun(args);
    case 'demo': return cmdDemo(args);
    case 'once': return cmdOnce(args);
    case 'export': return cmdExport(args);
    case 'serve': return cmdServe(args);
    case 'help': case '-h': case '--help':
      usage(); return;
    default:
      console.error(`unknown command: ${cmd}`); usage(); process.exit(2);
  }
}

function resolveStorePath(config) {
  return config?.store?.path ?? path.join(process.cwd(), 'apm-watch.db');
}

function ensureStoreDir(p) {
  const dir = path.dirname(path.resolve(p));
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
}

// server.listen() bind errors (EADDRINUSE, EACCES) fire asynchronously on the
// server's 'error' event — not as a rejection of listen() — so a bare listen
// dumps a raw "Unhandled 'error' event" stack that bypasses the one-line fatal
// handler in main().catch(). Route them through the same curated message.
function listenWithFatal(server, opts, onListening) {
  server.on('error', (err) => {
    console.error('[apm-watch] fatal:', err?.message ?? err);
    process.exit(1);
  });
  server.listen(opts, onListening);
  return server;
}

async function cmdRun(args) {
  const configPath = args.config;
  const config = loadConfig(configPath);
  assertValidConfig(config);
  const storePath = resolveStorePath(config);
  ensureStoreDir(storePath);
  const store = new Store(storePath);
  const engine = new Engine({ store, config });
  const ui = args.ui || config.ui?.mode || 'web';
  const uiPort = args.uiPort !== undefined ? args.uiPort : config.ui?.port ?? 0;
  const shutdown = () => engine.stop();

  // start UI before engine so first status is visible quickly
  if (ui === 'web') {
    const server = createUiServer(store, config);
    const uiServer = listenWithFatal(server, { host: config.ui?.host || '127.0.0.1', port: uiPort }, () => {
      const addr = server.address();
      console.log(`web UI on http://127.0.0.1:${addr.port}/`);
    });
    attachCollector(uiServer, engine);
  } else if (ui === 'tui') {
    // TUI owns stdout; don't let engine logs corrupt it. Logs go to stderr.
    engine.log = (m) => console.error(`[apm-watch] ${m}`);
    // TUI has no web server to hang the APM collector on, so expose a minimal
    // intake server unless the user disabled collection.
    if (config.apm?.collect !== false) {
      const port = args.apmPort || config.apm?.port || 8789;
      try {
        const { createServer: createHttp } = await import('node:http');
        const collectorServer = createHttp();
        attachCollector(collectorServer, engine);
        // A busy apm-port must fail fast with the same one-line message as a
        // busy web port — the old bare listen dumped a raw stack here too.
        listenWithFatal(collectorServer, { port, host: '127.0.0.1' }, () => {
          console.error(`[apm-watch] APM collector on http://127.0.0.1:${port}/apm/agent/trace`);
        });
      } catch (e) {
        console.error('[apm-watch] could not start APM collector:', e.message);
      }
    }
    const tui = new Tui({
      store,
      intervalMs: 2000,
      historyMs: (config.ui?.historySeconds ?? 24 * 3600) * 1000, // match web charts window
      latencyThresholds: httpLatencyThresholds(config),
      tlsWarnDaysBefore: tlsWarnDaysBefore(config),
      // the judged-against http assert criteria ride the TUI rows like every
      // other face (once --json / web rows / export JSON parity, inc-63+64):
      // per-target expected status code + required body substring, resolved from
      // the same canonical maps the web mirror blocks carry.
      httpAssertStatusCodes: httpAssertStatusCodes(config),
      httpAssertBodyIncludes: httpAssertBodyIncludes(config),
      // the per-check abort timeouts (http probe + tls cert-fetch socket) ride the
      // TUI rows like every other face (web /api/states rows + export JSON blocks
      // parity, inc 67): threaded through the same per-target maps the web rows
      // and export blocks carry — states rows have no timeout column, so the TUI
      // must re-resolve from config.
      httpTimeoutMs: httpTimeoutMs(config),
      tlsTimeoutMs: tlsTimeoutMs(config),
      // the per-tls-target probe port rides the TUI rows like every other face
      // (web /api/states rows + export JSON blocks + once rows parity, inc 78):
      // threaded through the same per-target map the web rows and export blocks
      // carry — states rows have no port column, so the TUI must re-resolve
      // from config (pemFile targets resolve to null, no socket opened).
      tlsPort: tlsPort(config),
      // the per-check run cadences ride the TUI rows like every other face (web
      // /api/states rows + export JSON blocks + once rows parity, inc 71):
      // threaded through the same per-target maps the web rows and export blocks
      // carry — states rows have no cadence column, so the TUI must re-resolve
      // from config.
      httpIntervalSeconds: httpIntervalSeconds(config),
      tlsIntervalSeconds: tlsIntervalSeconds(config),
      // apm warn criteria the collector summary is judged against (web drawApm
      // /drawErrRate marker parity): null error-rate here would leave the err
      // line unannotated even though the engine always judges against 0.05.
      apmLatencyThresholdMs: config.apm?.latencyThresholdMs ?? null,
      apmErrorRateThreshold: config.apm?.errorRateThreshold ?? 0.05,
      // the apm collection cadence rides the TUI rows like every other face (web
      // /api/states rows + export JSON blocks + once rows parity, inc 76): the
      // cadence is config-global, resolved from the same scheduler mapping the
      // mirror blocks carry.
      apmIntervalSeconds: schedulerIntervals(config).apmIntervalSeconds,
      // the apm sampling window rides the TUI rows like every other face (web
      // /api/states rows + export JSON blocks + once rows parity, inc 77): the
      // window is config-global, resolved from the same apm config the mirror
      // blocks carry — states rows have no window column, so the TUI must
      // re-resolve from config.
      apmWindowMs: config.apm?.windowMs ?? 60_000,
      // the store retention window rides the TUI header like every other face
      // (web meta `keep Nd`, export page `keep Nd`, once report `keep Nd`,
      // inc 83): config-global, resolved from the same canonical engine
      // retentionDays resolver the JSON faces carry.
      retentionDays: retentionDays(config?.store),
      // the availability/series history window rides the TUI header like every
      // other face (web meta `history`, export page `history`, once report
      // `history`, inc 89 parity): config-global, resolved from the same
      // canonical engine uiHistorySeconds resolver the JSON faces carry — the
      // same window the header uptime pct + sparklines aggregate over.
      historySeconds: uiHistorySeconds(config),
      // the notification channel-state rides the TUI header like every other
      // face (once --json / web /api/states / export JSON `notifications` block,
      // inc 88 parity): repeat-interval + resolved per-channel gates threaded
      // through the same canonical config resolvers the JSON faces carry, so a
      // terminal operator sees which alert channels are armed at a glance.
      notifications: { repeatIntervalSeconds: config.notifications?.repeatIntervalSeconds ?? 3600, desktop: notificationsDesktop(config), webhook: notificationsWebhookEnabled(config), email: notificationsEmailEnabled(config) },
      // the product version rides the TUI header like the web PAGE h1, export
      // page footer and once report header (inc 95 parity): threaded from the
      // CLI's VERSION const, so the terminal operator sees the same version
      // string every other face carries.
      version: VERSION,
      onExit: shutdown,
    });
    tui.start();
  }

  engine.start();
  // keep process alive
  process.stdin.resume?.();
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
}

function attachCollector(server, engine) {
  // The ApmCollector expects to attach to an http server's request handler;
  // engine.collector attach() adds its own listener and re-dispatches others.
  engine.collector.attach(server);
  // seed engine's collector already attached; runApmCheck uses collector summaries
}

async function cmdDemo(args) {
  const addr = args.collectAddr || 'http://127.0.0.1:8787/apm/agent/trace';
  const interval = args.interval || 700;
  const agent = startDemoAgent({ target: addr, intervalMs: interval });
  const log = (m) => console.log(m);
  agent.log = log;
  console.log(`demo agent reporting to ${addr} every ${interval}ms`);
  console.log('ctrl-c to stop');
}

async function cmdOnce(args) {
  const config = loadConfig(args.config);
  assertValidConfig(config);
  const storePath = resolveStorePath(config);
  ensureStoreDir(storePath);
  const store = new Store(storePath);
  const engine = new Engine({ store, config });
  // Keep stdout a pure check report: engine status lines go to stderr so a
  // `once --json` document (or `once | jot -g ...`) is never mixed with logs.
  engine.log = (m) => console.error(`[apm-watch] ${m}`);
  const results = [];
  for (const h of config.http || []) {
    const r = await engine.runHttpCheck(h);
    results.push(r);
  }
  for (const t of config.tls || []) {
    const r = await engine.runTlsCheck(t);
    results.push(r);
  }
  if (config.apm?.collect) {
    // `once` means "check each configured dimension once": APM services are
    // summarized from whatever the collector has in its window (empty when no
    // agent upstream is feeding it). No alerts here, matching http/tls.
    const { results: apmResults } = await engine.runApmCheck();
    results.push(...apmResults);
  }
  // Availability/uptime rides the http rows like the web /api/states
  // availability map, export uptime_pct/uptime_ms, and the TUI uptime suffix
  // (inc 58 parity): computed over the same ui history window and gated
  // exactly like export.js — pct null on a zero-width window, breakdown only
  // when the window has a positive span (totalMs > 0).
  const since = Date.now() - uiHistorySeconds(config) * 1000;
  // The per-target availability map rides the cron/CI document exactly like the
  // web /api/states `availability` block and the export JSON (inc 94 parity):
  // one `{pct, upMs, downMs, totalMs, samples}` entry per http target this run
  // checked, captured from the *same* per-row computation below so map values
  // equal the stamped row breakdown exactly (recomputing with a fresh now
  // would drift the window endpoint a tick and break the equality).
  const availabilityMap = {};
  for (const r of results) {
    if (r.kind !== 'http') continue;
    const rows = store.history(r.target, 'http', since);
    // The snapshot this run just wrote is the monitor's current live state.
    // When a fast check completes in the same millisecond the row is
    // timestamped, the availability window's `now` endpoint collides with the
    // row ts and the span degenerates to 0ms -> pct null, silently dropping the
    // uptime suffix off a fresh single-check report (inc 80/85 flake). Bump the
    // endpoint one tick past the newest snapshot so the just-written state
    // deterministically covers the present instant.
    const lastTs = rows[rows.length - 1]?.ts;
    const nowTs = lastTs != null ? Math.max(Date.now(), lastTs + 1) : Date.now();
    const avail = availability(rows, nowTs);
    availabilityMap[r.target] = avail;
    r.uptimePct = avail && avail.pct != null ? avail.pct : null;
    r.uptimeMs = avail && avail.totalMs > 0
      ? { up_ms: avail.upMs, down_ms: avail.downMs, total_ms: avail.totalMs, samples: avail.samples }
      : null;
  }
  // The per-check run cadence the engine's scheduler runs each probe on rides
  // the once rows like every other face (web /api/states rows + export JSON
  // blocks + TUI rows parity, inc 71): resolved once from the same per-target
  // maps the top-level http:/tls: mirror blocks carry, null off-kind. The apm
  // collection cadence is config-global (no per-target map), mirroring the
  // scheduler: block (inc 76 parity).
  const httpIntMap = httpIntervalSeconds(config);
  const tlsIntMap = tlsIntervalSeconds(config);
  const apmIntSec = schedulerIntervals(config).apmIntervalSeconds;
  for (const r of results) {
    r.intervalSeconds = r.kind === 'http' ? (httpIntMap[r.target] ?? null)
      : r.kind === 'tls' ? (tlsIntMap[r.target] ?? null)
      : r.kind === 'apm' ? (apmIntSec ?? null)
      : null;
  }
  // Exit code mirrors the worst status so `once` works as a cron/CI smoke check:
  // 0 = all ok, 1 = any warn, 2 = any error. Matching Nagios conventions.
  process.exitCode = worstStatus(results);
  // Monitor self-health: the engine persists this meta on every check path it
  // ran above — web /api/states and export mirror this exact block, so the
  // cron/CI document carries the same "up since / last check" snapshot.
  // Null when no check ran (fresh store or empty config).
  const h = store.getMeta?.('health')?.value;
  const health = h?.lastCheckAt
    ? { status: h.status || 'unknown', uptimeSince: h.uptimeSince ?? null, lastCheckAt: h.lastCheckAt ?? null }
    : null;
  // The recent-events list mirrors the web /api/events + export page surfaces
  // (ts/level/source/message shape, newest first — store.recentEvents order).
  // A `once` run itself records no events (checks run without the alert path),
  // so a fresh run yields [] until a run/export alert cycle wrote some to the
  // store; the cron/CI document still carries the key so consumers see history.
  const events = store.recentEvents(50).map((e) => ({ ts: e.ts, level: e.level, source: e.source, message: e.message }));
  // The per-target metric series ride the cron/CI document exactly like the web
  // /api/states `series` block and the export JSON (inc 91 parity): each target
  // this run just checked gets its metric line over the same ui-history window
  // the availability above aggregates over, one `{target, ts, value}` point per
  // stored sample (ts in seconds — the web formatSeries shape). Targets with no
  // stored samples yet carry an empty array, so a consumer can render the six
  // chart families from any snapshot without a null-guard.
  const onceEventKindTargets = (kind) => [...new Set(results.filter((r) => r.kind === kind).map((r) => r.target))];
  const onceSeriesRows = (prefix, targets, suffix) => {
    const byTarget = {};
    for (const t of targets) {
      byTarget[t] = store.series(`${prefix}${t}/${suffix}`, since, 400)
        .map((row) => ({ target: t, ts: row.ts / 1000, value: row.value }));
    }
    return byTarget;
  };
  const onceHttpTargets = onceEventKindTargets('http');
  const onceTlsTargets = onceEventKindTargets('tls');
  const onceApmNames = onceEventKindTargets('apm');
  const series = {
    'http:latency': onceSeriesRows('http:', onceHttpTargets, 'latency'),
    'http:status': onceSeriesRows('http:', onceHttpTargets, 'status'),
    'tls:remaining': onceSeriesRows('tls:', onceTlsTargets, 'remaining'),
    'apm:p50': onceSeriesRows('apm:', onceApmNames, 'p50'),
    'apm:p95': onceSeriesRows('apm:', onceApmNames, 'p95'),
    'apm:errorRate': onceSeriesRows('apm:', onceApmNames, 'errorRate'),
  };
  if (args.json) {
    // the generation instant is computed once so the top-level twins and the
    // summary block timestamp are the same instant (the export JSON constraint,
    // export.test.js — a consumer can diff generated_at against updated_at)
    const docNow = Date.now();
    console.log(JSON.stringify({
      exit_code: process.exitCode,
      // the product version rides the cron/CI document like the export JSON
      // `apm_watch_version` (inc 92 parity): the once --json and /api/states
      // faces used to drop it, so a cron/CI consumer had no version string to
      // pair with the block shapes it engineers against.
      apm_watch_version: VERSION,
      // the generation-time twin rides the cron/CI document like the export
      // JSON `generated_at`/`generated_ts` (inc 93 parity): the once --json
      // and /api/states faces used to drop it, so a cron/CI consumer had no
      // ISO/epoch pair for when the snapshot was generated. The summary
      // block's snapshot-update timestamp is the same instant.
      generated_at: new Date(docNow).toISOString(),
      generated_ts: docNow,
      apm: { collect: config.apm?.collect === true, errorRateThreshold: config.apm?.errorRateThreshold ?? 0.05, latencyThresholdMs: config.apm?.latencyThresholdMs ?? null, windowMs: config.apm?.windowMs ?? 60_000, maxSamples: config.apm?.maxSamples ?? 5000 },
      http: { latencyThresholds: httpLatencyThresholds(config), timeoutMs: httpTimeoutMs(config), assertStatusCodes: httpAssertStatusCodes(config), assertBodyIncludes: httpAssertBodyIncludes(config), intervalSeconds: httpIntervalSeconds(config) },
      tls: { warnDaysBefore: tlsWarnDaysBefore(config), timeoutMs: tlsTimeoutMs(config), port: tlsPort(config), intervalSeconds: tlsIntervalSeconds(config) },
      store: { retentionDays: retentionDays(config?.store) },
      notifications: { repeatIntervalSeconds: config.notifications?.repeatIntervalSeconds ?? 3600, desktop: notificationsDesktop(config), webhook: notificationsWebhookEnabled(config), email: notificationsEmailEnabled(config) },
      scheduler: schedulerIntervals(config),
      ui: { historySeconds: uiHistorySeconds(config) },
      availability: availabilityMap,
      health,
      events,
      // the snapshot status-count summary rides the once --json document like
      // the web /api/states summary block and export JSON summary (inc 79
      // parity): the worst status plus the ok/warn/error/unknown distribution
      // of exactly the results that just ran. The snapshot-update timestamp
      // rides the summary block too (inc 81 parity): the web /api/states
      // summary computes `updated_at: Date.now()` at response time, and the
      // once document used to drop it, so a cron/CI consumer had no "generated
      // when" field for the counts — now it mirrors the web block exactly.
      summary: { overall: aggStatus(results.map((r) => r.status)), counts: countStatuses(results.map((r) => r.status)), updated_at: docNow },
      series,
      results: results.map(onceJsonRow),
    }, null, 2));
    return;
  }
  // the product version rides the human report like the export page footer,
  // web PAGE h1 and TUI header (inc 95 parity): a cron/CI author grepping the
  // report pairs the block shapes with the exact version that produced them —
  // the same `apm-watch vX.Y.Z` string the usage/--version paths print.
  console.log(`apm-watch v${VERSION}`);
  for (const r of results) {
    const verb = r.method ? r.method + ' ' : '';
    // numeric response code rides the row like the tui http row (inc-52
    // parity): states without a code (network-error path) keep the compact
    // `GET err:...` shape, so guard on null.
    const code = r.statusCode != null ? r.statusCode + ' ' : '';
    // tls chain metadata, mirroring the tui row / web table & tooltip. The
    // multi-cert chain path rides the row leaf-first like the TUI `chain: A
    // -> B` annotation (inc 72 parity): runTlsCheck returns the full per-cert
    // array on every tls result (once --json carries it as `chain`), but the
    // human row used to drop it, showing only the leaf subject. Single-cert
    // chains are already covered by the leaf subject, so gate on length > 1
    // exactly like the TUI row. The per-cert validity windows ride along after
    // the subject run (inc 84 parity): each cert's validFrom / notAfter / days
    // remaining seed the web & export tooltips and every JSON face, but the
    // human row used to drop every field but the subject — now the row renders
    // them leaf-first, one space-separated block per cert.
    // per-cert validity windows ride the human row like the web/export tooltips
    // and every JSON face (inc 84 parity): the chain producers emit the raw
    // notBefore/notAfter strings (GMT for socket certs, ISO for pem/cert-test
    // fixtures) and the tooltips render them verbatim, so the human row passes
    // them through untouched too — a cert with no date still renders a dash.
    const chainDates = Array.isArray(r.chain) && r.chain.length > 1
      ? '  ' + r.chain.map((c) => `valid ${c.validFrom || '—'} notAfter ${c.notAfter || '—'} ${c.daysRemaining != null ? `${c.daysRemaining}d` : '—'}${c.selfSigned ? ' (self-signed)' : ''}`).join(' | ')
      : '';
    const tls = r.kind === 'tls'
      ? `${r.leafSubject ? ` (${r.leafSubject})` : ''}${r.validChain === false ? ' (chain broken)' : ''}${Array.isArray(r.chain) && r.chain.length > 1 ? `  chain: ${r.chain.map((c) => shortName(c.subject)).join(' -> ')}` : ''}${chainDates}`
      : '';
    // http rows whose detail prose carries no timing figure (assert/body
    // mismatches, network errors — unlike `HTTP 200 in Nms`, `slow: Nms >`,
    // `timeout after Nms`) gain the numeric latency as the tui/web/export
    // latency columns always surface it (inc-55 parity). Guarded on null so
    // hypothetical latency-less rows keep the compact shape.
    const latency = r.kind === 'http' && r.latencyMs != null && !/ms/.test(r.detail ?? '')
      ? ` · ${r.latencyMs.toFixed(0)}ms`
      : '';
    // availability rides the human http row like the export html / TUI uptime
    // suffix (inc 58 parity): ` · N% uptime`, gated on a computed pct
    const uptime = r.kind === 'http' && r.uptimePct != null
      ? ` · ${r.uptimePct}% uptime${r.uptimeMs != null ? ` (down ${fmtInterval(r.uptimeMs.down_ms / 1000)})` : ''}${r.uptimeMs && r.uptimeMs.samples != null ? ` (over ${r.uptimeMs.samples} sample${r.uptimeMs.samples === 1 ? '' : 's'})` : ''}`
      : '';
    // judged-against http assert criteria ride the row like the tui row / web
    // table (inc 65 parity, inc 64 ` exp N` / ` body "s"` format): stamped onto
    // each engine result by check-http.js finalize (expectedStatusCode/
    // bodyIncludes), so no new config maps — null-guarded, so targets without
    // an `assert` block keep the bare row.
    const assertAnno = r.kind === 'http' && (r.expectedStatusCode != null || r.bodyIncludes != null)
      ? `${r.expectedStatusCode != null ? ` exp ${r.expectedStatusCode}` : ''}${r.bodyIncludes != null ? ` body "${r.bodyIncludes}"` : ''}`
      : '';
    // the abort timeout the probe was actually judged against rides the human
    // row like the tui/web/export rows (inc 67 parity): the engine stamps
    // timeoutMs on every http/tls result (check-http.js finalize / runTlsCheck),
    // so this reads straight off the result — null-gated, so hypothetical
    // timeout-less rows keep the compact shape.
    const timeoutAnno = r.kind === 'http' || r.kind === 'tls'
      ? (r.timeoutMs != null ? ` timeout ${r.timeoutMs}ms` : '')
      : '';
    // the apm thresholds the run was judged against ride the human row like the
    // web /api/states rows + once --json + export JSON blocks (inc 68 parity):
    // stamped onto each runApmCheck result (errorRateThreshold always-resolved
    // to the 0.05 default, latencyThresholdMs null when unconfigured — matching
    // onceJsonRow's error_rate_threshold / latency_threshold_ms). Same
    // ` errThr N%` / ` slow thr Nms` format the TUI apm-history section uses.
    // The measured error rate rides along as ` err N%` (inc 75 parity) — the
    // engine stamps errorRate on every apm result and the detail renders only
    // the errors=N/M fraction, so the labeled percentage gives the terminal
    // row the same at-a-glance rate the TUI apm-history err line carries.
    // The sampling window rides as ` window 1m` (inc 77 parity): stamped onto
    // every apm result by runApmCheck (windowMs, the collector's configured
    // sampling window), so the human row says how long a window each summary
    // was collected over — compact formatted like the every-cadence anno above.
    // The per-service sample-buffer capacity rides as ` cap N` (inc 82 parity):
    // stamped onto every apm result by runApmCheck (maxSamples, the ring the
    // collector caps the buffer at), so the row says how many samples the
    // window's summary was collected over.
    const apmAnno = r.kind === 'apm'
      ? `${r.errorRateThreshold != null ? ` errThr ${(r.errorRateThreshold * 100).toFixed(1)}%` : ''}${r.latencyThresholdMs != null ? ` slow thr ${r.latencyThresholdMs}ms` : ''}${r.errorRate != null ? ` err ${(r.errorRate * 100).toFixed(1)}%` : ''}${r.windowMs != null ? ` window ${fmtInterval(r.windowMs / 1000)}` : ''}${r.maxSamples != null ? ` cap ${r.maxSamples}` : ''}`
      : '';
    // the per-check run cadence rides the human row like the tui/web/export rows
    // (inc 71 parity): stamped onto each result in cmdOnce (intervalSeconds,
    // resolved from the same per-target maps the other faces carry) — the apm
    // collection cadence rides too, from the config-global scheduler value (inc
    // 76 parity). ` every 5m`-style, formatted compact. Null off-kind.
    const intervalAnno = r.kind === 'http' || r.kind === 'tls' || r.kind === 'apm'
      ? (r.intervalSeconds != null ? ` every ${fmtInterval(r.intervalSeconds)}` : '')
      : '';
    // the per-probe slow-latency threshold whose exceedance demotes ok->warn
    // rides the human row like the tui/web/export rows (inc 73 parity): stamped
    // onto each engine result by check-http.js finalize (latencyThresholdMs), so
    // this reads straight off the result — null-gated, so targets without a
    // latency threshold keep the bare row and the apm row keeps its slow thr anno.
    const thrAnno = r.kind === 'http' && r.latencyThresholdMs != null ? ` thr ${r.latencyThresholdMs}ms` : '';
    // the judged-against cert-warn threshold its proximity demotes ok->warn
    // rides the human row like the tui/web/export rows (inc 74 parity): stamped
    // onto every tls result by engine.runTlsCheck (warnDaysBefore, resolved to
    // the config default when unset), so this reads straight off the result —
    // null-gated, so targets without a configured warn window keep the bare row.
    const warnAnno = r.kind === 'tls' && r.warnDaysBefore != null ? ` warn ${r.warnDaysBefore}d` : '';
    // the port the cert check actually probed rides the human row like the
    // tui/web/export rows (inc 78 parity): stamped onto every tls result by
    // engine.runTlsCheck (cfg.port ?? 443 for sockets, null for pemFile
    // bundles), so this reads straight off the result — null-gated, so
    // pemFile targets keep the bare row.
    const portAnno = r.kind === 'tls' && r.port != null ? ` port ${r.port}` : '';
    console.log(`${emoji(r.status)} ${r.kind} ${r.target}: ${verb}${code}${r.detail}${latency}${uptime}${tls}${assertAnno}${timeoutAnno}${intervalAnno}${thrAnno}${warnAnno}${portAnno}${apmAnno}`);
  }
  // Snapshot status-count summary rides the human report like the web pillbox,
  // export page pills / JSON summary, once --json summary block and TUI header
  // (inc 79 parity): `ok N warn N err N` of exactly the checks that just ran.
  // The snapshot-update time rides the summary line like the web meta `updated`
  // and export page `generated` (inc 81 parity): `ok 1 warn 0 err 0 · updated
  // 12:34:56` — the web /api/states summary carries updated_at while the once
  // human report used to carry no "generated when" for the counts.
  const counts = countStatuses(results.map((r) => r.status));
  // the overall worst-status word rides the summary line like the web pillbox /
  // export page pill / JSON `summary.overall` (inc 96 parity): aggStatus's
  // error>warn>ok precedence over exactly the checks that just ran.
  console.log(`ok ${counts.ok} warn ${counts.warn} err ${counts.error} · overall ${aggStatus(results.map((r) => r.status))} · updated ${new Date().toLocaleTimeString()} · keep ${retentionDays(config?.store)}d`);
  // Monitor self-health rides the human report like the once --json block and
  // the TUI header / web / export page meta lines (inc 66 parity): the worst
  // status, up-duration and last-check time of exactly the checks that just
  // ran. Null-gated like the JSON path — a fresh store (no check ran) prints
  // nothing, so a cron/CI author sees the same snapshot every other face
  // shows when there is one.
  if (health) {
    const upMs = Math.max(0, health.lastCheckAt - (health.uptimeSince ?? health.lastCheckAt));
    const when = new Date(health.lastCheckAt).toLocaleTimeString();
    console.log(`health ${health.status || 'unknown'} · up ${fmtDuration(upMs)} · last check ${when}`);
  }
  // The notification channel-state rides the human report like the once --json
  // / web /api/states / export JSON `notifications` block (inc 88 parity): which
  // alert channels are armed plus the dedup repeat-interval, resolved by the
  // same canonical config resolvers every other face carries, so a cron/CI
  // author sees the same alert-arming summary the JSON document shows.
  const notifCh = [notificationsDesktop(config) ? 'desktop' : null, notificationsWebhookEnabled(config) ? 'webhook' : null, notificationsEmailEnabled(config) ? 'email' : null].filter(Boolean);
  console.log(`notif ${notifCh.join(' ') || 'none'} · repeat ${fmtInterval(config.notifications?.repeatIntervalSeconds ?? 3600)}`);
  // The availability/series history window the uptime pct + breakdown aggregate
  // over rides the human report like the once --json / web /api/states / export
  // JSON `ui.historySeconds` block (inc 89 parity): resolved by the same
  // canonical uiHistorySeconds resolver those JSON faces carry — a cron/CI
  // author sees the window span the `100% uptime (over N samples)` line
  // aggregates over instead of only the JSON document carrying it.
  console.log(`history ${fmtInterval(uiHistorySeconds(config))}`);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

// compact run-cadence label (90 -> '90s', 120 -> '2m', 300 -> '5m'),
// mirroring the fmtInterval helpers on the web / export / TUI faces
function fmtInterval(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// last slash-separated component of an x509 subject (`/C=US/O=Acme/CN=fixture.test`
// -> `CN=fixture.test`), mirroring the TUI row's shortName so the once human tls
// chain annotation matches its format exactly
function shortName(subject) {
  const part = String(subject ?? '').split('/').filter(Boolean).pop();
  return part || '?';
}

// Severity rank across the ok/warn/error status set. warn is "soft" failure,
// error is "hard" — used to pick the process exit code for `once`.
export function worstStatus(results, { warnExit = 1, errorExit = 2 } = {}) {
  let code = 0;
  for (const r of results) {
    if (r.status === 'error') return errorExit;
    if (r.status === 'warn') code = warnExit;
  }
  return code;
}

// Row mapper for `once --json` — every result kind (http/tls/apm) gets the full
// field set with `?? null` normalization so a CI consumer can rely on a stable
// shape. Kind-specific fields are null on the other kinds.
export function onceJsonRow(r) {
  return {
    target: r.target, kind: r.kind, status: r.status,
    ts: r.ts ?? null,
    latency_ms: r.latencyMs ?? null,
    method: r.method ?? null,                // http only
    status_code: r.statusCode ?? null,       // http only
    // the judged-against assert criteria that drove any status/body failure,
    // stamped on the engine results (check-http.js finalize, inc 63): the
    // expected status code + required body substring, null when no `assert`
    // block is configured
    expected_status_code: r.expectedStatusCode ?? null, // http only
    body_includes: r.bodyIncludes ?? null,               // http only
    // http: resolved per-target threshold; apm: the config-level threshold the
    // summary was judged against (latency_ms precedent — one field, both kinds)
    latency_threshold_ms: r.latencyThresholdMs ?? null,
    // http: the timeout the probe was actually aborted by; tls: the cert-fetch
    // socket timeout the check was aborted by (both default 5000, stamped on
    // the engine results; latency_threshold_ms precedent)
    timeout_ms: r.timeoutMs ?? null,
    // this target's run cadence (seconds between scheduled checks, the
    // intervalSeconds the engine's taskIntervalMs actually runs on, computed in
    // cmdOnce from the same per-target maps the web/export/TUI faces carry —
    // inc 71 parity; the apm cadence is the config-global scheduler value, inc 76).
    // Null off-kind.
    interval_seconds: r.intervalSeconds ?? null, // http/tls/apm only
    days_remaining: r.daysRemaining ?? null, // tls only
    warn_days_before: r.warnDaysBefore ?? null, // tls only
    port: r.port ?? null, // tls only (probe port the cert check actually ran against: cfg.port ?? 443 for sockets, null for pemFile bundles)
    chain: r.chain?.length ? r.chain : null, // tls only (empty/error chain -> null, matching web/export)
    valid_chain: r.validChain ?? null,       // tls only
    leaf_subject: r.leafSubject ?? null,     // tls only
    p50_ms: r.p50Ms ?? null,                 // apm only
    p95_ms: r.p95Ms ?? null,                 // apm only
    error_rate: r.errorRate ?? null,         // apm only
    errors: r.errors ?? null,                // apm only
    samples: r.samples ?? null,              // apm only
    error_rate_threshold: r.errorRateThreshold ?? null, // apm only (stamped by runApmCheck, inc 33)
    window_ms: r.windowMs ?? null, // apm only (stamped by runApmCheck, inc 77 — the sampling window the summary was collected over)
    max_samples: r.maxSamples ?? null, // apm only (stamped by runApmCheck, inc 82 — the sample-buffer capacity the collector capped the window's summary at)
    uptime_pct: r.uptimePct ?? null, // http only (computed in cmdOnce, inc 58)
    uptime_ms: r.uptimeMs ?? null,   // http only (breakdown, export.js:43 gates)
    detail: r.detail,
  };
}

function emoji(s) { return s === 'ok' ? 'OK' : s === 'warn' ? 'WS' : '!!'; }

async function cmdExport(args) {
  const config = loadConfig(args.config);
  assertValidConfig(config);
  const storePath = resolveStorePath(config);
  ensureStoreDir(storePath);
  const store = new Store(storePath);
  const out = exportStatus(store, config, VERSION);
  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    const isHtml = args.out.toLowerCase().endsWith('.html') || args.out.toLowerCase().endsWith('.htm');
    writeFileSync(args.out, isHtml ? renderStatusPage(out) : JSON.stringify(out, null, 2));
    console.log(`wrote ${args.out} (${isHtml ? 'html' : 'json'})`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

async function cmdServe(args) {
  const config = loadConfig(args.config);
  assertValidConfig(config);
  const storePath = resolveStorePath(config);
  ensureStoreDir(storePath);
  const store = new Store(storePath);
  const server = createUiServer(store, config);
  const port = args.port !== undefined ? args.port : config.ui?.port ?? 8787;
  listenWithFatal(server, { host: '127.0.0.1', port }, () => {
    const addr = server.address();
    console.log(`web UI on http://127.0.0.1:${addr.port}/`);
  });
}

if (IS_MAIN) {
  main().catch((err) => {
    // A one-line message keeps cron/CI stderr clean: every error that reaches
    // here already explains itself (config read/parse/validation, file write,
    // port bind), so a raw stack dump only buries the operator-facing line.
    console.error('[apm-watch] fatal:', err?.message ?? err);
    process.exit(1);
  });
}
