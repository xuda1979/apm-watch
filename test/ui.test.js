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
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, method: 'POST', detail: 'HTTP 200 in 12.0ms' });
  store.saveMetric('http:api/latency', 10, Date.now() - 4000);
  store.saveMetric('http:api/latency', 15, Date.now());
  store.saveMetric('http:api/status', 200, Date.now() - 4000);
  store.saveMetric('http:api/status', 503, Date.now());
  // tls target with days-remaining series
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', chain: [{ subject: '/CN=fixture.test', issuer: '/CN=fixture.test', notAfter: '2030-01-01T00:00:00.000Z', validFrom: '2025-01-01T00:00:00.000Z', daysRemaining: 12, selfSigned: true }], validChain: true, leafSubject: '/CN=fixture.test', detail: 'expires in 12d (threshold 30d)' });
  store.saveMetric('tls:api/remaining', 12, Date.now());
  // apm target with p50/p95 series
  store.saveState({ target: 'svc', kind: 'apm', status: 'ok', latencyMs: 40, detail: 'p50=20ms p95=40ms errors=0/10' });
  store.saveMetric('apm:svc/p50', 20, Date.now());
  store.saveMetric('apm:svc/p95', 40, Date.now());
  store.saveMetric('apm:svc/errorRate', 0.1, Date.now());

  const server = createUiServer(store, { ui: { historySeconds: 3600 }, apm: { latencyThresholdMs: 500, windowMs: 90_000, maxSamples: 7 }, http: [{ name: 'api', latencyThresholdMs: 200 }], tls: [{ name: 'api', host: 'fixture.test', warnDaysBefore: 30 }] });
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
  // the p50/p95 chart draws the configured slow-latency threshold marker
  assert.match(html, /yellow=slow threshold/);
  // status table shows a per-row kind field alongside target/status/latency/detail
  assert.match(html, /<th>target<\/th><th>status<\/th><th>kind<\/th><th>latency<\/th><th>detail<\/th>/);
  // status-code history chart section rendered alongside the latency chart
  assert.match(html, /cLat/);
  assert.match(html, /cStatus/);
  assert.match(html, /http status code history/);
  // refresh() targets the meta <p> by id, not the <meta charset> tag, so the
  // status line actually updates instead of forever showing "loading…"
  assert.match(html, /\$\('#meta'\)\.textContent = 'updated '/);
  // the browser-side table renderers surface tls chain metadata (leaf subject,
  // broken-chain marker, and per-cert rows in a hover tooltip)
  assert.match(html, /s\.kind === 'tls'/);
  assert.match(html, /s\.leaf_subject/);
  assert.match(html, /chain broken/);
  assert.match(html, /self-signed/);
  // the tls hover tooltip also surfaces each cert's valid-from time
  assert.match(html, /c\.validFrom/);

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
  assert.equal(apiHttp.method, 'POST');
  const apiTls = data.states.find((s) => s.target === 'api' && s.kind === 'tls');
  assert.equal(apiTls.status, 'warn');
  assert.match(apiTls.detail, /expires in 12d/);
  // tls chain metadata is exposed to the browser UI
  assert.equal(apiTls.leaf_subject, '/CN=fixture.test');
  assert.equal(apiTls.valid_chain, true);
  assert.deepEqual(apiTls.chain, [
    { subject: '/CN=fixture.test', issuer: '/CN=fixture.test', notAfter: '2030-01-01T00:00:00.000Z', validFrom: '2025-01-01T00:00:00.000Z', daysRemaining: 12, selfSigned: true },
  ]);
  const svcApm = data.states.find((s) => s.target === 'svc' && s.kind === 'apm');
  // numeric per-kind fields are exposed to the browser UI
  assert.equal(apiHttp.status_code, null);          // http row: seeded without status_code -> null not undefined
  assert.equal(apiHttp.days_remaining, null);
  assert.equal(svcApm.status, 'ok');
  assert.equal(svcApm.p50_ms, null);                // apm row: seeded without numerics -> null
  assert.equal(svcApm.error_rate, null);
  assert.equal(svcApm.errors, null);
  assert.equal(svcApm.samples, null);

  // history curves present, keyed per target (so the browser can draw one
  // line per endpoint), points in seconds ts space
  assert.equal(typeof data.series['http:latency'], 'object');
  assert.equal(typeof data.series['http:latency']['api'], 'object');
  assert.ok(Array.isArray(data.series['http:latency']['api']));
  assert.ok(data.series['http:latency']['api'].length >= 2);
  assert.equal(data.series['http:status']['api'][0].value, 200);   // status-code history surfaced per target
  assert.equal(data.series['http:status']['api'][1].value, 503);
  assert.ok(data.series['tls:remaining']['api'].length >= 1);
  assert.ok(data.series['apm:p50']['svc'].length >= 1);
  assert.ok(data.series['apm:p95']['svc'].length >= 1);
  assert.ok(data.series['apm:errorRate']['svc'].length >= 1);
  assert.equal(data.series['apm:errorRate']['svc'][0].value, 0.1);
  assert.equal(data.apm.errorRateThreshold, 0.05); // default threshold
  assert.equal(data.apm.latencyThresholdMs, 500);  // configured slow-latency threshold
  assert.equal(data.apm.windowMs, 90_000);         // configured collector window
  assert.equal(data.apm.maxSamples, 7);            // configured collector sample-cap
  assert.deepEqual(data.http.latencyThresholds, { api: 200 }, 'per-target latency thresholds reach the web api');
  assert.deepEqual(data.tls.warnDaysBefore, { api: 30 }, 'per-target cert warn thresholds reach the web api');
  // the cTls chart is drawn with the per-target threshold map so the browser can
  // dash-mark each cert's configured warn day (web latency-chart parity)
  assert.match(html, /drawLines\(\$\('#cTls'\), data\.series\['tls:remaining'\], 'days', data\.tls\.warnDaysBefore\)/);
  for (const pt of data.series['http:latency']['api']) {
    assert.equal(typeof pt.ts, 'number');
    assert.equal(typeof pt.value, 'number');
  }

  // health summary: overall + per-status counts
  assert.equal(data.summary.overall, 'warn');  // one warn state present
  assert.equal(data.summary.counts.ok, 2);
  assert.equal(data.summary.counts.warn, 1);
  assert.equal(data.summary.counts.error, 0);

  // time-weighted availability per http target over the history window
  assert.ok(data.availability);
  assert.equal(data.availability['api'].pct, 100);   // single ok snapshot -> up for the whole window
  assert.equal(data.availability['api'].samples, 1);

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
  // backdate states so the availability window is nonzero (same-ms saves -> 0ms -> pct null)
  store.setClock(() => Date.now() - 60000);
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, method: 'GET', detail: 'HTTP 200' });
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', chain: [], validChain: false, leafSubject: '/CN=fixture.test', detail: 'expires in 12d' });
  store.saveMetric('http:api/latency', 10, Date.now() - 2000);
  store.saveMetric('http:api/latency', 20, Date.now());
  store.saveMetric('http:api/status', 200, Date.now() - 2000);
  store.saveMetric('http:api/status', 200, Date.now());
  store.saveMetric('tls:api/remaining', 15, Date.now() - 2000);
  store.saveMetric('tls:api/remaining', 12, Date.now());
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
  assert.match(out, /http:GET ok:12ms 100%/); // single ok snapshot -> full-window uptime
  assert.match(out, /cert:expires in 12d/);
  // leaf cert subject surfaces next to the tls detail
  assert.match(out, /\(\/CN=fixture\.test\)/);
  // chain-validity parity with the web table: broken chains are flagged in the row
  assert.match(out, /\(chain broken\)/);
  // sparkline glyph block for latency history
  assert.match(out, /▁|▂|▃|▄|▅|▆|▇|█/);
  // status-code history section renders per http target
  assert.match(out, /── http status history ──/);
  assert.match(out, /api: ▁|api: ▂|api: ▃|api: █/);
  // tls remaining-days history renders as its own per-target sparkline block
  assert.match(out, /── tls remaining history ──/);
  assert.match(out, /api: █▁/); // remaining 15 -> 12 over two samples
});

