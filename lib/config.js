// Configuration: reads apm-watch.json / apm-watch.json5(lite) / env vars.
// Only JSON is fully specified; env overrides help with secrets.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSeconds, MIN_INTERVAL_S, MAX_INTERVAL_S } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the per-http-target slow-latency thresholds exactly as the engine
// does (check-http.js finalize): entry-level latencyThresholdMs wins over
// assert.latencyThresholdMs. Keyed by the store target (name || url) so every
// surface (web api/chart, export, TUI) annotates the threshold each endpoint is
// actually judged against — canonical resolver shared by lib/ui-server.js,
// lib/export.js and lib/ui-tui.js.
export function httpLatencyThresholds(config) {
  const out = {};
  for (const h of config?.http || []) {
    if (!h || (!h.name && !h.url)) continue;
    const ms = h.latencyThresholdMs ?? h.assert?.latencyThresholdMs ?? null;
    if (ms !== null && ms !== undefined) out[h.name || h.url] = Number(ms);
  }
  return out;
}

// Resolve the per-http-target probe timeout exactly as the engine does
// (check-http.js: cfg.timeoutMs ?? 5000). Keyed by the store target
// (name || url) so every surface (web api, export) shows the timeout each
// endpoint was actually aborted by — canonical resolver shared by
// lib/ui-server.js and lib/export.js.
export function httpTimeoutMs(config) {
  const out = {};
  for (const h of config?.http || []) {
    if (!h || (!h.name && !h.url)) continue;
    out[h.name || h.url] = Number(h.timeoutMs ?? 5000);
  }
  return out;
}

// Resolve the per-tls-target certificate warn threshold exactly as the engine
// does (engine.js runTlsCheck: entry-level warnDaysBefore wins; default 30).
// Keyed by the engine's store-target convention (name, else pemFile, else
// host:port with the 443 fallback) so every surface (web api/chart, export,
// TUI) annotates the threshold each cert is actually judged against — canonical
// resolver shared by lib/ui-server.js, lib/export.js and lib/ui-tui.js.
export function tlsWarnDaysBefore(config) {
  const out = {};
  for (const t of config?.tls || []) {
    if (!t || (!t.name && !t.pemFile && !t.host)) continue;
    out[t.name || (t.pemFile ? t.pemFile : `${t.host}:${t.port || 443}`)] = Number(t.warnDaysBefore ?? 30);
  }
  return out;
}

// Resolve the per-tls-target cert-fetch timeout exactly as the engine does
// (check-tls.js fetchCertChain: cfg.timeoutMs ?? 5000). Keyed by the engine's
// store-target convention (name, else pemFile, else host:port with the 443
// fallback) so every surface (web api, export) shows the abort timeout each
// cert fetch was actually cut short by — canonical resolver shared by
// lib/ui-server.js and lib/export.js.
export function tlsTimeoutMs(config) {
  const out = {};
  for (const t of config?.tls || []) {
    if (!t || (!t.name && !t.pemFile && !t.host)) continue;
    out[t.name || (t.pemFile ? t.pemFile : `${t.host}:${t.port || 443}`)] = Number(t.timeoutMs ?? 5000);
  }
  return out;
}

// Resolve the scheduler grid exactly as the engine's buildTasks does
// (engine.js taskIntervalMs/clampIntervalSeconds): per-scheduler-section keys
// `httpIntervalSeconds`/`tlsIntervalSeconds`/`apmIntervalSeconds` fall back to
// hard defaults (60s http, 300s tls, 60s apm) and are clamped into the
// scheduler's [MIN_INTERVAL_S=30, MAX_INTERVAL_S=300] window so every surface
// (web api, export, once --json) shows the interval each task actually runs on
// — canonical resolver shared by lib/ui-server.js, lib/export.js and
// bin/apm-watch.js.
// Effective per-check run interval (seconds), replicating engine.js buildTasks
// -> taskIntervalMs: entry-level `intervalSeconds` beats the scheduler-wide
// default, both parsed via the configSeconds grammar, clamped into the
// scheduler's [MIN_INTERVAL_S, MAX_INTERVAL_S] window, falling back to the
// kind's hard default (60s http, 300s tls) when nothing finite is configured.
// Keyed by the store target so web/export mirror the cadence each task actually
// runs on — canonical resolver shared by lib/ui-server.js and lib/export.js.
function checkIntervalMap(entries, schedulerSeconds, kindFallback, keyOf) {
  const out = {};
  for (const e of entries || []) {
    if (!e) continue;
    const key = keyOf(e);
    if (!key) continue;
    let s = configSeconds(e.intervalSeconds ?? schedulerSeconds);
    if (!Number.isFinite(s)) s = kindFallback;
    out[key] = Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, s));
  }
  return out;
}

