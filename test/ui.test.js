// UI tests: web single-page + JSON API over the store, and the TUI renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { createUiServer } from '../lib/ui-server.js';
import { Tui } from '../lib/ui-tui.js';

async function listen(server, port = 0) {
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server.address().port;
}

test('ui: web server serves the page and a live-state JSON API with series', async (t) => {
  const store = new Store(':memory:');
  // http target with history
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200 in 12.0ms' });
  store.saveMetric('http:api/latency', 10, Date.now() - 4000);
  store.saveMetric('http:api/latency', 15, Date.now());
  // tls target with days-remaining series
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', detail: 'expires in 12d (threshold 30d)' });
  store.saveMetric('tls:api/remaining', 12, Date.now());
  // apm target with p50/p95 series
  store.saveState({ target: 'svc', kind: 'apm', status: 'ok', latencyMs: 40, detail: 'p50=20ms p95=40ms errors=0/10' });
  store.saveMetric('apm:svc/p50', 20, Date.now());
  store.saveMetric('apm:svc/p95', 40, Date.now());
  store.saveMetric('apm:svc/errorRate', 0.1, Date.now());

  const server = createUiServer(store, { ui: { historySeconds: 3600 } });
  const port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  // root page
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /apm-watch/);
  assert.match(html, /cLat/);
  assert.match(html, /cTls/);
  assert.match(html, /cApm/);
  assert.match(html, /cApmErr/);
  // status table shows a per-row kind field alongside target/status/latency/detail
  assert.match(html, /<th>target<\/th><th>status<\/th><th>kind<\/th><th>latency<\/th><th>detail<\/th>/);

  // JSON API
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const data = await res.json();
  assert.ok(Array.isArray(data.states));
  assert.equal(data.states.length, 3);
  const apiHttp = data.states.find((s) => s.target === 'api' && s.kind === 'http');
  assert.equal(apiHttp.status, 'ok');
  assert.equal(apiHttp.latency_ms, 12);
  const apiTls = data.states.find((s) => s.target === 'api' && s.kind === 'tls');
  assert.equal(apiTls.status, 'warn');
  assert.match(apiTls.detail, /expires in 12d/);

  // history curves present and in the right, monotonically-increasing ts space
  assert.ok(data.series['http:latency'].length >= 2);
  assert.ok(data.series['tls:remaining'].length >= 1);
  assert.ok(data.series['apm:p50'].length >= 1);
  assert.ok(data.series['apm:p95'].length >= 1);
  assert.ok(data.series['apm:errorRate'].length >= 1);
  assert.equal(data.series['apm:errorRate'][0].value, 0.1);
  assert.equal(data.apm.errorRateThreshold, 0.05); // default threshold
  for (const pt of data.series['http:latency']) {
    assert.equal(typeof pt.ts, 'number');
    assert.equal(typeof pt.value, 'number');
  }

  // health summary: overall + per-status counts
  assert.equal(data.summary.overall, 'warn');  // one warn state present
  assert.equal(data.summary.counts.ok, 2);
  assert.equal(data.summary.counts.warn, 1);
  assert.equal(data.summary.counts.error, 0);

  // events API: seeded store events, newest first
  store.addEvent('warn', 'http', 'down then up');
  store.addEvent('info', 'http', 'api: recovered');
  const evRes = await fetch(`http://127.0.0.1:${port}/api/events`);
  assert.equal(evRes.status, 200);
  assert.match(evRes.headers.get('content-type'), /application\/json/);
  const evData = await evRes.json();
  assert.ok(Array.isArray(evData.events));
  assert.equal(evData.events.length, 2);
  assert.equal(evData.events[1].level, 'warn');      // older warn stays second
  assert.equal(evData.events[0].source, 'http');

  // page references the events section
  assert.match(html, /recent events/);

  // unknown route -> 404 with nosniff
  const miss = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get('x-content-type-options'), 'nosniff');
});

test('ui: tui renders live status + latency sparkline', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', detail: 'expires in 12d' });
  store.saveMetric('http:api/latency', 10, Date.now() - 2000);
  store.saveMetric('http:api/latency', 20, Date.now());
  t.after(() => store.close());

  const tui = new Tui({ store, intervalMs: 1000 });
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try {
    tui.render();
  } finally {
    process.stdout.write = orig;
  }
  assert.match(out, /apm-watch/);
  assert.match(out, /api/);
  assert.match(out, /http:ok:12ms/);
  assert.match(out, /cert:expires in 12d/);
  // sparkline glyph block for latency history
  assert.match(out, /▁|▂|▃|▄|▅|▆|▇|█/);
});
