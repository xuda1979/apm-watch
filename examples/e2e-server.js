#!/usr/bin/env node
// Runable fixture for the SPEC demo / AC1-AC3:
//   - an HTTP server: /live -> 200 all good, /missing -> 404, /hang -> never responds
//   - an HTTPS server with a self-signed cert expiring in 15 days
// Writes examples/e2e-config.json (with the real ephemeral ports) and prints
// the commands to start the monitor + a demo APM agent.

import { createServer as httpServer } from 'node:http';
import { createServer as tlsServer } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- self-signed cert valid for 15 days -----------------------------------
const certDir = path.join(__dirname, '.certs');
mkdirSync(certDir, { recursive: true });
const keyFile = path.join(certDir, 'e2e-key.pem');
const certFile = path.join(certDir, 'e2e-cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
  '-days', '15', '-subj', '/CN=fixture.test',
  '-keyout', keyFile, '-out', certFile,
], { stdio: 'ignore' });

// --- HTTP fixture: one 200, one 404, one that hangs -------------------------
let hangSrv;
const http = httpServer((req, res) => {
  if (req.url === '/live') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('all good'); return; }
  if (req.url === '/hang') { hangSrv = true; return; } // never respond
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope');
});

// --- HTTPS fixture: cert expires in 15 days ---------------------------------
const https = tlsServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  (socket) => {
    const body = 'fixture https ok';
    socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ' + Buffer.byteLength(body) + '\r\nconnection: close\r\n\r\n' + body);
    socket.end();
  },
);
https.on('tlsClientError', () => { /* self-signed: client must set rejectUnauthorized:false */ });

http.listen(0, '127.0.0.1', () => {
  const httpPort = http.address().port;
  https.listen(0, '127.0.0.1', () => {
    const tlsPort = https.address().port;
    const config = {
      http: [
        { name: 'ok-svc', url: `http://127.0.0.1:${httpPort}/live`, timeoutMs: 5000, assert: { statusCode: 200, bodyIncludes: 'all good' } },
        { name: 'missing-svc', url: `http://127.0.0.1:${httpPort}/missing`, timeoutMs: 5000, assert: { statusCode: 404 } },
        { name: 'hang-svc', url: `http://127.0.0.1:${httpPort}/hang`, timeoutMs: 2000 },
      ],
      tls: [
        { name: 'cert-soon', host: '127.0.0.1', port: tlsPort, warnDaysBefore: 30, timeoutMs: 5000, rejectUnauthorized: false },
      ],
      apm: { collect: true, errorRateThreshold: 0.05 },
      scheduler: { httpIntervalSeconds: 30, tlsIntervalSeconds: 60, apmIntervalSeconds: 30 },
      notifications: { desktop: false },
      ui: { host: '127.0.0.1', port: 8787, historySeconds: 86400 },
      store: { path: path.join(__dirname, 'apm-watch.db') },
    };
    const out = path.join(__dirname, 'e2e-config.json');
    writeFileSync(out, JSON.stringify(config, null, 2));
    console.log(`fixtures up:
  http  200  http://127.0.0.1:${httpPort}/live
  http  404  http://127.0.0.1:${httpPort}/missing
  http  hang http://127.0.0.1:${httpPort}/hang   (never responds)
  tls  15d  https://127.0.0.1:${tlsPort}  (self-signed, expires in 15 days)
wrote ${out}

start the monitor:
  node bin/apm-watch.js run --config ${out} --ui web

inject APM demo traffic (second terminal):
  node bin/apm-watch.js demo --collect-addr http://127.0.0.1:8787/apm/agent/trace

web UI: http://127.0.0.1:8787/   (ok-svc green, missing-svc green, hang-svc red,
cert-soon yellow since 15d < 30d threshold, APM p50/p95 curve on demo spans)
`);
  });
});
