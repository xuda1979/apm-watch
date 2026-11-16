#!/usr/bin/env node
// apm-watch entrypoint: `run`, `demo`, `once`, `export`, `serve`, `tui`.

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { Engine } from '../lib/engine.js';
import { ApmCollector } from '../lib/apm.js';
import { createUiServer } from '../lib/ui-server.js';
import { Tui } from '../lib/ui-tui.js';
import { startDemoAgent } from '../lib/demo-agent.js';
import { checkEndpoint } from '../lib/check-http.js';
import { fetchCertChain, netChainToReport } from '../lib/check-tls.js';
import { desktopNotification } from '../lib/notify.js';

const VERSION = '0.1.0';
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
  export  write current status as JSON for a status page
  serve   start only the web UI over an existing store
`);
}

function parseArgs(argv) {
  const args = { _: [] };
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
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) { /* ignore unknown */ }
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
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
  const storePath = resolveStorePath(config);
  ensureStoreDir(storePath);
  const store = new Store(storePath);
  const engine = new Engine({ store, config });
  const ui = args.ui || config.ui?.mode || 'web';
  const uiPort = args.uiPort !== undefined ? args.uiPort : config.ui?.port ?? 0;

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
    const tui = new Tui({ store, intervalMs: 2000 });
    tui.start();
  }

  engine.start();
  // keep process alive
  process.stdin.resume?.();
  const shutdown = () => engine.stop();
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
  const storePath = resolveStorePath(config);
  ensureStoreDir(storePath);
  const store = new Store(storePath);
  const engine = new Engine({ store, config });
  for (const h of config.http || []) {
    const r = await engine.runHttpCheck(h);
    console.log(`${emoji(r.status)} http ${r.target}: ${r.detail}`);
  }
  for (const t of config.tls || []) {
    try {
      const { certs } = await fetchCertChain(t);
      const rep = netChainToReport({ host: t.host, port: t.port || 443, certs });
      const days = rep.daysRemaining;
      const threshold = t.warnDaysBefore ?? 30;
      const fail = days === null;
      let code;
      if (fail) code = 'error';
      else if (days <= 0) code = 'error';
      else if (days <= threshold) code = 'warn';
      else code = 'ok';
      console.log(`${emoji(code)} tls ${t.name || t.host}: ${days === null ? 'no certificate' : days + 'd remaining'}${fail ? '' : days <= 0 ? ' EXPIRED' : ''}`);
    } catch (e) {
      console.log(`${emoji('error')} tls ${t.host}: ${e.message}`);
    }
  }
}

function emoji(s) { return s === 'ok' ? 'OK' : s === 'warn' ? 'WS' : '!!'; }

async function cmdExport(args) {
  const config = loadConfig(args.config);
  const storePath = resolveStorePath(config);
  ensureStoreDir(storePath);
  const store = new Store(storePath);
  const out = exportStatus(store, config);
  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, JSON.stringify(out, null, 2));
    console.log(`wrote ${args.out}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

export function exportStatus(store, config) {
  const states = store.latestStates(100);
  const byTarget = new Map();
  for (const s of states) {
    if (!byTarget.has(s.target)) byTarget.set(s.target, []);
    byTarget.get(s.target).push(s);
  }
  const targets = [];
  for (const [target, rows] of byTarget) {
    const http = rows.find((r) => r.kind === 'http');
    const tls = rows.find((r) => r.kind === 'tls');
    const apm = rows.find((r) => r.kind === 'apm');
    targets.push({
      target,
      status: aggStatus(rows.map((r) => r.status)),
      http: http ? { status: http.status, latency_ms: http.latency_ms, detail: http.detail, ts: http.ts } : null,
      tls: tls ? { status: tls.status, detail: tls.detail, ts: tls.ts } : null,
      apm: apm ? { status: apm.status, latency_ms: apm.latency_ms, detail: apm.detail, ts: apm.ts } : null,
    });
  }
  const now = Date.now();
  const statuses = targets.map((t) => t.status);
  const counts = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  return {
    generated_at: new Date(now).toISOString(),
    generated_ts: now,
    apm_watch_version: VERSION,
    summary: { overall: aggStatus(statuses), counts },
    targets,
  };
}

function aggStatus(statuses) {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

async function cmdServe(args) {
  const config = loadConfig(args.config);
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
