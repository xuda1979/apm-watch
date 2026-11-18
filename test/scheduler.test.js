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

test('scheduler: a throwing task logs one `task <id> error:` line and the loop survives', async () => {
  // Run-mode crash-resistance parity (web 9d5bee7 / TUI 8d9e9e1 / export 069ce55):
  // the task-guard catches a throwing task.run() so no raw uncaught-exception
  // stack can kill the long-running monitor, the guard logs one clean line, and
  // the failure does not stop the scheduler from running sibling tasks.
  const logs = [];
  const s = new Scheduler({ log: (m) => logs.push(m) });
  let good = 0;
  s.start([
    { id: 'boom', intervalMs: 30, initialDelayMs: 1, run: async () => { throw new Error('kaboom'); } },
    { id: 'ok', intervalMs: 30, initialDelayMs: 2, run: async () => { good++; } },
  ]);
  await sleep(120);
  s.stop();
  assert.ok(logs.length >= 1, `throwing task was guarded and logged, got: ${JSON.stringify(logs)}`);
  assert.match(logs[0], /^task boom error: kaboom$/, 'guard emits one clean `task <id> error:` line (no raw stack)');
  assert.ok(good >= 2, `sibling task kept running ${good} times after the throw`);
});
