// HTTP(S) endpoint checker: status code, latency, body assertions.
// Built on global fetch (undici) — no runtime deps.

export function buildAssertions(asserts = {}) {
  const out = { statusCode: null, bodyIncludes: null };
  if (asserts.statusCode !== undefined && asserts.statusCode !== null) {
    out.statusCode = Number(asserts.statusCode);
  }
  if (asserts.bodyIncludes !== undefined && asserts.bodyIncludes !== null) {
    out.bodyIncludes = String(asserts.bodyIncludes);
  }
  return out;
}

/**
 * Perform one endpoint check.
 * cfg: { url, name?, method?, headers?, body?, timeoutMs?, assert?: { statusCode?, bodyIncludes? } }
 * opts: { fetchFn, now }
 * Returns a normalized result object:
 *   { ts, target, kind:'http', status:'ok'|'warn'|'error', latencyMs, statusCode, method, timeoutMs, detail }
 */
export async function checkEndpoint(cfg, { fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const url = cfg.url;
  const method = (cfg.method || 'GET').toUpperCase();
  const timeoutMs = cfg.timeoutMs ?? 5000;
  const assertions = buildAssertions(cfg.assert);
  const headers = cfg.headers || {};

  const startedAt = now();
  let latencyMs;
  let statusCode = null;
  let httpError = null;
  let body = null;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );

  try {
    const res = await fetchFn(url, {
      method,
      headers,
      redirect: cfg.redirect ? 'follow' : 'manual',
      signal: controller.signal,
      ...(cfg.body !== undefined ? { body: cfg.body } : {}),
    });
    latencyMs = now() - startedAt;
    statusCode = res.status;
    if (assertions.bodyIncludes !== null) {
      body = await res.text();
    } else {
      // consume body without buffering to keep latency measurement honest
      await res.body?.cancel?.().catch?.(() => {});
    }
  } catch (err) {
    latencyMs = now() - startedAt;
    httpError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  return finalize(cfg, { target: cfg.name || cfg.url, statusCode, latencyMs, httpError, body }, assertions, now());
}

function finalize(cfg, r, assertions, ts) {
  const failures = [];
  let status;

  if (r.httpError) {
    status = 'error';
    failures.push(r.httpError);
  } else if (assertions.statusCode !== null && r.statusCode !== assertions.statusCode) {
    status = 'error';
    failures.push(`expected status ${assertions.statusCode}, got ${r.statusCode}`);
  } else {
    status = 'ok';
  }

  if (assertions.bodyIncludes !== null) {
    if (r.body === null) {
      status = 'error';
      failures.push('body assertion not evaluated');
    } else if (!r.body.includes(assertions.bodyIncludes)) {
      status = 'error';
      failures.push(`body missing "${assertions.bodyIncludes}"`);
    }
  }

  // Slow-but-asserting endpoint: demote ok -> warn once a latency threshold is
  // set. Errors stay errors; warn feeds the shared pillbox/TUI and counts as
  // online for availability (same convention as TLS warn).
  const thresholdMs = cfg.latencyThresholdMs ?? cfg.assert?.latencyThresholdMs ?? null;
  if (status === 'ok' && thresholdMs !== null && r.latencyMs != null &&
      r.latencyMs > thresholdMs) {
    status = 'warn';
    failures.push(`slow: ${r.latencyMs.toFixed(1)}ms > ${thresholdMs}ms`);
  }

  return {
    ts,
    target: r.target,
    kind: 'http',
    status,
    latencyMs: r.latencyMs,
    statusCode: r.statusCode,
    method: (cfg.method || 'GET').toUpperCase(),
    latencyThresholdMs: thresholdMs,
    // the timeout the probe was actually aborted by (default 5000) — surfaces
    // on once --json rows just like latencyThresholdMs
    timeoutMs: cfg.timeoutMs ?? 5000,
    detail: failures.length
      ? failures.join('; ')
      : `HTTP ${r.statusCode} in ${(r.latencyMs ?? 0).toFixed(1)}ms`,
  };
}
