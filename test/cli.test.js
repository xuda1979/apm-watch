// CLI integration: the `once` command must be cron/CI-friendly, i.e. its exit
// code mirrors the worst check status (0 ok, 1 warn, 2 error).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { worstStatus, onceJsonRow } from '../bin/apm-watch.js';
import { startHttpServer, startHttpsServer } from './helpers/fixtures.js';

const BIN = fileURLToPath(new URL('../bin/apm-watch.js', import.meta.url));

test('cli: worstStatus picks exit code across ok/warn/error', () => {
  const ok = { status: 'ok' };
  const warn = { status: 'warn' };
  const err = { status: 'error' };
  assert.equal(worstStatus([ok, ok]), 0);
  assert.equal(worstStatus([ok, warn]), 1, 'any warn -> 1');
  assert.equal(worstStatus([err, warn, ok]), 2, 'error outranks warn -> 2');
  assert.equal(worstStatus([]), 0);
  // severity order holds regardless of result order
  assert.equal(worstStatus([warn, ok, err]), 2);
});

test('cli: onceJsonRow surfaces the apm warn thresholds and nulls them off-kind', () => {
  // a stamped apm result (runApmCheck, inc 33) carries both judged thresholds
  const apm = onceJsonRow({
    target: 'pay', kind: 'apm', status: 'warn', ts: 123,
    latencyMs: 900, p50Ms: 700, p95Ms: 900, errorRate: 0.13, errors: 13, samples: 100,
    errorRateThreshold: 0.12, latencyThresholdMs: 800, windowMs: 120_000, maxSamples: 25,
    detail: 'p50=700ms p95=900ms errors=13/100 (slow p95)',
  });
  assert.equal(apm.kind, 'apm');
  assert.equal(apm.p95_ms, 900, 'p95 ms rides its own labelled row field');
  assert.equal(apm.error_rate_threshold, 0.12, 'configured apm error-rate threshold surfaces');
  assert.equal(apm.latency_threshold_ms, 800, 'apm latency threshold rides the shared http/apm field');
  assert.equal(apm.window_ms, 120_000, 'stamped collector window rides its own labelled row field');
  assert.equal(apm.max_samples, 25, 'stamped collector sample-cap rides its own labelled row field');
  assert.equal(apm.error_rate, 0.13);
  assert.equal(apm.status_code, null, 'http-only field is null for apm');
  assert.equal(apm.uptime_pct, null, 'http-only availability pct is null on apm rows');
  assert.equal(apm.uptime_ms, null, 'http-only availability breakdown is null on apm rows');

  // http rows stamp a per-target latency threshold but no error-rate threshold
  const http = onceJsonRow({
    target: 'api', kind: 'http', status: 'ok', ts: 1,
    latencyMs: 4, method: 'GET', statusCode: 200, latencyThresholdMs: 250, timeoutMs: 8000,
    uptimePct: 99.97, uptimeMs: { up_ms: 9997, down_ms: 3, total_ms: 10000, samples: 3 },
    detail: 'HTTP 200 in 4ms',
  });
  assert.equal(http.latency_threshold_ms, 250, 'per-http threshold keeps its slot');
  assert.equal(http.timeout_ms, 8000, 'configured abort timeout surfaces on http rows');
  assert.equal(http.expected_status_code, null, 'unconfigured expected status stays null on http rows');
  assert.equal(http.body_includes, null, 'unconfigured body marker stays null on http rows');
  assert.equal(http.error_rate_threshold, null, 'apm-only field is null for http');
  assert.equal(http.window_ms, null, 'apm-only collector window is null on http rows');
  assert.equal(http.max_samples, null, 'apm-only collector sample-cap is null on http rows');
  assert.equal(http.p50_ms, null);
  assert.equal(http.p95_ms, null, 'apm-only p95 slot stays null on http rows');
  assert.equal(http.uptime_pct, 99.97, 'http availability percentage maps to its row field');
  assert.deepEqual(http.uptime_ms, { up_ms: 9997, down_ms: 3, total_ms: 10000, samples: 3 }, 'http availability breakdown maps up_ms/down_ms/total_ms/samples');

  // tls rows carry neither apm threshold nor http verb, but stamp the
  // cert-fetch socket timeout like http rows stamp the probe abort timeout
  const tls = onceJsonRow({
    target: 'cert', kind: 'tls', status: 'ok', ts: 2,
    timeoutMs: 4000, daysRemaining: 200, warnDaysBefore: 30,
    chain: [{ subject: 'CN=fixture.test' }], validChain: true, leafSubject: 'CN=fixture.test',
    detail: 'expires in 200d',
  });
  assert.equal(tls.error_rate_threshold, null, 'apm-only field is null for tls');
  assert.equal(tls.window_ms, null, 'apm-only collector window is null on tls rows');
  assert.equal(tls.max_samples, null, 'apm-only collector sample-cap is null on tls rows');
  assert.equal(tls.timeout_ms, 4000, 'cert-fetch socket timeout surfaces on tls rows');
  assert.equal(tls.warn_days_before, 30, 'tls threshold untouched by the apm field');
  assert.equal(tls.port, null, 'tls row without a probed port keeps the field null, not dropped');
  assert.equal(tls.uptime_pct, null, 'http-only availability pct is null on tls rows');
  assert.equal(tls.uptime_ms, null, 'http-only availability breakdown is null on tls rows');
});