export function httpIntervalSeconds(config) {
  return checkIntervalMap(config?.http, config?.scheduler?.httpIntervalSeconds, 60, (h) => h.name || h.url);
}

export function tlsIntervalSeconds(config) {
  return checkIntervalMap(config?.tls, config?.scheduler?.tlsIntervalSeconds, 300, (t) => t.name || (t.pemFile ? t.pemFile : `${t.host}:${t.port || 443}`));
}

export function schedulerIntervals(config) {
  const via = (defaultSeconds, key) => {
    let s = configSeconds(config?.scheduler?.[key]);
    if (!Number.isFinite(s)) s = defaultSeconds;       // engine: `|| defaultSeconds`
    if (!Number.isFinite(s)) return null;
    return Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, s));
  };
  return {
    httpIntervalSeconds: via(60, 'httpIntervalSeconds'),
    tlsIntervalSeconds: via(300, 'tlsIntervalSeconds'),
    apmIntervalSeconds: via(60, 'apmIntervalSeconds'),
  };
}

// Resolve the availability/series history window exactly as every consumer does
// (web /api/states, export, TUI: `config.ui?.historySeconds ?? 24 * 3600`),
// so the surfaced number matches the window each surface actually aggregates
// over — canonical resolver shared by lib/ui-server.js, lib/export.js and
// bin/apm-watch.js. Plain-seconds fallback (not unit-string grammar): the
// consumers multiply by 1000 directly, so a typo'd string would silently fall
// back to 24h today; surfacing the resolved value keeps that visible.
export function uiHistorySeconds(config) {
  return config?.ui?.historySeconds ?? 24 * 3600;
}

// Resolve the desktop-notification gate exactly as the engine dispatches it
// (engine.js `_defaultNotify`: `n.desktop !== false` — anything but the literal
// `false` sends a desktop popup), shared by lib/ui-server.js, lib/export.js and
// bin/apm-watch.js so every surfaced value matches the engine's gate. The `!==
// false` grammar is kept deliberately: a "false"/"no"/0 typo in JSON config
// stays ON today, and this surfaces the resolved truth instead of hiding it.
export function notificationsDesktop(config) {
  return config?.notifications?.desktop !== false;
}

export function defaultConfigFile() {
  const cwd = process.cwd();
  for (const name of ['apm-watch.json', '.apm-watch.json']) {
    if (existsSync(path.join(cwd, name))) return path.join(cwd, name);
  }
  return null;
}

export function loadConfig(file = defaultConfigFile()) {
  if (!file) {
    return {
      http: [],
      tls: [],
      apm: {},
      notifications: {},
      scheduler: {},
      ui: { port: 0 },
    };
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read config ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config ${file} is not valid JSON: ${e.message}`);
  }
  // env overrides
  if (process.env.APMW_NOTIFY_WEBHOOK_URL) {
    parsed.notifications = parsed.notifications || {};
    parsed.notifications.webhook = parsed.notifications.webhook || {};
    parsed.notifications.webhook.url = process.env.APMW_NOTIFY_WEBHOOK_URL;
  }
  // SMTP env overrides
  const smtpEnv = envSmtp();
  if (smtpEnv) {
    parsed.notifications = parsed.notifications || {};
    parsed.notifications.email = smtpEnv;
  }
  return parsed;
}

function envSmtp() {
  const pick = (name) => process.env[name];
  const required = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_TO'];
  const cfg = {
    host: pick('SMTP_HOST'),
    from: pick('SMTP_FROM'),
    to: pick('SMTP_TO'),
    port: pick('SMTP_PORT') ? Number(pick('SMTP_PORT')) : 587,
    secure: pick('SMTP_SECURE') === 'true',
    user: pick('SMTP_USER') || undefined,
    pass: pick('SMTP_PASS') || undefined,
  };
  if (!cfg.host || !cfg.from || !cfg.to) return null;
  if (!pick('SMTP_PORT')) delete cfg.port;
  return cfg;
}
