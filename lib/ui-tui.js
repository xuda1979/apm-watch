// TUI: terminal dashboard refreshing every few seconds. Pure ASCII, no deps.

import { availability } from './availability.js';

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
    this.started = false;
  }

  start() {
    this.started = true;
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
    // Only hard-exit when the TUI owns the process (started). When used
    // programmatically (tests) the caller decides how to tear down.
    if (this.started) process.exit(0);
  }

  render() {
    const lines = [];
    const h = this.store.getMeta?.('health')?.value;
    if (h?.lastCheckAt) {
      const when = (ms) => new Date(ms).toLocaleTimeString();
      lines.push(CLR.cyan + 'apm-watch  up ' + fmtAgo(h.uptimeSince) +
        `  ·  last check ${when(h.lastCheckAt)}` +
        `  ·  monitor ${h.status || 'unknown'}` + CLR.reset);
    } else {
      lines.push(CLR.cyan + 'apm-watch' + '─'.repeat(44) + CLR.reset);
    }
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
      const avail = http ? availability(this.store.history(target, 'http', Date.now() - 3600e3), Date.now()) : null;
      const up = avail && avail.pct != null ? ` ${avail.pct}%` : '';
      lines.push(
        `  ${colorStatus(worst)} ${target}  ` +
        (http ? `http:${http.status}:${http.latency_ms != null ? http.latency_ms.toFixed(0) + 'ms' : '—'}${up}` : '') +
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
    // apm p50/p95 latency + error-rate history per apm target (web UI parity)
    const apmNames = [...new Set(states.filter((s) => s.kind === 'apm').map((s) => s.target))];
    if (apmNames.length) {
      lines.push(CLR.cyan + '  ── apm history ──' + CLR.reset);
      for (const n of apmNames.slice(0, 5)) {
        const p50 = this.store.series(`apm:${n}/p50`, Date.now() - 3600e3, 30);
        const p95 = this.store.series(`apm:${n}/p95`, Date.now() - 3600e3, 30);
        const err = this.store.series(`apm:${n}/errorRate`, Date.now() - 3600e3, 30);
        const last = (arr) => (arr.length ? Math.round(arr[arr.length - 1].value) : '—');
        lines.push(`  ${n}: p50 ${last(p50)}ms  p95 ${last(p95)}ms  ${spark(p95.map((p) => p.value))}`);
        if (err.length) {
          lines.push(`    err ${(err[err.length - 1].value * 100).toFixed(1)}%  ${spark(err.map((p) => p.value))}`);
        }
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

function fmtAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const h = Math.floor(min / 60);
  return h + 'h ' + (min % 60) + 'm ago';
}

function spark(vals) {
  if (!vals.length) return '—';
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const glyphs = '▁▂▃▄▅▆▇█';
  return vals.map((v) => glyphs[Math.min(7, Math.max(0, Math.floor(((v - min) / range) * 8)))]).join('');
}
