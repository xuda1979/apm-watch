// TUI: terminal dashboard refreshing every few seconds. Pure ASCII, no deps.

const CLR = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m' };

function colorStatus(s) {
  if (s === 'ok') return CLR.green + 'ok  ' + CLR.reset;
  if (s === 'warn') return CLR.yellow + 'warn' + CLR.reset;
  if (s === 'error') return CLR.red + 'err ' + CLR.reset;
  return '?';
}

export class Tui {
  constructor({ store, intervalMs = 2000, onExit = null } = {}) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.onExit = onExit;
    this.timer = null;
    this.cleared = false;
  }

  start() {
    process.stdout.write('\x1b[2J\x1b[?25l'); // clear + hide cursor
    this.render();
    this.timer = setInterval(() => this.render(), this.intervalMs);
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  stop() {
    if (this.cleared) return;
    this.cleared = true;
    if (this.timer) clearInterval(this.timer);
    process.stdout.write('\x1b[?25h' + CLR.reset); // show cursor
    this.onExit?.();
    process.exit(0);
  }

  render() {
    const lines = [];
    lines.push(CLR.cyan + 'apm-watch ' + '─'.repeat(40) + CLR.reset);
    let states;
    try { states = this.store.latestStates(50); } catch { states = []; }
    // group by target
    const byTarget = new Map();
    for (const s of states) {
      if (!byTarget.has(s.target)) byTarget.set(s.target, []);
      byTarget.get(s.target).push(s);
    }
    if (!byTarget.size) {
      lines.push(CLR.dim + '  (no checks yet — waiting for first run)' + CLR.reset);
    }
    for (const [target, rows] of byTarget) {
      const http = rows.find((r) => r.kind === 'http');
      const tls = rows.find((r) => r.kind === 'tls');
      const apm = rows.find((r) => r.kind === 'apm');
      const kinds = [http, tls, apm].filter(Boolean);
      const worst = kinds.length ? kinds.map((k) => k.status).sort((a, b) => weight(b) - weight(a))[0] : 'unknown';
      lines.push(
        `  ${colorStatus(worst)} ${target}  ` +
        (http ? `http:${http.status}:${http.latency_ms != null ? http.latency_ms.toFixed(0) + 'ms' : '—'}` : '') +
        (tls ? `  cert:${tls.detail}` : '') +
        (apm ? `  apm:${apm.detail}` : ''),
      );
    }
    // history sparkline per http target
    const httpTargets = [...new Set(states.filter((s) => s.kind === 'http').map((s) => s.target))];
    if (httpTargets.length) {
      lines.push(CLR.cyan + '  ── latency history ──' + CLR.reset);
      for (const t of httpTargets.slice(0, 5)) {
        const pts = this.store.series(`http:${t}/latency`, Date.now() - 3600e3, 30);
        lines.push(`  ${t}: ${spark(pts.map((p) => p.value))}`);
      }
    }
    // recent alert/audit events
    let events = [];
    try { events = this.store.recentEvents(5); } catch { events = []; }
    if (events.length) {
      lines.push(CLR.cyan + '  ── recent events ──' + CLR.reset);
      for (const e of events) {
        const lvl = e.level === 'error' ? CLR.red : e.level === 'warn' ? CLR.yellow : CLR.dim;
        lines.push(`  ${lvl}${e.level.padEnd(5)}${CLR.reset} ${new Date(e.ts).toLocaleTimeString()} ${e.source}: ${e.message}`);
      }
    }
    process.stdout.write('\x1b[H\x1b[2J' + lines.join('\n') + '\n');
  }
}

function weight(s) { return s === 'error' ? 2 : s === 'warn' ? 1 : 0; }

function spark(vals) {
  if (!vals.length) return '—';
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const glyphs = '▁▂▃▄▅▆▇█';
  return vals.map((v) => glyphs[Math.min(7, Math.max(0, Math.floor(((v - min) / range) * 8)))]).join('');
}