// Run `node bin/apm-watch.js once --config <file>` and resolve {code, stdout}.
function runOnce(configFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'once', '--config', configFile], {
      cwd: path.dirname(BIN),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Same as runOnce but with `--json` so stdout is a single JSON document.
function runOnceJson(configFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'once', '--config', configFile, '--json'], {
      cwd: path.dirname(BIN),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Run a bare CLI invocation and resolve {code, stdout}.
function runCli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: path.dirname(BIN) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('cli: --version prints the version and does not start the monitor', async () => {
  const { code, stdout } = await runCli('--version');
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^1\.0\.0$/);
});

test('cli: once exits 0 when every check is ok', async (t) => {
  const srv = await startHttpServer({ '/ok': { status: 200, body: 'good' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'ok.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'ok.db') },
  }));
  const { code, stdout } = await runOnce(cfg);
  assert.equal(code, 0, `stdout:\n${stdout}`);
  assert.match(stdout, /ok-svc/);  // the numeric http status-code rides the row like the tui ui row (inc-52 parity)
  assert.match(stdout, /GET 200 /, `numeric status-code surfaces on the human report\nstdout:\n${stdout}`);
  // monitor self-health rides the human report like the once --json block and
  // the TUI header / web / export meta lines (inc-66 parity)
  assert.match(stdout, /health ok · up \d+s · last check \d+:\d+:\d+/, `self-health snapshot surfaces on the human report\nstdout:\n${stdout}`);
  // the snapshot status-count summary rides the human report like the web
  // pillbox / export pills / TUI header (inc 79 parity): the single all-ok
  // result prints `ok 1 warn 0 err 0`
  assert.match(stdout, /ok 1 warn 0 err 0/, `snapshot status-count summary surfaces on the human report\nstdout:\n${stdout}`);
  // the snapshot-update time rides the summary line like the web meta `updated`
  // and export page `generated` (inc 81 parity)
  assert.match(stdout, /ok 1 warn 0 err 0 · updated \d+:\d+:\d+/, `snapshot-update time surfaces on the human report\nstdout:\n${stdout}`);
  // the store retention window rides the summary line like the web meta `keep
  // Nd`, export page `keep Nd` and TUI header (inc 83 parity): the unconfigured
  // store defaults to the engine's canonical 7 days
  assert.match(stdout, /ok 1 warn 0 err 0 · updated .* · keep 7d/, `store retention window surfaces on the human report\nstdout:\n${stdout}`);
  // the notification channel-state rides the human report like the once --json /
  // web /api/states / export JSON `notifications` block (inc 88 parity): the
  // unconfigured channels resolve to the canonical defaults (desktop on,
  // webhook/email off, repeat 3600s -> `1h 0m` under the shared fmtInterval
  // short-form) exactly like the JSON envelope every other face carries
  assert.match(stdout, /notif desktop · repeat 1h 0m/, `notification channel-state surfaces on the human report\nstdout:\n${stdout}`);
  // the availability/series history window the uptime pct + breakdown aggregate
  // over rides the human report like the once --json / web /api/states / export
  // JSON `ui.historySeconds` block (inc 89 parity): the unconfigured window
  // resolves to the canonical 24h default, `86400` -> `24h 0m` under the shared
  // fmtInterval short-form — the same ` (over N samples)` line's span printed
  // as a config-global line like `keep Nd` / `notif ...`
  assert.match(stdout, /history 24h 0m/, `availability/series history window surfaces on the human report\nstdout:\n${stdout}`);
  // the down-time window rides the uptime suffix like the tui/web/export rows
  // (inc 80 parity): the live ok snapshot owns the whole history window, so the
  // breakdown renders ` (down 0s)` after the pct. The availability snapshot
  // count rides along too (inc 85 parity — the same `uptime_ms.samples` the
  // once --json breakdown carries) as a ` (over N samples)` suffix: the single
  // live snapshot renders as ` (over 1 sample)`.
  assert.match(stdout, /· 100% uptime \(down 0s\) \(over 1 sample\)/, `down-time window + snapshot count surface on the human report\nstdout:\n${stdout}`);
});

test('cli: once exits 1 when a check is warn (slow latency)', async (t) => {
  const srv = await startHttpServer({ '/slow': { status: 200, body: 'ok', delayMs: 60 } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'warn.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'slow-svc', url: srv.url + '/slow', latencyThresholdMs: 1 }],
    store: { path: path.join(dir, 'warn.db') },
  }));
  const { code, stdout } = await runOnce(cfg);
  assert.equal(code, 1, `stdout:\n${stdout}`);
  assert.match(stdout, /slow:/);
  // the per-probe slow-latency threshold that demoted ok->warn rides the human
  // row like the tui/web/export rows (inc 73 parity): stamped onto the engine
  // result by check-http.js finalize, so the warn line carries ` thr 1ms`
  assert.match(stdout, /slow-svc: .* thr 1ms/, `slow-latency threshold surfaces on the human report\nstdout:\n${stdout}`);
  // the snapshot status-count summary rides the human report like the web
  // pillbox / export pills / TUI header (inc 79 parity): the single warn
  // result prints `ok 0 warn 1 err 0`
  assert.match(stdout, /ok 0 warn 1 err 0/, `snapshot status-count summary surfaces on the warn human report\nstdout:\n${stdout}`);
});

