import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportStatus } from '../bin/apm-watch.js';
import { Store } from '../lib/store.js';

test('export: aggregates latest status across http/tls target into JSON', () => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', detail: 'expires in 12d' });
  store.saveState({ target: 'other', kind: 'http', status: 'error', detail: 'down' });

  const out = exportStatus(store, {});
  assert.equal(out.targets.length, 2);
  const api = out.targets.find((t) => t.target === 'api');
  assert.equal(api.status, 'warn');
  assert.equal(api.http.latency_ms, 12);
  assert.equal(api.tls.detail, 'expires in 12d');
  assert.equal(out.generated_at, new Date(out.generated_ts).toISOString());
  setTimeout(store.close, 0);
});
