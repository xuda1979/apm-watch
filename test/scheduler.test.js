import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, MIN_INTERVAL_S, MAX_INTERVAL_S } from '../lib/scheduler.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('scheduler: runs a task periodically and stops cleanly', async () => {
  const s = new Scheduler();
  let count = 0;
  s.start([
    { id: 'x', intervalMs: 30, initialDelayMs: 1, run: async () => { count++; } },
  ]);
  await sleep(120);
  s.stop();
  assert.ok(count >= 2, `ran ${count} times`);
});

test('scheduler: does not re-enter a still-running task (no overlap)', async () => {
  const s = new Scheduler();
  const running = [];
  let startCount = 0;
  s.start([
    {
      id: 'slow',
      intervalMs: 40,
      initialDelayMs: 1,
      run: async () => {
        startCount++;
        running.push(1);
        assert.equal(running.length, 1, 'overlap detected');
        await sleep(60);
        running.pop();
      },
    },
  ]);
  await sleep(190);
  s.stop();
  assert.ok(startCount >= 2);
  assert.equal(running.length, 0);
});

test('scheduler: grid bounds', () => {
  assert.equal(MIN_INTERVAL_S, 30);
  assert.equal(MAX_INTERVAL_S, 300);
});