test('cli: once accepts an apm-only config and exits 0', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'apm-only.json');
  writeFileSync(cfg, JSON.stringify({
    apm: { collect: true, errorRateThreshold: 0.12, latencyThresholdMs: 800, windowMs: 120_000, maxSamples: 3 },
    store: { path: path.join(dir, 'apm-only.db'), retentionDays: 21 },
    notifications: { repeatIntervalSeconds: 1800, desktop: false },
    scheduler: { apmIntervalSeconds: 90 },
    ui: { historySeconds: 43200 },
  }));
  // No agent is feeding the collector in this fresh process, so the APM
  // summary is empty — what matters is that validation stops rejecting the
  // shape and `once` completes without crashing.
  const { code, stderr } = await runOnce(cfg);
  assert.equal(code, 0, `stderr:\n${stderr}`);
  // the configured threshold closes the data-surface gap with the web api
  const { code: jcode, stdout: jstdout } = await runOnceJson(cfg);
  assert.equal(jcode, 0, `stderr:\n${jstdout}`);
  const doc = JSON.parse(jstdout);
  assert.equal(doc.apm.errorRateThreshold, 0.12, 'configured apm threshold surfaces in once --json');
  assert.equal(doc.apm.latencyThresholdMs, 800, 'configured apm slow-latency threshold surfaces in once --json');
  assert.equal(doc.apm.windowMs, 120_000, 'configured collector window surfaces in once --json');
  assert.equal(doc.apm.maxSamples, 3, 'configured collector sample-cap surfaces in once --json');
  assert.equal(doc.apm.collect, true, 'configured apm collection flag surfaces in once --json');
  assert.equal(doc.store.retentionDays, 21, 'configured store retention surfaces in once --json');
  assert.equal(doc.notifications.repeatIntervalSeconds, 1800, 'configured alert repeat-interval surfaces in once --json');
  assert.equal(doc.notifications.desktop, false, 'configured desktop-notification gate surfaces in once --json');
  assert.equal(doc.notifications.webhook, false, 'unconfigured webhook channel surfaces as disabled in once --json');
  assert.equal(doc.notifications.email, false, 'unconfigured email channel surfaces as disabled in once --json');
  assert.equal(doc.scheduler.apmIntervalSeconds, 90, 'configured apm scheduler interval surfaces in once --json');
  assert.equal(doc.scheduler.httpIntervalSeconds, 60, 'unconfigured http scheduler interval defaults to 60s');
  assert.equal(doc.scheduler.tlsIntervalSeconds, 300, 'unconfigured tls scheduler interval defaults to 300s');
  assert.equal(doc.ui.historySeconds, 43200, 'configured ui history window surfaces in once --json');
  // per-kind threshold/timeout/interval mirror maps (web + export parity): with
  // no http/tls entries configured the maps are {}, not dropped from the envelope
  assert.deepEqual(doc.http.latencyThresholds, {}, 'empty-config http threshold map stays {} on once --json');
  assert.deepEqual(doc.http.timeoutMs, {}, 'empty-config http timeout map stays {} on once --json');
  assert.deepEqual(doc.http.intervalSeconds, {}, 'empty-config http interval map stays {} on once --json');
  assert.deepEqual(doc.http.assertStatusCodes, {}, 'empty-config http expected-status map stays {} on once --json');
  assert.deepEqual(doc.http.assertBodyIncludes, {}, 'empty-config http body-marker map stays {} on once --json');
  assert.deepEqual(doc.tls.warnDaysBefore, {}, 'empty-config tls warn-days map stays {} on once --json');
  assert.deepEqual(doc.tls.timeoutMs, {}, 'empty-config tls timeout map stays {} on once --json');
  assert.deepEqual(doc.tls.intervalSeconds, {}, 'empty-config tls interval map stays {} on once --json');
  assert.deepEqual(doc.tls.port, {}, 'empty-config tls probe-port map stays {} on once --json');
  // monitor self-health: the apm run above persisted it, so the once --json
  // envelope surfaces the same block the web /api/states + export emit (web +
  // export parity for the cron/CI document)
  assert.ok(doc.health, 'once --json surfaces the engine-persisted monitor health block');
  assert.equal(doc.health.status, 'ok', 'an all-ok run records ok monitor status');
  assert.ok(Number.isFinite(doc.health.uptimeSince), 'monitor uptime-since timestamp surfaces');
  assert.ok(Number.isFinite(doc.health.lastCheckAt), 'monitor last-check timestamp surfaces');
  assert.ok(doc.health.lastCheckAt >= doc.health.uptimeSince, 'last check is at/after monitor start');
  // the recent-events list rides the envelope like the web /api/events +
  // export page surfaces (ts/level/source/message shape): a fresh once run
  // records no alert-path events, so the key is present and empty rather
  // than dropped (web + export parity for the cron/CI document)
  assert.ok(Array.isArray(doc.events), 'once --json surfaces the events list key');
  assert.equal(doc.events.length, 0, 'a fresh once run records no alert events');
});

