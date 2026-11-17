import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../lib/engine.js';
import { Store } from '../lib/store.js';
import { startHttpServer, startHttpsServer } from './helpers/fixtures.js';

test('engine: runs http + tls checks and persists + alerts on cert expiry', async (t) => {
  const httpSrv = await startHttpServer({
    '/ok': { status: 200, body: 'all good' },
    '/bad': { status: 503, body: 'down' },
  });
  t.after(httpSrv.close);

  const httpsSoon = await startHttpsServer({ days: 15 });   // warn (threshold 30)
  const httpsOk = await startHttpsServer({ days: 200 });    // ok
  t.after(httpsSoon.close);
  t.after(httpsOk.close);

  const store = new Store(':memory:');
  let now = 0;
  store.setClock(() => now);
  const alerts = [];
  const engine = new Engine({
    store,
    config: {
      http: [
        { name: 'api', url: httpSrv.url + '/ok', assert: { statusCode: 200, bodyIncludes: 'all good' } },
        { name: 'api2', url: httpSrv.url + '/bad', assert: { statusCode: 200 } },
      ],
      tls: [
        { name: 'soon', host: '127.0.0.1', port: httpsSoon.port, warnDaysBefore: 30, rejectUnauthorized: false, servername: 'fixture.test' },
        { name: 'okcert', host: '127.0.0.1', port: httpsOk.port, warnDaysBefore: 30, rejectUnauthorized: false, servername: 'fixture.test' },
      ],
      notifications: { repeatIntervalSeconds: 3600, desktop: false },
    },
    log: () => {},
  });
  engine.notifyFn = async (r) => { alerts.push(r); return [{ ok: true }]; };

  // Run a manual tick (all jobs)
  await engine.tick();

  const httpStates = store.latestStates();
  const api = httpStates.find((s) => s.target === 'api');
  const api2 = httpStates.find((s) => s.target === 'api2');
  assert.equal(api.status, 'ok');
  assert.match(api.detail, /HTTP 200/);
  assert.equal(api2.status, 'error');

  const tlsSoon = httpStates.find((s) => s.target === 'soon');
  const tlsOk = httpStates.find((s) => s.target === 'okcert');
  assert.equal(tlsSoon.status, 'warn');
  assert.match(tlsSoon.detail, /expires in \d+d/, `detail=${tlsSoon.detail}`);
  assert.equal(tlsOk.status, 'ok');

  // numeric per-kind fields persist through the store for the export/web surfaces
  assert.equal(api.status_code, 200);
  assert.equal(api2.status_code, 503);
  assert.equal(api.method, 'GET');
  assert.equal(api2.method, 'GET');
  assert.equal(tlsSoon.days_remaining, 15);
  assert.ok(tlsOk.days_remaining > 30);
  // chain metadata: leaf subject + validity + per-cert entries persist
  const okChain = JSON.parse(tlsOk.chain_json);
  assert.ok(Array.isArray(okChain) && okChain.length >= 1, 'cert chain persisted per-cert');
  assert.equal(okChain[0].subject, 'CN=fixture.test'); // X509Certificate DNs omit the leading '/'
  assert.equal(okChain[0].selfSigned, true);
  assert.equal(okChain[0].daysRemaining, tlsOk.days_remaining);
  assert.equal(tlsOk.valid_chain, 1);
  assert.equal(tlsOk.leaf_subject, 'CN=fixture.test');


  // alerts: soon is warn, okcert is ok, api is ok, api2 is error -> 2 alerts
  assert.ok(alerts.length >= 2);
  const warnAlerts = alerts.filter((a) => a.status === 'warn' && a.target === 'soon');
  const errAlerts = alerts.filter((a) => a.status === 'error');
  assert.ok(warnAlerts.length >= 1);
  assert.ok(errAlerts.length >= 1);

  // the cert-fetch socket timeout stamps the tls result (default 5000 when
  // unset in config) — same stamping family as warnDaysBefore
  const soonRes = await engine.runTlsCheck({ name: 'soon', host: '127.0.0.1', port: httpsSoon.port, rejectUnauthorized: false, servername: 'fixture.test' });
  assert.equal(soonRes.status, 'warn');
  assert.equal(soonRes.timeoutMs, 5000, 'unconfigured tls timeout resolves to the 5000 default');

  // events recorded
  const events = store.recentEvents();
  assert.ok(events.length >= 2);
});

test('engine: dead/unresponsive endpoint -> error, JSON body assert works', async (t) => {
  const { startHttpServer } = await import('./helpers/fixtures.js');
  const srv = await startHttpServer({ '/json': { status: 200, body: '{"ok":true}' } });
  t.after(srv.close);
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { http: [{ name: 'j', url: srv.url + '/json', assert: { statusCode: 200, bodyIncludes: '"ok":true' } }] }, log: () => {} });
  await engine.runHttpCheck(engine.config.http[0]);
  const latest = store.latestStates()[0];
  assert.equal(latest.status, 'ok');
  assert.equal(latest.method, 'GET', 'default verb persists into the states row');

  // timeout target
  const hangSrv = await startHttpServer({ '/x': { hang: true } });
  t.after(hangSrv.close);
  const res = await engine.runHttpCheck({ name: 'hang', url: hangSrv.url + '/x', timeoutMs: 300 });
  assert.equal(res.status, 'error');
});

