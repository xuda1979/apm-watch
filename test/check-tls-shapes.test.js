// Runtime shape coverage for lib/check-tls.js's cert-list parsing and timeout
// path. The network path's toCertList() must survive every historical
// getPeerCertificate(true) return shape (Array, detailed {raw,ca}, legacy
// fingerprint-keyed object, false on an unauthenticated socket), and the
// socket 'timeout' event must abort a fetch even when no connect error ever
// fires. A live socket never delivers these legacy shapes and its stalled-
// handshake timeout is always beat to the punch by the arming timer, so we
// mock node:tls for this file only (each test file runs in its own process,
// so the real-socket tests in check-tls.test.js are unaffected).
//
// Covers previously-uncovered lib/check-tls.js lines in the full-suite
// coverage report: 23 (toCert non-cert/non-buffer/non-string via a chain
// array), 69 (sock 'timeout' handler), 100-103 (parse string-array-null
// branches), 110-115 (fingerprint-keyed loop), 117-118 (chain.ca loop),
// 121 (falsy chain fallback).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake socket factory swapped in for node:tls.connect. fetchCertChain wires
// 'secureConnect' / 'timeout' / 'error' on it and calls setTimeout/end/destroy;
// the test drives the events, and destroy(err) re-emits the error next tick
// exactly like a real TLSSocket.
let lastSock = null;
function fakeConnect(props) {
  const s = new EventEmitter();
  s.props = props;
  s.destroyed = false;
  s.setTimeout = () => {};
  s.end = () => {};
  s.destroy = (e) => {
    if (s.destroyed) return;
    s.destroyed = true;
    if (e) process.nextTick(() => s.emit('error', e));
  };
  lastSock = s;
  return s;
}

// Register the mock before lib/check-tls.js is ever imported in this process,
// so its `import { connect } from 'node:tls'` binding resolves to fakeConnect.
await mock.module('node:tls', { namedExports: { connect: fakeConnect } });
const { fetchCertChain } = await import('../lib/check-tls.js');

function startFetch() {
  const p = fetchCertChain({ host: 'shape.test', port: 443, timeoutMs: 20000 });
  assert.ok(lastSock, 'fake connect recorded the socket before the promise resolved');
  return { p, s: lastSock };
}

// One self-signed cert: { pem, der } where der = raw DER bytes.
function fixturePem() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apmw-shape-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=shape.test', '-keyout', key, '-out', crt, '-days', '5'],
    { stdio: 'ignore' },
  );
  return { dir, pem: readFileSync(crt, 'utf8') };
}

// Structurally present but not a real DER cert (same payload as the pem-path test).
const BAD_PEM = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n';

test('tls-shapes: socket timeout event aborts a fetch before any connect error', async () => {
  const { p, s } = startFetch();
  s.emit('timeout');
  await assert.rejects(
    p,
    (e) => /cert fetch failed: cert fetch timeout/.test(e.message),
    'the timeout-event destroy surfaces the curated timeout failure',
  );
});

test('tls-shapes: array chain parses strings and cert instances and drops unparseable entries', async () => {
  const f = fixturePem();
  const x509 = new X509Certificate(f.pem);
  const { p, s } = startFetch();
  s.getPeerCertificate = () => [f.pem, {}, x509];
  s.emit('secureConnect');
  const { certs } = await p;
  rmSync(f.dir, { recursive: true, force: true });
  assert.equal(certs.length, 2, 'the PEM string and the X509Certificate parse; the plain object drops out');
  assert.ok(certs[0] instanceof X509Certificate);
  assert.ok(certs[1] instanceof X509Certificate);
});

test('tls-shapes: detailed {raw, ca} chain keeps the leaf and every ca entry it can parse', async () => {
  const f = fixturePem();
  const x509 = new X509Certificate(f.pem);
  const der = x509.raw;
  const { p, s } = startFetch();
  s.getPeerCertificate = () => ({
    raw: der,
    ca: [
      { rawCert: f.pem },   // PEM-string entry
      { rawCert: BAD_PEM }, // structurally present but invalid DER -> dropped
      [der],                // nested array entry
      {},                   // unparseable entry -> dropped
    ],
  });
  s.emit('secureConnect');
  const { certs } = await p;
  rmSync(f.dir, { recursive: true, force: true });
  assert.equal(certs.length, 3, 'leaf + PEM-string entry + nested-array entry survive');
  assert.ok(certs.every((c) => c instanceof X509Certificate));
});

test('tls-shapes: legacy fingerprint-keyed chain parses each stored cert object', async () => {
  const f = fixturePem();
  const x509 = new X509Certificate(f.pem);
  const { p, s } = startFetch();
  s.getPeerCertificate = () => ({
    'AA:BB:CC:DD': { rawCert: x509.raw },
    empty: {},
  });
  s.emit('secureConnect');
  const { certs } = await p;
  rmSync(f.dir, { recursive: true, force: true });
  assert.equal(certs.length, 1, 'only the fingerprint entry holding a real cert parses');
  assert.ok(certs[0] instanceof X509Certificate);
});

test('tls-shapes: false chain (unauthenticated socket) yields an empty cert list', async () => {
  const { p, s } = startFetch();
  s.getPeerCertificate = () => false;
  s.emit('secureConnect');
  const { certs } = await p;
  assert.deepEqual(certs, []);
});
