import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportStatus, renderStatusPage } from '../lib/export.js';
import { Store } from '../lib/store.js';

test('export: aggregates latest status across http/tls/apm target into JSON', () => {
  const store = new Store(':memory:');
  let now = Date.now();
  store.setClock(() => now);
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, method: 'POST', statusCode: 200, detail: 'HTTP 200' });
  now += 1000;
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, method: 'POST', statusCode: 200, detail: 'HTTP 200' });
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', daysRemaining: 12, chain: [{ subject: '/CN=fixture.test', issuer: '/CN=fixture.test', notAfter: '2030-01-01T00:00:00.000Z', daysRemaining: 12, selfSigned: true }], validChain: true, leafSubject: '/CN=fixture.test', detail: 'expires in 12d' });
  store.saveState({ target: 'api', kind: 'apm', status: 'warn', latencyMs: 320, p50Ms: 200, p95Ms: 320, errorRate: 0.1, errors: 1, samples: 10, detail: 'p50=200ms p95=320ms errors=1/10 (slow p95)' });
  store.saveState({ target: 'other', kind: 'http', status: 'error', latencyMs: null, statusCode: 503, detail: 'down' });
  const out = exportStatus(store, {});
  assert.equal(out.targets.length, 2);
  const api = out.targets.find((t) => t.target === 'api');
  assert.equal(api.status, 'warn');
  assert.equal(api.http.latency_ms, 12);
  assert.equal(api.tls.detail, 'expires in 12d');
  // cert-chain metadata surfaces on the export JSON snapshot
  assert.equal(api.tls.leaf_subject, '/CN=fixture.test');
  assert.equal(api.tls.valid_chain, true);
  assert.deepEqual(api.tls.chain, [
    { subject: '/CN=fixture.test', issuer: '/CN=fixture.test', notAfter: '2030-01-01T00:00:00.000Z', daysRemaining: 12, selfSigned: true },
  ]);
  assert.equal(api.apm.status, 'warn');
  assert.equal(api.apm.latency_ms, 320);
  assert.match(api.apm.detail, /slow p95/);
  // numeric per-kind fields surface on the export JSON snapshot
  assert.equal(api.http.method, 'POST', 'http verb surfaces on the export JSON snapshot');
  assert.equal(api.http.status_code, 200);
  // judged-against thresholds ride the per-target blocks (once --json / web
  // /api/states parity): unconfigured -> null on the http/tls blocks, exactly
  // like the empty mirror maps
  assert.equal(api.http.latency_threshold_ms, null, 'unconfigured http slow-latency threshold is null on the export snapshot');
  assert.equal(api.http.timeout_ms, null, 'unconfigured http abort timeout is null on the export snapshot');
  assert.equal(api.http.expected_status_code, null, 'unconfigured http assert status code is null on the export snapshot');
  assert.equal(api.http.body_includes, null, 'unconfigured http assert body marker is null on the export snapshot');
  assert.equal(api.tls.warn_days_before, null, 'unconfigured tls warn-days threshold is null on the export snapshot');
  assert.equal(api.tls.timeout_ms, null, 'unconfigured tls cert-fetch timeout is null on the export snapshot');
  assert.equal(api.tls.port, null, 'unconfigured tls probe port is null on the export snapshot');
  assert.equal(api.http.interval_seconds, null, 'unconfigured http run cadence is null on the export snapshot');
  assert.equal(api.tls.interval_seconds, null, 'unconfigured tls run cadence is null on the export snapshot');
  assert.equal(api.apm.interval_seconds, 60, 'unconfigured apm run cadence resolves to the 60s default on the export snapshot');
  assert.equal(api.tls.days_remaining, 12);
  assert.equal(api.apm.p50_ms, 200);
  assert.equal(api.apm.p95_ms, 320, 'p95 ms surfaces on the export snapshot like p50');
  assert.equal(api.apm.error_rate, 0.1);
  assert.equal(api.apm.errors, 1);
  assert.equal(api.apm.samples, 10);
  // the apm warn criteria ride the row like once --json (the engine stamps the
  // judged-against thresholds onto each runApmCheck result): re-resolved from
  // the same config-global defaults the apm mirror block carries
  assert.equal(api.apm.error_rate_threshold, 0.05, 'unconfigured apm error-rate threshold resolves to the 0.05 default on the export snapshot');
  assert.equal(api.apm.latency_threshold_ms, null, 'unconfigured apm slow-latency threshold is null, not dropped, on the export snapshot');
  const other = out.targets.find((t) => t.target === 'other');
  assert.equal(other.http.status_code, 503);
  // a target without the kind keeps null numerics, not undefined (stable JSON)
  assert.equal(other.http.uptime_pct, null);
  assert.equal(other.apm, null);
  // time-weighted availability: api was up for all 2000ms of history
  assert.equal(api.http.uptime_pct, 100);
  // configured thresholds/timeouts surface on the per-target blocks (once
  // --json / web /api/states parity): re-export against a config that actually
  // sets the http/tls knobs, resolved from the same per-target maps the
  // top-level mirror blocks carry
  const cfg2 = {
    http: [{ name: 'api', latencyThresholdMs: 200, timeoutMs: 3000, assert: { statusCode: 201, bodyIncludes: 'welcome' } }],
    tls: [{ name: 'api', warnDaysBefore: 14, timeoutMs: 4000 }],
    apm: { errorRateThreshold: 0.08, latencyThresholdMs: 400 },
  };
  const out2 = exportStatus(store, cfg2);
  const api2 = out2.targets.find((t) => t.target === 'api');
  assert.equal(api2.http.latency_threshold_ms, 200, 'configured http slow-latency threshold surfaces on the export snapshot');
  assert.equal(api2.http.timeout_ms, 3000, 'configured http abort timeout surfaces on the export snapshot');
  assert.equal(api2.http.expected_status_code, 201, 'configured assert status code surfaces on the export snapshot');
  assert.equal(api2.http.body_includes, 'welcome', 'configured assert body marker surfaces on the export snapshot');
  assert.equal(api2.tls.warn_days_before, 14, 'configured tls warn-days threshold surfaces on the export snapshot');
  assert.equal(api2.tls.timeout_ms, 4000, 'configured tls cert-fetch timeout surfaces on the export snapshot');
  // the probe port resolves the same path as the timeout: cfg2's tls target
  // sets no port, so the per-target map resolves the 443 socket default exactly
  // like the engine's runTlsCheck fetches over (inc 78 parity)
  assert.equal(api2.tls.port, 443, 'configured tls probe port resolves to the 443 socket default on the export snapshot');
  assert.equal(api2.apm.error_rate_threshold, 0.08, 'configured apm error-rate threshold surfaces on the export snapshot');
  assert.equal(api2.apm.latency_threshold_ms, 400, 'configured apm slow-latency threshold surfaces on the export snapshot');
  assert.equal(api2.apm.window_ms, 60_000, 'unconfigured collector window resolves to the 60s default on the export snapshot');
  // per-check run cadence traces the same resolve path as the thresholds: cfg2
  // sets no intervalSeconds, so the per-target map resolves the kind defaults
  // (60s http / 300s tls) exactly like the mirror blocks assert above
  assert.equal(api2.http.interval_seconds, 60, 'unconfigured per-http interval resolves to the 60s default on the export snapshot');
  assert.equal(api2.tls.interval_seconds, 300, 'unconfigured per-cert interval resolves to the 300s default on the export snapshot');
  // the judged-against thresholds also annotate the rendered status-page apm row
  // (web table + TUI + once parity, inc 68): ` errThr 8.0%` / ` slow thr 400ms`
  // append to the detail exactly like the machine apm block carries them, plus
  // the measured error rate as ` err 10.0%` (inc 75 parity — the seeded 0.1
  // error_rate the detail's errors=1/10 fraction encodes, labeled for at-a-glance
  // reading like the TUI apm-history err line) and the config-global collection
  // cadence as ` · every 1m` (inc 76 parity — the 60s scheduler default apm's
  // interval_seconds resolved to, rendered before the threshold annotations)
  const html2 = renderStatusPage(out2);
  assert.match(html2, /p50=200ms p95=320ms errors=1\/10 \(slow p95\) · every 1m errThr 8\.0% slow thr 400ms err 10\.0% · window 1m/, 'judged-against apm thresholds, the measured error rate, the collection cadence and the sampling window annotate the export page apm row');
  // the per-probe slow-latency threshold rides the http row too (inc 73 parity):
  // api carries latencyThresholdMs 200 in cfg2, so the detail appends ` · thr 200ms`
  // after the resolved cadence, exactly like the JSON http block carries it
  assert.match(html2, /HTTP 200 · POST 200 · 100% uptime exp 201 body &quot;welcome&quot; · timeout 3000ms · every 1m · thr 200ms/, 'configured slow-latency threshold annotates the export page http row');
  // the judged-against cert warn-days threshold rides the tls row too (inc 74
  // parity): api carries warnDaysBefore 14 in cfg2, so the detail appends
  // ` · warn 14d` after the resolved cadence, exactly like the JSON tls block
  // carries it and the TUI history section annotates it
  assert.match(html2, /expires in 12d · \/CN=fixture\.test · timeout 4000ms · every 5m · warn 14d · port 443/, 'configured cert warn-days threshold and probed port annotate the export page tls row');
  assert.deepEqual(out2.http.latencyThresholds, { api: 200 }, 'mirror block matches the per-target resolved map');
  assert.deepEqual(out2.http.assertStatusCodes, { api: 201 }, 'assert status mirror block matches the per-target resolved map');
  assert.deepEqual(out2.http.assertBodyIncludes, { api: 'welcome' }, 'assert body mirror block matches the per-target resolved map');
  assert.deepEqual(out2.tls.warnDaysBefore, { api: 14 }, 'mirror block matches the per-target resolved map');
  // the per-target probe-port map (web api parity): cfg2's tls target sets no
  // port, so it resolves to the 443 socket default exactly like the engine's
  // runTlsCheck fetches over (inc 78)
  assert.deepEqual(out2.tls.port, { api: 443 }, 'probe-port mirror block matches the per-target resolved map');
  // the closed-over-target "other" row (no config entry) stays null
  const other2 = out2.targets.find((t) => t.target === 'other');
  assert.equal(other2.http.latency_threshold_ms, null, 'unconfigured target keeps null on the export snapshot');
  assert.equal(other2.http.timeout_ms, null);
  // uptime_ms mirrors the same window (web api availability-map parity): all-up
  // target -> 0 down ms, and the snapshot count rides along
  assert.equal(api.http.uptime_ms.down_ms, 0);
  assert.ok(api.http.uptime_ms.up_ms >= api.http.uptime_ms.total_ms);
  assert.equal(api.http.uptime_ms.samples, 2);
  // zero-window target keeps the sibling null (uptime_pct parity on the same row)
  assert.equal(other.http.uptime_ms, null);
  // overall summary + counts
  assert.equal(out.summary.overall, 'error');   // error outweighs warn
  assert.equal(out.summary.counts.ok, 0);
  assert.equal(out.summary.counts.warn, 1);
  assert.equal(out.summary.counts.error, 1);
  assert.equal(out.generated_at, new Date(out.generated_ts).toISOString());
  // the apm error-rate threshold the summary is judged against (web api parity)
  assert.equal(out.apm.errorRateThreshold, 0.05);
  // unconfigured slow-latency threshold is null, not dropped (web api parity)
  assert.equal(out.apm.latencyThresholdMs, null);
  assert.equal(out.apm.windowMs, 60_000, 'collector window defaults surfaced like the other apm knobs');
  assert.equal(out.apm.maxSamples, 5000, 'collector sample-cap default surfaced too');
  assert.equal(out.apm.collect, false, 'unconfigured apm collection surfaces as false on the export snapshot');
  // per-target slow-latency threshold map (web api parity): none configured -> {}
  assert.deepEqual(out.http.latencyThresholds, {}, 'empty-config http threshold map defaults to {}');
  // per-target probe timeout map (web api parity): none configured -> {}
  assert.deepEqual(out.http.timeoutMs, {}, 'empty-config http timeout map defaults to {}');
  // per-target assert criteria maps (web api parity): none configured -> {}
  assert.deepEqual(out.http.assertStatusCodes, {}, 'empty-config http assert status map defaults to {}');
  assert.deepEqual(out.http.assertBodyIncludes, {}, 'empty-config http assert body map defaults to {}');
  // per-target cert warn-days threshold map (web api parity): none configured -> {}
  assert.deepEqual(out.tls.warnDaysBefore, {}, 'empty-config tls warn-days map defaults to {}');
  // per-target cert-fetch timeout map (web api parity): none configured -> {}
  assert.deepEqual(out.tls.timeoutMs, {}, 'empty-config tls timeout map defaults to {}');
  // per-target cert probe-port map (web api parity): none configured -> {}
  assert.deepEqual(out.tls.port, {}, 'empty-config tls probe-port map defaults to {}');
  // per-check run-interval maps (web api parity): none configured -> {}
  assert.deepEqual(out.http.intervalSeconds, {}, 'empty-config http run-interval map defaults to {}');
  assert.deepEqual(out.tls.intervalSeconds, {}, 'empty-config tls run-interval map defaults to {}');
  // store retention (the value the store:prune scheduler task uses): default 7
  assert.equal(out.store.retentionDays, 7, 'unconfigured store retention surfaces as the 7d default');
  // alert repeat-interval (the engine's re-send dedup window): default 3600
  assert.equal(out.notifications.repeatIntervalSeconds, 3600, 'unconfigured alert repeat-interval surfaces as the 3600s default');
  assert.equal(out.notifications.desktop, true, 'unconfigured desktop-notification gate surfaces as on (engine `!== false` parity) on the export JSON snapshot');
  assert.equal(out.notifications.webhook, false, 'unconfigured webhook channel surfaces as disabled on the export JSON snapshot');
  assert.equal(out.notifications.email, false, 'unconfigured email channel surfaces as disabled on the export JSON snapshot');
  // the scheduler grid the engine's task intervals actually run on: defaults
  assert.deepEqual(out.scheduler, { httpIntervalSeconds: 60, tlsIntervalSeconds: 300, apmIntervalSeconds: 60 }, 'default scheduler grid surfaces on the export JSON snapshot');
  // availability/series history window the snapshot aggregates over: ui.historySeconds
  // (web api parity), default 24h when unconfigured
  assert.equal(out.ui.historySeconds, 86400, 'unconfigured ui history window surfaces as the 24h default on the export snapshot');
  setTimeout(store.close, 0);
});

