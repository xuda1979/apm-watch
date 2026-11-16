// Config validation: catch typos and missing fields that would otherwise
// silently disable checks (e.g. `http` written as an object instead of an
// array, or a TLS entry with neither host nor pemFile).

import { configSeconds, toDays } from './engine.js';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Positive number of seconds, or a unit string the scheduler understands
// ("30", "45s", "2m", "1h", "7d"). Delegates to engine's configSeconds so the
// validator and scheduler agree on what is parseable.
function isPositiveDuration(v) {
  const s = configSeconds(v);
  return s != null && Number.isFinite(s) && s > 0;
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['config must be an object'];

  const { http, tls, apm } = config;
  const apmCollects = apm?.collect === true;
  if (http == null && tls == null && !apmCollects) {
    errors.push('config has no checks: add an `http` or `tls` array (or enable `apm.collect`)');
  }

  if (http != null && !Array.isArray(http)) errors.push('config.http must be an array of http check entries');
  if (tls != null && !Array.isArray(tls)) errors.push('config.tls must be an array of tls check entries');

  if (Array.isArray(http)) {
    for (const [i, h] of http.entries()) {
      const where = `config.http[${i}]`;
      if (!h || typeof h !== 'object') { errors.push(`${where} must be an object`); continue; }
      if (!isNonEmptyString(h.url)) errors.push(`${where} is missing a URL (e.g. "https://example.com/health")`);
      if (h.assert != null && typeof h.assert !== 'object') errors.push(`${where}.assert must be an object`);
      if (h.assert?.bodyIncludes != null && !isNonEmptyString(h.assert.bodyIncludes)) {
        errors.push(`${where}.assert.bodyIncludes must be a non-empty string`);
      }
      if (h.latencyThresholdMs != null && (!Number.isFinite(h.latencyThresholdMs) || h.latencyThresholdMs <= 0)) {
        errors.push(`${where}.latencyThresholdMs must be a positive number of milliseconds`);
      }
      if (h.timeoutMs != null && (!Number.isFinite(h.timeoutMs) || h.timeoutMs <= 0)) {
        errors.push(`${where}.timeoutMs must be a positive number of milliseconds`);
      }
      if (h.intervalSeconds != null && !isPositiveDuration(h.intervalSeconds)) {
        errors.push(`${where}.intervalSeconds must be a positive number of seconds (or a unit string like "2m")`);
      }
    }
  }

  if (Array.isArray(tls)) {
    for (const [i, t] of tls.entries()) {
      const where = `config.tls[${i}]`;
      if (!t || typeof t !== 'object') { errors.push(`${where} must be an object`); continue; }
      const hasHost = isNonEmptyString(t.host);
      const hasPem = isNonEmptyString(t.pemFile);
      if (!hasHost && !hasPem) {
        errors.push(`${where} needs a host (socket scan) or a pemFile (offline bundle check)`);
      }
      if (hasHost && t.port != null && (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535)) {
        errors.push(`${where}.port must be an integer in 1..65535`);
      }
      if (t.warnDaysBefore != null && (!Number.isFinite(t.warnDaysBefore) || t.warnDaysBefore < 0)) {
        errors.push(`${where}.warnDaysBefore must be a non-negative number of days`);
      }
      // tls[i].timeoutMs feeds the cert-fetch socket abort (check-tls.js); an
      // invalid value would make every fetch fail instantly or hang forever.
      if (t.timeoutMs != null && (!Number.isFinite(t.timeoutMs) || t.timeoutMs <= 0)) {
        errors.push(`${where}.timeoutMs must be a positive number of milliseconds`);
      }
      if (t.intervalSeconds != null && !isPositiveDuration(t.intervalSeconds)) {
        errors.push(`${where}.intervalSeconds must be a positive number of seconds (or a unit string like "2m")`);
      }
    }
  }

  if (config.scheduler != null) {
    if (typeof config.scheduler !== 'object') errors.push('config.scheduler must be an object');
    else {
      for (const key of ['httpIntervalSeconds', 'tlsIntervalSeconds', 'apmIntervalSeconds']) {
        if (config.scheduler[key] != null && !isPositiveDuration(config.scheduler[key])) {
          errors.push(`config.scheduler.${key} must be a positive number of seconds (or a unit string like "5m")`);
        }
      }
    }
  }

  if (config.apm != null && typeof config.apm === 'object') {
    // apm warn triggers feed straight into the engine's comparison; catch
    // typos that would otherwise silently always- or never-warn.
    if (config.apm.errorRateThreshold != null && (!Number.isFinite(config.apm.errorRateThreshold) || config.apm.errorRateThreshold < 0 || config.apm.errorRateThreshold > 1)) {
      errors.push('config.apm.errorRateThreshold must be a number between 0 and 1 (error-rate fraction)');
    }
    if (config.apm.latencyThresholdMs != null && (!Number.isFinite(config.apm.latencyThresholdMs) || config.apm.latencyThresholdMs <= 0)) {
      errors.push('config.apm.latencyThresholdMs must be a positive number of milliseconds');
    }
    // collector window/size feed the sliding-window summary; a typo would
    // silently freeze history at default lengths or reject every sample.
    if (config.apm.windowMs != null && (!Number.isFinite(config.apm.windowMs) || config.apm.windowMs <= 0)) {
      errors.push('config.apm.windowMs must be a positive number of milliseconds');
    }
    if (config.apm.maxSamples != null && (!Number.isInteger(config.apm.maxSamples) || config.apm.maxSamples <= 0)) {
      errors.push('config.apm.maxSamples must be a positive integer');
    }
  }

  for (const key of ['notifications', 'ui', 'store']) {
    if (config[key] != null && typeof config[key] !== 'object') {
      errors.push(`config.${key} must be an object`);
    }
  }

  // notifications.repeatIntervalSeconds gates the alert re-send window
  // (engine.js maybeAlert); it multiplies by 1000 directly, so only a plain
  // whole number of seconds is meaningful — a unit string or fraction would
  // silently respam.
  if (config.notifications?.repeatIntervalSeconds != null &&
      (!Number.isInteger(config.notifications.repeatIntervalSeconds) || config.notifications.repeatIntervalSeconds <= 0)) {
    errors.push('config.notifications.repeatIntervalSeconds must be a positive integer number of seconds');
  }

  // store.retentionDays drives the store:prune task (engine's toDays grammar:
  // plain days, or a unit string like "48h"/"1w", default 'd' — NOT the
  // scheduler's s|m|h|d). A typo would silently fall back to the 7d default.
  if (config.store?.retentionDays != null) {
    const d = toDays(config.store.retentionDays);
    if (!Number.isFinite(d) || d <= 0) {
      errors.push('config.store.retentionDays must be a positive number of days (or a unit string like "1w"/"48h")');
    }
  }

  return errors;
}

export function assertValidConfig(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`invalid config:\n  - ${errors.join('\n  - ')}`);
}
