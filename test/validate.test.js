import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, assertValidConfig } from '../lib/validate.js';

test('validate: accepts a well-formed config', () => {
  const cfg = {
    http: [
      { name: 'api', url: 'https://example.com/health', timeoutMs: 5000, assert: { statusCode: 200, bodyIncludes: 'ok' }, intervalSeconds: 30 },
    ],
    tls: [
      { name: 'cert', host: 'example.com', port: 443, warnDaysBefore: 30 },
      { name: 'bundle', pemFile: './cert-bundle.pem' },
    ],
    scheduler: { httpIntervalSeconds: '1m' },
    apm: { collect: true, errorRateThreshold: 0.05 },
    ui: { mode: 'web' },
    store: { path: 'apm-watch.db', retentionDays: 7 },
  };
  assert.deepEqual(validateConfig(cfg), []);
  assert.doesNotThrow(() => assertValidConfig(cfg));
});

test('validate: http as object (typo) instead of array is caught', () => {
  const { fill } = requireFiller();
  const errs = validateConfig(fill({ http: { name: 'api', url: 'https://x' } }));
  assert.match(errs.join('\n'), /config\.http must be an array/);
});

test('validate: http entry missing url is caught', () => {
  const errs = validateConfig({ http: [{ name: 'no-url' }], tls: [] });
  assert.match(errs.join('\n'), /http\[0\].*missing a URL/);
});

test('validate: tls entry with neither host nor pemFile is caught', () => {
  const errs = validateConfig({ http: [], tls: [{ name: 'bare' }] });
  assert.match(errs.join('\n'), /tls\[0\].*host.*pemFile/);
});

test('validate: invalid port / warnDaysBefore / timeoutMs', () => {
  const errs = validateConfig({
    http: [{ url: 'https://x', timeoutMs: -1 }],
    tls: [{ host: 'x', port: 99999, warnDaysBefore: -5, timeoutMs: -1 }],
  });
  const joined = errs.join('\n');
  assert.match(joined, /timeoutMs.*positive/);
  assert.match(joined, /port.*1\.\.65535/);
  assert.match(joined, /warnDaysBefore.*non-negative/);
  assert.match(joined, /tls\[0\].*timeoutMs.*positive/, 'per-tls cert-fetch timeout typos are caught too');
});

test('validate: unit-string intervals agree with the scheduler parser', () => {
  const ok = validateConfig({ http: [{ url: 'https://x', intervalSeconds: '5m' }], tls: [], scheduler: { httpIntervalSeconds: '45s' } });
  assert.deepEqual(ok, []);
  const bad = validateConfig({ http: [{ url: 'https://x', intervalSeconds: 'every-so-often' }], tls: [] });
  assert.match(bad.join('\n'), /intervalSeconds/);
});

test('validate: no checks at all (no apm.collect) is still rejected', () => {
  const errs = validateConfig({});
  assert.deepEqual(errs, ['config has no checks: add an `http` or `tls` array (or enable `apm.collect`)']);
  assert.throws(() => assertValidConfig({ apm: {} }), /invalid config/);
});

test('validate: apm-only config with collect enabled is accepted', () => {
  const cfg = { apm: { collect: true, errorRateThreshold: 0.05, latencyThresholdMs: 500 } };
  assert.deepEqual(validateConfig(cfg), []);
  assert.doesNotThrow(() => assertValidConfig(cfg));
});

test('validate: apm threshold typos that would corrupt the warn logic are caught', () => {
  // error-rate threshold must be a fraction in [0,1]; latency threshold a
  // positive number of ms — both feed engine comparisons unguarded.
  const errs = validateConfig({
    http: [], tls: [], apm: { collect: true, errorRateThreshold: 1.5, latencyThresholdMs: -10, windowMs: -1, maxSamples: 0 },
  });
  const joined = errs.join('\n');
  assert.match(joined, /apm\.errorRateThreshold.*between 0 and 1/);
  assert.match(joined, /apm\.latencyThresholdMs.*positive/);
  assert.match(joined, /apm\.windowMs.*positive/);
  assert.match(joined, /apm\.maxSamples.*positive integer/);
  // non-numeric typos are caught the same way
  const notNum = validateConfig({ http: [], tls: [], apm: { collect: true, errorRateThreshold: 'high', latencyThresholdMs: '500ms', windowMs: '1min', maxSamples: 'lots' } });
  assert.match(notNum.join('\n'), /apm\.errorRateThreshold.*between 0 and 1/);
  assert.match(notNum.join('\n'), /apm\.latencyThresholdMs.*positive/);
  assert.match(notNum.join('\n'), /apm\.windowMs.*positive/);
  assert.match(notNum.join('\n'), /apm\.maxSamples.*positive integer/);
  // boundary values remain accepted: 0 = warn on any error, 1 = never by rate
  const ok = validateConfig({ http: [], tls: [], apm: { collect: true, errorRateThreshold: 0, latencyThresholdMs: 1, windowMs: 1000, maxSamples: 5 } });
  assert.deepEqual(ok, []);
});

test('validate: non-object section is caught', () => {
  const errs = validateConfig({ http: [], tls: [], scheduler: 'daily' });
  assert.match(errs.join('\n'), /config\.scheduler must be an object/);
});

test('validate: non-array http entry fail-fast during CLI boot', () => {
  assert.throws(() => assertValidConfig({ http: {}, tls: [] }), /http must be an array/);
});

// tiny helper so the file has no top-level fixture machinery
function requireFiller() {
  return { fill: (over) => ({ http: [], tls: [], apm: {}, notifications: {}, scheduler: {}, ui: {}, store: {}, ...over }) };
}
