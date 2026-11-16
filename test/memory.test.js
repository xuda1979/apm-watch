// 24h simulation: run checks in an accelerated loop and assert RSS stays under 200MB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { Engine } from '../lib/engine.js';
import { startHttpServer, startHttpsServer } from './helpers/fixtures.js';

function rss() { return process.memoryUsage().rss; }

async function simulate24h({ httpTargets = 5, tlsTargets = 3 } = {}) {
  const srvs = await Promise.all(
    Array.from({ length: httpTargets }, (_, i) => startHttpServer({ [`/t${i}`]: { status: 200, body: `ok${i}` } })),
  );
  const tlsSrvs = await Promise.all([
    startHttpsServer({ days: 60 }),
    startHttpsServer({ days: 12 }),
    startHttpsServer({ days: 400 }),
  ]);

  const store = new Store(process.env.APMW_TEST_DB || ':memory:');
  store.setClock(() => { /* fast-forward: fake clock is advanced per loop below */ });

  const config = {
    http: srvs.map((s, i) => ({ name: `api${i}`, url: (s => s.url + `/t${i}`)(s), assert: { statusCode: 200, bodyIncludes: `ok${i}` } })),
    tls: tlsSrvs.map((s, i) => ({ name: `cert${i}`, host: '127.0.0.1', port: s.port, warnDaysBefore: 30 })),
    apm: { collect: true, errorRateThreshold: 0.05 },
    notifications: { desktop: false },
  };
  const engine = new Engine({ store, config, log: () => {} });

  // Simulate clock drift: each iteration = 10 min of wall time; run count = 144*~= 1 day across 6 weeks...
  let now = Date.now();
  const ITERATIONS = 620;          // each iteration == ~3.7 min of check history
  const fakeNow = () => now;
  for (let i = 0; i < ITERATIONS; i++) {
    store.setClock(fakeNow);
    now += 30_000;                 // 30s of simulated time per iteration
    if (i % 2 === 0) await engine.runHttpCheck(config.http[i % config.http.length]);
    if (i % 5 === 0) {
      for (const t of config.tls) await engine.runTlsCheck(t);
    }
    engine.collector.add('svc', 20 + (i % 50), i % 50 === 0, now);
    await engine.runApmCheck();
    if (i % 50 === 0) { await Promise.all([store.pruneMetrics(now - 86400e3), store.pruneStates(now - 86400e3)]); }
  }

  const mem = rss();
  for (const s of srvs) await s.close();
  for (const t of tlsSrvs) await t.close();
  store.close();
  return mem;
}

test('memory: accelerated 24h simulation stays under 200MB RSS', { timeout: 120000 }, async () => {
  // ensure baseline warmed
  await new Promise((resolve) => setTimeout(resolve, 10));
  const mem = await simulate24h();
  const MB = mem / 1024 / 1024;
  console.log(`\n  [memory] 24h-sim RSS: ${MB.toFixed(1)} MB, heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`);
  assert.ok(MB < 200, `RSS ${MB.toFixed(1)}MB exceeded 200MB budget`);
});