test('export: renderStatusPage builds a self-contained html snapshot', () => {
  const store = new Store(':memory:');
  // backdate states so availability sees a nonzero window (same-ms saves -> 0ms).
  const past = Date.now() - 60000;
  store.setClock(() => past);
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, method: 'GET', statusCode: 200, detail: 'HTTP 200' });
  store.saveState({ target: 'api', kind: 'tls', status: 'warn', detail: 'expires in 12d', validChain: false, chain: [{ subject: '/CN=fixture.test', issuer: '/CN=fixture.test', notAfter: '2030-01-01T00:00:00.000Z', validFrom: '2025-01-01T00:00:00.000Z', daysRemaining: 12, selfSigned: true }] });
  store.saveState({ target: 'other', kind: 'http', status: 'error', latencyMs: null, detail: 'down' });
  store.saveState({ target: 'evil', kind: 'http', status: 'ok', latencyMs: 1, detail: '<script>alert(1)</script>& "x"' });
  // api is configured with an http assert block so the judged-against criteria
  // (expected status 201 + body marker "welcome") render on its row like the
  // tui/web/once rows (inc-65 parity) — the JSON block carries them regardless
  const out = exportStatus(store, { http: [{ name: 'api', assert: { statusCode: 201, bodyIncludes: 'welcome' } }] }, '9.9.9');
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
  // broken-chain marker on the tls row (valid_chain=false row)
  assert.match(html, /expires in 12d \(chain broken\)/);
  // per-cert chain rows surface on the status page as a hover tooltip, with
  // subject/issuer/valid/notAfter/days (web table tooltip parity)
  assert.match(html, /title="\/CN=fixture\.test -&gt; \/CN=fixture\.test/);
  assert.match(html, /valid 2025-01-01T00:00:00\.000Z/);
  assert.match(html, /notAfter 2030-01-01T00:00:00\.000Z/);
  assert.match(html, /12d \(self-signed\)/);
  // uptime pct rendered in the http row detail, after the verb + response code
  // (web table row parity: export JSON carries method/status_code, the page
  // renderer used to drop them, the row now shows `HTTP 200 · GET 200 · 100%`)
  assert.match(html, /HTTP 200 · GET 200 · 100% uptime/);
  // judged-against http assert criteria render on the row detail after uptime
  // (web table + TUI + once parity, inc-65): the detail is escaped as a whole,
  // so the body marker's quotes render as &quot;
  assert.match(html, /HTTP 200 · GET 200 · 100% uptime exp 201 body &quot;welcome&quot;/, 'assert criteria annotate the export page http row');
  // the resolved probe abort timeout rides the row too (inc-67 parity): api has
  // no timeoutMs in the config so the per-target map resolves the 5000 default,
  // exactly like the web/export JSON `timeout_ms` value the block carries
  assert.match(html, /HTTP 200 · GET 200 · 100% uptime exp 201 body &quot;welcome&quot; · timeout 5000ms/, 'resolved abort timeout annotates the export page http row');
  // the resolved per-check run cadence rides the row too (inc-71 parity): api
  // sets no intervalSeconds so the per-target map resolves the 60s http default,
  // formatted compact like the web/TUI/once human faces (` · every 1m` — 60s
  // renders as 1m under the shared fmtInterval short-form)
  assert.match(html, /HTTP 200 · GET 200 · 100% uptime exp 201 body &quot;welcome&quot; · timeout 5000ms · every 1m/, 'resolved run cadence annotates the export page http row');
  // detail is html-escaped: < and & cannot break out of the page
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /apm-watch v9\.9\.9/);
  // hostile details are html-escaped, cannot inject markup or lose attrs
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;x&quot;/);
  setTimeout(store.close, 0);
});

