// Status export: aggregate the latest per-target states from the store into a
// JSON summary (`exportStatus`), and render that snapshot as a self-contained
// HTML status page (`renderStatusPage`) for static hosting / offline sharing.

import { availability } from './availability.js';
import { httpLatencyThresholds, tlsWarnDaysBefore, httpTimeoutMs, tlsTimeoutMs, httpAssertStatusCodes, httpAssertBodyIncludes, httpIntervalSeconds, tlsIntervalSeconds, schedulerIntervals, uiHistorySeconds, notificationsDesktop, notificationsWebhookEnabled, notificationsEmailEnabled } from './config.js';
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
  // per-target threshold/timeout maps, resolved once so the per-target kind
  // blocks and the top-level http:/tls: mirror blocks carry identical values
  // (web /api/states per-row + once --json parity — the export JSON per-kind
  // blocks used to drop the judged-against thresholds the rows now surface)
  const httpLatThresholdMap = httpLatencyThresholds(config);
  const httpTimeoutMap = httpTimeoutMs(config);
  const httpStatusMap = httpAssertStatusCodes(config);
  const httpBodyMap = httpAssertBodyIncludes(config);
  const tlsWarnMap = tlsWarnDaysBefore(config);
  const tlsTimeoutMap = tlsTimeoutMs(config);
  // per-target run-cadence maps (the intervalSeconds the engine's scheduler
  // actually runs each check on, entry beats scheduler-wide default): resolved
  // once so the per-target kind blocks and the top-level `http:` / `tls:`
  // mirror blocks carry identical values (inc 71 parity).
  const httpIntMap = httpIntervalSeconds(config);
  const tlsIntMap = tlsIntervalSeconds(config);
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
      // uptime_ms mirrors the full availability computation (up/down/total durations
      // + snapshot count) that the web /api/states availability map already emits —
      // pct alone loses the actual downtime window a status-page consumer needs.
      // Sibling of uptime_pct, gated on the same totalMs > 0 window test.
      // each kind's judged-against threshold / abort timeout rides the per-target
      // block exactly like the web /api/states + once --json rows (inc 61/62
      // parity): http latency_threshold_ms + timeout_ms, tls warn_days_before +
      // timeout_ms, resolved from the same per-target maps the top-level http:/
      // tls: mirror blocks carry, null off-kind / unconfigured. The apm block
      // carries error_rate_threshold + latency_threshold_ms below.
      http: http ? { status: http.status, latency_ms: http.latency_ms, method: http.method, status_code: http.status_code, latency_threshold_ms: httpLatThresholdMap[http.target] ?? null, timeout_ms: httpTimeoutMap[http.target] ?? null, expected_status_code: httpStatusMap[http.target] ?? null, body_includes: httpBodyMap[http.target] ?? null, interval_seconds: httpIntMap[http.target] ?? null, detail: http.detail, ts: http.ts, uptime_pct: avail && avail.pct != null ? avail.pct : null, uptime_ms: avail && avail.totalMs > 0 ? { up_ms: avail.upMs, down_ms: avail.downMs, total_ms: avail.totalMs, samples: avail.samples } : null } : null,
      tls: tls ? { status: tls.status, days_remaining: tls.days_remaining, leaf_subject: tls.leaf_subject ?? null, valid_chain: tls.valid_chain == null ? null : !!tls.valid_chain, chain: tls.chain_json ? JSON.parse(tls.chain_json) : null, warn_days_before: tlsWarnMap[tls.target] ?? null, timeout_ms: tlsTimeoutMap[tls.target] ?? null, interval_seconds: tlsIntMap[tls.target] ?? null, detail: tls.detail, ts: tls.ts } : null,
      apm: apm ? { status: apm.status, latency_ms: apm.latency_ms, p50_ms: apm.p50_ms, p95_ms: apm.p95_ms, error_rate: apm.error_rate, errors: apm.errors, samples: apm.samples, error_rate_threshold: config?.apm?.errorRateThreshold ?? 0.05, latency_threshold_ms: config?.apm?.latencyThresholdMs ?? null, interval_seconds: schedulerIntervals(config).apmIntervalSeconds, detail: apm.detail, ts: apm.ts } : null,
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
    apm: { collect: config?.apm?.collect === true, errorRateThreshold: config?.apm?.errorRateThreshold ?? 0.05, latencyThresholdMs: config?.apm?.latencyThresholdMs ?? null, windowMs: config?.apm?.windowMs ?? 60_000, maxSamples: config?.apm?.maxSamples ?? 5000 },
    http: { latencyThresholds: httpLatThresholdMap, timeoutMs: httpTimeoutMap, assertStatusCodes: httpStatusMap, assertBodyIncludes: httpBodyMap, intervalSeconds: httpIntervalSeconds(config) },
    tls: { warnDaysBefore: tlsWarnMap, timeoutMs: tlsTimeoutMap, intervalSeconds: tlsIntervalSeconds(config) },
    store: { retentionDays: retentionDays(config?.store) },
    notifications: { repeatIntervalSeconds: config?.notifications?.repeatIntervalSeconds ?? 3600, desktop: notificationsDesktop(config), webhook: notificationsWebhookEnabled(config), email: notificationsEmailEnabled(config) },
    scheduler: schedulerIntervals(config),
    ui: { historySeconds: uiHistorySeconds(config) },
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

