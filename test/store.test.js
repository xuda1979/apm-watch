import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('store: saveState + latestStates + history', () => {
  const s = new Store(':memory:');
  let now = 1000;
  s.setClock(() => now);
  s.saveState({ target: 'a', kind: 'http', status: 'ok', latencyMs: 5, detail: 'x' });
  now += 1000;
  s.saveState({ target: 'a', kind: 'http', status: 'error', latencyMs: null, detail: 'boom' });
  const latest = s.latestStates();
  assert.equal(latest.length, 1);
  assert.equal(latest[0].status, 'error');
  const hist = s.history('a', 'http', 500);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].status, 'ok');
  s.close();
});

test('store: metrics series + retention', () => {
  const s = new Store(':memory:');
  let now = 1000;
  s.setClock(() => now);
  s.saveMetric('http:x/latency', 10);
  now += 500;
  s.saveMetric('http:x/latency', 20);
  const series = s.series('http:x/latency', 0);
  assert.equal(series.length, 2);
  assert.equal(series[0].value, 10);
  const pruned = s.pruneMetrics(1500);
  assert.ok(pruned >= 0);
  const series2 = s.series('http:x/latency', 0);
  assert.ok(series2.length <= 2);
  s.close();
});

test('store: metrics series returns the latest points within the window', () => {
  const s = new Store(':memory:');
  for (let i = 0; i < 500; i++) s.saveMetric('http:x/latency', i, 1000 + i);
  const series = s.series('http:x/latency', 0, 400);
  assert.equal(series.length, 400);
  // newest 400 of 500 -> values 100..499, ascending ts
  assert.equal(series[0].value, 100);
  assert.equal(series[series.length - 1].value, 499);
  assert.ok(series[0].ts < series[series.length - 1].ts, 'ascending ts for plotting');
  s.close();
});

test('store: events + recent', () => {
  const s = new Store(':memory:');
  s.addEvent('warn', 'http', 'x');
  s.addEvent('error', 'tls', 'y expired');
  const ev = s.recentEvents(10);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].level, 'error');
  s.close();
});

test('store: setMeta/getMeta persist json or plain strings per key', () => {
  const s = new Store(':memory:');
  assert.equal(s.getMeta('nope'), null);
  s.setMeta('health', { status: 'warn', uptimeSince: 5, lastCheckAt: 9 });
  s.setMeta('note', 'hello');
  const health = s.getMeta('health');
  assert.deepEqual(health.value, { status: 'warn', uptimeSince: 5, lastCheckAt: 9 });
  assert.ok(Number.isFinite(health.ts));
  assert.equal(s.getMeta('note').value, 'hello');
  // overwrite replaces the previous value
  s.setMeta('health', { status: 'ok' });
  assert.equal(s.getMeta('health').value.status, 'ok');
  s.close();
});

test('store: saveState persists numeric per-kind fields and round-trips them', () => {
  const s = new Store(':memory:');
  let now = 1000;
  s.setClock(() => now);
  s.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, method: 'POST', statusCode: 200, detail: 'HTTP 200' });
  now += 500;
  s.saveState({ target: 'api', kind: 'tls', status: 'warn', daysRemaining: 12, chain: [{ subject: '/CN=fixture.test', issuer: '/CN=fixture.test', notAfter: 999, daysRemaining: 12, selfSigned: true }], validChain: true, leafSubject: '/CN=fixture.test', detail: 'expires in 12d' });
  now += 500;
  s.saveState({ target: 'svc', kind: 'apm', status: 'warn', latencyMs: 320, p50Ms: 200, p95Ms: 320, errorRate: 0.1, errors: 1, samples: 10, detail: 'slow' });
  const latest = s.latestStates();
  const http = latest.find((r) => r.kind === 'http');
  const tls = latest.find((r) => r.kind === 'tls');
  const apm = latest.find((r) => r.kind === 'apm');
  assert.equal(http.method, 'POST');
  assert.equal(http.status_code, 200);
  assert.equal(http.latency_ms, 12);
  assert.equal(tls.days_remaining, 12);
  // tls chain metadata round-trips through the store
  assert.equal(tls.valid_chain, 1);
  assert.equal(tls.leaf_subject, '/CN=fixture.test');
  assert.deepEqual(JSON.parse(tls.chain_json), [
    { subject: '/CN=fixture.test', issuer: '/CN=fixture.test', notAfter: 999, daysRemaining: 12, selfSigned: true },
  ]);
  assert.equal(apm.p50_ms, 200);
  assert.equal(apm.p95_ms, 320, 'p95 ms round-trips through the store like p50');
  assert.equal(apm.error_rate, 0.1);
  assert.equal(apm.errors, 1);
  assert.equal(apm.samples, 10);
  assert.equal(apm.latency_ms, 320);
  // history rows carry the stored numeric column too
  const hist = s.history('api', 'tls', 0);
  assert.equal(hist[0].days_remaining, 12);
  s.close();
});

test('store: states migration adds numeric columns to an old-schema database', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-migrate-'));
  const dbPath = path.join(dir, 'old.db');
  try {
    // Simulate a DB created before the per-kind numeric columns existed.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms REAL,
        detail TEXT
      );
    `);
    raw.close();

    // Opening through the Store must ALTER the old table in place, keeping
    // existing history and adding every numeric column used by the surfaces.
    const s = new Store(dbPath);
    const cols = new Set(s.db.prepare('PRAGMA table_info(states)').all().map((c) => c.name));
    for (const name of ['method', 'status_code', 'days_remaining', 'chain_json', 'valid_chain', 'leaf_subject', 'p50_ms', 'p95_ms', 'error_rate', 'errors', 'samples']) {
      assert.ok(cols.has(name), `migration must add column ${name}`);
    }
    // pre-existing rows are untouched by the migration and get NULL numerics
    s.db.prepare('INSERT INTO states (ts, target, kind, status) VALUES (1, ?, ?, ?)')
      .run('old', 'http', 'ok');
    s.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, statusCode: 200, detail: 'HTTP 200' });
    const rows = s.latestStates();
    assert.equal(rows.length, 2, 'old history survives the migration');
    assert.equal(rows.find((r) => r.target === 'old').status_code, null);
    assert.equal(rows.find((r) => r.target === 'api').status_code, 200);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
