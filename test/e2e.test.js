// End-to-end: full engine + store + web UI + collector against local fixtures.
// Mirrors the SPEC acceptance criteria:
//   AC1  — 200 / 404 / unresponsive targets show accurate status
//   AC2  — self-signed cert expiry countdown correct
//   AC3  — cert expiring within N days triggers an alert
//   AC4  — APM agent reports latency shown as p50/p95
//   AC5  — UI shows live status + history curves
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Engine } from '../lib/engine.js';
import { Store } from '../lib/store.js';
import { startHttpServer, startHttpsServer } from './helpers/fixtures.js';
import { ApmCollector } from '../lib/apm.js';

async function getJson(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}

test('e2e: full monitor — accurate status, cert countdown, cert alert, APM percentiles, UI curves', async (t) => {
  // AC1 fixtures: one 200, one 404, one that hangs (no response)
  const okSrv = await startHttpServer({ '/live': { status: 200, body: 'all good' } });
  const notFoundSrv = await startHttpServer({ '/missing': { status: 404, body: 'nope' } });
  const hangSrv = await startHttpServer({ '/hang': { hang: true } });
  // AC2/AC3 fixtures: cert expiring soon (15d < 30d threshold) and one far out
  const certSoon = await startHttpsServer({ days: 15 });
  const certOk = await startHttpsServer({ days: 200 });
  t.after(async () => {
    await okSrv.close();
    await notFoundSrv.close();
    await hangSrv.close();
    await certSoon.close();
    await certOk.close();
  });

  const store = new Store(':memory:');
  const alerts = [];
  const engine = new Engine({
    store,
    config: {
      http: [
        { name: 'ok-svc', url: okSrv.url + '/live', assert: { statusCode: 200, bodyIncludes: 'all good' } },
        { name: 'missing-svc', url: notFoundSrv.url + '/missing', assert: { statusCode: 404 } },
        { name: 'hang-svc', url: hangSrv.url + '/hang', timeoutMs: 300 },
      ],
      tls: [
        { name: 'cert-soon', host: '127.0.0.1', port: certSoon.port, warnDaysBefore: 30, rejectUnauthorized: false },
        { name: 'cert-ok', host: '127.0.0.1', port: certOk.port, warnDaysBefore: 30, rejectUnauthorized: false },
      ],
      apm: { collect: true, errorRateThreshold: 0.05 },
      notifications: { desktop: false, repeatIntervalSeconds: 3600 },
    },
    log: () => {},
  });
  engine.notifyFn = async (r) => { alerts.push(r); return [{ ok: true }]; };

  // AC4: feed APM spans through the collector like a demo agent would
  for (let i = 0; i < 20; i++) engine.collector.add('demo', 20 + i, i % 20 === 0);

  // one full tick, then a second so the APM state refreshes into the store
  await engine.tick();
  await engine.tick();

  // AC1: exact status for each of the three service shapes
  const states = store.latestStates();
  const by = (name, kind) => states.find((s) => s.target === name && s.kind === kind);
  assert.equal(by('ok-svc', 'http').status, 'ok');
  assert.equal(by('missing-svc', 'http').status, 'ok');  // 404 is the *expected* status
  assert.equal(by('hang-svc', 'http').status, 'error');
  assert.match(by('hang-svc', 'http').detail, /timeout/i);

  // AC2: cert countdown in days (self-signed, 15d fixture, ceil => 15)
  const soon = by('cert-soon', 'tls');
  assert.equal(soon.status, 'warn');
  assert.match(soon.detail, /expires in 15d \(threshold 30d\)/);
  assert.match(by('cert-ok', 'tls').detail, /expires in \d+d/);

  // AC3: cert-within-threshold triggered a warn alert; ok cert did not
  assert.ok(alerts.some((a) => a.status === 'warn' && a.target === 'cert-soon'), 'warn alert for cert-soon');
  assert.ok(!alerts.some((a) => a.target === 'cert-ok' && a.status !== 'ok'), 'cert-ok must not alert');
  // ...and the failing http target alerted too
  assert.ok(alerts.some((a) => a.status === 'error' && a.target === 'hang-svc'), 'error alert for hang-svc');

  // AC4: p50/p95 persisted on the apm state
  const apm = by('demo', 'apm');
  assert.ok(apm, 'apm state exists');
  assert.ok(apm.latency_ms >= apm.detail.match(/p50=(\d+)ms/)[1], 'p95 (latency_ms) >= p50');

  // AC5: UI over the same store exposes states + curves
  const { createUiServer } = await import('../lib/ui-server.js');
  const server = createUiServer(store, { ui: { historySeconds: 3600 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const data = await getJson(`http://127.0.0.1:${port}/api/states`);
  assert.ok(data.states.some((s) => s.target === 'hang-svc' && s.status === 'error'));
  assert.ok(data.states.some((s) => s.target === 'cert-soon' && s.status === 'warn'));
  // series are keyed per target; after two ticks each http target has one
  // latency point per tick (the timing-out target records its timeout too)
  const latSeries = data.series['http:latency'];
  const keys = Object.keys(latSeries);
  assert.deepEqual(keys.sort(), ['hang-svc', 'missing-svc', 'ok-svc']);
  for (const k of keys) assert.equal(latSeries[k].length, 2, `${k} has one point per tick`);
  const tlsFlat = Object.values(data.series['tls:remaining']).flat();
  assert.ok(tlsFlat.some((p) => p.value <= 15), 'tls series has the 15d point');
  assert.ok(Object.values(data.series['apm:p50']).some((pts) => pts.length >= 1));
  assert.ok(Object.values(data.series['apm:p95']).some((pts) => pts.length >= 1));

  store.close();
});

test('e2e: collector accepts agent POSTs over HTTP and computes percentiles', async (t) => {
  const server = createServer();
  const collector = new ApmCollector({});
  collector.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();

  const base = `http://127.0.0.1:${port}/apm/agent/trace`;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo', latency_ms: 100 + i, error: i === 9 }),
    });
    assert.equal(res.status, 204);
  }
  const sum = collector.summary().demo;
  assert.ok(sum);
  assert.equal(sum.samples, 10);
  assert.equal(sum.errors, 1);
  assert.equal(sum.p50, 104);   // ceil(50% of 10) -> index 4 -> value 104
  assert.equal(sum.p95, 109);   // ceil(95% of 10) -> index 9 -> value 109
  // 10% error rate below a 5% threshold would be warn — verify computation here
  assert.equal(sum.errorRate, 0.1);
});
