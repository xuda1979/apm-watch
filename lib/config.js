// Configuration: reads apm-watch.json / apm-watch.json5(lite) / env vars.
// Only JSON is fully specified; env overrides help with secrets.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