test('cli: once --json emits machine-readable results and the exit code', async (t) => {
  const srv = await startHttpServer({
    '/ok': { status: 200, body: 'good' },
    '/slow': { status: 200, body: 'ok', delayMs: 60 },
  });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'json.json');
  writeFileSync(cfg, JSON.stringify({
    http: [
      { name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } },
      { name: 'slow-svc', url: srv.url + '/slow', latencyThresholdMs: 1, timeoutMs: 1234 },
    ],
    store: { path: path.join(dir, 'json.db') },
  }));
  // Seed backdated ok-svc history so the availability breakdown is
  // deterministic: two stored snapshots ~1s apart plus the live run's row give
  // a guaranteed nonzero window (a fresh single snapshot can collapse to a
  // same-ms window and report pct null).
  const { Store } = await import('../lib/store.js');
  const seeded = new Store(path.join(dir, 'json.db'));
  let seedNow = Date.now() - 5000;
  seeded.setClock(() => seedNow);
  seeded.saveState({ target: 'ok-svc', kind: 'http', status: 'ok', latencyMs: 3, detail: 'HTTP 200 in 3ms', method: 'GET', statusCode: 200 });
  seedNow += 1000;
  seeded.saveState({ target: 'ok-svc', kind: 'http', status: 'ok', latencyMs: 4, detail: 'HTTP 200 in 4ms', method: 'GET', statusCode: 200 });
  seeded.close();
  const { code, stdout, stderr } = await runOnceJson(cfg);
  assert.equal(code, 1, `stderr:\n${stderr}`);
  const doc = JSON.parse(stdout);
  assert.equal(doc.exit_code, 1);
  assert.equal(doc.results.length, 2);
  const ok = doc.results.find((r) => r.target === 'ok-svc');
  const slow = doc.results.find((r) => r.target === 'slow-svc');
  assert.equal(ok.status, 'ok');
  assert.equal(slow.status, 'warn');
  assert.equal(slow.kind, 'http');
  assert.equal(typeof ok.ts, 'number', 'http results carry a per-result timestamp');
  assert.equal(ok.method, 'GET', 'http-only method field surfaces the configured verb');
  assert.equal(slow.method, 'GET');
  assert.equal(slow.latency_threshold_ms, 1, 'configured per-http latency threshold surfaces on once --json rows');
  assert.equal(ok.latency_threshold_ms, null, 'unconfigured http threshold is null, not dropped');
  assert.equal(slow.timeout_ms, 1234, 'configured per-http abort timeout surfaces on once --json rows');
  assert.equal(ok.timeout_ms, 5000, 'unconfigured http timeout defaults to 5000, not dropped');
  // per-check run cadence traces the same resolve path (inc-71 parity): neither
  // entry sets intervalSeconds, so the per-target map resolves the 60s http
  // default on every row exactly like the mirror block asserts below
  assert.equal(ok.interval_seconds, 60, 'unconfigured per-http interval resolves to the 60s default on once --json rows');
  assert.equal(slow.interval_seconds, 60, 'unconfigured per-http interval resolves to the 60s default on once --json rows');
  assert.equal(ok.error_rate_threshold, null, 'apm-only error-rate threshold is null on http rows');
  assert.equal(ok.expected_status_code, 200, 'the configured expected status surfaces on once --json rows');
  assert.equal(slow.expected_status_code, null, 'unconfigured expected status is null, not dropped');
  assert.equal(ok.body_includes, null, 'unconfigured body marker is null, not dropped');
  assert.equal(slow.body_includes, null, 'no body assert -> body marker stays null even on the row');
  // per-kind threshold/timeout/interval mirror maps (web + export parity): the
  // configured per-http map entries surface on the once --json envelope
  assert.deepEqual(doc.http.latencyThresholds, { 'slow-svc': 1 }, 'configured per-http latency threshold surfaces in the mirror map');
  assert.deepEqual(doc.http.timeoutMs, { 'ok-svc': 5000, 'slow-svc': 1234 }, 'per-http abort timeouts surface, resolved default and configured');
  assert.deepEqual(doc.http.assertStatusCodes, { 'ok-svc': 200 }, 'configured expected status surfaces in the mirror map');
  assert.deepEqual(doc.http.assertBodyIncludes, {}, 'unconfigured body markers keep an empty mirror map');
  assert.deepEqual(doc.http.intervalSeconds, { 'ok-svc': 60, 'slow-svc': 60 }, 'unconfigured per-http intervals resolve to the 60s default');
  assert.deepEqual(doc.tls.warnDaysBefore, {}, 'empty-config tls warn-days map stays {} on once --json');
  assert.deepEqual(doc.tls.timeoutMs, {}, 'empty-config tls timeout map stays {} on once --json');
  assert.deepEqual(doc.tls.intervalSeconds, {}, 'empty-config tls interval map stays {} on once --json');
  // stdout is a pure JSON document — engine status lines go to stderr, never
  // mixed into the machine-readable output
  assert.ok(stderr.includes('http ok'), 'engine log lands on stderr');
  // availability/uptime rides the http rows like the web /api/states
  // availability map, export uptime_pct/uptime_ms, and the TUI uptime suffix
  // (inc-58 parity): the seeded history + live run give a 3-sample all-ok window
  assert.equal(ok.uptime_pct, 100, 'availability pct surfaces on once --json http rows');
  assert.equal(ok.uptime_ms.samples, 3, 'seeded + live ok-svc snapshots all count toward the breakdown');
  assert.equal(ok.uptime_ms.down_ms, 0, 'all-ok history yields zero downtime');
  assert.equal(ok.uptime_ms.up_ms, ok.uptime_ms.total_ms, 'up duration covers the whole window');
  assert.equal(typeof ok.uptime_ms.total_ms, 'number', 'total duration surfaces as a number');
  // the snapshot status-count summary rides the once --json document like the
  // web /api/states summary block + export JSON summary (inc 79 parity): the
  // mixed ok/warn snapshot resolves warn overall with a per-bin distribution
  assert.equal(doc.summary.overall, 'warn', 'the worst status of the mixed snapshot surfaces in the summary block');
  assert.deepEqual(doc.summary.counts, { ok: 1, warn: 1, error: 0, unknown: 0 }, 'the status distribution over the just-run results surfaces in the summary block');
  // the snapshot-update timestamp rides the summary block like the web
  // /api/states summary (inc 81 parity): updated_at computed at snapshot time
  assert.ok(Number.isFinite(doc.summary.updated_at), 'the summary block carries the snapshot-update timestamp');
  assert.ok(doc.summary.updated_at >= ok.ts, 'summary update time is at/after the just-run result timestamps');
});

test('cli: once --json reports the configured http verb (POST) per check', async (t) => {
  const { startHttpServer: httpSrv } = await import('./helpers/fixtures.js');
  const srv = await httpSrv({ '/submit': { status: 201, body: 'created' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'verb.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'submit-svc', url: srv.url + '/submit', method: 'POST', assert: { statusCode: 201 } }],
    store: { path: path.join(dir, 'verb.db') },
  }));
  const { code, stdout } = await runOnceJson(cfg);
  assert.equal(code, 0, `stdout:\n${stdout}`);
  const doc = JSON.parse(stdout);
  const r = doc.results.find((x) => x.target === 'submit-svc');
  assert.equal(r.status, 'ok');
  assert.equal(r.status_code, 201);
  assert.equal(r.method, 'POST', 'explicit method flows into once --json');
});

