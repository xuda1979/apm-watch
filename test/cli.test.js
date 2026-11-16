// CLI integration: the `once` command must be cron/CI-friendly, i.e. its exit
// code mirrors the worst check status (0 ok, 1 warn, 2 error).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { worstStatus } from '../bin/apm-watch.js';
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
  assert.match(stdout, /ok-svc/);
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
});

test('cli: once accepts an apm-only config and exits 0', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'apm-only.json');
  writeFileSync(cfg, JSON.stringify({
    apm: { collect: true, errorRateThreshold: 0.05 },
    store: { path: path.join(dir, 'apm-only.db') },
  }));
  // No agent is feeding the collector in this fresh process, so the APM
  // summary is empty — what matters is that validation stops rejecting the
  // shape and `once` completes without crashing.
  const { code, stderr } = await runOnce(cfg);
  assert.equal(code, 0, `stderr:\n${stderr}`);
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
      { name: 'slow-svc', url: srv.url + '/slow', latencyThresholdMs: 1 },
    ],
    store: { path: path.join(dir, 'json.db') },
  }));
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
  // stdout is a pure JSON document — engine status lines go to stderr, never
  // mixed into the machine-readable output
  assert.ok(stderr.includes('http ok'), 'engine log lands on stderr');
});

test('cli: once --json includes numeric days_remaining for tls checks', async (t) => {
  const srv = await startHttpsServer({ days: 15 });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'tls.json');
  writeFileSync(cfg, JSON.stringify({
    tls: [{ name: 'cert-soon', host: '127.0.0.1', port: srv.port, rejectUnauthorized: false, warnDaysBefore: 30 }],
    store: { path: path.join(dir, 'tls.db') },
  }));
  const { code, stdout, stderr } = await runOnceJson(cfg);
  assert.equal(code, 1, `warn threshold in [1,30]d -> exit 1\nstderr:\n${stderr}`);
  const doc = JSON.parse(stdout);
  const tls = doc.results.find((r) => r.target === 'cert-soon');
  assert.equal(tls.kind, 'tls');
  assert.equal(tls.status, 'warn');
  assert.equal(typeof tls.days_remaining, 'number');
  assert.equal(tls.days_remaining, 15);
  assert.equal(tls.status_code, null, 'http-only field is null for tls');
});

test('cli: once exits 2 when a check errors (asserted status mismatch)', async (t) => {
  const srv = await startHttpServer({ '/down': { status: 404, body: 'missing' } });
  t.after(srv.close);
  const dir = mkdtempSync(path.join(tmpdir(), 'apmw-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'err.json');
  writeFileSync(cfg, JSON.stringify({
    http: [{ name: 'down-svc', url: srv.url + '/down', assert: { statusCode: 200 } }],
    store: { path: path.join(dir, 'err.db') },
  }));
  const { code, stdout } = await runOnce(cfg);
  assert.equal(code, 2, `stdout:\n${stdout}`);
  assert.match(stdout, /down-svc/);
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
