// Engine: owns the store, runs http+tls+apm checks on the scheduler grid,
// collects APM spans, maintains a dedup'd alerting loop.

import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { Scheduler, MIN_INTERVAL_S, MAX_INTERVAL_S } from './scheduler.js';
import { checkEndpoint } from './check-http.js';
import { fetchCertChain, netChainToReport, inspectPemChain } from './check-tls.js';
import { ApmCollector } from './apm.js';
import { desktopNotification, webhookNotification, emailNotification } from './notify.js';

export { MIN_INTERVAL_S, MAX_INTERVAL_S, configSeconds, retentionDays, toDays };

// Self-health status decays: worst status among checks recorded in the last
// window. Long enough to cover the slowest check interval (5m max) twice.
const HEALTH_WINDOW_MS = 10 * 60 * 1000;

export class Engine {
  constructor({ store, config, log = console.log.bind(console) } = {}) {
    this.store = store || new Store(config?.store?.path || ':memory:');
    this.config = config || {};
    this.log = log;
    this.scheduler = new Scheduler({ log });
    this.collector = new ApmCollector({
      log,
      windowMs: config?.apm?.windowMs ?? 60_000,
      maxSamples: config?.apm?.maxSamples ?? 5000,
    });
    this.alertState = new Map();
    this.health = { recent: [], lastCheckAt: null, uptimeSince: Date.now() };
  }

  // Record one check outcome and keep the monitor's self-health fresh: worst
  // status within the window, latest check timestamp, process uptime start.
  _noteHealth(status) {
    const now = Date.now();
    this.health.lastCheckAt = now;
    this.health.recent = [...this.health.recent, { status, ts: now }]
      .filter((p) => now - p.ts <= HEALTH_WINDOW_MS);
    this.health.status = worstStatus(this.health.recent.map((p) => p.status));
  }