test('cli: once --json includes numeric days_remaining for tls checks', async (t) => {
  const srv = await startHttpsServer({ days: 15 });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'tls.json');
  writeFileSync(cfg, JSON.stringify({
    tls: [{ name: 'cert-soon', host: '127.0.0.1', port: srv.port, rejectUnauthorized: false, warnDaysBefore: 30, timeoutMs: 1500 }],
    store: { path: path.join(dir, 'tls.db') },
  }));
  const { code, stdout, stderr } = await runOnceJson(cfg);
  assert.equal(code, 1, `warn threshold in [1,30]d -> exit 1\nstderr:\n${stderr}`);
  const doc = JSON.parse(stdout);
  const tls = doc.results.find((r) => r.target === 'cert-soon');
  assert.equal(tls.kind, 'tls');
  assert.equal(tls.status, 'warn');
  assert.equal(typeof tls.ts, 'number', 'per-result timestamp surfaces, like the web api and export json');
  assert.equal(typeof tls.days_remaining, 'number');
  assert.equal(tls.days_remaining, 15);
  assert.equal(tls.status_code, null, 'http-only field is null for tls');
  assert.equal(tls.uptime_pct, null, 'http-only availability pct is null on tls rows');
  assert.equal(tls.uptime_ms, null, 'http-only availability breakdown is null on tls rows');
  assert.equal(Array.isArray(tls.chain), true);
  assert.ok(tls.chain.length >= 1, 'valid leaf cert -> chain entries present');
  assert.equal(typeof tls.valid_chain, 'boolean');
  assert.equal(tls.leaf_subject, tls.chain[0].subject);
  // the resolved warn-days threshold the check was judged against (web/export parity)
  assert.equal(tls.warn_days_before, 30);
  // the cert-fetch socket timeout that would have aborted the fetch (web/export parity)
  assert.equal(tls.timeout_ms, 1500);
  // the probe port the cert check actually ran against (web/export parity, inc
  // 78): cfg's cert-soon socket target carries the fixture port, so the json
  // row surfaces it exactly like the mirror map resolves it
  assert.equal(tls.port, srv.port, 'the cert probe port the socket check ran against flows into once --json rows');
  // the per-check run cadence (inc-71 parity): no intervalSeconds configured,
  // so the per-target map resolves the 300s tls default like the mirror block
  assert.equal(tls.interval_seconds, 300, 'unconfigured per-cert interval resolves to the 300s default on once --json rows');
  // per-kind threshold/timeout/interval mirror maps (web + export parity): the
  // configured per-cert warn-days and socket timeout surface on the envelope
  assert.deepEqual(doc.tls.warnDaysBefore, { 'cert-soon': 30 }, 'configured per-cert warn-days surface in the mirror map');
  assert.deepEqual(doc.tls.timeoutMs, { 'cert-soon': 1500 }, 'configured per-cert fetch timeout surfaces in the mirror map');
  assert.deepEqual(doc.tls.intervalSeconds, { 'cert-soon': 300 }, 'unconfigured per-cert interval resolves to the 300s default');
  assert.deepEqual(doc.tls.port, { 'cert-soon': srv.port }, 'configured per-cert probe port surfaces in the mirror map');
  assert.deepEqual(doc.http.latencyThresholds, {}, 'empty-config http threshold map stays {} on once --json');
  assert.deepEqual(doc.http.timeoutMs, {}, 'empty-config http timeout map stays {} on once --json');
  assert.deepEqual(doc.http.assertStatusCodes, {}, 'empty-config http assert status map stays {} on once --json');
  assert.deepEqual(doc.http.assertBodyIncludes, {}, 'empty-config http assert body map stays {} on once --json');
  assert.deepEqual(doc.http.intervalSeconds, {}, 'empty-config http interval map stays {} on once --json');
});

test('cli: once human output surfaces tls chain metadata (leaf subject)', async (t) => {
  const srv = await startHttpsServer({ days: 15 });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // the fetched socket chain is a single self-signed cert, so to exercise the
  // multi-cert chain-path annotation (inc 72 parity) the row's chain is sourced
  // from the pemFile path with the cert duplicated: two CERT blocks parse into
  // a chain of length 2 (both self-signed, valid), rendering `chain: A -> A`
  const dup = path.join(dir, 'dup.pem');
  writeFileSync(dup, srv.cert.crtPem + srv.cert.crtPem);
  const cfg = path.join(dir, 'tls-hum.json');
  writeFileSync(cfg, JSON.stringify({
    tls: [{ name: 'cert-soon', pemFile: dup, warnDaysBefore: 30 }],
    store: { path: path.join(dir, 'tls-hum.db') },
  }));
  const { code, stdout, stderr } = await runOnce(cfg);
  assert.equal(code, 1, `warn threshold -> exit 1\nstderr:\n${stderr}`);
  // the warn detail plus the leaf-subject suffix, matching the tui row format
  assert.match(stdout, /tls cert-soon: expires in 15d/);
  assert.match(stdout, /\(CN=fixture\.test\)/, `leaf subject surfaces in the human report\nstdout:\n${stdout}`);
  // the full per-cert chain path rides the row like the TUI `chain: A -> B`
  // annotation (inc 72 parity): both entries shortened to their CN component
  assert.match(stdout, /  chain: CN=fixture\.test -> CN=fixture\.test/, `multi-cert chain path surfaces in the human report\nstdout:\n${stdout}`);
  // per-cert validity windows ride the chain path (inc 84 parity): the real
  // openssl cert's dates are relative to now and render as GMT strings (the
  // verbatim tooltip format), so assert the labeled shape; both duplicated
  // certs are self-signed, so the marker rides each block
  assert.match(stdout, /valid .* notAfter .* 15d \(self-signed\) \| valid .* notAfter .* 15d \(self-signed\)/, `per-cert validity windows surface in the human report\nstdout:\n${stdout}`);
  // a valid chain must not be flagged as broken
  assert.doesNotMatch(stdout, /chain broken/);
  // the judged-against cert warn-days threshold rides the row like the tui /
  // web / export rows (inc 74 parity): the engine stamps warnDaysBefore on every
  // runTlsCheck result (resolved to the configured 30), so the human row
  // annotates ` warn 30d` after the chain path
  assert.match(stdout, /tls cert-soon: expires in 15d.*warn 30d/, `cert warn-days threshold surfaces in the human report\nstdout:\n${stdout}`);
});

