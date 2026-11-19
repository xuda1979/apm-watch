import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, configSeconds, toDays, retentionDays } from '../lib/engine.js';
import { Store } from '../lib/store.js';
import { startHttpServer, startHttpsServer, freePort } from './helpers/fixtures.js';

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

  // error-rate-driven warn: rate above threshold with fine latency must be
  // labelled as *why* on the detail, mirroring the (slow p95) latency marker
  // (every human surface renders this detail verbatim)
  for (let i = 0; i < 10; i++) {
    engine.collector.add('errful', 5, true, now + i);
  }
  const { results: errResults } = await engine.runApmCheck();
  const errRes = errResults.find((r) => r.target === 'errful');
  assert.equal(errRes.status, 'warn');
  assert.equal(errRes.errorRate, 1, '10/10 error samples');
  assert.equal(errRes.errorRateThreshold, 0.5);
  assert.match(errRes.detail, /\(err rate 100% >= 50%\)/, 'rate cause surfaces on the detail like (slow p95) does for latency');
  assert.doesNotMatch(errRes.detail, /slow p95/, 'a rate-only warn must not claim a latency cause');
  assert.equal(errRes.latencyMs, 5, 'fast p95 keeps the row numerically healthy');
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

test('engine: deliverAlert recovered path records an info event and RECOVERED-detail notification', async () => {
  const store = new Store(':memory:');
  const notified = [];
  const engine = new Engine({ store, config: {}, log: () => {} });
  engine.notifyFn = async (r) => { notified.push(r); return [{ ok: true }]; };

  const res = await engine.deliverAlert({ status: 'ok', kind: 'http', target: 'svc', detail: 'latency back in range' });
  assert.deepEqual(res, [{ ok: true }]);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].detail, 'RECOVERED: latency back in range');
  assert.equal(notified[0].status, 'ok');
  const events = store.recentEvents();
  assert.equal(events[0].level, 'info');
  assert.equal(events[0].source, 'http');
  assert.equal(events[0].message, 'svc: recovered');
  store.close();
});

test('engine: _defaultNotify dispatches every configured channel (desktop/webhook/email) and logs channel failures', async (t) => {
  // real channels: notify-send spawn, a live local webhook listener, and an
  // SMTP client aimed at a port that refuses connections (CAUGHT by the engine)
  const hook = await startHttpServer({ '/hook': { status: 200, body: 'ok' } });
  t.after(hook.close);
  const refused = await freePort(); // nothing listens here -> ECONNREFUSED

  const logLines = [];
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    config: {
      notifications: {
        desktop: true, // real notify-send spawn (exits 0 in CI sandbox)
        webhook: { url: hook.url + '/hook' },
        email: { host: '127.0.0.1', port: refused, from: 'a@b.c', to: 'd@e.f', subject: 'x', connectTimeoutMs: 2000 },
      },
    },
    log: (m) => logLines.push(m),
  });

  const results = await engine._defaultNotify({ kind: 'tls', target: 'cert.example', status: 'error', detail: 'cert expired' });
  // desktop result is collected into the results array (real notify-send spawn)
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, 'notify-send exits 0 in the sandbox -> ok result entry');
  // the refused SMTP connection surfaces as a caught + logged failure, never a throw
  assert.ok(logLines.some((m) => m.includes('notify email failed')), `email failure logged: ${JSON.stringify(logLines)}`);
  assert.ok(!logLines.some((m) => m.includes('notify webhook failed')), '200 webhook must not log a failure');
  assert.ok(!logLines.some((m) => m.includes('notify desktop failed')), 'clean desktop spawn must not log a failure');
  store.close();
});

test('engine: _defaultNotify skips unconfigured channels and logs a failing webhook response', async (t) => {
  const hook = await startHttpServer({ '/hook': { status: 500, body: 'nope' } }); // non-2xx -> webhook { ok:false }
  t.after(hook.close);
  const logLines = [];
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    config: {
      notifications: {
        desktop: false,                       // skipped -> no desktop result entry
        webhook: { url: hook.url + '/hook' }, // configured; /hook answers 500
        email: {},                            // no host -> silently skipped
      },
    },
    log: (m) => logLines.push(m),
  });
  const results = await engine._defaultNotify({ kind: 'http', target: 'api', status: 'warn', detail: 'slow p95' });
  assert.deepEqual(results, [], 'no desktop channel -> empty results');
  assert.ok(logLines.some((m) => m.includes('notify webhook failed')), `webhook 500 logged: ${JSON.stringify(logLines)}`);
  assert.ok(!logLines.some((m) => m.includes('notify email failed')), 'unconfigured email stays silent');
  store.close();
});

test('engine: store:prune task body deletes rows older than configured retention', async () => {
  const store = new Store(':memory:');
  // the prune cutoff is real Date.now()-based (engine.js run body), so seed
  // rows relative to real wall-clock time
  const now = Date.now();
  const engine = new Engine({ store, config: { store: { retentionDays: 2 } }, log: () => {} });
  // seed fresh + stale rows (the engine normally writes these via saveState/events/metrics)
  for (const ts of [now - 3 * 86400e3, now - 86400e3]) {
    store.db.prepare('INSERT INTO states (ts, target, kind, status) VALUES (?,?,?,?)').run(ts, 'svc', 'http', 'ok');
    store.db.prepare('INSERT INTO metrics (ts, key, value) VALUES (?,?,?)').run(ts, 'http:svc/p50', 10);
    store.db.prepare('INSERT INTO events (ts, level, source, message) VALUES (?,?,?,?)').run(ts, 'info', 'http', 'check ok');
  }
  const prune = engine.buildTasks().find((t) => t.id === 'store:prune');
  assert.ok(prune, 'store:prune task present');
  await prune.run();
  const states = store.db.prepare('SELECT * FROM states').all();
  const metrics = store.db.prepare('SELECT * FROM metrics').all();
  const events = store.db.prepare('SELECT * FROM events').all();
  assert.equal(states.length, 1, 'stale (3d old) state pruned against 2d retention');
  assert.equal(states[0].ts, now - 86400e3, 'fresh state survives');
  assert.equal(metrics.length, 1);
  assert.equal(events.length, 1);
  store.close();
});

