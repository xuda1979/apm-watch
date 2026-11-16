// Scheduler: runs each check config on its own interval grid (30s..5m),
// non-overlapping (a slow check delays its next run rather than re-entering).

export const MIN_INTERVAL_S = 30;
export const MAX_INTERVAL_S = 300;

export class Scheduler {
  constructor({ now = Date.now, log = null } = {}) {
    this.now = now;
    this.log = log;
    this.timers = new Set();
    this.running = false;
  }

  /**
   * tasks: [{ id, intervalMs, run: async () => void, initialDelayMs }]
   * Each task self-reschedules after its run completes.
   */
  start(tasks) {
    if (this.running) throw new Error('scheduler already running');
    this.running = true;
    const self = this;
    for (const task of tasks) {
      const schedule = (delayMs) => {
        if (!self.running) return;
        const handle = setTimeout(async () => {
          self.timers.delete(handle);
          try {
            await task.run();
          } catch (err) {
            self.log?.('task ' + task.id + ' error: ' + (err?.message || err));
          }
          schedule(task.intervalMs);
        }, delayMs);
        // keep timer unref'd so the process can still exit naturally
        if (handle.unref) handle.unref();
        self.timers.add(handle);
      };
      // Stagger the very first run so all checks don't fire at once.
      schedule(task.initialDelayMs ?? Math.floor(Math.random() * Math.min(task.intervalMs, 5000)));
    }
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