test('ui: tui latency-history rows annotate the per-target slow threshold (web chart parity)', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.saveState({ target: 'anon', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  for (const target of ['api', 'anon']) {
    store.saveMetric(`http:${target}/latency`, 12, Date.now());
  }
  t.after(() => store.close());

  const tui = new Tui({ store, intervalMs: 1000, latencyThresholds: { api: 200 } });
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try { tui.render(); } finally { process.stdout.write = orig; }
  // the configured threshold is annotated on its target's row, others stay bare
  assert.match(out, /api: .*thr 200ms/);
  assert.doesNotMatch(out, /anon: .*thr/);
});

test('ui: tui has no threshold marker when config supplies none', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.saveMetric('http:api/latency', 12, Date.now());
  t.after(() => store.close());

  const tui = new Tui({ store, intervalMs: 1000 });
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try { tui.render(); } finally { process.stdout.write = orig; }
  assert.match(out, /── latency history ──/);
  assert.doesNotMatch(out, / thr /, 'no latency threshold annotation when the target has none configured');
});

test('ui: tui tls-history rows annotate the per-target cert warn threshold (web cTls parity)', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', chain: [], validChain: false, leafSubject: '/CN=fixture.test', detail: 'expires in 12d' });
  store.saveState({ target: 'anon', kind: 'tls', status: 'warn', chain: [], validChain: false, detail: 'expires in 12d' });
  for (const target of ['api', 'anon']) {
    store.saveMetric(`tls:${target}/remaining`, 12, Date.now());
  }
  t.after(() => store.close());

  const tui = new Tui({ store, intervalMs: 1000, tlsWarnDaysBefore: { api: 30 } });
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try { tui.render(); } finally { process.stdout.write = orig; }
  // the configured cert warn-days threshold is annotated on its target's row, others stay bare
  assert.match(out, /api: .*warn 30d/);
  assert.doesNotMatch(out, /anon: .*warn \d+d/);
});