test('cli: once --json nulls the chain when a tls check fails', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'tls-fail.json');
  writeFileSync(cfg, JSON.stringify({
    tls: [{ name: 'broken-cert', pemFile: path.join(dir, 'missing.pem'), warnDaysBefore: 30, timeoutMs: 1500 }],
    store: { path: path.join(dir, 'tls-fail.db') },
  }));
  // Seed a persisted event (as a run/export alert cycle would write) so the
  // once --json events key proves it surfaces stored history, not just the
  // empty fresh-run shape.
  const { Store } = await import('../lib/store.js');
  const seeded = new Store(path.join(dir, 'tls-fail.db'));
  seeded.addEvent('warn', 'tls', 'cert-soon: expires in 15d');
  seeded.addEvent('info', 'tls', 'cert-soon: recovered');
  seeded.close();
  const { code, stdout, stderr } = await runOnceJson(cfg);
  assert.equal(code, 2, `failed tls -> exit 2\nstderr:\n${stderr}`);
  const doc = JSON.parse(stdout);
  const tls = doc.results.find((r) => r.target === 'broken-cert');
  assert.equal(tls.kind, 'tls');
  assert.equal(tls.status, 'error');
  assert.equal(tls.days_remaining, null);
  assert.equal(tls.chain, null, 'error/empty chain normalizes to null, matching the web api and export json');
  assert.equal(tls.valid_chain, false);
  assert.equal(tls.leaf_subject, null);
  assert.equal(typeof tls.ts, 'number');
  // the resolved warn-days threshold still surfaces even on a failed check
  assert.equal(tls.warn_days_before, 30);
  // the cert-fetch socket timeout stamps the failed row too, like warnDaysBefore
  assert.equal(tls.timeout_ms, 1500);
  // a pemFile bundle opens no socket, so its probe port is null even on the
  // failed path (web/export parity, inc 78)
  assert.equal(tls.port, null, 'pemFile cert checks carry no probed port on once --json rows');
  // monitor self-health reflects the failure path (web/export parity on the
  // cron/CI document): the error check recorded a hard state, so the block
  // carries error status rather than the all-ok default
  assert.ok(doc.health, 'once --json surfaces monitor health even when a check errors');
  assert.equal(doc.health.status, 'error', 'health block records the worst check status');
  assert.ok(Number.isFinite(doc.health.uptimeSince), 'health uptime-since still surfaces on failure');
  assert.ok(Number.isFinite(doc.health.lastCheckAt), 'health last-check still surfaces on failure');
  // seeded store events surface on the cron/CI document (web /api/events +
  // export page parity): newest first, full ts/level/source/message shape
  assert.ok(Array.isArray(doc.events), 'once --json carries the events list key');
  assert.equal(doc.events.length, 2, 'both seeded events surface on once --json');
  assert.equal(doc.events[0].level, 'info', 'newest event sorts first (store.recentEvents order)');
  assert.equal(doc.events[0].source, 'tls');
  assert.equal(doc.events[0].message, 'cert-soon: recovered');
  assert.equal(doc.events[1].level, 'warn');
  assert.equal(doc.events[1].message, 'cert-soon: expires in 15d');
  assert.ok(Number.isFinite(doc.events[0].ts), 'each event carries its ts, matching the web api shape');
});

test('cli: once exits 2 when a check errors (asserted status mismatch)', async (t) => {
  const srv = await startHttpServer({ '/down': { status: 404, body: 'missing' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'err.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'down-svc', url: srv.url + '/down', assert: { statusCode: 200, bodyIncludes: 'missing' } }],
    store: { path: path.join(dir, 'err.db') },
  }));
  const { code, stdout } = await runOnce(cfg);
  assert.equal(code, 2, `stdout:\n${stdout}`);
  assert.match(stdout, /down-svc/);
  // the failing check's real numeric code rides the row (inc-52 tui parity), so
  // the mismatch detail + code both surface for a cron/CI author
  assert.match(stdout, /GET 404 /, `numeric status-code surfaces on the error report\nstdout:\n${stdout}`);
  // the mismatch detail has no timing prose, so the numeric latency rides the
  // row like the tui/web/export latency columns always surface it (inc-55 parity)
  assert.match(stdout, /expected status 200, got 404 · \d+ms/, `numeric latency surfaces when the detail lacks it\nstdout:\n${stdout}`);
  assert.doesNotMatch(stdout, /expected status 200, got 404 · \d+ms · \d+ms/, 'latency is appended once');
  // judged-against http assert criteria ride the row like the tui row (inc-65
  // parity): the assert block's expected status + required body substring stamp
  // onto the engine result and annotate the report even when the status check
  // failed first (the body probe still carries the 'missing' marker as judged)
  assert.match(stdout, /exp 200 body "missing"/, `assert criteria annotate the error row\nstdout:\n${stdout}`);
  // monitor self-health reflects the failure path on the human report too
  // (once --json parity, inc-66): the error check recorded a hard state
  assert.match(stdout, /health error/, `worst status surfaces on the human health line\nstdout:\n${stdout}`);
});

test('cli: once --json reports error status_code and exit_code 2', async (t) => {
  const srv = await startHttpServer({ '/down': { status: 404, body: 'missing' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'err-json.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'down-svc', url: srv.url + '/down', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'err-json.db') },
  }));
  const { code, stdout, stderr } = await runOnceJson(cfg);
  assert.equal(code, 2, `stderr:\n${stderr}`);
  const doc = JSON.parse(stdout);
  assert.equal(doc.exit_code, 2);
  const down = doc.results.find((r) => r.target === 'down-svc');
  assert.equal(down.status, 'error');
  assert.equal(down.status_code, 404, 'numeric status_code survives in error results');
  assert.match(down.detail, /expected status 200, got 404/);
  // the snapshot status-count summary rides the once --json document like the
  // web /api/states summary block + export JSON summary (inc 79 parity): the
  // single error result drives an error overall and a 1-count error bin
  assert.equal(doc.summary.overall, 'error', 'the worst status of the snapshot surfaces in the summary block');
  assert.deepEqual(doc.summary.counts, { ok: 0, warn: 0, error: 1, unknown: 0 }, 'the status distribution over the just-run results surfaces in the summary block');
});

