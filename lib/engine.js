// Engine: owns the store, runs http+tls+apm checks on the scheduler grid,
// collects APM spans, maintains a dedup'd alerting loop.

import { Store } from './store.js';
import { Scheduler, MIN_INTERVAL_S, MAX_INTERVAL_S } from './scheduler.js';
import { checkEndpoint } from './check-http.js';
import { fetchCertChain, netChainToReport } from './check-tls.js';
import { ApmCollector } from './apm.js';
import { desktopNotification, webhookNotification, emailNotification } from './notify.js';

export { MIN_INTERVAL_S, MAX_INTERVAL_S };

export class Engine {
  constructor({ store, config, log = console.log.bind(console) } = {}) {
    this.store = store || new Store(config?.store?.path || ':memory:');
    this.config = config || {};
    this.log = log;
    this.scheduler = new Scheduler({ log });
    this.collector = new ApmCollector({ log });
    this.alertState = new Map();
    this.health = { lastCheckAt: null, uptimeSince: Date.now() };
  }

  // ---------- individual checks ----------
  async runHttpCheck(cfg) {
    const result = await checkEndpoint(cfg);
    this.store.saveState({
      target: result.target,
      kind: 'http',
      status: result.status,
      latencyMs: result.latencyMs,
      detail: result.detail,
    });
    if (result.latencyMs != null) this.store.saveMetric(`http:${result.target}/latency`, result.latencyMs);
    if (result.statusCode != null) this.store.saveMetric(`http:${result.target}/status`, result.statusCode);
    this.log(`http ${result.status} ${result.target} ${result.latencyMs?.toFixed(0)}ms`);
    return result;
  }

  async runTlsCheck(cfg) {
    let report;
    try {
      const { certs } = await fetchCertChain(cfg);
      report = netChainToReport({ host: cfg.host, port: cfg.port || 443, certs });
    } catch (err) {
      report = { host: cfg.host, port: cfg.port || 443, daysRemaining: null, chain: [], validChain: false, error: err.message };
    }
    const threshold = cfg.warnDaysBefore ?? this.config.tls?.warnDaysBefore ?? 30;
    const days = report.daysRemaining;
    let status = 'ok';
    let detail = '';
    if (report.error) status = 'error', detail = report.error;
    else if (days === null) status = 'error', detail = 'no certificate';
    else if (days <= 0) status = 'error', detail = `EXPIRED ${-days}d ago`;
    else if (days <= threshold) status = 'warn', detail = `expires in ${days}d (threshold ${threshold}d)`;
    else status = 'ok', detail = `expires in ${days}d`;

    const target = cfg.name || `${cfg.host}:${cfg.port || 443}`;
    this.store.saveState({ target, kind: 'tls', status, detail });
    if (days !== null && days !== undefined) this.store.saveMetric(`tls:${target}/remaining`, days);
    this.log(`tls ${status} ${target} ${detail}`);
    return { status, target, kind: 'tls', detail, daysRemaining: days, chain: report.chain };
  }

  async runApmCheck() {
    const summary = this.collector.summary();
    const now = Date.now();
    for (const [name, s] of Object.entries(summary)) {
      this.store.saveMetric(`apm:${name}/p50`, s.p50, now);
      this.store.saveMetric(`apm:${name}/p95`, s.p95, now);
      this.store.saveMetric(`apm:${name}/errorRate`, s.errorRate, now);
      const errorRateThreshold = this.config.apm?.errorRateThreshold ?? 0.05;
      const latencyThresholdMs = this.config.apm?.latencyThresholdMs;
      const status =
        s.errorRate >= errorRateThreshold ||
        (latencyThresholdMs && Number.isFinite(s.p95) && s.p95 >= latencyThresholdMs)
          ? 'warn'
          : 'ok';
      this.store.saveState({
        target: name, kind: 'apm', status,
        latencyMs: s.p95,
        detail: `p50=${s.p50}ms p95=${s.p95}ms errors=${s.errors}/${s.samples}${status === 'warn' && s.errorRate < errorRateThreshold ? ' (slow p95)' : ''}`,
      });
    }
    return summary;
  }

  // ---------- alerting (dedup + channels) ----------
  maybeAlert(result) {
    const key = `${result.kind}:${result.target}`;
    const prev = this.alertState.get(key);
    const repeatMs = (this.config.notifications?.repeatIntervalSeconds ?? 3600) * 1000;
    const now = Date.now();
    if (result.status !== 'ok') {
      const freshen = prev && now - prev.lastTs > repeatMs;
      const shouldSend = !prev || prev.status !== result.status || freshen;
      this.alertState.set(key, { status: result.status, lastTs: shouldSend ? now : prev.lastTs, count: (prev?.count || 0) + 1 });
      return { ...result, send: shouldSend };
    }
    const recovered = prev && prev.status !== 'ok';
    this.alertState.set(key, { status: 'ok', lastTs: now, count: 0 });
    return { ...result, send: recovered };
  }

  async deliverAlert(r) {
    if (r.status === 'ok') {
      this.store.addEvent('info', r.kind, `${r.target}: recovered`);
      return this.notifyFn({ ...r, detail: `RECOVERED: ${r.detail || ''}` });
    }
    this.store.addEvent('warn', r.kind, `${r.target}: ${r.detail}`);
    return this.notifyFn(r);
  }