test('engine: apm slow p95 latency flips status to warn below error threshold', async () => {
  const store = new Store(':memory:');
  const alerts = [];
  const engine = new Engine({
    store,
    config: { apm: { collect: true, errorRateThreshold: 0.5, latencyThresholdMs: 100 } },
    log: () => {},
  });
  engine.notifyFn = async (r) => { alerts.push(r); return [{ ok: true }]; };
  // 10 spans, 1 error (10% < 50% threshold) but p95 well above 100ms
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    engine.collector.add('slow', 200 + i, i === 0, now + i);
  }
  const { summary, results } = await engine.runApmCheck();
  assert.equal(summary.slow.p95 >= 100, true);
  // numeric fields flow through the result so a `once --json` CI consumer can
  // compare error_rate/samples without parsing the detail string
  const slowRes = results.find((r) => r.target === 'slow');
  assert.equal(slowRes.p50Ms, summary.slow.p50);
  assert.equal(slowRes.p95Ms, summary.slow.p95, 'p95 stamps its own labelled field alongside latency_ms');
  assert.equal(slowRes.errorRate, 0.1, '1 error / 10 samples');
  assert.equal(slowRes.errors, 1);
  assert.equal(slowRes.samples, 10);
  assert.equal(slowRes.latencyMs, summary.slow.p95);
  // the thresholds judged against stamp the result (once --json / surfaces
  // see the warn criteria without re-resolving the config)
  assert.equal(slowRes.errorRateThreshold, 0.5);
  assert.equal(slowRes.latencyThresholdMs, 100);
  // route through the alert pipeline so slow/erroring services notify + log events
  await engine.runApmCheckWithAlerts();
  // slow service alerts + warns
  const slowAlert = alerts.find((a) => a.target === 'slow');
  assert.equal(slowAlert.status, 'warn');
  assert.match(slowAlert.detail, /slow p95/);
  const warnEvent = store.recentEvents().find((e) => e.source === 'apm' && e.message.includes('slow'));
  assert.ok(warnEvent, 'slow apm service recorded an event');
  // the same numeric fields persist into the states rows for export/web surfaces
  const slowState = store.latestStates().find((s) => s.target === 'slow');
  assert.equal(slowState.p50_ms, summary.slow.p50);
  assert.equal(slowState.p95_ms, summary.slow.p95, 'p95_ms persists as its own state column');
  assert.equal(slowState.error_rate, 0.1);
  assert.equal(slowState.errors, 1);
  assert.equal(slowState.samples, 10);
  assert.equal(slowState.latency_ms, summary.slow.p95);

  // fast service: p95 under latency threshold, low errors -> ok
  for (let i = 0; i < 10; i++) {
    engine.collector.add('fast', 5, false, now + i);
  }
  const { results: fastResults } = await engine.runApmCheck();
  const fastRes = fastResults.find((r) => r.target === 'fast');
  assert.equal(fastRes.status, 'ok');
  assert.equal(fastRes.errorRateThreshold, 0.5, 'thresholds stamp ok results too');
  assert.equal(fastRes.latencyThresholdMs, 100);
  const states = store.latestStates();
  assert.equal(states.find((s) => s.target === 'slow').status, 'warn');
  assert.equal(states.find((s) => s.target === 'fast').status, 'ok');
  assert.ok(!alerts.some((a) => a.target === 'fast'), 'fast service must not alert');
});

test('engine: collector window and maxSamples are wired from config', async () => {
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    config: { apm: { collect: true, windowMs: 50_000, maxSamples: 3 } },
    log: () => {},
  });
  // windowMs: a sample 60s old falls outside the 50s window and is pruned
  const now = Date.now();
  engine.collector.add('win', 10, false, now - 60_000);
  engine.collector.add('win', 20, false, now);
  const { summary } = await engine.runApmCheck();
  assert.equal(summary.win.samples, 1, 'old sample pruned by configured windowMs');
  assert.equal(summary.win.p50, 20);
  // maxSamples: the buffer caps at the configured 3 even with 5 writes
  for (let i = 0; i < 5; i++) engine.collector.add('cap', i, false, now + i);
  const { summary: summ2 } = await engine.runApmCheck();
  assert.ok(summ2.cap.samples <= 3, 'samples capped by configured maxSamples');
  store.close();
});