  // Persist the monitor's self-health so the web/tui/export surfaces can show
  // "up since / last check / monitor status". Called by every check path
  // (scheduler tasks and tick), so `run` keeps it as live as the checks.
  persistHealth() {
    this.store.setMeta('health', {
      status: this.health.status || 'ok',
      uptimeSince: this.health.uptimeSince,
      lastCheckAt: this.health.lastCheckAt,
    });
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
      method: result.method,
      statusCode: result.statusCode,
    });
    if (result.latencyMs != null) this.store.saveMetric(`http:${result.target}/latency`, result.latencyMs);
    if (result.statusCode != null) this.store.saveMetric(`http:${result.target}/status`, result.statusCode);
    this._noteHealth(result.status);
    this.persistHealth();
    this.log(`http ${result.status} ${result.target} ${result.latencyMs?.toFixed(0)}ms`);
    return result;
  }

  async runTlsCheck(cfg) {
    let report;
    try {
      if (cfg.pemFile) {
        // Local bundle check: read the PEM file instead of opening a socket,
        // so expired/offline hosts' certs can still be watched.
        const pem = readFileSync(cfg.pemFile, 'utf8');
        report = { host: cfg.pemFile, port: null, ...inspectPemChain(pem) };
      } else {
        const { certs } = await fetchCertChain(cfg);
        report = netChainToReport({ host: cfg.host, port: cfg.port || 443, certs });
      }
    } catch (err) {
      report = { host: cfg.host || cfg.pemFile || '?', port: cfg.port ?? null, daysRemaining: null, chain: [], validChain: false, error: err.message };
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

    const target = cfg.name || (cfg.pemFile ? cfg.pemFile : `${cfg.host}:${cfg.port || 443}`);
    const chain = report.chain ?? (report.error ? [] : []);
    const validChain = report.validChain ?? (chain.length > 0 ? true : null);
    const leafSubject = report.leafSubject ?? chain[0]?.subject ?? null;
    this.store.saveState({ target, kind: 'tls', status, detail, daysRemaining: days, chain, validChain, leafSubject });
    if (days !== null && days !== undefined) this.store.saveMetric(`tls:${target}/remaining`, days);
    this._noteHealth(status);
    this.persistHealth();
    this.log(`tls ${status} ${target} ${detail}`);
    // timeoutMs: the cert-fetch socket timeout the check was actually aborted
    // by (default 5000, resolved in check-tls.js) — surfaces on once --json
    // rows just like the per-http timeoutMs; never persisted (no store column).
    return { status, target, kind: 'tls', detail, daysRemaining: days, chain, validChain, leafSubject, warnDaysBefore: threshold, timeoutMs: cfg.timeoutMs ?? 5000, ts: Date.now() };
  }

  async runApmCheck() {
    const summary = this.collector.summary();
    const now = Date.now();
    const results = [];
    for (const [name, s] of Object.entries(summary)) {
      this.store.saveMetric(`apm:${name}/p50`, s.p50, now);
      this.store.saveMetric(`apm:${name}/p95`, s.p95, now);
      this.store.saveMetric(`apm:${name}/errorRate`, s.errorRate, now);
      const errorRateThreshold = this.config.apm?.errorRateThreshold ?? 0.05;
      const latencyThresholdMs = this.config.apm?.latencyThresholdMs;
      const rateWarn = s.errorRate >= errorRateThreshold;
      const latencyWarn = latencyThresholdMs && Number.isFinite(s.p95) && s.p95 >= latencyThresholdMs;
      const status = rateWarn || latencyWarn ? 'warn' : 'ok';
      const result = {
        target: name,
        kind: 'apm',
        status,
        ts: now,
        latencyMs: s.p95,
        p50Ms: s.p50,
        p95Ms: s.p95,
        errorRate: s.errorRate,
        errors: s.errors,
        samples: s.samples,
        // the sampling window this result was collected over, so once rows and
        // the storageless surfaces can surface it without a store column
        // (apm.js summary() windowMs precedent)
        windowMs: this.collector.windowMs,
        // the thresholds this result was judged against, so once --json rows /
        // surfaces know the warn criteria without re-resolving the config
        // (runTlsCheck's warnDaysBefore stamping precedent)
        errorRateThreshold,
        latencyThresholdMs,
        // every human surface (web table, export page, TUI row, once rows,
        // alerts/events) renders this detail verbatim, so mark *why* a warn
        // fired: latency cause keeps the inc-prior `(slow p95)` shape, the
        // rate cause gets its own parallel marker instead of a bare prose copy.
        detail: `p50=${s.p50}ms p95=${s.p95}ms errors=${s.errors}/${s.samples}${rateWarn ? ` (err rate ${(s.errorRate * 100).toFixed(0)}% >= ${(errorRateThreshold * 100).toFixed(0)}%)` : ''}${latencyWarn ? ' (slow p95)' : ''}`,
      };
      this.store.saveState(result);
      results.push(result);
    }
    this._noteHealth(results.length ? worstStatus(results.map((r) => r.status)) : 'ok');
    this.persistHealth();
    return { summary, results };
  }

  // Run the APM summary, then route each service through the alert pipeline so
  // slow/erroring services notify + hit the event log, like http/tls checks.
  async runApmCheckWithAlerts() {
    const { results } = await this.runApmCheck();
    for (const r of results) {
      const a = this.maybeAlert(r);
      if (a.send) await this.deliverAlert(a);
    }
    return results.length;
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
    if (this.config.apm?.collect) await this.runApmCheckWithAlerts();
    // Each check call already recorded + persisted health; re-persist so the
    // meta always reflects the freshest possible snapshot even on silent ticks.
    this.persistHealth();
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
    for (const h of this.config.http || []) {
      const id = `http:${h.name || h.url}`;
      tasks.push({
        id,
        intervalMs: taskIntervalMs(h, this.config.scheduler?.httpIntervalSeconds, 60),
        initialDelayMs: Math.floor(Math.random() * 2000),
        run: async () => {
          const r = await this.runHttpCheck(h);
          const a = this.maybeAlert(r);
          if (a.send) await this.deliverAlert(a);
        },
      });
    }
    for (const t of this.config.tls || []) {
      const id = `tls:${t.name || (t.pemFile ? t.pemFile : t.host + ':' + t.port)}`;
      tasks.push({
        id,
        intervalMs: taskIntervalMs(t, this.config.scheduler?.tlsIntervalSeconds, 300),
        initialDelayMs: Math.floor(Math.random() * 3000),
        run: async () => {
          const r = await this.runTlsCheck(t);
          const a = this.maybeAlert(r);
          if (a.send) await this.deliverAlert(a);
        },
      });
    }
    if (this.config.apm?.collect) {
      const apmInterval = taskIntervalMs({}, this.config.scheduler?.apmIntervalSeconds, 60);
      tasks.push({
        id: 'apm:summary',
        intervalMs: apmInterval,
        initialDelayMs: 1500,
        run: async () => { await this.runApmCheckWithAlerts(); },
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

// Worst of the ok/warn/error status set (error > warn > ok) for the monitor's
// own self-health summary.
function worstStatus(statuses) {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

// Effective interval for one check task: per-check `intervalSeconds` beats the
// scheduler-wide default, falling back to a hard default if neither is set.
function taskIntervalMs(task, defaultSeconds, fallbackSeconds) {
  const v = task?.intervalSeconds ?? defaultSeconds;
  return clampIntervalSeconds(configSeconds(v)) * 1000 || fallbackSeconds * 1000;
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