test('export: recent events surface in the JSON snapshot, newest first', () => {
  const store = new Store(':memory:');
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.addEvent('info', 'http', 'api: recovered');
  store.addEvent('warn', 'http', 'api: down then up');
  const out = exportStatus(store, {});
  assert.ok(Array.isArray(out.events));
  assert.equal(out.events.length, 2);
  assert.deepEqual(out.events[0], {
    ts: out.events[0].ts, level: 'warn', source: 'http', message: 'api: down then up',
  }, 'newest event first');
  assert.equal(out.events[1].level, 'info');
  assert.equal(typeof out.events[0].ts, 'number', 'event ts is a number, matching the web /api/events shape');
  setTimeout(store.close, 0);
});

test('export: renderStatusPage renders recent events with html-escaped messages', () => {
  const store = new Store(':memory:');
  const past = Date.now() - 60000;
  store.setClock(() => past);
  store.saveState({ target: 'api', kind: 'http', status: 'ok', latencyMs: 12, detail: 'HTTP 200' });
  store.addEvent('error', 'http', '<script>alert(1)</script> & "hi"');
  store.addEvent('info', 'tls', 'api: cert refreshed');
  const out = exportStatus(store, {}, '9.9.9');
  const html = renderStatusPage(out);
  assert.match(html, /<h2>recent events<\/h2>/);
  assert.match(html, /api: cert refreshed/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)/);
  assert.match(html, /&quot;hi&quot;/);
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