test('engine: tls pemFile checks a local cert bundle without a socket', async (t) => {
  const { startHttpsServer } = await import('./helpers/fixtures.js');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const soon = await startHttpsServer({ days: 15 });
  const ok = await startHttpsServer({ days: 200 });
  t.after(() => Promise.all([soon.close(), ok.close()]));

  const dir = mkdtempSync(path.join(os.tmpdir(), 'apmw-pem-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const soonFile = path.join(dir, 'soon.pem');
  const okFile = path.join(dir, 'ok.pem');
  writeFileSync(soonFile, soon.cert.crtPem);
  writeFileSync(okFile, ok.cert.crtPem);

  const store = new Store(':memory:');
  const alerts = [];
  const engine = new Engine({
    store,
    config: {
      tls: [
        { name: 'bundle-soon', pemFile: soonFile, warnDaysBefore: 30 },
        { name: 'bundle-ok', pemFile: okFile, warnDaysBefore: 30 },
      ],
      notifications: { repeatIntervalSeconds: 3600, desktop: false },
    },
    log: () => {},
  });
  engine.notifyFn = async (r) => { alerts.push(r); return [{ ok: true }]; };

  await engine.tick();

  const states = store.latestStates();
  const soonState = states.find((s) => s.target === 'bundle-soon');
  const okState = states.find((s) => s.target === 'bundle-ok');
  assert.equal(soonState.status, 'warn');
  assert.match(soonState.detail, /expires in \d+d \(threshold 30d\)/);
  assert.equal(okState.status, 'ok');
  assert.ok(alerts.some((a) => a.status === 'warn' && a.target === 'bundle-soon'));
  assert.ok(!alerts.some((a) => a.target === 'bundle-ok' && a.status !== 'ok'));

  // missing file -> error state, not a crash
  const res = await engine.runTlsCheck({ name: 'missing', pemFile: path.join(dir, 'nope.pem'), timeoutMs: 750 });
  assert.equal(res.status, 'error');
  assert.match(res.detail, /ENOENT|no such file/i);
  // the resolved warn threshold stamps the tls result even on error
  assert.equal(res.warnDaysBefore, 30, 'default warnDaysBefore=30 resolves onto the failed check result');
  // the cert-fetch socket timeout stamps the tls result even on error
  assert.equal(res.timeoutMs, 750, 'configured cert-fetch timeout stamps the failed check result');
});

test('engine: per-check intervalSeconds overrides the scheduler-wide default', () => {
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    config: {
      scheduler: { httpIntervalSeconds: 120, tlsIntervalSeconds: 300 },
      http: [
        { name: 'fast', url: 'http://x/', intervalSeconds: 31 },   // uses per-check
        { name: 'plain', url: 'http://y/' },                        // falls back to scheduler
        { name: 'closed', url: 'http://z/', intervalSeconds: 5 },   // clamped up to 30
      ],
      tls: [{ name: 'cert', host: 'h', port: 443, intervalSeconds: '2m' }],
    },
    log: () => {},
  });
  const tasks = engine.buildTasks();
  const find = (id) => tasks.find((t) => t.id === id).intervalMs;
  assert.equal(find('http:fast'), 31_000);     // explicit per-check
  assert.equal(find('http:plain'), 120_000);   // scheduler-wide http default
  assert.equal(find('http:closed'), 30_000);   // clamped to MIN_INTERVAL_S
  assert.equal(find('tls:cert'), 120_000); // unit string "2m"
});

test('engine: tick persists monitor self-health (uptime/lastCheck/status)', async (t) => {
  const httpSrv = await startHttpServer({
    '/ok': { status: 200, body: 'all good' },
    '/bad': { status: 503, body: 'down' },
  });
  t.after(httpSrv.close);
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    config: {
      http: [
        { name: 'api', url: httpSrv.url + '/ok', assert: { statusCode: 200 } },
        { name: 'api2', url: httpSrv.url + '/bad', assert: { statusCode: 200 } },
      ],
      notifications: { desktop: false },
    },
    log: () => {},
  });
  await engine.tick();
  const h = store.getMeta('health');
  assert.ok(h, 'health meta persisted');
  assert.ok(Number.isFinite(h.value.uptimeSince));
  assert.ok(Number.isFinite(h.value.lastCheckAt));
  assert.ok(h.value.lastCheckAt >= h.value.uptimeSince);
  assert.equal(h.value.status, 'error'); // api2 is down -> worst status
});

test('engine: scheduler-path check runs also persist monitor self-health (not just tick)', async (t) => {
  const httpSrv = await startHttpServer({
    '/ok': { status: 200, body: 'all good' },
    '/bad': { status: 503, body: 'down' },
  });
  t.after(httpSrv.close);
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    config: {
      http: [
        { name: 'api', url: httpSrv.url + '/ok', assert: { statusCode: 200 } },
        { name: 'bad', url: httpSrv.url + '/bad', assert: { statusCode: 200 } },
      ],
      notifications: { desktop: false },
    },
    log: () => {},
  });
  // `run` drives checks through individual methods (scheduler tasks), never
  // tick; health meta must still be persisted for the web/tui/export surfaces.
  await engine.runHttpCheck({ name: 'api', url: httpSrv.url + '/ok', assert: { statusCode: 200 } });
  await engine.runHttpCheck({ name: 'bad', url: httpSrv.url + '/bad', assert: { statusCode: 200 } });
  const h = store.getMeta('health');
  assert.ok(h, 'health meta persisted from scheduler-path runs');
  assert.ok(Number.isFinite(h.value.lastCheckAt));
  assert.ok(Number.isFinite(h.value.uptimeSince));
  assert.equal(h.value.status, 'error'); // latest run (bad) is error
  assert.ok(h.value.lastCheckAt >= h.value.uptimeSince);
});
