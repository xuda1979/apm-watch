// Fixture helpers: spin up mock HTTP servers (with body assertions, 404s,
// non-responding) and self-signed HTTPS servers whose cert expires in N days.

import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(__dirname, '..', '.fixtures');

/**
 * Generate a self-signed cert valid for `days` (or expired when negative).
 * Returns { keyFile, certFile, crtPem, keyPem }.
 */
function isoAfterDays(days) {
  // 'YYYYMMDDHHMMSSZ' (no 'T', no ms) for now + days (negative => past).
  const d = new Date(Date.now() + days * 86400e3);
  if (Number.isNaN(d.getTime())) throw new Error('bad date delta ' + days);
  return d.toISOString().replace(/[-:T.]/g, '').replace(/\d{3}Z/, 'Z');
}

// Bump `certSeq` so parallel node --test processes (each test file runs as a
// separate process) never write the same key/cert file at once: two test files
// both call makeCert(days) for identical days, and concurrent openssl writes to
// a shared path tear the file and make the TLS handshake fail intermittently.
// Include process.pid: node --test runs each test file as a separate process,
// so a per-process counter alone would still collide (two files both calling
// makeCert(15) would write the same "…-1.pem" path). pid + counter keeps every
// key/cert pair unique across concurrent processes and repeated calls.
const PID_TAG = process.pid;
let certSeq = 0;
export function makeCert(days, cn = 'fixture.test') {
  mkdirSync(FIXTURES, { recursive: true });
  const keyFile = path.join(FIXTURES, `key-${cn}-${days}-${PID_TAG}-${++certSeq}.pem`);
  const certFile = path.join(FIXTURES, `cert-${cn}-${days}-${PID_TAG}-${++certSeq}.pem`);
  // openssl refuses an end-date before the start-date; for past/expired certs
  // set an explicit notBefore in the past too and notAfter at now+(days).
  const validity =
    days <= 0
      ? ['-not_before', isoAfterDays(-7), '-not_after', isoAfterDays(days)]
      : ['-days', String(days)];
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-subj', `/CN=${cn}`,
    '-keyout', keyFile, '-out', certFile,
    ...validity,
  ];
  execFileSync('openssl', args, { stdio: 'ignore' });
  return {
    keyFile, certFile,
    crtPem: readFileSync(certFile, 'utf8'),
    keyPem: readFileSync(keyFile, 'utf8'),
  };
}

/**
 * Start an HTTP server with configurable responses.
 * routes: { path: { status?, body?, delayMs?, hang? } }
 * Returns { url, server, close }.
 */
export function startHttpServer(routes = {}, opts = {}) {
  const server = createServer((req, res) => {
    const route = routes[req.url] || { status: 404, body: 'not found' };
    if (route.hang) { /* never respond */ return; }
    setTimeout(async () => {
      res.writeHead(route.status ?? 200, { 'content-type': 'text/html' });
      res.end(route.body ?? 'ok');
    }, route.delayMs ?? 0);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Start an HTTPS server with a self-signed cert; the TLS server does NOT do
 * handshake auth so clients must use rejectUnauthorized:false.
 * Returns { url (https), port, cert, key, server, close }.
 */
export function startHttpsServer({ days, delayMs = 0, hang = false } = {}) {
  return new Promise((resolve) => {
    const cert = makeCert(days);
    const server = createTlsServer(
      { key: cert.keyPem, cert: cert.crtPem },
      (socket) => {
        if (hang) return;
        const body = 'fixture https ok';
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ' + Buffer.byteLength(body) + '\r\nconnection: close\r\n\r\n' + body,
        );
        socket.end();
      },
    );
    server.on('tlsClientError', () => { /* ignore */ });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `https://127.0.0.1:${port}`,
        port,
        cert: cert,
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export async function freePort() {
  const { createServer } = await import('node:http');
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
