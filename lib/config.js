// Configuration: reads apm-watch.json / apm-watch.json5(lite) / env vars.
// Only JSON is fully specified; env overrides help with secrets.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
