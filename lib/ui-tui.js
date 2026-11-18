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
  constructor({ store, intervalMs = 2000, onExit = null, historyMs = 3600e3, latencyThresholds = {}, tlsWarnDaysBefore = {}, apmLatencyThresholdMs = null, apmErrorRateThreshold = null, httpAssertStatusCodes = {}, httpAssertBodyIncludes = {}, httpTimeoutMs = {}, tlsTimeoutMs = {}, tlsPort = {}, httpIntervalSeconds = {}, tlsIntervalSeconds = {}, apmIntervalSeconds = null, apmWindowMs = null, apmMaxSamples = null, retentionDays = null, historySeconds = null, notifications = null, version = null } = {}) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.historyMs = historyMs;
    this.latencyThresholds = latencyThresholds;
    this.tlsWarnDaysBefore = tlsWarnDaysBefore;
    this.apmLatencyThresholdMs = apmLatencyThresholdMs;
    this.apmErrorRateThreshold = apmErrorRateThreshold;
    this.httpAssertStatusCodes = httpAssertStatusCodes;
    this.httpAssertBodyIncludes = httpAssertBodyIncludes;
    this.httpTimeoutMs = httpTimeoutMs;
    this.tlsTimeoutMs = tlsTimeoutMs;
    this.tlsPort = tlsPort;
    this.httpIntervalSeconds = httpIntervalSeconds;
    this.tlsIntervalSeconds = tlsIntervalSeconds;
    this.apmIntervalSeconds = apmIntervalSeconds;
    this.apmWindowMs = apmWindowMs;
    this.apmMaxSamples = apmMaxSamples;
    this.retentionDays = retentionDays;
    this.historySeconds = historySeconds;
    this.notifications = notifications;
    // the product version rides the header line like every other face (export
    // page `apm-watch vX.Y.Z`, once report header, web PAGE h1, inc 95 parity):
    // threaded from the CLI's VERSION const, null-gated for bare programmatic
    // Tui.
    this.version = version;
    this.onExit = onExit;
    this.timer = null;
    this.cleared = false;
    this.started = false;
  }

  // Current parked-store snapshot for the header counts (inc 79 parity): the
  // same latestStates feed the row renderer uses, plus the ok/warn/error/
  // unknown status distribution — the web pillbox / export summary / once
  // report aggregates, recomputed for this face.
  snapshotStates(limit = 50) {
    let states = [];
    try { states = this.store.latestStates(limit); } catch { states = []; }
    const counts = { ok: 0, warn: 0, error: 0, unknown: 0 };
    for (const s of states) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return { states, counts };
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
      const st = this.snapshotStates();
      lines.push(CLR.cyan + 'apm-watch' + (this.version ? ' v' + this.version : '') + '  up ' + fmtAgo(h.uptimeSince) +
        `  ·  last check ${when(h.lastCheckAt)}` +
        `  ·  monitor ${h.status || 'unknown'}` +
        // snapshot status-count summary rides the header like the web pillbox,
        // export page pills / JSON summary and once report (inc 79 parity):
        // `ok N warn N err N` of the current parked snapshot.
        `  ·  ok ${st.counts.ok} warn ${st.counts.warn} err ${st.counts.error}` +
        // the store retention window rides the header like every other face
        // (web meta `keep Nd`, export page `keep Nd`, once report `keep Nd`,
        // inc 83): config-global, threaded from the engine's canonical
        // retentionDays resolver; null-gated for bare programmatic Tui.
        (this.retentionDays != null ? `  ·  keep ${this.retentionDays}d` : '') +
        // the availability/series history window the uptime pct + sparklines
        // aggregate over rides the header like every other face (web meta /
        // export page / once report, inc 89 parity): config-global, threaded
        // from the engine's canonical uiHistorySeconds resolver; null-gated
        // for bare programmatic Tui.
        (this.historySeconds != null ? '  ·  history ' + fmtInterval(this.historySeconds) : '') +
        // the notification channel-state rides the header like every other face
        // (once --json / web /api/states / export JSON `notifications` block,
        // inc 88 parity): repeat-interval + resolved per-channel gate flags
        // threaded from the same config resolvers the JSON faces carry, so the
        // terminal operator sees which alert channels are armed and how often
        // dedup resets. null-gated like the JSON null-gating — a bare Tui stays
        // without it.
        (this.notifications ? '  ·  notif ' +
          (this.notifications.desktop ? 'desktop' : '') +
          (this.notifications.webhook ? ' webhook' : '') +
          (this.notifications.email ? ' email' : '') +
          (this.notifications.repeatIntervalSeconds != null ? ' repeat ' + fmtInterval(this.notifications.repeatIntervalSeconds) : '')
          : '') + CLR.reset);
    } else {
      lines.push(CLR.cyan + 'apm-watch' + (this.version ? ' v' + this.version : '') + '─'.repeat(44) + CLR.reset);
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
      const avail = http ? availability(this.store.history(target, 'http', Date.now() - this.historyMs), Date.now()) : null;
      const up = avail && avail.pct != null
        ? ` ${avail.pct}%${avail.totalMs > 0 ? ` (down ${fmtInterval(avail.downMs / 1000)})` : ''}${avail.samples != null ? ` (over ${avail.samples} sample${avail.samples === 1 ? '' : 's'})` : ''}`
        : '';
      const verb = http?.method ? http.method + ' ' : '';
      // numeric response code rides the row like the web/export `· GET 200`
      // detail cells (inc-48 parity): states without a code (network-error path)
      // keep the compact `http:GET err:—` shape, so guard on null.
      const code = http?.status_code != null ? http.status_code + ' ' : '';
      let seg = `  ${colorStatus(worst)} ${target}  `;
      // judged-against http assert criteria ride the row when the target has
      // them configured (inc-63 interop parity): ` exp 201` / ` body "welcome"`
      // annotate the probe's assertion targets — the same canonical maps the web
      // rows + export JSON carry — while unconfigured targets stay bare. The http
      // failure/success reason string rides along like the tls/apm rows carry
      // theirs (web detail-column parity): a terminal user sees *why* a probe
      // failed (e.g. `expected status 200, got 503`) instead of bare `err:—`.
      if (http) {
        seg += `http:${verb}${code}${http.status}:${http.latency_ms != null ? http.latency_ms.toFixed(0) + 'ms' : '—'}${up}${http.detail ? ` (${http.detail})` : ''}`;
        if (this.httpAssertStatusCodes[target] != null) seg += ` exp ${this.httpAssertStatusCodes[target]}`;
        if (this.httpAssertBodyIncludes[target] != null) seg += ` body "${this.httpAssertBodyIncludes[target]}"`;
        // the resolved probe abort timeout rides the row like the web/export
        // `· timeout Nms` detail cells and the once human line (inc 67 parity):
        // threaded through the same per-target map the web /api/states rows and
        // export JSON blocks carry (states rows have no timeout column).
        if (this.httpTimeoutMs[target] != null) seg += ` timeout ${this.httpTimeoutMs[target]}ms`;
        // the per-check run cadence the engine's scheduler runs this probe on
        // rides the row like the web/export/once rows (inc 71 parity): threaded
        // through the same per-target map the web /api/states rows + export JSON
        // carry. Formatted compact (90s / 2m / 5m).
        if (this.httpIntervalSeconds[target] != null) seg += ' every ' + fmtInterval(this.httpIntervalSeconds[target]);
        // the per-probe slow-latency threshold whose exceedance demotes ok->warn
        // rides the row like the web/export/once human rows (inc 73 parity):
        // threaded through the same per-target map the web chart dashes + TUI
        // sparkline (thr Nms) carry — gated so unconfigured targets stay bare.
        if (this.latencyThresholds[target] != null) seg += ' thr ' + this.latencyThresholds[target] + 'ms';
      }
      if (tls) {
        seg += `  cert:${tls.detail}${tls.leaf_subject ? ` (${tls.leaf_subject})` : ''}${tls.valid_chain === 0 || tls.valid_chain === false ? ' (chain broken)' : ''}`;
        // per-cert chain path, leaf-first like the stored chain_json (web/export
        // tooltip parity): multi-cert chains render their subjects, single-cert
        // chains are already covered by the leaf subject above.
        if (tls.chain_json) {
          try {
            const chain = JSON.parse(tls.chain_json);
            if (Array.isArray(chain) && chain.length > 1) {
              seg += '  chain: ' + chain.map((c) => shortName(c.subject)).join(' -> ');
              // per-cert validity windows ride the live row like the web/export
              // tooltip + once human row (inc 84 parity): chain_json persists the
              // full per-cert fields (validFrom / notAfter / days / selfSigned),
              // so the row surfaces them leaf-first instead of dropping them.
              seg += '  ' + chain.map((c) => `valid ${c.validFrom || '—'} notAfter ${c.notAfter || '—'} ${c.daysRemaining != null ? `${c.daysRemaining}d` : '—'}${c.selfSigned ? ' (self-signed)' : ''}`).join(' | ');
            }
          } catch { /* malformed chain_json: fall back to the leaf-only row */ }
        }
        // the resolved cert-fetch socket timeout rides the row like the web /
        // export `· timeout Nms` detail cells (inc 67 parity): threaded through
        // the same per-target map the web rows + export JSON carry.
        if (this.tlsTimeoutMs[target] != null) seg += ` timeout ${this.tlsTimeoutMs[target]}ms`;
        // the per-check run cadence rides the row like the web/export/once rows
        // (inc 71 parity): same per-target map the web rows + export JSON carry.
        if (this.tlsIntervalSeconds[target] != null) seg += ' every ' + fmtInterval(this.tlsIntervalSeconds[target]);
        // the judged-against cert-warn threshold its proximity demotes ok->warn
        // rides the live row like the export page / web table / once rows (inc 74
        // parity): threaded through the same per-target map the web /api/states
        // rows + export JSON + history section (warn 30d) carry. Gated so
        // unconfigured targets stay bare.
        if (this.tlsWarnDaysBefore[target] != null) seg += ' warn ' + this.tlsWarnDaysBefore[target] + 'd';
        // the probed port rides the row like the web/export/once rows (inc 78
        // parity): threaded through the same per-target map the web /api/states
        // rows + export JSON + once rows carry — pemFile targets resolve to
        // null (no socket opened), gated so they stay bare.
        if (this.tlsPort[target] != null) seg += ' port ' + this.tlsPort[target];
      }
      if (apm) {
        seg += `  apm:${apm.detail}`;
        // the judged-against apm thresholds surface on the live row like the
        // web /api/states rows + once --json + export JSON blocks (inc 68
        // parity): threaded through the constructor values the engine resolves
        // (error-rate always-resolved to the 0.05 default, latency null when
        // unconfigured) — gated like the apm-history section so unconfigured
        // rows stay bare.
        if (this.apmErrorRateThreshold != null) seg += ` errThr ${(this.apmErrorRateThreshold * 100).toFixed(1)}%`;
        if (this.apmLatencyThresholdMs != null) seg += ` slow thr ${this.apmLatencyThresholdMs}ms`;
        // the measured error rate rides the live row like the apm-history err
        // line + once human row + export page (inc 75 parity): read off the
        // stored states row (apm.error_rate), same `err N%` label — gated so
        // rows snapshotted without the column keep the compact shape.
        if (apm.error_rate != null) seg += ` err ${(apm.error_rate * 100).toFixed(1)}%`;
        // the apm collection cadence rides the live row like the once human row
        // + export page + web table (inc 76 parity): config-global, threaded
        // through the constructor — gated so unseeded rows stay bare.
        if (this.apmIntervalSeconds != null) seg += ' every ' + fmtInterval(this.apmIntervalSeconds);
        // the sampling window the summary was collected over rides the live row
        // like the once human row + export page + web table (inc 77 parity):
        // config-global, threaded through the constructor — gated so unseeded
        // rows stay bare.
        if (this.apmWindowMs != null) seg += ' window ' + fmtInterval(this.apmWindowMs / 1000);
        // the per-service sample-buffer capacity the collector caps its ring at
        // rides the live row like the window anno above (inc 82 parity):
        // config-global, threaded through the constructor — gated so unseeded
        // rows stay bare.
        if (this.apmMaxSamples != null) seg += ' cap ' + this.apmMaxSamples;
      }
      lines.push(seg);
    }
    // history sparkline per http target
    const httpTargets = [...new Set(states.filter((s) => s.kind === 'http').map((s) => s.target))];
    if (httpTargets.length) {
      lines.push(CLR.cyan + '  ── latency history ──' + CLR.reset);
      for (const t of httpTargets.slice(0, 5)) {
        const pts = this.store.series(`http:${t}/latency`, Date.now() - this.historyMs, 30);
        // annotate the target's configured slow-latency threshold (web chart parity)
        const thr = this.latencyThresholds[t] != null ? '  thr ' + this.latencyThresholds[t] + 'ms' : '';
        lines.push(`  ${t}: ${spark(pts.map((p) => p.value))}${thr}`);
      }
      lines.push(CLR.cyan + '  ── http status history ──' + CLR.reset);
      for (const t of httpTargets.slice(0, 5)) {
        const statuses = this.store.series(`http:${t}/status`, Date.now() - this.historyMs, 30);
        // annotate the target's judged-against expected status code, the
        // assert criterion the plotted codes are matched against (live-row
        // ` exp N` + web dashboard dash parity, inc 87): per-target, from the
        // same map the live row + web row + export + once faces carry. Gated
        // so unseeded rows keep the compact history lines.
        const exp = this.httpAssertStatusCodes[t] != null ? '  exp ' + this.httpAssertStatusCodes[t] : '';
        lines.push(`  ${t}: ${spark(statuses.map((p) => p.value))}${exp}`);
      }
    }
    // tls remaining-days history per tls target (web cTls chart parity)
    const tlsTargets = [...new Set(states.filter((s) => s.kind === 'tls').map((s) => s.target))];
    if (tlsTargets.length) {
      lines.push(CLR.cyan + '  ── tls remaining history ──' + CLR.reset);
      for (const t of tlsTargets.slice(0, 5)) {
        const pts = this.store.series(`tls:${t}/remaining`, Date.now() - this.historyMs, 30);
        // annotate the target's configured cert warn threshold (web cTls dashed-line parity)
        const th = this.tlsWarnDaysBefore[t] != null ? '  warn ' + this.tlsWarnDaysBefore[t] + 'd' : '';
        lines.push(`  ${t}: ${spark(pts.map((p) => p.value))}${th}`);
      }
    }
    // apm p50/p95 latency + error-rate history per apm target (web UI parity)
    const apmNames = [...new Set(states.filter((s) => s.kind === 'apm').map((s) => s.target))];
    if (apmNames.length) {
      lines.push(CLR.cyan + '  ── apm history ──' + CLR.reset);
      for (const n of apmNames.slice(0, 5)) {
        const p50 = this.store.series(`apm:${n}/p50`, Date.now() - this.historyMs, 30);
        const p95 = this.store.series(`apm:${n}/p95`, Date.now() - this.historyMs, 30);
        const err = this.store.series(`apm:${n}/errorRate`, Date.now() - this.historyMs, 30);
        const last = (arr) => (arr.length ? Math.round(arr[arr.length - 1].value) : '—');
        // annotate the configured slow-latency threshold on the p95 line (web
        // drawApm dashed-marker parity: only when actually configured)
        const slowThr = this.apmLatencyThresholdMs != null && Number.isFinite(this.apmLatencyThresholdMs)
          ? '  slow thr ' + this.apmLatencyThresholdMs + 'ms' : '';
        // the sampling window the summary was collected over + the sample-buffer
        // capacity ride the history lines like the live apm row (inc 86 parity):
        // config-global, threaded through the constructor — gated so unseeded
        // rows keep the compact history lines.
        const winCap = (this.apmWindowMs != null ? '  window ' + fmtInterval(this.apmWindowMs / 1000) : '')
          + (this.apmMaxSamples != null ? ' cap ' + this.apmMaxSamples : '');
        lines.push(`  ${n}: p50 ${last(p50)}ms  p95 ${last(p95)}ms  ${spark(p95.map((p) => p.value))}${slowThr}${winCap}`);
        if (err.length) {
          // annotate the resolved error-rate threshold on the err line (web
          // drawErrRate marker parity — resolves to 0.05 when unconfigured)
          const errThr = this.apmErrorRateThreshold != null
            ? '  errThr ' + (this.apmErrorRateThreshold * 100).toFixed(1) + '%' : '';
          lines.push(`    err ${(err[err.length - 1].value * 100).toFixed(1)}%  ${spark(err.map((p) => p.value))}${errThr}`);
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

// last DN component of a subject (e.g. "/C=US/O=Acme/CN=api.test" -> "CN=api.test")
// — compact fit for a terminal row; the web tooltip keeps the full subject.
function shortName(subject) {
  const part = String(subject ?? '').split('/').filter(Boolean).pop();
  return part || '?';
}

function fmtAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const h = Math.floor(min / 60);
  return h + 'h ' + (min % 60) + 'm ago';
}

// compact run-cadence label (90 -> '90s', 120 -> '2m', 300 -> '5m'),
// mirroring the fmtInterval helpers on the web / export / once faces
function fmtInterval(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function spark(vals) {
  if (!vals.length) return '—';
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const glyphs = '▁▂▃▄▅▆▇█';
  return vals.map((v) => glyphs[Math.min(7, Math.max(0, Math.floor(((v - min) / range) * 8)))]).join('');
}
