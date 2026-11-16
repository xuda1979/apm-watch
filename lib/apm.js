// APM: local collector for agent-reported latency/error samples.
// Demo services POST /apm/agent/trace {name, latency_ms, error} — the collector
// buffers recent spans and computes p50/p95 over a window.

import { createServer } from 'node:http';
import { extentPercentiles } from './stats.js';

export class ApmCollector {
  constructor({ maxSamples = 5000, windowMs = 60_000, log = null, now = Date.now } = {}) {
    this.maxSamples = maxSamples;
    this.windowMs = windowMs;
    this.log = log;
    this.now = now;
    this.samples = new Map();  // name -> [{ts, latencyMs, error}]
    this.rejected = 0;
  }

  add(name, latencyMs, isError = false, ts = this.now()) {
    if (!this.samples.has(name)) this.samples.set(name, []);
    const arr = this.samples.get(name);
    arr.push({ ts, latencyMs, error: isError });
    if (arr.length > this.maxSamples) {
      arr.splice(0, arr.length - this.maxSamples);
    }
    this._prune(name, ts);
  }

  _prune(name, nowTs) {
    const arr = this.samples.get(name);
    if (!arr) return;
    const cutoff = nowTs - this.windowMs;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
    if (!arr.length) this.samples.delete(name);
  }

  prune(nowTs = this.now()) {
    for (const name of [...this.samples.keys()]) {
      this._prune(name, nowTs);
    }
  }

  summary() {
    const now = this.now();
    this.prune(now);
    const out = {};
    for (const [name, arr] of this.samples) {
      const latencies = arr.map((s) => s.latencyMs);
      const errors = arr.filter((s) => s.error).length;
      const [p50, p95] = extentPercentiles(latencies, [50, 95]);
      out[name] = {
        samples: arr.length,
        errors,
        errorRate: arr.length ? errors / arr.length : 0,
        p50,
        p95,
        windowMs: this.windowMs,
      };
    }
    return out;
  }

  // HTTP handler: accept spans from demo service agent.
  attach(server, handlerPrefix = '/apm/agent/trace') {
    const self = this;
    const prev = server.listeners('request');
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (!req.url.startsWith(handlerPrefix)) {
        // delegate to prior handlers
        for (const h of prev) { try { h(req, res); } catch {} }
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
      req.on('end', () => {
        let payload;
        try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
        const name = payload.name || 'demo';
        const latencyMs = Number(payload.latency_ms ?? payload.latency) || 0;
        const isError = Boolean(payload.error) || payload.error === true;
        self.add(name, latencyMs, isError);
        if (self.log) self.log(`apm trace ${name} ${latencyMs}ms${isError ? ' ERR' : ''}`);
        res.writeHead(204).end();
      });
      req.on('error', () => { res.writeHead(400).end(); });
    });
    return server;
  }
}
