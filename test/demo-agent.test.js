import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDemoAgent } from '../lib/demo-agent.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('demo-agent: fetch rejection logs a curated failure line', async () => {
  const logs = [];
  const agent = startDemoAgent({
    target: 'http://127.0.0.1:1/unreachable',
    intervalMs: 30,
    fetchFn: async () => { throw new Error('boom'); },
    log: (l) => logs.push(l),
  });
  await sleep(120);
  agent.stop();
  await sleep(120); // let any in-flight post settle
  assert.ok(logs.some((l) => l === 'agent post failed: boom'), `logs=${JSON.stringify(logs)}`);
  assert.ok(logs.length >= 2, `logs=${JSON.stringify(logs)}`);
});

test('demo-agent: error span logs the ERR suffix via a truthy res.ok', async () => {
  const logs = [];
  const agent = startDemoAgent({
    target: 'http://127.0.0.1:1/unreachable',
    intervalMs: 30,
    errorRate: 1,
    fetchFn: async () => ({ ok: true }),
    log: (l) => logs.push(l),
  });
  await sleep(120);
  agent.stop();
  await sleep(120);
  assert.ok(logs.length >= 2, `logs=${JSON.stringify(logs)}`);
  assert.ok(logs.every((l) => l.includes(' ERR')), `logs=${JSON.stringify(logs)}`);
});

test('demo-agent: non-ok response is silent (no span log)', async () => {
  const logs = [];
  const agent = startDemoAgent({
    target: 'http://127.0.0.1:1/unreachable',
    intervalMs: 30,
    fetchFn: async () => ({ ok: false, status: 500 }),
    log: (l) => logs.push(l),
  });
  await sleep(120);
  agent.stop();
  await sleep(120);
  assert.deepEqual(logs, []);
});

test('demo-agent: omitted log falls back to console.log without throwing', async () => {
  const agent = startDemoAgent({
    target: 'http://127.0.0.1:1/unreachable',
    intervalMs: 30,
    fetchFn: async () => { throw new Error('boom'); },
  });
  await sleep(120);
  agent.stop();
  await sleep(120);
  assert.ok(agent && typeof agent.stop === 'function', 'agent start/stop with default logging');
});
