// loadConfig error paths + env-override regression coverage for lib/config.js.
// A live process only ever hits these branches when a config file disappears,
// holds invalid JSON, or secrets are supplied via the APMW_NOTIFY_WEBHOOK_URL /
// SMTP_* environment variables, so deterministic tests drive each branch
// directly. Env vars are process-global; every test restores them in its
// finally block, and node --test runs each test file in its own process so the
// rest of the suite never sees these values.
//
// Covers previously-uncovered lib/config.js lines in the full-suite coverage
// report: 233-234 (readFileSync failure), 239-240 (JSON.parse failure),
// 243-246 (webhook env override), 250-252 (SMTP env override), 269-270
// (default SMTP port deleted when SMTP_PORT is absent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, httpIntervalSeconds, tlsIntervalSeconds, defaultConfigFile } from '../lib/config.js';

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_TO', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS'];

function withDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apmw-conf-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConf(dir, content) {
  const file = path.join(dir, 'apm-watch.json');
  writeFileSync(file, content);
  return file;
}

test('config: loadConfig parses a valid JSON config file', () => {
  withDir((dir) => {
    const file = writeConf(dir, JSON.stringify({ http: [{ name: 'a', url: 'http://a' }], ui: { port: 8080 } }));
    const cfg = loadConfig(file);
    assert.equal(cfg.http.length, 1);
    assert.equal(cfg.http[0].name, 'a');
    assert.equal(cfg.ui.port, 8080);
  });
});

test('config: loadConfig raises a curated error when the file cannot be read', () => {
  assert.throws(
    () => loadConfig('/nonexistent/apm-watch-missing.json'),
    (e) => /cannot read config/.test(e.message) && /ENOENT/.test(e.message),
    'missing file surfaces the read failure, not a raw fs error',
  );
});

test('config: loadConfig raises a curated error on invalid JSON content', () => {
  withDir((dir) => {
    const file = writeConf(dir, '{ not json !!!');
    assert.throws(() => loadConfig(file), (e) => /is not valid JSON/.test(e.message));
  });
});

test('config: APMW_NOTIFY_WEBHOOK_URL env override seeds the webhook channel', () => {
  process.env.APMW_NOTIFY_WEBHOOK_URL = 'https://hook.example/inbound';
  try {
    withDir((dir) => {
      const file = writeConf(dir, JSON.stringify({ http: [] }));
      const cfg = loadConfig(file);
      assert.equal(cfg.notifications.webhook.url, 'https://hook.example/inbound');
    });
  } finally {
    delete process.env.APMW_NOTIFY_WEBHOOK_URL;
  }
});

test('config: webhook env override merges into an existing notifications section', () => {
  process.env.APMW_NOTIFY_WEBHOOK_URL = 'https://hook.example/inbound';
  try {
    withDir((dir) => {
      const file = writeConf(dir, JSON.stringify({ notifications: { desktop: false } }));
      const cfg = loadConfig(file);
      assert.equal(cfg.notifications.desktop, false, 'existing settings survive the override');
      assert.equal(cfg.notifications.webhook.url, 'https://hook.example/inbound');
    });
  } finally {
    delete process.env.APMW_NOTIFY_WEBHOOK_URL;
  }
});

test('config: SMTP env overrides build the email channel with a numeric port', () => {
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.example.com',
    SMTP_FROM: 'app@example.com',
    SMTP_TO: 'ops@example.com',
    SMTP_PORT: '2525',
    SMTP_SECURE: 'true',
    SMTP_USER: 'u1',
    SMTP_PASS: 'p1',
  });
  try {
    withDir((dir) => {
      const file = writeConf(dir, JSON.stringify({ http: [] }));
      const cfg = loadConfig(file);
      assert.deepEqual(cfg.notifications.email, {
        host: 'smtp.example.com',
        from: 'app@example.com',
        to: 'ops@example.com',
        port: 2525,
        secure: true,
        user: 'u1',
        pass: 'p1',
      });
    });
  } finally {
    for (const k of SMTP_KEYS) delete process.env[k];
  }
});

test('config: SMTP env override omits the port when SMTP_PORT is absent', () => {
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.example.com',
    SMTP_FROM: 'a@example.com',
    SMTP_TO: 'b@example.com',
  });
  try {
    withDir((dir) => {
      const file = writeConf(dir, JSON.stringify({}));
      const email = loadConfig(file).notifications.email;
      assert.equal(email.host, 'smtp.example.com');
      assert.equal('port' in email, false, 'the deleted default 587 port is not surfaced');
    });
  } finally {
    for (const k of SMTP_KEYS) delete process.env[k];
  }
});

test('config: partial SMTP env does not enable the email channel', () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  try {
    withDir((dir) => {
      const file = writeConf(dir, JSON.stringify({}));
      const cfg = loadConfig(file);
      assert.equal(cfg.notifications?.email, undefined, 'missing from/to keeps the channel off');
    });
  } finally {
    for (const k of SMTP_KEYS) delete process.env[k];
  }
});

test('config: non-finite interval falls back to the kind default (http 60s, tls 300s)', () => {
  // A typo'd string ("2x") fails configSeconds' grammar and returns NaN, which
  // must not escape the scheduler window — the old pre-fallback NaN half.
  const out = httpIntervalSeconds({
    http: [{ name: 'a', url: 'http://a', intervalSeconds: '2x' }],
    scheduler: { httpIntervalSeconds: '1x' },
  });
  assert.equal(out.a, 60, 'http non-finite interval falls back to 60s');
  const tlsOut = tlsIntervalSeconds({
    tls: [{ name: 'api', host: 'api.example.com', intervalSeconds: '3x' }],
    scheduler: { tlsIntervalSeconds: '5x' },
  });
  assert.equal(tlsOut.api, 300, 'tls non-finite interval falls back to 300s');
});

test('config: defaultConfigFile finds apm-watch.json in the cwd', () => {
  withDir((dir) => {
    writeConf(dir, JSON.stringify({ http: [{ name: 'found', url: 'http://found' }] }));
    // Temporarily rebind cwd so defaultConfigFile scans the temp dir; fs
    // lookups are dynamic so the real existsSync sees the file we wrote.
    const realCwd = process.cwd;
    process.cwd = () => dir;
    try {
      const cfg = loadConfig();
      assert.equal(cfg.http[0]?.name, 'found', 'resolves and parses the cwd config when no explicit file is given');
    } finally {
      process.cwd = realCwd;
    }
  });
});
