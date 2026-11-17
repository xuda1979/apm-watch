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

  const server = createUiServer(store, { ui: { historySeconds: 3600 }, apm: { latencyThresholdMs: 500, windowMs: 90_000, maxSamples: 7 }, http: [{ name: 'api', latencyThresholdMs: 200, timeoutMs: 3000, assert: { statusCode: 200, bodyIncludes: 'fixture' }, intervalSeconds: '30s' }], tls: [{ name: 'api', host: 'fixture.test', warnDaysBefore: 30, timeoutMs: 4000, intervalSeconds: 90 }], store: { retentionDays: 14 }, notifications: { repeatIntervalSeconds: 7200, webhook: { url: 'https://example.com/hook' }, email: { host: 'smtp.example.com' } }, scheduler: { httpIntervalSeconds: '45s', tlsIntervalSeconds: 120, apmIntervalSeconds: '2m' } });
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
  // the browser-side table renderer surfaces http verb + response code too
  // (export page / TUI parity: /api/states carries method/status_code, the row
  // renderer used to drop them, the detail now appends ` · GET 200`)
  assert.match(html, /s\.kind === 'http'/);
  assert.match(html, /s\.method/);
  assert.match(html, /s\.status_code/);

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
  assert.equal(svcApm.p95_ms, null, 'unseeded p95 surfaces as null on the web api too');
  assert.equal(svcApm.error_rate, null);
  assert.equal(svcApm.errors, null);
  assert.equal(svcApm.samples, null);
  // the apm warn criteria ride the row like once --json (engine stamps the
  // judged-against thresholds onto each runApmCheck result): resolved from the
  // same config-global defaults, null off-kind
  assert.equal(svcApm.error_rate_threshold, 0.05, 'unconfigured apm error-rate threshold resolves to the 0.05 default on the web api row');
  assert.equal(svcApm.latency_threshold_ms, 500, 'configured apm slow-latency threshold reaches the web api row');
  assert.equal(svcApm.timeout_ms, null, 'apm rows carry no per-check abort timeout');
  assert.equal(svcApm.warn_days_before, null, 'apm rows carry no tls warn-days threshold');
  assert.equal(apiHttp.error_rate_threshold, null, 'http rows carry no apm error-rate threshold');
  // the per-row judged-against threshold / abort timeout fields ride the web
  // api rows on the same shared slot once --json uses (latency_threshold_ms:
  // http per-target, timeout_ms: http probe abort, warn_days_before: tls)
  assert.equal(apiHttp.latency_threshold_ms, 200, 'configured per-http latency threshold surfaces on the web api row');
  assert.equal(apiHttp.timeout_ms, 3000, 'configured per-http abort timeout surfaces on the web api row');
  assert.equal(apiHttp.warn_days_before, null, 'http rows carry no tls warn-days threshold');
  // the judged-against assert criteria ride the web api row on the same slot
  // once --json uses (expected_status_code / body_includes parity): re-resolved
  // from config because a stored snapshot can't recall the criteria it met
  assert.equal(apiHttp.expected_status_code, 200, 'configured assert.statusCode reaches the web api row');
  assert.equal(apiHttp.body_includes, 'fixture', 'configured assert.bodyIncludes reaches the web api row');
  assert.equal(svcApm.expected_status_code, null, 'apm rows carry no http assert status code');
  assert.equal(svcApm.body_includes, null, 'apm rows carry no http assert body marker');
  assert.equal(apiTls.error_rate_threshold, null, 'tls rows carry no apm error-rate threshold');
  assert.equal(apiTls.latency_threshold_ms, null, 'tls rows carry no latency threshold');
  assert.equal(apiTls.timeout_ms, 4000, 'configured cert-fetch socket timeout surfaces on the web api row');
  assert.equal(apiTls.warn_days_before, 30, 'configured cert warn-days threshold surfaces on the web api row');

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
  assert.equal(data.apm.collect, false, 'unconfigured apm collection surfaces as false on the web api');
  assert.deepEqual(data.http.latencyThresholds, { api: 200 }, 'per-target latency thresholds reach the web api');
  assert.deepEqual(data.http.timeoutMs, { api: 3000 }, 'per-target probe timeouts reach the web api');
  assert.deepEqual(data.http.assertStatusCodes, { api: 200 }, 'per-target assert status codes reach the web api');
  assert.deepEqual(data.http.assertBodyIncludes, { api: 'fixture' }, 'per-target assert body markers reach the web api');
  assert.deepEqual(data.tls.warnDaysBefore, { api: 30 }, 'per-target cert warn thresholds reach the web api');
  assert.deepEqual(data.http.intervalSeconds, { api: 30 }, "per-check http interval '30s' beats the scheduler-wide 45s and reaches the web api");
  assert.deepEqual(data.tls.intervalSeconds, { api: 90 }, 'per-check tls interval 90 beats the scheduler-wide 120 and reaches the web api');
  assert.equal(data.store.retentionDays, 14, 'configured store retention reaches the web api');
  assert.equal(data.notifications.repeatIntervalSeconds, 7200, 'configured alert repeat-interval reaches the web api');
  assert.equal(data.notifications.desktop, true, 'unconfigured desktop-notification gate defaults to on (engine `!== false` parity) on the web api');
  assert.equal(data.notifications.webhook, true, 'configured webhook URL surfaces the channel as enabled (engine `webhook.url` parity) on the web api');
  assert.equal(data.notifications.email, true, 'configured SMTP host surfaces the channel as enabled (engine `email.host` parity) on the web api');
  // the scheduler grid, resolved + clamped exactly like the engine's buildTasks
  assert.equal(data.scheduler.httpIntervalSeconds, 45, "unit-string '45s' resolves to 45s");
  assert.equal(data.scheduler.tlsIntervalSeconds, 120, 'plain tls interval surfaces as configured');
  assert.equal(data.scheduler.apmIntervalSeconds, 120, "'2m' resolves to 120s");
  // the availability/series history window the charts aggregate over, resolved
  // exactly like the engine consumer (`config.ui.historySeconds`, 24h default)
  assert.equal(data.ui.historySeconds, 3600, 'configured ui history window reaches the web api');
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

  // per-row availability parity: the http states row carries uptime_pct /
  // uptime_ms like export JSON (export.js:43) and once --json (inc 58), drawn
  // from the same window as the top-level availability map; off-kind rows null
  assert.equal(apiHttp.uptime_pct, 100, 'per-row http availability pct matches the top-level availability map');
  assert.deepEqual(apiHttp.uptime_ms, { up_ms: data.availability['api'].upMs, down_ms: data.availability['api'].downMs, total_ms: data.availability['api'].totalMs, samples: 1 });
  assert.equal(apiTls.uptime_pct, null, 'tls rows carry no availability pct');
  assert.equal(apiTls.uptime_ms, null, 'tls rows carry no availability breakdown');
  assert.equal(svcApm.uptime_pct, null, 'apm rows carry no availability pct');
  assert.equal(svcApm.uptime_ms, null, 'apm rows carry no availability breakdown');

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
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, method: 'GET', statusCode: 200, detail: 'HTTP 200' });
  // failure target: its *why* (the http failure reason) must reach the row
  store.saveState({ target: 'broken', kind: 'http', status: 'error', latencyMs: null, method: 'GET', statusCode: 503, detail: 'expected status 200, got 503' });
  // leaf-first multi-cert chain (the stored chain_json shape producers emit)
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', chain: [
    { subject: '/C=US/O=Acme/CN=fixture.test', issuer: '/CN=inter.test', notAfter: '2030-01-01T00:00:00.000Z', validFrom: '2025-01-01T00:00:00.000Z', daysRemaining: 12, selfSigned: false },
    { subject: '/CN=inter.test', issuer: '/CN=root.test', notAfter: '2035-01-01T00:00:00.000Z', validFrom: '2025-01-01T00:00:00.000Z', daysRemaining: 100, selfSigned: false },
  ], validChain: true, leafSubject: '/CN=fixture.test', detail: 'expires in 12d' });
  store.saveMetric('http:api/latency', 10, Date.now() - 2000);
  store.saveMetric('http:api/latency', 20, Date.now());
  store.saveMetric('http:api/status', 200, Date.now() - 2000);
  store.saveMetric('http:api/status', 200, Date.now());
  store.saveMetric('tls:api/remaining', 15, Date.now() - 2000);
  store.saveMetric('tls:api/remaining', 12, Date.now());
  t.after(() => store.close());

  // judged-against http assert criteria ride the row when configured (inc-64:
  // once --json / web rows / export JSON parity): configure both maps for the
  // broken target and expect `exp 200` + `body "welcome"` after its detail.
  const tui = new Tui({ store, intervalMs: 1000, httpAssertStatusCodes: { broken: 200 }, httpAssertBodyIncludes: { broken: 'welcome' } });
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
  assert.match(out, /http:GET 200 ok:12ms 100%/); // single ok snapshot -> full-window uptime
  // the http failure reason reaches the row (web detail-column parity): the
  // tls/apm rows carry their detail, the http row must too. The error snapshot
  // owns the whole backdated window -> 0% uptime, rendered before the detail.
  // The numeric response code rides the row like the web/export `· GET 200`
  // detail cells (inc-48 parity).
  assert.match(out, /http:GET 503 error:— 0% \(expected status 200, got 503\)/);
  // the judged-against assert criteria reach the same row (inc-64 web/once/export
  // parity): `exp 200` + `body "welcome"` after the detail, bare elsewhere
  assert.match(out, /http:GET 503 error:— 0% \(expected status 200, got 503\) exp 200 body "welcome"/);
  assert.doesNotMatch(out, /api: .* exp /, 'unconfigured http target carries no assert annotation');
  assert.match(out, /cert:expires in 12d/);
  // leaf cert subject surfaces next to the tls detail
  assert.match(out, /\(\/CN=fixture\.test\)/);
  // per-cert chain path surfaces in the row, leaf-first (web/export tooltip
  // parity): subjects use the compact last-DN-component form
  assert.match(out, /chain: CN=fixture\.test -> CN=inter\.test/);
  // ...but no broken-chain marker on a valid chain
  assert.doesNotMatch(out, /\(chain broken\)/);
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
  // chain-validity parity with the web table: a broken (non-valid) chain is
  // flagged in the row even when it carries no per-cert chain path
  assert.match(out, /api\s+.*\(chain broken\)/);
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
