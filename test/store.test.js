import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';

test('store: saveState + latestStates + history', () => {
  const s = new Store(':memory:');
  let now = 1000;
  s.setClock(() => now);
  s.saveState({ target: 'a', kind: 'http', status: 'ok', latencyMs: 5, detail: 'x' });
  now += 1000;
  s.saveState({ target: 'a', kind: 'http', status: 'error', latencyMs: null, detail: 'boom' });
  const latest = s.latestStates();
  assert.equal(latest.length, 1);
  assert.equal(latest[0].status, 'error');
  const hist = s.history('a', 'http', 500);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].status, 'ok');
  s.close();
});

test('store: metrics series + retention', () => {
  const s = new Store(':memory:');
  let now = 1000;
  s.setClock(() => now);
  s.saveMetric('http:x/latency', 10);
  now += 500;
  s.saveMetric('http:x/latency', 20);
  const series = s.series('http:x/latency', 0);
  assert.equal(series.length, 2);
  assert.equal(series[0].value, 10);
  const pruned = s.pruneMetrics(1500);
  assert.ok(pruned >= 0);
  const series2 = s.series('http:x/latency', 0);
  assert.ok(series2.length <= 2);
  s.close();
});

test('store: metrics series returns the latest points within the window', () => {
  const s = new Store(':memory:');
  for (let i = 0; i < 500; i++) s.saveMetric('http:x/latency', i, 1000 + i);
  const series = s.series('http:x/latency', 0, 400);
  assert.equal(series.length, 400);
  // newest 400 of 500 -> values 100..499, ascending ts
  assert.equal(series[0].value, 100);
  assert.equal(series[series.length - 1].value, 499);
  assert.ok(series[0].ts < series[series.length - 1].ts, 'ascending ts for plotting');
  s.close();
});

test('store: events + recent', () => {
  const s = new Store(':memory:');
  s.addEvent('warn', 'http', 'x');
  s.addEvent('error', 'tls', 'y expired');
  const ev = s.recentEvents(10);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].level, 'error');
  s.close();
});

test('store: setMeta/getMeta persist json or plain strings per key', () => {
  const s = new Store(':memory:');
  assert.equal(s.getMeta('nope'), null);
  s.setMeta('health', { status: 'warn', uptimeSince: 5, lastCheckAt: 9 });
  s.setMeta('note', 'hello');
  const health = s.getMeta('health');
  assert.deepEqual(health.value, { status: 'warn', uptimeSince: 5, lastCheckAt: 9 });
  assert.ok(Number.isFinite(health.ts));
  assert.equal(s.getMeta('note').value, 'hello');
  // overwrite replaces the previous value
  s.setMeta('health', { status: 'ok' });
  assert.equal(s.getMeta('health').value.status, 'ok');
  s.close();
});
