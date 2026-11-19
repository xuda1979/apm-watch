// Defensive-shape coverage for lib/engine.js runTlsCheck: check-tls.js's
// netChainToReport/inspectPemChain always return the chain/validChain/
// leafSubject keys, so the `??` fallback guards at engine.js:100-102 are
// unreachable with real output. A malformed report missing those keys (the
// shape a stubbed/third-party check-tls could hand back) is the only way they
// fire. We mock lib/check-tls.js for this file only — each test file runs in
// its own process, so the real-socket+tls paths in engine.test.js and
// check-tls.test.js are unaffected.
//
// Covers previously-uncovered lib/engine.js halves in the full-suite report:
// 100,36 / 101,37 / 102,38 (malformed-report fallbacks).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let nextReport = {};
let fetchError = null;
let netArgs = null;
await mock.module('../lib/check-tls.js', {
  namedExports: {
    fetchCertChain: async () => {
      if (fetchError) throw new Error(fetchError);
      return { certs: [] };
    },
    netChainToReport: (args) => { netArgs = args; return nextReport; },
    inspectPemChain: () => nextReport,
  },
});

const { Engine } = await import('../lib/engine.js');
const { Store } = await import('../lib/store.js');

function freshEngine() {
  return new Engine({ store: new Store(':memory:'), config: {}, log: () => {} });
}

test('engine-tls-shape: bare malformed report falls back to empty chain/null validity/subject', async () => {
  nextReport = { host: 'shape.test', port: 443, daysRemaining: 42 };
  const engine = freshEngine();
  const res = await engine.runTlsCheck({ name: 'shape', host: 'shape.test', port: 443 });
  assert.equal(res.status, 'ok', '42d > default 30d threshold');
  assert.deepEqual(res.chain, [], 'missing chain key -> [] fallback');
  assert.equal(res.validChain, null, 'no chain entries -> null fallback');
  assert.equal(res.leafSubject, null, 'no chain entry -> null fallback');
  const row = engine.store.latestStates().find((s) => s.target === 'shape');
  assert.equal(row.status, 'ok');
  assert.equal(row.chain_json, null);
  assert.equal(row.valid_chain, null);
  assert.equal(row.leaf_subject, null);
});

test('engine-tls-shape: error-only malformed report falls back to an empty chain', async () => {
  nextReport = { host: 'shape.test', port: 443, error: 'bogus upstream report', daysRemaining: null };
  const engine = freshEngine();
  const res = await engine.runTlsCheck({ name: 'shape-err', host: 'shape.test', port: 443 });
  assert.equal(res.status, 'error');
  assert.equal(res.detail, 'bogus upstream report');
  assert.deepEqual(res.chain, [], 'error report without chain -> [] fallback');
  assert.equal(res.validChain, null);
  assert.equal(res.leafSubject, null);
  const row = engine.store.latestStates().find((s) => s.target === 'shape-err');
  assert.equal(row.status, 'error');
  assert.equal(row.chain_json, null);
  assert.equal(row.valid_chain, null);
});

test('engine-tls-shape: chain-bearing report missing validity/subject infers from the chain', async () => {
  nextReport = {
    host: 'shape.test',
    port: 443,
    daysRemaining: 42,
    chain: [{ subject: 'CN=shape.test', daysRemaining: 42 }],
  };
  const engine = freshEngine();
  const res = await engine.runTlsCheck({ name: 'shape-chain', host: 'shape.test', port: 443 });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.chain, [{ subject: 'CN=shape.test', daysRemaining: 42 }], 'report chain passes through unchanged');
  assert.equal(res.validChain, true, 'missing validChain key + non-empty chain -> true inference');
  assert.equal(res.leafSubject, 'CN=shape.test', 'missing leafSubject key -> first chain subject');
  const row = engine.store.latestStates().find((s) => s.target === 'shape-chain');
  assert.equal(row.valid_chain, 1);
  assert.equal(row.leaf_subject, 'CN=shape.test');
  assert.ok(row.chain_json.includes('CN=shape.test'), 'chain persists');
});

test('engine-tls-shape: cert-fetch rejection lands in the catch-shape report', async () => {
  fetchError = 'synthetic socket failure';
  const engine = freshEngine();
  const res = await engine.runTlsCheck({ name: 'shape-throw', host: 'shape.test', port: 443 });
  fetchError = null;
  assert.equal(res.status, 'error');
  assert.equal(res.detail, 'synthetic socket failure');
  assert.deepEqual(res.chain, [], 'catch handler stamps an empty chain');
  assert.equal(res.validChain, false, 'catch handler stamps validChain=false');
  const row = engine.store.latestStates().find((s) => s.target === 'shape-throw');
  assert.equal(row.status, 'error');
  assert.equal(row.chain_json, null);
  assert.equal(row.valid_chain, 0);
});

test('engine-tls-shape: missing cfg.port falls back to 443 for the chain fetch', async () => {
  nextReport = { host: 'shape.test', port: 443, daysRemaining: 42, chain: [], validChain: null, leafSubject: null };
  const engine = freshEngine();
  const res = await engine.runTlsCheck({ name: 'shape-no-port', host: 'shape.test' });
  assert.equal(netArgs.port, 443, 'cfg.port || 443 picks the default port');
  assert.equal(res.status, 'ok');
  assert.equal(res.port, 443, 'report port surfaces on the result');
  const row = engine.store.latestStates().find((s) => s.target === 'shape-no-port');
  assert.equal(row.status, 'ok');
});

test('engine-tls-shape: null daysRemaining without error -> "no certificate" error', async () => {
  nextReport = { host: 'shape.test', port: 443, daysRemaining: null, chain: [], validChain: null, leafSubject: null };
  const engine = freshEngine();
  const res = await engine.runTlsCheck({ name: 'shape-nocert', host: 'shape.test', port: 443 });
  assert.equal(res.status, 'error');
  assert.equal(res.detail, 'no certificate');
  const row = engine.store.latestStates().find((s) => s.target === 'shape-nocert');
  assert.equal(row.status, 'error');
  assert.equal(row.detail, 'no certificate');
});

test('engine-tls-shape: non-positive daysRemaining -> EXPIRED error', async () => {
  nextReport = { host: 'shape.test', port: 443, daysRemaining: -5, chain: [], validChain: null, leafSubject: null };
  const engine = freshEngine();
  const res = await engine.runTlsCheck({ name: 'shape-expired', host: 'shape.test', port: 443 });
  assert.equal(res.status, 'error');
  assert.equal(res.detail, 'EXPIRED 5d ago');
  const row = engine.store.latestStates().find((s) => s.target === 'shape-expired');
  assert.equal(row.status, 'error');
  assert.equal(row.days_remaining, -5);
});
