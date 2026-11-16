// Unit tests for time-weighted availability (uptime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availability } from '../lib/availability.js';

test('availability: empty input -> null pct, zero totals', () => {
  const r = availability([], 1000);
  assert.equal(r.pct, null);
  assert.equal(r.upMs, 0);
  assert.equal(r.downMs, 0);
  assert.equal(r.totalMs, 0);
  assert.equal(r.samples, 0);
});

test('availability: single row covers [ts, now)', () => {
  // one ok row at t=0, now=1000 -> 100% up
  const ok = availability([{ ts: 0, status: 'ok' }], 1000);
  assert.equal(ok.pct, 100);
  assert.equal(ok.upMs, 1000);
  assert.equal(ok.samples, 1);
  // one error row: down for the whole window
  const err = availability([{ ts: 0, status: 'error' }], 1000);
  assert.equal(err.pct, 0);
  assert.equal(err.downMs, 1000);
});

test('availability: warn counts as UP (datadog parity)', () => {
  // half warn, half ok -> 100% up, because warn is still available traffic
  const rows = [
    { ts: 0, status: 'warn' },
    { ts: 500, status: 'ok' },
  ];
  const r = availability(rows, 1000);
  assert.equal(r.pct, 100);
  assert.equal(r.upMs, 1000);
  assert.equal(r.downMs, 0);
});

test('availability: error interval weights by time', () => {
  // ok from 0..400, error from 400..1000 -> 40% up
  const rows = [
    { ts: 0, status: 'ok' },
    { ts: 400, status: 'error' },
  ];
  const r = availability(rows, 1000);
  assert.equal(r.pct, 40);
  assert.equal(r.upMs, 400);
  assert.equal(r.downMs, 600);
  assert.equal(r.totalMs, 1000);
});

test('availability: flapping - each interval uses its own snapshot status', () => {
  // ok 0..300, error 300..600, ok 600..1000 -> 70% up
  const rows = [
    { ts: 0, status: 'ok' },
    { ts: 300, status: 'error' },
    { ts: 600, status: 'ok' },
  ];
  const r = availability(rows, 1000);
  assert.equal(r.pct, 70);
  assert.equal(r.upMs, 700);
  assert.equal(r.downMs, 300);
});

test('availability: pct rounding to 2 decimals', () => {
  // 1 up of 3 units -> 33.33%
  const rows = [
    { ts: 0, status: 'ok' },
    { ts: 1, status: 'error' },
    { ts: 2, status: 'error' },
  ];
  const r = availability(rows, 3);
  assert.equal(r.pct, 33.33);
});

test('availability: now before last sample yields the sample interval only', () => {
  // now=500, but samples extend past it -> total = 500, ok -> 100% of that
  const rows = [{ ts: 100, status: 'ok' }];
  const r = availability(rows, 500);
  assert.equal(r.totalMs, 400);
  assert.equal(r.pct, 100);
});

test('availability: zero-delta intervals are harmless', () => {
  // two rows at the same ts, now equal to ts -> total ms 0 -> pct null
  const rows = [{ ts: 0, status: 'ok' }, { ts: 0, status: 'error' }];
  const r = availability(rows, 0);
  assert.equal(r.samples, 2);
  assert.equal(r.totalMs, 0);
  assert.equal(r.pct, null);
});

test('availability: null/undefined rows treated as empty', () => {
  assert.equal(availability(null, 1).pct, null);
  assert.equal(availability(undefined, 1).pct, null);
});
