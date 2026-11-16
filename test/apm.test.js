import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApmCollector } from '../lib/apm.js';
import { extentPercentiles } from '../lib/stats.js';
import { startDemoAgent } from '../lib/demo-agent.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('apm: percentiles computed correctly', () => {
  const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const [p50, p95] = extentPercentiles(vals, [50, 95]);
  assert.equal(p50, 50);
  assert.equal(p95, 100);
  assert.deepEqual(extentPercentiles([], [50]), [null]);
});

test('apm: collector tracks error rate and prunes window', () => {
  let now = 1_000_000;
  const c = new ApmCollector({ windowMs: 1000, now: () => now });
  for (let i = 0; i < 100; i++) {
    c.add('svc', 10 + i, i % 10 === 0, now + i);
  }
  now += 100; // advance within window
  const sum = c.summary();
  assert.ok(sum.svc, 'svc present after summary');
  assert.equal(sum.svc.samples, 100);
  assert.equal(sum.svc.errors, 10);
  assert.ok(sum.svc.p50 >= 10 && sum.svc.p50 <= 110);
  // age out everything
  now += 5000;
  c.summary();
  assert.equal(c.samples.get('svc')?.length ?? 0, 0);
});

test('apm: span POST accepted by collector-attached server', async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer();
  const c = new ApmCollector({});
  c.attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/apm/agent/trace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'demo', latency_ms: 42, error: false }),
  });
  assert.equal(res.status, 204);
  const sum = c.summary();
  assert.ok(sum.demo);
  assert.equal(sum.demo.p50, 42);
});

test('apm: demo agent posts spans', async (t) => {
  const { createServer } = await import('node:http');
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => { received.push(JSON.parse(raw)); res.writeHead(204).end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const agent = startDemoAgent({
    target: `http://127.0.0.1:${server.address().port}/apm/agent/trace`,
    intervalMs: 30,
    baseLatencyMs: 10,
    jitterMs: 5,
    log: () => {},
  });
  await sleep(250);
  agent.stop();
  assert.ok(received.length >= 3, `received ${received.length}`);
  assert.ok(received.every((r) => r.latency_ms > 0 && typeof r.error === 'boolean'));
  assert.ok(received.some((r) => r.name === 'demo'));
});
