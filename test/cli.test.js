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
import { startHttpServer } from './helpers/fixtures.js';

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
