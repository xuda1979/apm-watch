import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportStatus, renderStatusPage } from '../lib/export.js';
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

test('export: renderStatusPage builds a self-contained html snapshot', () => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', detail: 'expires in 12d' });
  store.saveState({ target: 'other', kind: 'http', status: 'error', latencyMs: null, detail: 'down' });
  store.saveState({ target: 'evil', kind: 'http', status: 'ok', latencyMs: 1, detail: '<script>alert(1)</script>& "x"' });
  const out = exportStatus(store, {}, '9.9.9');
  const html = renderStatusPage(out);

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /apm-watch <small>status snapshot<\/small>/);
  // pill counts from the aggregate summary (evil->ok, api->warn, other->error)
  assert.match(html, /ok <b>1<\/b>/);
  assert.match(html, /warn <b>1<\/b>/);
  assert.match(html, /error <b>1<\/b>/);
  assert.match(html, /overall error/);
  // both targets + each kind row present
  assert.match(html, />api<\/td>/);
  assert.match(html, />other<\/td>/);
  assert.match(html, /HTTP 200/);
  assert.match(html, /expires in 12d/);
  // detail is html-escaped: < and & cannot break out of the page
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /apm-watch v9\.9\.9/);
  // hostile details are html-escaped, cannot inject markup or lose attrs
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;x&quot;/);
  setTimeout(store.close, 0);
});
