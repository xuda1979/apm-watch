// Time-weighted availability ("uptime") from state snapshots.
//
// Rows are ASC-ordered snapshots for one (target, kind). A snapshot taken at
// ts covers the half-open interval [ts, nextTs); the newest snapshot extends
// to `now`. "Up" counts every non-error status (warn included) — matching
// Datadog monitor availability, where time spent in WARN is still traffic that
// the monitor considers available. A latched-warn target (e.g. a cert expiring
// within days) therefore reports near-full availability instead of 0%.
export function availability(rows, nowTs = Date.now()) {
  if (!rows || rows.length === 0) {
    return { pct: null, upMs: 0, downMs: 0, totalMs: 0, samples: 0 };
  }
  let upMs = 0;
  let downMs = 0;
  for (let i = 0; i < rows.length; i++) {
    const start = rows[i].ts;
    const end = i + 1 < rows.length ? rows[i + 1].ts : nowTs;
    const dur = Math.max(0, end - start);
    if (rows[i].status === 'error') downMs += dur;
    else upMs += dur;
  }
  const totalMs = upMs + downMs;
  const pct = totalMs > 0 ? Math.round((10000 * upMs) / totalMs) / 100 : null;
  return { pct, upMs, downMs, totalMs, samples: rows.length };
}