// compact run-cadence label (90 -> '90s', 120 -> '2m', 300 -> '5m'),
// mirroring the fmtInterval helpers on the web / TUI / once faces
function fmtInterval(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
  // http verb + response code ride the row like the tls leaf subject does
  // (web table + TUI `http:GET 200:` parity): the export JSON carries both
  // fields but the page renderer dropped them before this.
  const req = kind === 'http' ? [r.method, r.status_code].filter((v) => v != null && v !== '').join(' ') : '';
  // judged-against http assert criteria ride the row like the web table + TUI +
  // once rows (inc 65 parity): the export JSON http block carries
  // expected_status_code + body_includes, the page renderer dropped them before
  // this. The joined detail is esc()'d as a whole at the <td>, so quotes render
  // as &quot;.
  const assertAnno = kind === 'http'
    ? (r.expected_status_code != null ? ` exp ${r.expected_status_code}` : '') + (r.body_includes != null ? ` body "${r.body_includes}"` : '')
    : '';
  // the resolved probe abort timeout rides the row like the web table + TUI +
  // once rows (inc 67 parity): the export JSON http/tls blocks carry timeout_ms
  // (per-target map, resolved from the config default when unset), the page
  // renderer dropped it before this. apm rows naturally have timeout_ms null.
  const timeoutAnno = r.timeout_ms != null ? ` · timeout ${r.timeout_ms}ms` : '';
  // the per-check run cadence rides the row like the web table + TUI + once
  // rows (inc 71 parity): the export JSON http/tls blocks carry interval_seconds
  // (per-target map, entry beats kind default), the apm block carries the
  // config-global scheduler cadence (inc 76 parity), the page renderer dropped
  // it before this. Formatted compact (90s / 2m / 5m).
  const intervalAnno = (kind === 'http' || kind === 'tls' || kind === 'apm') && r.interval_seconds != null ? ` · every ${fmtInterval(r.interval_seconds)}` : '';
  // the per-probe slow-latency threshold whose exceedance demotes ok->warn rides
  // the row like the web table + TUI + once rows (inc 73 parity): the export JSON
  // http block carries latency_threshold_ms (null when unconfigured), the page
  // renderer dropped it before this. Same `· thr Nms` family as the timeout cell.
  const thrAnno = kind === 'http' && r.latency_threshold_ms != null ? ` · thr ${r.latency_threshold_ms}ms` : '';
  // the judged-against cert-warn threshold its proximity demotes ok->warn rides
  // the row like the web table + TUI + once rows (inc 74 parity): the export JSON
  // tls block carries warn_days_before (per-target map, null when unconfigured),
  // the page renderer dropped it before this. Same `· warn Nd` annotation family
  // as the tls rows' interval/timeout cells, so the ok-path detail (which carries
  // no threshold prose) gains the judged-against target.
  const warnAnno = kind === 'tls' && r.warn_days_before != null ? ` · warn ${r.warn_days_before}d` : '';
  // the judged-against apm thresholds ride the row like the web table + TUI +
  // once rows (inc 68 parity): the export JSON apm block carries
  // error_rate_threshold (always-resolved 0.05 default) + latency_threshold_ms
  // (null when unconfigured), the page renderer used to drop them. Same
  // ` errThr N%` / ` slow thr Nms` format the TUI apm-history section uses.
  // The measured error rate rides along as ` err N%` (inc 75 parity) — the
  // apm block carries error_rate (null when unseeded) and the detail renders
  // only the errors=N/M fraction, so the labeled percentage gives the page row
  // the same at-a-glance rate the TUI apm-history err line carries.
  const apmAnno = kind === 'apm'
    ? (r.error_rate_threshold != null ? ` errThr ${(r.error_rate_threshold * 100).toFixed(1)}%` : '') + (r.latency_threshold_ms != null ? ` slow thr ${r.latency_threshold_ms}ms` : '') + (r.error_rate != null ? ` err ${(r.error_rate * 100).toFixed(1)}%` : '')
    : '';
  const detail = (r.detail || '') + (req ? ` · ${esc(req)}` : '') + up + subject + broken + assertAnno + timeoutAnno + intervalAnno + thrAnno + warnAnno + apmAnno;
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
