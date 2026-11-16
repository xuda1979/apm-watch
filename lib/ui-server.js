// Web UI: single-page live status + history curves. Serves a static HTML and
// a JSON API backed directly by the store.

import { createServer } from 'node:http';

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
<section><h3>tls days-remaining</h3><canvas id="cTls"></canvas></section>
<section><h3>apm p50/p95</h3><canvas id="cApm"></canvas></section>
<section id="eventsSec"><h3>recent events</h3><table><thead><tr><th>time</th><th>level</th><th>source</th><th>message</th></tr></thead><tbody id="evtBody"></tbody></table></section>
  </div>
</div>
<script>
const $ = (s) => document.querySelector(s);
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function refresh() {
  try {
    const res = await fetch('/api/states');
    const data = await res.json();
    $('tbody').innerHTML = data.states.map(s => \`<tr><td>\${esc(s.target)}</td><td><span class="pill \${'ok warn error unknown'.includes(s.status) ? esc(s.status) : 'unknown'}">\${esc(s.status)}</span></td><td>\${esc(s.kind)}</td><td>\${s.latency_ms != null ? s.latency_ms.toFixed(0) + ' ms' : '—'}</td><td>\${esc(s.detail)}</td></tr>\`).join('');
    const c = data.summary.counts || {};
    $('pillbox').innerHTML = ['ok','warn','error'].map(k => \`<span class="pill \${k}">\${k} <span class="count">\${c[k] || 0}</span></span>\`).join('')
      + \` <span class="pill unknown">overall \${esc(data.summary.overall)}</span>\`;
    drawLines($('#cLat'), data.series['http:latency'], 'latency ms');
    drawLines($('#cTls'), data.series['tls:remaining'], 'days');
    drawApm($('#cApm'), data.series['apm:p50'], data.series['apm:p95']);
  } catch (e) { $('tbody').innerHTML = '<tr><td colspan=5>error: ' + esc(e) + '</td></tr>'; }
  try {
    const ev = await (await fetch('/api/events')).json();
    $('evtBody').innerHTML = (ev.events || []).map(e => \`<tr><td>\${new Date(e.ts).toLocaleTimeString()}</td><td><span class="pill \${esc(e.level)}">\${esc(e.level)}</span></td><td>\${esc(e.source)}</td><td>\${esc(e.message)}</td></tr>\`).join('');
  } catch (e) { $('evtBody').innerHTML = '<tr><td colspan=4>events unavailable: ' + esc(e) + '</td></tr>'; }
}
function drawLines(canvas, pts, label) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0,0,w,h);
  if (!pts || !pts.length) { ctx.fillText('no data', 10, 20); return; }
  const xs = pts.map(p => p.ts); const ys = pts.map(p => p.value);
  const minY = Math.min(...ys), maxY = Math.max(...ys, minY + 1);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = (i / (pts.length - 1)) * w; const y = h - ((p.value - minY) / (maxY - minY)) * (h - 20) - 10;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillText(label + ' ' + maxY.toFixed(1) + '…' + minY.toFixed(1), 8, 20);
}
function drawApm(canvas, p50, p95) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0,0,w,h);
  if (!p50 || !p50.length) { ctx.fillText('no apm data (start a demo agent)', 10, 20); return; }
  const draw = (pts, color) => {
    const ys = pts.map(p => p.value); const minY = Math.min(...ys), maxY = Math.max(...ys, minY + 1);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * w; const y = h - ((p.value - minY) / (maxY - minY)) * (h - 20) - 10;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  };
  draw(p50, '#22c55e'); draw(p95, '#ef4444');
  ctx.fillText('green=p50 red=p95', 8, 20);
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;

function formatSeries(raw) {
  // raw rows: { ts, value }. Convert ts to seconds for plotting scale.
  return raw.map((r) => ({ ts: r.ts / 1000, value: r.value }));
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
      // pick per-target series
      const httpTargets = [...new Set(states.filter(s => s.kind === 'http').map(s => s.target))];
      const latSeries = httpTargets.map(t => (store.series(`http:${t}/latency`, since, 400))).flat(1);
      const tlsTargets = [...new Set(states.filter(s => s.kind === 'tls').map(s => s.target))];
      const tlsSeries = tlsTargets.map(t => store.series(`tls:${t}/remaining`, since, 400)).flat(1);
      const apmNames = [...new Set(states.filter(s => s.kind === 'apm').map(s => s.target))];
      const apmP50 = apmNames.map(n => store.series(`apm:${n}/p50`, since, 400)).flat(1);
      const apmP95 = apmNames.map(n => store.series(`apm:${n}/p95`, since, 400)).flat(1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        states: states.map((s) => ({
          target: s.target, kind: s.kind, status: s.status,
          latency_ms: s.latency_ms, detail: s.detail, ts: s.ts,
        })),
        summary: {
          overall: aggStatus(states.map((s) => s.status)),
          counts: countStatuses(states.map((s) => s.status)),
          updated_at: Date.now(),
        },
        series: {
          'http:latency': formatSeries(latSeries),
          'tls:remaining': formatSeries(tlsSeries),
          'apm:p50': formatSeries(apmP50),
          'apm:p95': formatSeries(apmP95),
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
