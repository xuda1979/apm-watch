#!/usr/bin/env node
// apm-watch entrypoint: `run`, `demo`, `once`, `export`, `serve`, `tui`.

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, httpLatencyThresholds, tlsWarnDaysBefore } from '../lib/config.js';
import { assertValidConfig } from '../lib/validate.js';
import { Store } from '../lib/store.js';
import { Engine, retentionDays } from '../lib/engine.js';
import { createUiServer } from '../lib/ui-server.js';
import { Tui } from '../lib/ui-tui.js';
import { startDemoAgent } from '../lib/demo-agent.js';
import { exportStatus, renderStatusPage } from '../lib/export.js';

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
  const args = { _: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--ui') args.ui = argv[++i];
    else if (a === '--ui-port') args.uiPort = Number(argv[++i]);
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--collect-addr') args.collectAddr = argv[++i];
    else if (a === '--apm-port') args.apmPort = Number(argv[++i]);
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-V') args.version = true;
    else if (a.startsWith('--')) args.unknown.push(a);
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A typo'd flag must not silently fall back to the default config and run
  // checks against it — surface it so cron/CI authors catch mistakes.
  for (const u of args.unknown) {
    console.error(`[apm-watch] unknown flag "${u}" ignored (see --help)`);
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
    server.listen({ host: config.ui?.host || '127.0.0.1', port: uiPort }, () => {
      const addr = server.address();
      console.log(`web UI on http://127.0.0.1:${addr.port}/`);
    });
    attachCollector(server, engine);
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
        collectorServer.listen(port, '127.0.0.1', () => {
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
      // apm warn criteria the collector summary is judged against (web drawApm
      // /drawErrRate marker parity): null error-rate here would leave the err
      // line unannotated even though the engine always judges against 0.05.
      apmLatencyThresholdMs: config.apm?.latencyThresholdMs ?? null,
      apmErrorRateThreshold: config.apm?.errorRateThreshold ?? 0.05,
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
  // Exit code mirrors the worst status so `once` works as a cron/CI smoke check:
  // 0 = all ok, 1 = any warn, 2 = any error. Matching Nagios conventions.
  process.exitCode = worstStatus(results);
  if (args.json) {
    console.log(JSON.stringify({
      exit_code: process.exitCode,
      apm: { errorRateThreshold: config.apm?.errorRateThreshold ?? 0.05, latencyThresholdMs: config.apm?.latencyThresholdMs ?? null, windowMs: config.apm?.windowMs ?? 60_000, maxSamples: config.apm?.maxSamples ?? 5000 },
      store: { retentionDays: retentionDays(config?.store) },
      notifications: { repeatIntervalSeconds: config.notifications?.repeatIntervalSeconds ?? 3600 },
      results: results.map(onceJsonRow),
    }, null, 2));
    return;
  }
  for (const r of results) {
    const verb = r.method ? r.method + ' ' : '';
    // tls chain metadata, mirroring the tui row / web table & tooltip
    const tls = r.kind === 'tls'
      ? `${r.leafSubject ? ` (${r.leafSubject})` : ''}${r.validChain === false ? ' (chain broken)' : ''}`
      : '';
    console.log(`${emoji(r.status)} ${r.kind} ${r.target}: ${verb}${r.detail}${tls}`);
  }
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
    // http: resolved per-target threshold; apm: the config-level threshold the
    // summary was judged against (latency_ms precedent — one field, both kinds)
    latency_threshold_ms: r.latencyThresholdMs ?? null,
    // http: the timeout the probe was actually aborted by; tls: the cert-fetch
    // socket timeout the check was aborted by (both default 5000, stamped on
    // the engine results; latency_threshold_ms precedent)
    timeout_ms: r.timeoutMs ?? null,
    days_remaining: r.daysRemaining ?? null, // tls only
    warn_days_before: r.warnDaysBefore ?? null, // tls only
    chain: r.chain?.length ? r.chain : null, // tls only (empty/error chain -> null, matching web/export)
    valid_chain: r.validChain ?? null,       // tls only
    leaf_subject: r.leafSubject ?? null,     // tls only
    p50_ms: r.p50Ms ?? null,                 // apm only
    error_rate: r.errorRate ?? null,         // apm only
    errors: r.errors ?? null,                // apm only
    samples: r.samples ?? null,              // apm only
    error_rate_threshold: r.errorRateThreshold ?? null, // apm only (stamped by runApmCheck, inc 33)
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
  server.listen({ host: '127.0.0.1', port }, () => {
    const addr = server.address();
    console.log(`web UI on http://127.0.0.1:${addr.port}/`);
  });
}

if (IS_MAIN) {
  main().catch((err) => {
    console.error('[apm-watch] fatal:', err);
    process.exit(1);
  });
}