  async _defaultNotify({ kind, target, status, detail }) {
    const title = `apm-watch ${kind} ${status.toUpperCase()} — ${target}`;
    const n = this.config.notifications || {};
    const results = [];
    if (n.desktop !== false) {
      try { results.push(await desktopNotification({ title, message: detail || '', urgency: status === 'error' ? 'critical' : 'normal' })); }
      catch (err) { this.log(`notify desktop failed: ${err.message}`); }
    }
    if (n.webhook?.url) {
      const res = await webhookNotification(n.webhook.url, { kind, target, status, detail, ts: Date.now() });
      if (!res.ok) this.log(`notify webhook failed: ${JSON.stringify(res)}`);
    }
    if (n.email?.host) {
      try {
        const res = await emailNotification({ ...n.email, subject: `apm-watch: ${kind} ${status} ${target}` });
        if (!res.ok) this.log(`notify email failed: ${JSON.stringify(res)}`);
      } catch (err) { this.log(`notify email failed: ${err.message}`); }
    }
    return results;
  }

  get notifyFn() { return this._notifyFn || this._defaultNotify.bind(this); }
  set notifyFn(f) { this._notifyFn = f; }

  // ---------- wiring ----------
  start() {
    const config = this.config;
    this.scheduler.start(this.buildTasks());
  }

  // Run every configured check once immediately (used by `once` and tests).
  async tick() {
    const runs = [];
    for (const h of this.config.http || []) {
      runs.push(this.runHttpCheck(h).then((r) => ({ r, k: 'http' })));
    }
    for (const t of this.config.tls || []) {
      runs.push(this.runTlsCheck(t).then((r) => ({ r, k: 'tls' })));
    }
    const settled = await Promise.allSettled(runs);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        const a = this.maybeAlert(s.value.r);
        if (a.send) await this.deliverAlert(a);
      }
    }
    if (this.config.apm?.collect) await this.runApmCheck();
    this.health.lastCheckAt = this.health.lastCheckAt || Date.now();
  }

  buildTasks() {
    const tasks = [];
    // SQLite retention: prune old metrics/states/events on a slow cadence so a
    // long-running monitor never grows unbounded. Default: keep 7d of history.
    const retentionMs = retentionMsFrom(this.config.store);
    tasks.push({
      id: 'store:prune',
      intervalMs: 3600e3,
      initialDelayMs: 60_000,
      run: async () => {
        const cutoff = Date.now() - retentionMs;
        const n =
          this.store.pruneMetrics(cutoff) +
          this.store.pruneStates(cutoff) +
          this.store.pruneEvents(cutoff);
        if (n) this.log(`pruned ${n} rows older than ${retentionDays(this.config.store)}d`);
      },
    });
    const httpInterval = clampIntervalSeconds(configSeconds(this.config.scheduler?.httpIntervalSeconds)) * 1000 || 60_000;
    for (const h of this.config.http || []) {
      const id = `http:${h.name || h.url}`;
      tasks.push({
        id,
        intervalMs: httpInterval,
        initialDelayMs: Math.floor(Math.random() * 2000),
        run: async () => {
          const r = await this.runHttpCheck(h);
          const a = this.maybeAlert(r);
          if (a.send) await this.deliverAlert(a);
        },
      });
    }
    const tlsInterval = clampIntervalSeconds(configSeconds(this.config.scheduler?.tlsIntervalSeconds)) * 1000 || 300_000;
    for (const t of this.config.tls || []) {
      const id = `tls:${t.name || t.host + ':' + t.port}`;
      tasks.push({
        id,
        intervalMs: tlsInterval,
        initialDelayMs: Math.floor(Math.random() * 3000),
        run: async () => {
          const r = await this.runTlsCheck(t);
          const a = this.maybeAlert(r);
          if (a.send) await this.deliverAlert(a);
        },
      });
    }
    if (this.config.apm?.collect) {
      const apmInterval = clampIntervalSeconds(configSeconds(this.config.scheduler?.apmIntervalSeconds)) * 1000 || 60_000;
      tasks.push({
        id: 'apm:summary',
        intervalMs: apmInterval,
        initialDelayMs: 1500,
        run: async () => { await this.runApmCheck(); },
      });
    }
    return tasks;
  }

  stop() { this.scheduler.stop(); }
}

function clampIntervalSeconds(v) {
  if (!v || !Number.isFinite(v)) return null;
  return Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, v));
}

function configSeconds(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)(h|d|m|s)?$/i);
    if (!m) return Number.NaN;
    const n = Number(m[1]);
    const u = (m[2] || 's').toLowerCase();
    return n * (u === 'd' ? 86400 : u === 'h' ? 3600 : u === 'm' ? 60 : 1);
  }
  return null;
}

function retentionDays(storeCfg) {
  const days = toDays(storeCfg?.retentionDays ?? 7);
  return Number.isFinite(days) && days > 0 ? days : 7;
}

function retentionMsFrom(storeCfg) {
  return retentionDays(storeCfg) * 86400e3;
}

// Retention is expressed in days (plain number, or a unit string like "48h"/"1w").
function toDays(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)(w|d|h)?$/i);
    if (!m) return Number.NaN;
    const n = Number(m[1]);
    const u = (m[2] || 'd').toLowerCase();
    return n * (u === 'w' ? 7 : u === 'h' ? 1 / 24 : 1);
  }
  return Number.NaN;
}
