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

test('scheduler: start() rejects a second start (running guard)', () => {
  const s = new Scheduler();
  s.start([]);
  assert.throws(() => s.start([{ id: 'x', intervalMs: 30, run: async () => {} }]), /already running/);
  s.stop();
});

test('scheduler: a task without initialDelayMs gets a staggered first run', async () => {
  // No explicit initialDelayMs → the grid staggers via `?? floor(random()*min(interval,5000))`.
  const s = new Scheduler();
  let fired = 0;
  s.start([{ id: 'no-delay', intervalMs: 40, run: async () => { fired++; } }]);
  await sleep(120); // max stagger is 39ms; plenty of margin past a first fire
  s.stop();
  assert.ok(fired >= 1, `staggered first run fired ${fired} time(s)`);
});

test('scheduler: a run finishing after stop() does not reschedule (not-running guard)', async () => {
  // stop() clears pending timers but cannot cancel an in-flight run(); the
  // post-run schedule() must then see `running === false` and skip.
  const s = new Scheduler();
  let count = 0;
  s.start([
    { id: 'in-flight', intervalMs: 20, initialDelayMs: 1, run: async () => { count++; await sleep(60); } },
  ]);
  await sleep(15); // run() now in flight, next timer not yet scheduled
  s.stop();
  const atStop = count;
  await sleep(150);
  assert.equal(count, atStop, 'no reschedule after stop while a run was in-flight');
  assert.equal(atStop, 1, 'the in-flight run still completed exactly once');
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
