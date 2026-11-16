// Status export: aggregate the latest per-target states from the store into a
// JSON summary (`exportStatus`), and render that snapshot as a self-contained
// HTML status page (`renderStatusPage`) for static hosting / offline sharing.

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
    targets.push({
      target,
      status: aggStatus(rows.map((r) => r.status)),
      http: http ? { status: http.status, latency_ms: http.latency_ms, detail: http.detail, ts: http.ts } : null,
      tls: tls ? { status: tls.status, detail: tls.detail, ts: tls.ts } : null,
      apm: apm ? { status: apm.status, latency_ms: apm.latency_ms, detail: apm.detail, ts: apm.ts } : null,
    });
  }
  const now = Date.now();
  const statuses = targets.map((t) => t.status);
  const counts = countStatuses(statuses);
  return {
    generated_at: new Date(now).toISOString(),
    generated_ts: now,
    apm_watch_version: version,
    summary: { overall: aggStatus(statuses), counts },
    targets,
  };
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function kindRow(target, kind, r) {
  if (!r) return '';
  const latency = r.latency_ms != null ? `${r.latency_ms.toFixed(0)} ms` : '—';
  return `<tr><td>${esc(target)}</td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>` +
    `<td>${kind}</td><td>${latency}</td><td>${esc(r.detail || '')}</td></tr>`;
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
<p class="meta">generated ${esc(status.generated_at)}</p>
<div class="pills">${pills}</div>
<table>
<thead><tr><th>target</th><th>status</th><th>kind</th><th>latency</th><th>detail</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<footer>apm-watch v${esc(v)}</footer>
</div>
</body>
</html>
`;
}
