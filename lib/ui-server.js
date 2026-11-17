// Web UI: single-page live status + history curves. Serves a static HTML and
// a JSON API backed directly by the store.

import { createServer } from 'node:http';
import { availability } from './availability.js';
import { httpLatencyThresholds, tlsWarnDaysBefore, httpTimeoutMs, tlsTimeoutMs, httpAssertStatusCodes, httpAssertBodyIncludes, httpIntervalSeconds, tlsIntervalSeconds, schedulerIntervals, uiHistorySeconds, notificationsDesktop, notificationsWebhookEnabled, notificationsEmailEnabled } from './config.js';
import { retentionDays } from './engine.js';

const PAGE = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>apm-watch</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; padding: 1rem; font-family: ui-monospace, Menlo, Consolas, monospace; background: #0a0e14; color: #c9d4e2; }
.term { display: flex; flex-direction: column; height: 100%; max-width: 960px; margin: 0 auto; border: 1px solid #2b3544; border-radius: 10px; background: #0d1421; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, .4); }
.term-head { display: flex; align-items: center; gap: 8px; flex: none; padding: 10px 14px; background: #141c2b; border-bottom: 1px solid #232e40; font-size: 13px; color: #62748e; }
.dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.dot.r { background: #ff5f57; }
.dot.y { background: #febc2e; }
.dot.g { background: #28c840; }
.term-title { margin-left: 8px; letter-spacing: .04em; }
.term-body { flex: 1; min-height: 0; overflow-y: scroll; overflow-x: hidden; padding: 1rem 1.25rem 2rem; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #3a4a63 #0d1421; }
.term-body::-webkit-scrollbar { width: 10px; }
.term-body::-webkit-scrollbar-track { background: #0d1421; }
.term-body::-webkit-scrollbar-thumb { background: #3a4a63; border-radius: 5px; }
.term-body::-webkit-scrollbar-thumb:hover { background: #4c5f7f; }
h1 { font-size: 1.15rem; margin: 0 0 .75rem; color: #7ee787; }
h3 { color: #8ab4ff; }
.pill { display: inline-block; padding: 1px 10px; border-radius: 12px; font-weight: 700; text-transform: uppercase; font-size: .75rem; }
.ok { background: #1f9d55; color: #fff; }
.warn { background: #d97706; color: #fff; }
.error { background: #dc2626; color: #fff; }
.unknown { background: #6b7280; color: #fff; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #232e40; }
canvas { width: 100%; height: 180px; margin-top: 1rem; }
section { margin-top: 1.6rem; }
.pills { display: flex; gap: 8px; flex-wrap: wrap; }
.pill { display: inline-block; padding: 1px 10px; border-radius: 12px; font-weight: 700; text-transform: uppercase; font-size: .75rem; }
.count { font-weight: 400; opacity: .8; }
</style>
</head>
<body>
<div class="term">
  <div class="term-head">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="term-title">apm-watch — live</span>
  </div>
  <div class="term-body">
<h1>apm-watch</h1>
<p id="meta">loading…</p>
<section id="overview"><div class="pills" id="pillbox"></div></section>
<section id="targets"><table><thead><tr><th>target</th><th>status</th><th>kind</th><th>latency</th><th>detail</th></tr></thead><tbody></tbody></table></section>
<section><h3>http latency history</h3><canvas id="cLat"></canvas></section>
<section><h3>http status code history</h3><canvas id="cStatus"></canvas></section>
<section><h3>tls days-remaining</h3><canvas id="cTls"></canvas></section>
<section><h3>apm p50/p95</h3><canvas id="cApm"></canvas></section>
<section><h3>apm error rate</h3><canvas id="cApmErr"></canvas></section>
<section id="eventsSec"><h3>recent events</h3><table><thead><tr><th>time</th><th>level</th><th>source</th><th>message</th></tr></thead><tbody id="evtBody"></tbody></table></section>
  </div>
</div>
<script>
const $ = (s) => document.querySelector(s);
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60);
  return h + 'h ' + (min % 60) + 'm';
}
// compact run-cadence label (90 -> '90s', 120 -> '2m', 300 -> '5m'),
// mirroring the fmtInterval helpers on the export page / TUI / once faces
function fmtInterval(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
async function refresh() {
  try {
    const res = await fetch('/api/states');
    const data = await res.json();
    $('tbody').innerHTML = data.states.map(s => {
      const av = s.kind === 'http' && data.availability && data.availability[s.target] ? data.availability[s.target].pct : null;
      let detail = esc(s.detail);
      // http verb + response code ride the row like the tls leaf subject does
      // (export page / TUI parity): /api/states sends both fields but the
      // table renderer dropped them before this.
      if (s.kind === 'http') {
        const req = [s.method, s.status_code].filter((v) => v != null && v !== '').join(' ');
        if (req) detail += ' · ' + esc(req);
      }
      detail += av != null ? ' · ' + av + '% uptime' : '';
      // judged-against http assert criteria ride the row like the export page /
      // TUI / once rows (inc 65 parity): /api/states sends expected_status_code
      // + body_includes, the table renderer dropped them before this.
      if (s.kind === 'http') {
        if (s.expected_status_code != null) detail += ' exp ' + s.expected_status_code;
        if (s.body_includes != null) detail += ' body "' + esc(s.body_includes) + '"';
      }
      // the abort timeout the probe was judged against rides the row like the
      // export page / TUI / once rows (inc 67 parity): /api/states sends
      // timeout_ms (http + tls), the table renderer dropped it before this.
      if (s.timeout_ms != null) detail += ' · timeout ' + s.timeout_ms + 'ms';
      // the per-check run cadence the engine's scheduler runs this probe on
      // rides the row like the export page / TUI / once rows (inc 71 parity):
      // /api/states sends interval_seconds (http + tls, kind-gated), the table
      // renderer dropped it before this. Formatted compact (90s / 2m / 5m).
      if (s.interval_seconds != null) detail += ' · every ' + fmtInterval(s.interval_seconds);
      // the per-probe slow-latency threshold whose exceedance demotes ok->warn
      // rides the row like the export page / TUI / once rows (inc 73 parity):
      // /api/states sends http latency_threshold_ms (null when unconfigured),
      // the table renderer dropped it before this. Same [thr Nms] detail-cell
      // family as the timeout cell, matching the dashed chart line the
      // threshold draws.
      if (s.kind === 'http' && s.latency_threshold_ms != null) detail += ' · thr ' + s.latency_threshold_ms + 'ms';
      // the judged-against apm thresholds ride the row like the export page /
      // TUI / once rows (inc 68 parity): /api/states sends error_rate_threshold
      // (always-resolved 0.05 default) + latency_threshold_ms (null when
      // unconfigured), the table renderer used to drop them on apm rows. Same
      // errThr N% / slow thr Nms format the TUI apm-history section uses.
      if (s.kind === 'apm') {
        if (s.error_rate_threshold != null) detail += ' errThr ' + (s.error_rate_threshold * 100).toFixed(1) + '%';
        if (s.latency_threshold_ms != null) detail += ' slow thr ' + s.latency_threshold_ms + 'ms';
        // the measured error rate rides the row like the export page + TUI rows
        // + once rows (inc 75 parity): /api/states sends error_rate (null when
        // unseeded), the table renderer used to drop it. Same err N% label as
        // the TUI apm-history section, so the ok-path detail (which carries no
        // rate prose) gains the measured rate its errors=N/M fraction encodes.
        if (s.error_rate != null) detail += ' err ' + (s.error_rate * 100).toFixed(1) + '%';
      }
      let tip = '';
      if (s.kind === 'tls') {
        if (s.leaf_subject) detail += ' · ' + esc(s.leaf_subject);
        if (s.valid_chain === false) detail += ' (chain broken)';
        // the judged-against cert-warn threshold its proximity demotes ok->warn
        // rides the row like the export page / TUI / once rows (inc 74 parity):
        // /api/states sends warn_days_before (null when unconfigured), the table
        // renderer dropped it before this. Same [warn Nd] annotation family as
        // the TUI history section, so the ok-path detail (which carries no
        // threshold prose) gains the judged-against target.
        if (s.warn_days_before != null) detail += ' · warn ' + s.warn_days_before + 'd';
        if (Array.isArray(s.chain) && s.chain.length) {
          tip = ' title="' + esc(s.chain.map(c => esc(c.subject) + ' -> ' + esc(c.issuer) + '  valid ' + (c.validFrom ? esc(c.validFrom) : '—') + '  notAfter ' + esc(c.notAfter) + '  ' + c.daysRemaining + 'd' + (c.selfSigned ? ' (self-signed)' : '')).join('\n')) + '"';
        }
      }
      return \`<tr\${tip}><td>\${esc(s.target)}</td><td><span class="pill \${'ok warn error unknown'.includes(s.status) ? esc(s.status) : 'unknown'}">\${esc(s.status)}</span></td><td>\${esc(s.kind)}</td><td>\${s.latency_ms != null ? s.latency_ms.toFixed(0) + ' ms' : '—'}</td><td>\${detail}</td></tr>\`;
    }).join('');
    const c = data.summary.counts || {};
    $('#meta').textContent = 'updated ' + new Date().toLocaleTimeString() + ' · ' + data.states.length + ' rows · overall ' + data.summary.overall
      + (data.health && data.health.lastCheckAt ? ' · up ' + fmtAgo(data.health.uptimeSince) + ' · last check ' + new Date(data.health.lastCheckAt).toLocaleTimeString() : '')
      // the monitor's self-health status word rides the meta line like the TUI
      // (monitor <status>), export page (monitor STATUS) and once report
      // (health <status>): /api/states sends health.status, the meta line used
      // to drop it. Same [status, up since, last check] triple the others show.
      + (data.health && data.health.status ? ' · monitor ' + data.health.status : '');
    $('pillbox').innerHTML = ['ok','warn','error'].map(k => \`<span class="pill \${k}">\${k} <span class="count">\${c[k] || 0}</span></span>\`).join('')
      + \` <span class="pill unknown">overall \${esc(data.summary.overall)}</span>\`;
    drawLines($('#cLat'), data.series['http:latency'], 'latency ms', data.http.latencyThresholds);
    drawStatus($('#cStatus'), data.series['http:status']);
    drawLines($('#cTls'), data.series['tls:remaining'], 'days', data.tls.warnDaysBefore);
    drawApm($('#cApm'), data.series['apm:p50'], data.series['apm:p95'], data.apm.latencyThresholdMs);
    drawErrRate($('#cApmErr'), data.series['apm:errorRate'], data.apm.errorRateThreshold);
  } catch (e) { $('tbody').innerHTML = '<tr><td colspan=5>error: ' + esc(e) + '</td></tr>'; }
  try {
    const ev = await (await fetch('/api/events')).json();
    $('evtBody').innerHTML = (ev.events || []).map(e => \`<tr><td>\${new Date(e.ts).toLocaleTimeString()}</td><td><span class="pill \${esc(e.level)}">\${esc(e.level)}</span></td><td>\${esc(e.source)}</td><td>\${esc(e.message)}</td></tr>\`).join('');
  } catch (e) { $('evtBody').innerHTML = '<tr><td colspan=4>events unavailable: ' + esc(e) + '</td></tr>'; }
}
const PALETTE = ['#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#f87171'];
function drawLegend(ctx, targets, w) {
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'top';
  let x = 8;
  targets.forEach((t, ti) => {
    const label = t.length > 16 ? t.slice(0, 15) + '…' : t;
    if (x + 22 + ctx.measureText(label).width + 14 > w) return; // drop overflow entries
    ctx.fillStyle = PALETTE[ti % PALETTE.length];
    ctx.fillRect(x, 40, 16, 3);
    ctx.fillStyle = '#7b8aa0';
    ctx.fillText(label, x + 22, 34);
    x += 22 + ctx.measureText(label).width + 14;
  });
  ctx.textBaseline = 'alphabetic';
}
function drawLines(canvas, byTarget, label, thresholds) {
  // byTarget: { target: [{ts, value}...] } — one colored line per monitored target
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0,0,w,h);
  const targets = Object.keys(byTarget || {}).filter(t => (byTarget[t] || []).length);
  if (!targets.length) { ctx.fillText('no data', 10, 20); return; }
  const ys = targets.flatMap(t => byTarget[t].map(p => p.value));
  const minY = Math.min(...ys), maxY = Math.max(...ys, minY + 1);
  const thVals = targets.map(t => thresholds?.[t]).filter(v => Number.isFinite(v));
  // include configured thresholds in the y-scale so the marker line is on-canvas
  const peakY = Math.max(maxY, ...thVals, 1);
  const yAt = (v) => h - ((v - minY) / (peakY - minY)) * (h - 20) - 10;
  targets.forEach((t, ti) => {
    const pts = byTarget[t];
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * w; const y = yAt(p.value);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = PALETTE[ti % PALETTE.length]; ctx.lineWidth = 2; ctx.stroke();
  });
  // per-target slow-latency threshold dash, in the target's line color
  targets.forEach((t, ti) => {
    const th = thresholds?.[t];
    if (!Number.isFinite(th)) return;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = PALETTE[ti % PALETTE.length]; ctx.lineWidth = 1;
    const y = yAt(th);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
  });
  ctx.fillText(label + ' ' + peakY.toFixed(1) + '…' + minY.toFixed(1), 8, 20);
  if (targets.length > 1) drawLegend(ctx, targets, w);
}
function drawErrRate(canvas, byTarget, threshold) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0,0,w,h);
  const targets = Object.keys(byTarget || {}).filter(t => (byTarget[t] || []).length);
  if (!targets.length) { ctx.fillText('no apm error data', 10, 20); return; }
  const peak = Math.max(threshold || 0, ...targets.flatMap(t => byTarget[t].map(p => p.value)), 1);
  targets.forEach((t, ti) => {
    const pts = byTarget[t];
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * w; const y = h - ((p.value - 0) / peak) * (h - 20) - 10;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = PALETTE[ti % PALETTE.length]; ctx.lineWidth = 2; ctx.stroke();
  });
  if (threshold != null) {
    // dashed horizontal line at the configured alert threshold
    const y = h - ((threshold - 0) / peak) * (h - 20) - 10;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#d97706'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText('colored=per target error rate  yellow=threshold(' + threshold + ')', 8, 20);
  } else {
    ctx.fillText('colored=per target error rate', 8, 20);
  }
  if (targets.length > 1) drawLegend(ctx, targets, w);
}
function drawStatus(canvas, byTarget) {
  // per-target http status-code history; each point colored by its code class
  // (2xx/3xx green, 4xx yellow, 5xx red) so a flip to error is visible
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0, 0, w, h);
  const targets = Object.keys(byTarget || {}).filter(t => (byTarget[t] || []).length);
  if (!targets.length) { ctx.fillText('no data', 10, 20); return; }
  const codeColor = (v) => (v >= 500 ? '#dc2626' : v >= 400 ? '#f59e0b' : '#22c55e');
  targets.forEach((t, ti) => {
    const pts = byTarget[t];
    const xAt = (i) => (i / (pts.length - 1)) * w;
    const yAt = (v) => h - 12 - (v - 100) / 400 * (h - 20);
    pts.forEach((p, i) => {
      ctx.fillStyle = codeColor(p.value);
      const r = 4;
      ctx.beginPath();
      ctx.arc(xAt(i), yAt(p.value), r, 0, Math.PI * 2);
      ctx.fill();
    });
  });
  ctx.fillStyle = '#7b8aa0';
  ctx.fillText('colored dots=status code history per target', 8, 20);
  ctx.fillText('100', 4, h - 14);
  ctx.fillText('500', 4, 28);
  if (targets.length > 1) drawLegend(ctx, targets, w);
}
function drawApm(canvas, p50By, p95By, threshold) {
  // one solid line (p50) + one dashed line (p95) per APM service
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0,0,w,h);
  const targets = Object.keys(p50By || {}).filter(t => (p50By[t] || []).length);
  if (!targets.length) { ctx.fillText('no apm data (start a demo agent)', 10, 20); return; }
  const all = targets.flatMap(t => p50By[t].concat((p95By[t] || [])));
  const minY = Math.min(...all.map(p => p.value)), maxY = Math.max(...all.map(p => p.value), minY + 1);
  const line = (pts, color, dash) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * w; const y = h - ((p.value - minY) / (maxY - minY)) * (h - 20) - 10;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    if (dash) { ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]); } else ctx.stroke();
  };
  targets.forEach((t, ti) => {
    const c = PALETTE[ti % PALETTE.length];
    if (p50By[t].length) line(p50By[t], c, false);
    if ((p95By[t] || []).length) line(p95By[t], c, true);
  });
  let label = 'solid=p50 dashed=p95';
  if (threshold != null && Number.isFinite(threshold)) {
    // dashed horizontal line at the configured slow-latency threshold
    const y = Math.min(h - 10, Math.max(10, h - ((threshold - minY) / (maxY - minY)) * (h - 20) - 10));
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#d97706'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
    label += '  yellow=slow threshold(' + threshold + 'ms)';
  }
  ctx.fillText(label, 8, 20);
  if (targets.length > 1) drawLegend(ctx, targets, w);
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;

function formatSeries(raw, target) {
  // raw rows: { ts, value }. Convert ts to seconds for plotting scale and
  // tag every point with its target so the browser can draw one line per
  // endpoint instead of merging all targets into a single misleading line.
  return raw.map((r) => ({ target, ts: r.ts / 1000, value: r.value }));
}

function aggStatus(statuses) {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  return statuses.length ? 'ok' : 'unknown';
}

function countStatuses(statuses) {
  const counts = { ok: 0, warn: 0, error: 0, unknown: 0 };
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}

// Monitor self-health persisted by the engine (setMeta). Null when the engine
// has not written it yet, e.g. `serve`/`export` against an empty store.
function healthBlock(store) {
  const h = store.getMeta('health');
  if (!h || !h.value) return null;
  return {
    status: h.value.status || 'unknown',
    uptimeSince: h.value.uptimeSince ?? null,
    lastCheckAt: h.value.lastCheckAt ?? null,
  };
}

export function createUiServer(store, config) {
  const historyMs = (config?.ui?.historySeconds ?? 24 * 3600) * 1000;
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('x-content-type-options', 'nosniff');
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (u.pathname === '/api/states') {
      const since = Date.now() - historyMs;
      const states = store.latestStates(100);
      // per-target series (one line per endpoint in the browser charts)
      const kindTargets = (kind) => [...new Set(states.filter(s => s.kind === kind).map(s => s.target))];
      const seriesByTarget = (kindPrefix, targets, suffix) => {
        const byTarget = {};
        for (const t of targets) byTarget[t] = store.series(`${kindPrefix}${t}/${suffix}`, since, 400);
        return byTarget;
      };
      const httpTargets = kindTargets('http');
      const tlsTargets = kindTargets('tls');
      const apmNames = kindTargets('apm');
      const latSeries = seriesByTarget('http:', httpTargets, 'latency');
      const statusSeries = seriesByTarget('http:', httpTargets, 'status');
      const tlsSeries = seriesByTarget('tls:', tlsTargets, 'remaining');
      const apmP50 = seriesByTarget('apm:', apmNames, 'p50');
      const apmP95 = seriesByTarget('apm:', apmNames, 'p95');
      const apmErr = seriesByTarget('apm:', apmNames, 'errorRate');
      // per-target time-weighted availability over the same history window
      const availabilityMap = {};
      for (const t of httpTargets) {
        availabilityMap[t] = availability(store.history(t, 'http', since));
      }
      const formatByTarget = (map) => {
        const out = {};
        for (const t of Object.keys(map)) out[t] = formatSeries(map[t], t);
        return out;
      };
      // per-target threshold maps, resolved once so both the per-row states and
      // the top-level mirror blocks carry identical values (onceJsonRow
      // latency_threshold_ms / timeout_ms / warn_days_before parity)
      const httpLatThresholdMap = httpLatencyThresholds(config);
      const httpTimeoutMap = httpTimeoutMs(config);
      const httpStatusMap = httpAssertStatusCodes(config);
      const httpBodyMap = httpAssertBodyIncludes(config);
      const tlsWarnMap = tlsWarnDaysBefore(config);
      const tlsTimeoutMap = tlsTimeoutMs(config);
      // per-target run-cadence maps (the intervalSeconds the engine's scheduler
      // actually runs each check on, entry beats scheduler-wide default):
      // resolved once so the per-row interval_seconds and the top-level `http:`
      // / `tls:` mirror blocks carry identical values (inc 71 parity).
      const httpIntMap = httpIntervalSeconds(config);
      const tlsIntMap = tlsIntervalSeconds(config);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        states: states.map((s) => {
          // per-row time-weighted availability for http snapshots, drawn from
          // the same per-target window the top-level `availability` map carries
          // (export.js:43 + once --json parity: pct null on a zero-width
          // window, breakdown only when totalMs > 0). Null off-kind.
          const avail = s.kind === 'http' ? availabilityMap[s.target] : null;
          return {
            target: s.target, kind: s.kind, status: s.status,
            latency_ms: s.latency_ms, detail: s.detail, ts: s.ts,
            method: s.method ?? null,              // http only
            status_code: s.status_code ?? null,    // http only
            // the judged-against assert criteria this probe is measured against,
            // re-resolved from the same config the engine stamps onto each
            // checkEndpoint result and once --json rows surface (onceJsonRow
            // expected_status_code / body_includes parity). Null off-kind /
            // unconfigured.
            expected_status_code: s.kind === 'http' ? (httpStatusMap[s.target] ?? null) : null, // http only
            body_includes: s.kind === 'http' ? (httpBodyMap[s.target] ?? null) : null,           // http only
            days_remaining: s.days_remaining ?? null,     // tls only
            chain: s.chain_json ? JSON.parse(s.chain_json) : null,   // tls only
            valid_chain: s.valid_chain == null ? null : !!s.valid_chain, // tls only
            leaf_subject: s.leaf_subject ?? null, // tls only
            p50_ms: s.p50_ms ?? null,                     // apm only
            p95_ms: s.p95_ms ?? null,                     // apm only
            error_rate: s.error_rate ?? null,             // apm only
            errors: s.errors ?? null,                     // apm only
            samples: s.samples ?? null,                   // apm only
            // the apm warn criteria this row was judged against, re-resolved
            // from the same config the engine stamps onto each runApmCheck
            // result and once --json rows surface (onceJsonRow
            // error_rate_threshold / latency_threshold_ms parity). Null
            // off-kind. Config-global, so no per-target map lookup.
            error_rate_threshold: s.kind === 'apm' ? (config?.apm?.errorRateThreshold ?? 0.05) : null,
            // the per-check judged-against threshold / abort timeout, resolved
            // from the same per-target maps the http: / tls: mirror blocks
            // carry (onceJsonRow latency_threshold_ms / timeout_ms /
            // warn_days_before parity — one latency_ms-family field shared by
            // http per-target and apm config-global, matching once --json).
            // Null off-kind / unconfigured.
            latency_threshold_ms:
              s.kind === 'apm' ? (config?.apm?.latencyThresholdMs ?? null)
              : s.kind === 'http' ? (httpLatThresholdMap[s.target] ?? null)
              : null,
            timeout_ms:
              s.kind === 'http' ? (httpTimeoutMap[s.target] ?? null)
              : s.kind === 'tls' ? (tlsTimeoutMap[s.target] ?? null)
              : null,
            warn_days_before: s.kind === 'tls' ? (tlsWarnMap[s.target] ?? null) : null, // tls only
            // the per-check run cadence the scheduler uses for this target (the
            // intervalSeconds the engine's taskIntervalMs runs on, entry beats
            // kind default; once --json / export JSON / mirror-block parity).
            // Null off-kind.
            interval_seconds:
              s.kind === 'http' ? (httpIntMap[s.target] ?? null)
              : s.kind === 'tls' ? (tlsIntMap[s.target] ?? null)
              : null,
            uptime_pct: avail && avail.pct != null ? avail.pct : null, // http only
            uptime_ms: avail && avail.totalMs > 0        // http only
              ? { up_ms: avail.upMs, down_ms: avail.downMs, total_ms: avail.totalMs, samples: avail.samples }
              : null,
          };
        }),
        summary: {
          overall: aggStatus(states.map((s) => s.status)),
          counts: countStatuses(states.map((s) => s.status)),
          updated_at: Date.now(),
        },
        apm: { collect: config?.apm?.collect === true, errorRateThreshold: config?.apm?.errorRateThreshold ?? 0.05, latencyThresholdMs: config?.apm?.latencyThresholdMs ?? null, windowMs: config?.apm?.windowMs ?? 60_000, maxSamples: config?.apm?.maxSamples ?? 5000 },
        http: { latencyThresholds: httpLatencyThresholds(config), timeoutMs: httpTimeoutMs(config), assertStatusCodes: httpAssertStatusCodes(config), assertBodyIncludes: httpAssertBodyIncludes(config), intervalSeconds: httpIntervalSeconds(config) },
        tls: { warnDaysBefore: tlsWarnDaysBefore(config), timeoutMs: tlsTimeoutMs(config), intervalSeconds: tlsIntervalSeconds(config) },
        store: { retentionDays: retentionDays(config?.store) },
        notifications: { repeatIntervalSeconds: config?.notifications?.repeatIntervalSeconds ?? 3600, desktop: notificationsDesktop(config), webhook: notificationsWebhookEnabled(config), email: notificationsEmailEnabled(config) },
        scheduler: schedulerIntervals(config),
        ui: { historySeconds: uiHistorySeconds(config) },
        availability: availabilityMap,
        health: healthBlock(store),
        series: {
          'http:latency': formatByTarget(latSeries),
          'http:status': formatByTarget(statusSeries),
          'tls:remaining': formatByTarget(tlsSeries),
          'apm:p50': formatByTarget(apmP50),
          'apm:p95': formatByTarget(apmP95),
          'apm:errorRate': formatByTarget(apmErr),
        },
      }, null, 2));
      return;
    }
    if (u.pathname === '/api/events') {
      const events = store.recentEvents(50).map((e) => ({
        ts: e.ts, level: e.level, source: e.source, message: e.message,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ events }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return server;
}