test('cli: export prints a parseable status snapshot to stdout', async (t) => {
  const { startHttpServer: httpSrv } = await import('./helpers/fixtures.js');
  const srv = await httpSrv({ '/ok': { status: 200, body: 'good' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'exp.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'exp.db') },
  }));
  // seed the store through `once` (runs checks + persists health meta), then export it
  const seeded = await runOnce(cfg);
  assert.equal(seeded.code, 0, `seed once failed:\n${seeded.stderr}`);
  const { code, stdout } = await runCli('export', '--config', cfg);
  assert.equal(code, 0, `stderr:\n${stdout}`);
  const doc = JSON.parse(stdout);       // stdout is a single JSON document
  assert.equal(doc.summary.overall, 'ok');
  assert.equal(doc.summary.counts.ok, 1);
  assert.ok(doc.health, 'monitor health meta persisted by the seeding run');
  assert.equal(doc.health.status, 'ok');
  assert.equal(doc.targets.length, 1);
  assert.equal(doc.targets[0].target, 'ok-svc');
  assert.equal(doc.targets[0].http.status, 'ok');
  assert.ok(doc.generated_at, 'snapshot carries a generated_at timestamp');
});

test('cli: export --out file.json writes a json snapshot', async (t) => {
  const { startHttpServer: httpSrv } = await import('./helpers/fixtures.js');
  const srv = await httpSrv({ '/ok': { status: 200, body: 'good' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'exp.json');
  const outFile = path.join(dir, 'status.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'exp.db') },
  }));
  const seeded = await runOnce(cfg);
  assert.equal(seeded.code, 0, `seed once failed:\n${seeded.stderr}`);
  const { code, stdout } = await runCli('export', '--config', cfg, '--out', outFile);
  assert.equal(code, 0);
  assert.match(stdout, /wrote .*status\.json \(json\)/);
  const { readFileSync } = await import('node:fs');
  const written = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(written.summary.overall, 'ok');
  assert.equal(written.targets[0].target, 'ok-svc');
  assert.equal(written.apm_watch_version, '1.0.0');
});

test('cli: export --out file.html writes a self-contained status page', async (t) => {
  const { startHttpServer: httpSrv } = await import('./helpers/fixtures.js');
  const srv = await httpSrv({ '/ok': { status: 200, body: 'good' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'exp.json');
  const outFile = path.join(dir, 'status.html');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'exp.db') },
  }));
  const seeded = await runOnce(cfg);
  assert.equal(seeded.code, 0, `seed once failed:\n${seeded.stderr}`);
  const { code, stdout } = await runCli('export', '--config', cfg, '--out', outFile);
  assert.equal(code, 0);
  assert.match(stdout, /wrote .*status\.html \(html\)/);
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(outFile, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>apm-watch status<\/title>/);
  assert.match(html, />ok-svc<\/td>/);
  assert.match(html, /overall ok/);
  assert.match(html, /apm-watch v1\.0\.0/);
});

test('cli: serve boots the web UI over an existing store and serves states + page', async (t) => {
  const { startHttpServer: httpSrv } = await import('./helpers/fixtures.js');
  const srv = await httpSrv({ '/ok': { status: 200, body: 'good' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'serve.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'serve.db') },
  }));
  // seed the store through `once` (runs checks + persists health meta), then serve it
  const seeded = await runOnce(cfg);
  assert.equal(seeded.code, 0, `seed once failed:\n${seeded.stderr}`);

  // `--port 0` lets the OS pick a free port; serve reports it on stdout
  const child = spawn(process.execPath, [BIN, 'serve', '--config', cfg, '--port', '0'], { cwd: path.dirname(BIN) });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`serve did not report a port; stdout:\n${out}\nstderr:\n${stderr}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/web UI on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('error', reject);
  });
  t.after(() => child.kill('SIGTERM'));

  // serve exposes the seeded store over HTTP
  const states = await (await fetch(`http://127.0.0.1:${port}/api/states`)).json();
  const ok = states.states.find((s) => s.target === 'ok-svc');
  assert.ok(ok, 'seeded state served over http');
  assert.equal(ok.status, 'ok');
  assert.ok(states.health, 'health meta from the seeding run is served');
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page, /apm-watch/);
  assert.match(page, /api\/states/);
});

test('cli: run boots the full monitor loop and serves live state over web', async (t) => {
  const { startHttpServer: httpSrv } = await import('./helpers/fixtures.js');
  const srv = await httpSrv({ '/ok': { status: 200, body: 'good' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'run.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'run.db') },
    notifications: { desktop: false },
  }));

  // `--ui web --ui-port 0` lets the OS assign a port; run reports it on stdout,
  // then the scheduler fires the first check within ~2s (random initial delay).
  const child = spawn(process.execPath, [BIN, 'run', '--config', cfg, '--ui', 'web', '--ui-port', '0'], { cwd: path.dirname(BIN) });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`run did not report a port; stdout:\n${out}\nstderr:\n${stderr}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/web UI on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('error', reject);
  });
  t.after(() => child.kill('SIGTERM'));

  // poll the live API until the engine's first scheduled check lands
  let states = null;
  for (let i = 0; i < 30 && !states; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/states`);
    const data = await res.json();
    if (data.states.length) states = data;
    else await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(states, `engine wrote a live state within the poll window\nstderr:\n${stderr}`);
  const ok = states.states.find((s) => s.target === 'ok-svc');
  assert.ok(ok, 'scheduled check result served by the run API');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.status_code, 200, 'numeric status_code served on the run path');
  assert.ok(states.health, 'engine persists monitor self-health on the run path');
  assert.equal(states.health.status, 'ok');
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page, /apm-watch/);
  assert.match(page, /api\/states/);
});

