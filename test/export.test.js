import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportStatus } from '../bin/apm-watch.js';
import { Store } from '../lib/store.js';

test('export: aggregates latest status across http/tls/apm target into JSON', () => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', detail: 'expires in 12d' });
  store.saveState({ target: 'api', kind: 'apm', status: 'warn', latencyMs: 320, detail: 'p50=200ms p95=320ms errors=0/10 (slow p95)' });
  store.saveState({ target: 'other', kind: 'http', status: 'error', detail: 'down' });

  const out = exportStatus(store, {});
  assert.equal(out.targets.length, 2);
  const api = out.targets.find((t) => t.target === 'api');
  assert.equal(api.status, 'warn');
  assert.equal(api.http.latency_ms, 12);
  assert.equal(api.tls.detail, 'expires in 12d');
  assert.equal(api.apm.status, 'warn');
  assert.equal(api.apm.latency_ms, 320);
  assert.match(api.apm.detail, /slow p95/);
  // overall summary + counts
  assert.equal(out.summary.overall, 'error');   // error outweighs warn
  assert.equal(out.summary.counts.ok, 0);
  assert.equal(out.summary.counts.warn, 1);
  assert.equal(out.summary.counts.error, 1);
  assert.equal(out.generated_at, new Date(out.generated_ts).toISOString());
  setTimeout(store.close, 0);
});