test('ui: tui renders apm p50/p95 + error-rate history like the web UI', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'svc', kind: 'apm', status: 'ok', latencyMs: 40, detail: 'p50=20ms p95=40ms errors=0/10' });
  store.saveMetric('apm:svc/p50', 20, Date.now() - 1000);
  store.saveMetric('apm:svc/p95', 40, Date.now() - 1000);
  store.saveMetric('apm:svc/errorRate', 0.03, Date.now());
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
  assert.match(out, /── apm history ──/);
  assert.match(out, /svc: p50 20ms  p95 40ms/);
  assert.match(out, /err 3\.0%/);
  // both latency and error-rate sparklines render glyph blocks
  assert.match(out, /▁|▂|▃|▄|▅|▆|▇|█/);
});

test('ui: tui apm-history rows annotate the warn criteria (web drawApm/drawErrRate parity)', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'svc', kind: 'apm', status: 'warn', latencyMs: 270, detail: 'p50=200ms p95=270ms errors=0/10 (slow p95)' });
  store.saveState({ target: 'bare', kind: 'apm', status: 'ok', latencyMs: 40, detail: 'p50=20ms p95=40ms errors=0/10' });
  for (const target of ['svc', 'bare']) {
    store.saveMetric(`apm:${target}/p50`, 20, Date.now() - 1000);
    store.saveMetric(`apm:${target}/p95`, target === 'svc' ? 270 : 40, Date.now() - 1000);
    store.saveMetric(`apm:${target}/errorRate`, 0.03, Date.now());
  }
  t.after(() => store.close());

  const tui = new Tui({ store, intervalMs: 1000, apmLatencyThresholdMs: 250, apmErrorRateThreshold: 0.05 });
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try { tui.render(); } finally { process.stdout.write = orig; }
  // the configured slow-latency threshold annotates every apm row (a single
  // config-level threshold governs all services, unlike per-target http/tls)
  assert.match(out, /svc: .*slow thr 250ms/);
  assert.match(out, /bare: .*slow thr 250ms/);
  // the resolved error-rate threshold annotates the err lines
  assert.match(out, /err 3\.0% .*errThr 5\.0%/);
});

test('ui: tui apm rows stay bare when no apm thresholds are configured', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'svc', kind: 'apm', status: 'ok', latencyMs: 40, detail: 'p50=20ms p95=40ms errors=0/10' });
  store.saveMetric('apm:svc/p50', 20, Date.now() - 1000);
  store.saveMetric('apm:svc/p95', 40, Date.now() - 1000);
  store.saveMetric('apm:svc/errorRate', 0.03, Date.now());
  t.after(() => store.close());

  const tui = new Tui({ store, intervalMs: 1000 });
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out += s; return true; };
  try { tui.render(); } finally { process.stdout.write = orig; }
  assert.match(out, /── apm history ──/);
  assert.doesNotMatch(out, / thr | errThr /, 'no apm threshold annotation when none configured');
});

