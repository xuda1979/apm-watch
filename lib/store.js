// SQLite storage layer. Wraps node:sqlite (built-in DatabaseSync).
// Tables: states (status snapshots), metrics (time series for curves),
// events (alert/audit log).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'http' | 'tls' | 'apm'
  status TEXT NOT NULL,          -- 'ok' | 'warn' | 'error' | 'unknown'
  latency_ms REAL,
  detail TEXT,
  method TEXT,                  -- http only
  status_code REAL,             -- http only
  days_remaining REAL,          -- tls only
  chain_json TEXT,              -- tls only: [{subject,issuer,notAfter,daysRemaining,selfSigned}]
  valid_chain INTEGER,          -- tls only
  leaf_subject TEXT,            -- tls only
  p50_ms REAL,                  -- apm only
  error_rate REAL,              -- apm only
  errors INTEGER,               -- apm only
  samples INTEGER               -- apm only
);
CREATE INDEX IF NOT EXISTS idx_states_target_ts ON states(target, ts);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key TEXT NOT NULL,             -- e.g. 'http:api/p50', 'tls:certs/remaining'
  value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_key_ts ON metrics(key, ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,           -- 'info' | 'warn' | 'error'
  source TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`;

export class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this._migrate();
    this.now = () => Date.now();
  }

  // Older on-disk DBs were created without the numeric per-kind columns on the
  // states table (CREATE TABLE IF NOT EXISTS won't add them). ALTER in place so
  // an upgraded binary keeps the existing history.
  _migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(states)').all().map((c) => c.name));
    const add = {
      method: 'TEXT', status_code: 'REAL', days_remaining: 'REAL', chain_json: 'TEXT',
      valid_chain: 'INTEGER', leaf_subject: 'TEXT', p50_ms: 'REAL',
      error_rate: 'REAL', errors: 'INTEGER', samples: 'INTEGER',
    };
    for (const [name, type] of Object.entries(add)) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE states ADD COLUMN ${name} ${type}`);
    }
  }

  // Break DB/driver abstraction only in tests; clock injection.
  setClock(fn) { this.now = fn; }

  close() { try { this.db.close(); } catch {} }

  // ---- states -----------------------------------------------------------
  saveState({ target, kind, status, latencyMs = null, detail = null, method = null, statusCode = null, daysRemaining = null, chain = null, validChain = null, leafSubject = null, p50Ms = null, errorRate = null, errors = null, samples = null }) {
    this.db.prepare(
      'INSERT INTO states (ts, target, kind, status, latency_ms, detail, method, status_code, days_remaining, chain_json, valid_chain, leaf_subject, p50_ms, error_rate, errors, samples) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      this.now(), target, kind, status, latencyMs ?? null, detail ?? null,
      method ?? null, statusCode ?? null, daysRemaining ?? null,
      chain && chain.length ? JSON.stringify(chain) : null,
      validChain == null ? null : (validChain ? 1 : 0),
      leafSubject ?? null, p50Ms ?? null,
      errorRate ?? null, errors ?? null, samples ?? null,
    );
  }

  latestStates(limit = null) {
    const q = limit
      ? 'SELECT * FROM states WHERE id IN (SELECT MAX(id) FROM states GROUP BY target, kind) ORDER BY id DESC LIMIT ?'
      : 'SELECT * FROM states WHERE id IN (SELECT MAX(id) FROM states GROUP BY target, kind) ORDER BY id DESC';
    return limit ? this.db.prepare(q).all(limit) : this.db.prepare(q).all();
  }

  history(target, kind, sinceTs, limit = 200) {
    return this.db
      .prepare('SELECT ts, status, latency_ms, detail, method, status_code, days_remaining, chain_json, valid_chain, leaf_subject, p50_ms, error_rate, errors, samples FROM states WHERE target=? AND kind=? AND ts>=? ORDER BY ts ASC LIMIT ?')
      .all(target, kind, sinceTs, limit);
  }

  // ---- metrics ----------------------------------------------------------
  saveMetric(key, value, ts = this.now()) {
    this.db.prepare('INSERT INTO metrics (ts, key, value) VALUES (?,?,?)').run(ts, key, value);
  }

  series(key, sinceTs, limit = 300) {
    // Latest `limit` points within the window, in ascending time order for
    // plotting (fetch newest N desc, then reverse).
    const rows = this.db
      .prepare('SELECT ts, value FROM metrics WHERE key=? AND ts>=? ORDER BY ts DESC LIMIT ?')
      .all(key, sinceTs, limit);
    return rows.reverse();
  }

  // ---- events -----------------------------------------------------------
  addEvent(level, source, message) {
    this.db.prepare('INSERT INTO events (ts, level, source, message) VALUES (?,?,?,?)')
      .run(this.now(), level, source, message);
  }

  recentEvents(limit = 50) {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---- meta (small key/value for monitor self-description) -----------------
  setMeta(key, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.db.prepare(
      'INSERT OR REPLACE INTO meta (key, value, ts) VALUES (?,?,?)'
    ).run(key, text, this.now());
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value, ts FROM meta WHERE key=?').get(key);
    if (!row) return null;
    let value = row.value;
    try { value = JSON.parse(value); } catch { /* plain string */ }
    return { value, ts: row.ts };
  }

  // ---- retention --------------------------------------------------------
  pruneMetrics(olderThanTs) {
    return this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(olderThanTs).changes;
  }
  pruneStates(olderThanTs) {
    return this.db.prepare('DELETE FROM states WHERE ts < ?').run(olderThanTs).changes;
  }
  pruneEvents(olderThanTs) {
    return this.db.prepare('DELETE FROM events WHERE ts < ?').run(olderThanTs).changes;
  }
}