test('cli: demo agent feeds the run monitor and its apm state surfaces over web', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'run-apm.json');
  writeFileSync(cfg, JSON.stringify({
    apm: { collect: true, errorRateThreshold: 0.05 },
    store: { path: path.join(dir, 'run-apm.db') },
    notifications: { desktop: false },
  }));

  const child = spawn(process.execPath, [BIN, 'run', '--config', cfg, '--ui', 'web', '--ui-port', '0'], { cwd: path.dirname(BIN) });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`run did not report a port; stdout:\n${out}\nstderr:\n${stderr}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/web UI on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('error', reject);
  });
  t.after(() => child.kill('SIGTERM'));

  // the `demo` command posts latency/error spans to the run monitor's collector
  const demo = spawn(process.execPath, [BIN, 'demo', '--collect-addr', `http://127.0.0.1:${port}/apm/agent/trace`, '--interval', '150'], { cwd: path.dirname(BIN) });
  let demoOut = '';
  demo.stdout.on('data', (d) => (demoOut += d));
  demo.stderr.on('data', (d) => (stderr += d));
  t.after(() => demo.kill('SIGTERM'));

  // apm:summary fires ~1.5s after run starts; poll until an apm state appears
  let apm = null;
  for (let i = 0; i < 50 && !apm; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/states`);
    const data = await res.json();
    apm = data.states.find((s) => s.kind === 'apm') || null;
    if (!apm) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(apm, `spans from the demo agent surfaced as apm state\nstderr:\n${stderr}`);
  assert.equal(apm.target, 'demo');
  assert.equal(typeof apm.samples, 'number', 'samples numeric survives the full loop');
  assert.ok(apm.samples >= 1, 'collector received at least one span');
  assert.ok(Number.isFinite(apm.p50_ms), 'p50_ms numeric on the web api');
  assert.ok(Number.isFinite(apm.error_rate), 'error_rate numeric on the web api');
  // the spawned demo command confirmed successful posts to the collector
  assert.match(demoOut, /agent → \d+ms/, `demo agent logged a successful post:\n${demoOut}`);
});

test('cli: a run monitor checks all three kinds (http/tls/apm) through one spawned process', async (t) => {
  const { startHttpServer: httpSrv, startHttpsServer: httpsSrv } = await import('./helpers/fixtures.js');
  const http = await httpSrv({ '/ok': { status: 200, body: 'good' } });
  t.after(http.close);
  const https = await httpsSrv({ days: 15 });   // expires soon -> tls warn
  t.after(https.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'all.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: http.url + '/ok', assert: { statusCode: 200 } }],
    tls: [{ name: 'cert-soon', host: '127.0.0.1', port: https.port, rejectUnauthorized: false, warnDaysBefore: 30 }],
    apm: { collect: true, errorRateThreshold: 0.05 },
    store: { path: path.join(dir, 'all.db') },
    notifications: { desktop: false },
  }));

  // one `run` process hosts the scheduler grid for all three check kinds at once
  const child = spawn(process.execPath, [BIN, 'run', '--config', cfg, '--ui', 'web', '--ui-port', '0'], { cwd: path.dirname(BIN) });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`run did not report a port; stdout:\n${out}\nstderr:\n${stderr}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/web UI on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.once('error', reject);
  });
  t.after(() => child.kill('SIGTERM'));

  // the demo agent feeds the apm collector through the spawned monitor's port
  const demo = spawn(process.execPath, [BIN, 'demo', '--collect-addr', `http://127.0.0.1:${port}/apm/agent/trace`, '--interval', '150'], { cwd: path.dirname(BIN) });
  demo.stderr.on('data', (d) => (stderr += d));
  t.after(() => demo.kill('SIGTERM'));

  // wait until scheduler ticks have landed for all three kinds (apm:summary
  // fires ~1.5s in, tls initial delay up to 3s, http up to 2s)
  let data = null;
  for (let i = 0; i < 60 && !data; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/states`);
    const d = await res.json();
    const kinds = new Set(d.states.map((s) => s.kind));
    if (kinds.has('http') && kinds.has('tls') && kinds.has('apm')) data = d;
    else await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(data, `all three check kinds landed on the live API\nstderr:\n${stderr}`);

  // http: ok with the asserted numeric status code
  const h = data.states.find((s) => s.kind === 'http');
  assert.equal(h.status, 'ok');
  assert.equal(h.status_code, 200);

  // tls: real cert scanned over TLS, expires in 15d -> warn inside threshold
  const tlsSt = data.states.find((s) => s.kind === 'tls');
  assert.equal(tlsSt.status, 'warn');
  assert.equal(tlsSt.days_remaining, 15);

  // apm: spans posted by the demo agent produced a numeric summary
  const apmSt = data.states.find((s) => s.kind === 'apm');
  assert.equal(apmSt.target, 'demo');
  assert.ok(apmSt.samples >= 1, 'collector received spans from the spawned demo agent');
  assert.ok(Number.isFinite(apmSt.p50_ms), 'p50_ms numeric when all three kinds run together');
  assert.ok(Number.isFinite(apmSt.error_rate), 'error_rate numeric when all three kinds run together');

  // monitor self-health reflects the mixed grid: the tls warn drags it to warn
  assert.equal(data.health.status, 'warn', 'warn tls check propagates to monitor self-health');
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page, /apm-watch/);
});

test('cli: unknown flags warn on stderr instead of silently dropping', async (t) => {
  const { startHttpServer: httpSrv } = await import('./helpers/fixtures.js');
  const srv = await httpSrv({ '/ok': { status: 200, body: 'good' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A typo'd --confg must not silently fall back to ./apm-watch.json; point the
  // real config at a pass and expect a clear stderr warning plus normal run.
  const cfg = path.join(dir, 'ok.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'ok-svc', url: srv.url + '/ok', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'ok.db') },
  }));
  const child = spawn(process.execPath, [BIN, 'once', '--confg', cfg], { cwd: path.dirname(BIN) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 0, `stdout:\n${stdout}`);
  assert.match(stderr, /unknown flag "--confg"/, 'typoed flag is flagged on stderr');
});