test('ui: tui header shows monitor self-health from the health meta', async (t) => {
  const store = new Store(':memory:');
  store.setClock(() => Date.now());
  store.setMeta('health', { status: 'warn', uptimeSince: Date.now() - 120000, lastCheckAt: Date.now() });
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
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
  assert.match(out, /up 2m ago/);
  assert.match(out, /monitor warn/);
  assert.match(out, /last check \d+/);
});

test('ui: series are kept per target so multi-endpoint charts stay readable', async (t) => {
  const store = new Store(':memory:');
  // two http + one tls target, each with latency/remaining history
  for (const { target, latency, remaining } of [
    { target: 'api-a', latency: [10, 20], remaining: null },
    { target: 'api-b', latency: [50, 80], remaining: 30 },
  ]) {
    store.saveState({ target, kind: 'http', status: 'ok', latencyMs: latency[1], detail: 'HTTP 200' });
    store.saveMetric(`http:${target}/latency`, latency[0], Date.now() - 2000);
    store.saveMetric(`http:${target}/latency`, latency[1], Date.now());
    if (remaining != null) {
      store.saveState({ target, kind: 'tls', status: 'warn', detail: `expires in ${remaining}d` });
      store.saveMetric(`tls:${target}/remaining`, remaining, Date.now());
    }
  }
  const server = createUiServer(store, { ui: { historySeconds: 3600 } });
  const port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  const data = await res.json();
  const lat = data.series['http:latency'];
  assert.deepEqual(Object.keys(lat).sort(), ['api-a', 'api-b']);
  // each target keeps its own values — no cross-target merging
  assert.deepEqual(lat['api-a'].map((p) => p.value), [10, 20]);
  assert.deepEqual(lat['api-b'].map((p) => p.value), [50, 80]);
  assert.equal(data.series['tls:remaining']['api-b'][0].value, 30);
});

test('ui: monitor self-health from the engine status meta is exposed via the api', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.setMeta('health', { status: 'ok', uptimeSince: 1_700_000_000_000, lastCheckAt: 1_700_000_001_000 });
  // page script appends the health line when the api returns lastCheckAt
  const server = createUiServer(store, { ui: { historySeconds: 3600 } });
  const port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  const data = await res.json();
  assert.deepEqual(data.health, {
    status: 'ok',
    uptimeSince: 1_700_000_000_000,
    lastCheckAt: 1_700_000_001_000,
  });
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  // browser JS renders the health fields into the #meta status line
  assert.match(html, /\$\('#meta'\)\.textContent = 'updated '/);
  assert.match(html, /fmtAgo\(data\.health\.uptimeSince\)/);
  assert.match(html, /last check ' \+ new Date\(data\.health\.lastCheckAt\)\.toLocaleTimeString\(\)/);
});

test('ui: api health is null when the engine has not persisted any yet', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  const server = createUiServer(store, { ui: { historySeconds: 3600 } });
  const port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  const data = await res.json();
  assert.equal(data.health, null);
});

test('ui: tui honors the configured history window for its sparklines', async (t) => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 20, detail: 'HTTP 200' });
  // one latency point far outside a short window, one current
  store.saveMetric('http:api/latency', 10, Date.now() - 60000);
  store.saveMetric('http:api/latency', 20, Date.now());
  t.after(() => store.close());

  const render = (tui) => {
    let out = '';
    const orig = process.stdout.write;
    process.stdout.write = (s) => { out += s; return true; };
    try { tui.render(); } finally { process.stdout.write = orig; }
    return out;
  };

  // 5s window: the minute-old point is dropped -> single-glyph sparkline
  const outShort = render(new Tui({ store, intervalMs: 1000, historyMs: 5000 }));
  assert.match(outShort, /api: ▁$/m);

  // default 1h window keeps both points -> two glyphs
  const outLong = render(new Tui({ store, intervalMs: 1000 }));
  assert.match(outLong, /api: ▁█/);
});
