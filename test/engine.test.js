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

  // alerts: soon is warn, okcert is ok, api is ok, api2 is error -> 2 alerts
  assert.ok(alerts.length >= 2);
  const warnAlerts = alerts.filter((a) => a.status === 'warn' && a.target === 'soon');
  const errAlerts = alerts.filter((a) => a.status === 'error');
  assert.ok(warnAlerts.length >= 1);
  assert.ok(errAlerts.length >= 1);

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

  // timeout target
  const hangSrv = await startHttpServer({ '/x': { hang: true } });
  t.after(hangSrv.close);
  const res = await engine.runHttpCheck({ name: 'hang', url: hangSrv.url + '/x', timeoutMs: 300 });
  assert.equal(res.status, 'error');
});

test('engine: apm slow p95 latency flips status to warn below error threshold', async () => {
  const store = new Store(':memory:');
  const engine = new Engine({
    store,
    config: { apm: { collect: true, errorRateThreshold: 0.5, latencyThresholdMs: 100 } },
    log: () => {},
  });
  // 10 spans, 1 error (10% < 50% threshold) but p95 well above 100ms
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    engine.collector.add('slow', 200 + i, i === 0, now + i);
  }
  const slow = await engine.runApmCheck();
  assert.equal(slow.slow.p95 >= 100, true);

  // fast service: p95 under latency threshold, low errors -> ok
  for (let i = 0; i < 10; i++) {
    engine.collector.add('fast', 5, false, now + i);
  }
  await engine.runApmCheck();
  const states = store.latestStates();
  assert.equal(states.find((s) => s.target === 'slow').status, 'warn');
  assert.equal(states.find((s) => s.target === 'fast').status, 'ok');
});
