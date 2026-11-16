import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportStatus, renderStatusPage } from '../lib/export.js';
import { Store } from '../lib/store.js';

test('export: aggregates latest status across http/tls/apm target into JSON', () => {
  const store = new Store(':memory:');
  let now = Date.now();
  store.setClock(() => now);
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  now += 1000;
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
  // time-weighted availability: api was up for all 2000ms of history
  assert.equal(api.http.uptime_pct, 100);
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
  // backdate states so availability sees a nonzero window (same-ms saves -> 0ms).
  const past = Date.now() - 60000;
  store.setClock(() => past);
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
  // uptime pct rendered in the http row detail
  assert.match(html, /HTTP 200 · 100% uptime/);
  // detail is html-escaped: < and & cannot break out of the page
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /apm-watch v9\.9\.9/);
  // hostile details are html-escaped, cannot inject markup or lose attrs
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;x&quot;/);
  setTimeout(store.close, 0);
});

test('export: health block surfaces monitor uptime/lastCheck in json + html', () => {
  const store = new Store(':memory:');
  const past = Date.now() - 300000;
  store.setClock(() => past);
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  // engine would have persisted its latest self-health summary here
  store.setMeta('health', { status: 'warn', uptimeSince: past - 200000, lastCheckAt: past });
  const out = exportStatus(store, {}, '1.2.3');
  assert.deepEqual(out.health, {
    status: 'warn',
    uptimeSince: past - 200000,
    lastCheckAt: past,
  });
  // html meta line shows monitor status + uptime for a non-empty health block
  const html = renderStatusPage(out);
  assert.match(html, /monitor warn/);
  assert.match(html, /up 3m 20s/);   // lastCheck - uptimeSince = 200000 ms
  assert.match(html, /last check /);
  setTimeout(store.close, 0);
});

test('export: health is null when no monitor meta was persisted', () => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  const out = exportStatus(store, {});
  assert.equal(out.health, null);
  const html = renderStatusPage(out);
  assert.doesNotMatch(html, /monitor /);
  setTimeout(store.close, 0);
});
