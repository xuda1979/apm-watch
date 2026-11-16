// Status export: aggregate the latest per-target states from the store into a
// JSON summary (`exportStatus`), and render that snapshot as a self-contained
// HTML status page (`renderStatusPage`) for static hosting / offline sharing.

import { availability } from './availability.js';
import { httpLatencyThresholds, tlsWarnDaysBefore, httpTimeoutMs, tlsTimeoutMs } from './config.js';
import { retentionDays } from './engine.js';

export function aggStatus(statuses) {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  return statuses.length ? 'ok' : 'unknown';
}

export function countStatuses(statuses) {
  const counts = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}

// Collapse the latest snapshot per (target, kind) into one entry per target.
export function exportStatus(store, config, version = '0.0.0') {
  const states = store.latestStates(100);
  const byTarget = new Map();
  for (const s of states) {
    if (!byTarget.has(s.target)) byTarget.set(s.target, []);
    byTarget.get(s.target).push(s);
  }
  const targets = [];
  for (const [target, rows] of byTarget) {
    const http = rows.find((r) => r.kind === 'http');
    const tls = rows.find((r) => r.kind === 'tls');
    const apm = rows.find((r) => r.kind === 'apm');
    // time-weighted availability over the retained states history window
    const avail = http ? availability(store.history(target, 'http', Date.now() - (config?.ui?.historySeconds ?? 24 * 3600) * 1000), Date.now()) : null;
    targets.push({
      target,
      status: aggStatus(rows.map((r) => r.status)),
      http: http ? { status: http.status, latency_ms: http.latency_ms, method: http.method, status_code: http.status_code, detail: http.detail, ts: http.ts, uptime_pct: avail && avail.pct != null ? avail.pct : null } : null,
      tls: tls ? { status: tls.status, days_remaining: tls.days_remaining, leaf_subject: tls.leaf_subject ?? null, valid_chain: tls.valid_chain == null ? null : !!tls.valid_chain, chain: tls.chain_json ? JSON.parse(tls.chain_json) : null, detail: tls.detail, ts: tls.ts } : null,
      apm: apm ? { status: apm.status, latency_ms: apm.latency_ms, p50_ms: apm.p50_ms, error_rate: apm.error_rate, errors: apm.errors, samples: apm.samples, detail: apm.detail, ts: apm.ts } : null,
    });
  }
  const now = Date.now();
  const statuses = targets.map((t) => t.status);
  const counts = countStatuses(statuses);
  const h = store.getMeta?.('health')?.value;
  const health = h?.lastCheckAt
    ? {
        status: h.status || 'unknown',
        uptimeSince: h.uptimeSince ?? null,
        lastCheckAt: h.lastCheckAt ?? null,
      }
    : null;
  // recent alert/audit events, newest first — same shape as the web /api/events
  const events = store.recentEvents(50).map((e) => ({
    ts: e.ts, level: e.level, source: e.source, message: e.message,
  }));
  return {
    generated_at: new Date(now).toISOString(),
    generated_ts: now,
    apm_watch_version: version,
    summary: { overall: aggStatus(statuses), counts },
    apm: { errorRateThreshold: config?.apm?.errorRateThreshold ?? 0.05, latencyThresholdMs: config?.apm?.latencyThresholdMs ?? null, windowMs: config?.apm?.windowMs ?? 60_000, maxSamples: config?.apm?.maxSamples ?? 5000 },
    http: { latencyThresholds: httpLatencyThresholds(config), timeoutMs: httpTimeoutMs(config) },
    tls: { warnDaysBefore: tlsWarnDaysBefore(config), timeoutMs: tlsTimeoutMs(config) },
    store: { retentionDays: retentionDays(config?.store) },
    health,
    targets,
    events,
  };
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function healthText(status) {
  const h = status.health;
  if (!h?.lastCheckAt) return '';
  const up = fmtDuration(h.lastCheckAt - (h.uptimeSince ?? h.lastCheckAt));
  return ` &middot; monitor ${esc(h.status)} &middot; up ${up} &middot; last check ${new Date(h.lastCheckAt).toISOString()}`;
}

function kindRow(target, kind, r) {
  if (!r) return '';
  const latency = r.latency_ms != null ? `${r.latency_ms.toFixed(0)} ms` : '—';
  const up = r.uptime_pct != null ? ` · ${r.uptime_pct}% uptime` : '';
  const subject = r.leaf_subject ? ` · ${r.leaf_subject}` : '';
  const broken = r.valid_chain === false ? ' (chain broken)' : '';
  const detail = (r.detail || '') + up + subject + broken;
  // per-cert chain rows as a hover tooltip, mirroring the web status table
  const tip = Array.isArray(r.chain) && r.chain.length
    ? ' title="' + esc(r.chain.map((c) =>
        `${esc(c.subject)} -> ${esc(c.issuer)}  valid ${c.validFrom ? esc(c.validFrom) : '—'}  notAfter ${esc(c.notAfter)}  ${c.daysRemaining}d${c.selfSigned ? ' (self-signed)' : ''}`
      ).join('\n')) + '"'
    : '';
  return `<tr${tip}><td>${esc(target)}</td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>` +
    `<td>${kind}</td><td>${latency}</td><td>${esc(detail)}</td></tr>`;
}

export function renderStatusPage(status) {
  const v = status.apm_watch_version || '0.0.0';
  const counts = status.summary?.counts || {};
  const pills = ['ok', 'warn', 'error'].map((k) =>
    `<span class="pill ${k}">${k} <b>${counts[k] || 0}</b></span>`).join('') +
    ` <span class="pill unknown">overall ${esc(status.summary?.overall)}</span>`;
  const rows = status.targets.map((t) =>
    kindRow(t.target, 'http', t.http) + kindRow(t.target, 'tls', t.tls) + kindRow(t.target, 'apm', t.apm)
  ).join('') || '<tr><td colspan="5">no targets configured yet</td></tr>';
  // recent alert/audit events, newest first (web page "recent events" parity)
  const evRows = (status.events || []).map((e) =>
    `<tr><td>${esc(new Date(e.ts).toLocaleTimeString())}</td><td><span class="pill ${esc(e.level)}">${esc(e.level)}</span></td><td>${esc(e.source)}</td><td>${esc(e.message)}</td></tr>`
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>apm-watch status</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 1.5rem; font-family: ui-monospace, Menlo, Consolas, monospace; background: #0a0e14; color: #c9d4e2; }
.wrap { max-width: 960px; margin: 0 auto; }
h1 { color: #7ee787; font-size: 1.25rem; margin: 0 0 .25rem; }
h1 small { color: #62748e; font-weight: 400; font-size: .8rem; }
.meta { color: #62748e; font-size: .8rem; margin: 0 0 1rem; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; margin: 1rem 0; }
.pill { display: inline-block; padding: 2px 12px; border-radius: 12px; font-weight: 700; text-transform: uppercase; font-size: .72rem; }
.pill b { font-weight: 400; opacity: .85; }
.ok { background: #1f9d55; color: #fff; }
.warn { background: #d97706; color: #fff; }
.error { background: #dc2626; color: #fff; }
.unknown { background: #6b7280; color: #fff; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #232e40; font-size: .85rem; }
th { color: #62748e; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; }
footer { margin-top: 1.5rem; color: #62748e; font-size: .75rem; }
</style>
</head>
<body>
<div class="wrap">
<h1>apm-watch <small>status snapshot</small></h1>
<p class="meta">generated ${esc(status.generated_at)}${healthText(status)}</p>
<div class="pills">${pills}</div>
<table>
<thead><tr><th>target</th><th>status</th><th>kind</th><th>latency</th><th>detail</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${evRows ? `<h2>recent events</h2><table><thead><tr><th>time</th><th>level</th><th>source</th><th>message</th></tr></thead><tbody>${evRows}</tbody></table>` : ''}
<footer>apm-watch v${esc(v)}</footer>
</div>
</body>
</html>
`;
}