test('engine: configSeconds and retentionDays/toDays poison inputs fall back to sane values', () => {
  assert.equal(configSeconds(true), null);       // non-number/non-string -> null (line 346)
  assert.equal(configSeconds('5x'), Number.NaN); // malformed unit string -> NaN
  assert.equal(configSeconds('1.5h'), 5400);
  assert.equal(configSeconds(90), 90);
  assert.equal(configSeconds('5'), 5, 'bare number string defaults to seconds (unit || "s")');
  assert.equal(toDays('5'), 5, 'bare number string defaults to days (unit || "d")');
  assert.equal(retentionDays({ retentionDays: [] }), 7, 'non-numeric retention falls back to the 7d default'); // toDays NaN -> 7
  assert.equal(retentionDays({ retentionDays: '48h' }), 2);
  assert.equal(retentionDays({ retentionDays: '1w' }), 7);
  assert.equal(retentionDays({}), 7);
  assert.equal(toDays(-1), -1, 'raw toDays passes negatives through (caller guards)');
});

test('engine: maybeAlert 按 repeatIntervalSeconds 去重，状态变化/freshen/恢复按文档放行', async () => {
  const store = new Store(':memory:');
  // 1 秒去重窗口:引擎用真的 Date.now() 判定 freshen,所以窗口越过靠真实
  // 时间推进(唯一一处不能靠 store clock 注入的时序)
  const engine = new Engine({ store, config: { notifications: { repeatIntervalSeconds: 1 } }, log: () => {} });
  const r = (status) => ({ kind: 'http', target: 'svc', status, detail: `d:${status}` });

  const first = engine.maybeAlert(r('warn'));
  assert.equal(first.send, true, '首次 warn 立即发送');
  assert.equal(engine.alertState.get('http:svc').count, 1, '首次告警 count 计数为 1');

  assert.equal(engine.maybeAlert(r('warn')).send, false, 'repeat 窗口内相同状态被去重抑制');
  assert.equal(engine.maybeAlert(r('warn')).send, false, '窗口内连续重复 warn 持续抑制');
  assert.equal(engine.alertState.get('http:svc').count, 3, '被抑制的告警仍然累计 count(暴露频率)');

  assert.equal(engine.maybeAlert(r('error')).send, true, '状态升级 warn->error 立即重新发送');
  assert.equal(engine.maybeAlert(r('error')).send, false, '窗口内重复 error 也被抑制');
  assert.equal(engine.alertState.get('http:svc').status, 'error');

  // freshen:越过 repeat 窗口后相同状态重新发送
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(engine.maybeAlert(r('error')).send, true, '越过 repeatIntervalSeconds 后同状态重新发送');

  // 从错误状态恢复为 ok:发送恢复告警并把 count 清零
  const rec = engine.maybeAlert(r('ok'));
  assert.equal(rec.send, true, 'error->ok 恢复时发送 RECOVERED 告警');
  assert.equal(rec.status, 'ok');
  assert.equal(engine.alertState.get('http:svc').count, 0, '恢复后 count 归零');
  assert.equal(engine.maybeAlert(r('ok')).send, false, 'ok 状态不重复告警');
  store.close();
});

test('engine: 无默认参数构造回退到内存 store 与空 config', () => {
  // config falsy -> this.config || {};store falsy -> new Store(':memory:')
  const engine = new Engine({ log: () => {} });
  assert.deepEqual(engine.config, {}, '不传 config 时回退为空对象');
  assert.ok(engine.store, '不传 store 时自动创建默认内存 store');
  assert.equal(engine.alertState.size, 0, '空 config 不会凭空产生告警状态');
  // 未记录任何健康检查时 persistHealth 回退 status 为 ok(health.status || "ok")
  engine.persistHealth();
  assert.equal(engine.store.getMeta('health').value.status, 'ok', '无检查记录时自健康状态回退 ok');
  engine.store.close();
});

test('engine: 未命名 tls pemFile 检查从文件路径派生 target', async (t) => {
  const { startHttpsServer } = await import('./helpers/fixtures.js');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const ok = await startHttpsServer({ days: 200 });
  t.after(ok.close);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apmw-pem-noname-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const okFile = path.join(dir, 'ok.pem');
  writeFileSync(okFile, ok.cert.crtPem);

  const store = new Store(':memory:');
  const engine = new Engine({ store, config: {}, log: () => {} });
  // 只给 pemFile 不给 name:target 派生走 cfg.name || (cfg.pemFile ? ...)
  const res = await engine.runTlsCheck({ pemFile: okFile });
  assert.equal(res.status, 'ok');
  assert.equal(res.target, okFile, '未命名 pemFile 检查以文件路径为 target');
  assert.ok(res.chain.length >= 1, '本地 bundle 仍解析出证书链');
  store.close();
});
