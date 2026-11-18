import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { inspectPemChain, remainingDays, fetchCertChain, netChainToReport } from '../lib/check-tls.js';
import { startHttpsServer } from './helpers/fixtures.js';

test('tls: parses a self-signed cert chain and reports days remaining', async (t) => {
  const srv = await startHttpsServer({ days: 25 });
  t.after(srv.close);
  const r = inspectPemChain(srv.cert.crtPem);
  assert.ok(r.daysRemaining > 0 && r.daysRemaining <= 25, `days=${r.daysRemaining}`);
  assert.equal(r.validChain, true);
  assert.equal(r.leafSubject, 'CN=fixture.test');
});

test('tls: chain order verified across intermediate + root', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = path.join(os.tmpdir(), 'apmw-chain-' + Date.now());
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(dir, { recursive: true }));
  const run = (args) => execFileSync('openssl', args, { stdio: 'ignore' });
  const p = (n, ext) => path.join(dir, n + (ext || '.key'));

  try {
    run(['genrsa', '-out', p('root'), '2048']);
    run(['req', '-new', '-key', p('root'), '-subj', '/CN=Root CA', '-out', p('root', '.csr')]);
    run(['x509', '-req', '-in', p('root', '.csr'), '-signkey', p('root'), '-days', '3650', '-out', p('root', '.crt')]);
    run(['genrsa', '-out', p('int'), '2048']);
    run(['req', '-new', '-key', p('int'), '-subj', '/CN=Intermediate CA', '-out', p('int', '.csr')]);
    run(['x509', '-req', '-in', p('int', '.csr'), '-CA', p('root', '.crt'), '-CAkey', p('root'), '-CAcreateserial', '-days', '1825', '-out', p('int', '.crt')]);
    run(['genrsa', '-out', p('leaf'), '2048']);
    run(['req', '-new', '-key', p('leaf'), '-subj', '/CN=leaf.example', '-out', p('leaf', '.csr')]);
    run(['x509', '-req', '-in', p('leaf', '.csr'), '-CA', p('int', '.crt'), '-CAkey', p('int'), '-CAcreateserial', '-days', '30', '-out', p('leaf', '.crt')]);

    const pem = readFileSync(p('leaf', '.crt'), 'utf8') + readFileSync(p('int', '.crt'), 'utf8') + readFileSync(p('root', '.crt'), 'utf8');
    const r = inspectPemChain(pem);
    assert.equal(r.chain.length, 3);
    assert.equal(r.validChain, true, 'issuer/subject linkage should hold');
    assert.ok(r.daysRemaining > 0 && r.daysRemaining <= 30);

    // corrupt the order to prove linkage check catches it
    const badPem = readFileSync(p('int', '.crt'), 'utf8') + readFileSync(p('leaf', '.crt'), 'utf8') + readFileSync(p('root', '.crt'), 'utf8');
    const bad = inspectPemChain(badPem);
    assert.equal(bad.validChain, false, 'mismatched order should fail linkage');

    // the network path applies the same linkage gate + leaf subject (inc 69):
    // wrap the openssl PEMs as X509Certificates and feed the same orders through
    // netChainToReport, mirroring what a live socket fetch would deliver
    const { X509Certificate } = await import('node:crypto');
    const leafCrt = readFileSync(p('leaf', '.crt'), 'utf8');
    const intCrt = readFileSync(p('int', '.crt'), 'utf8');
    const rootCrt = readFileSync(p('root', '.crt'), 'utf8');
    const netOk = netChainToReport({ host: 'leaf.example', port: 443, certs: [leafCrt, intCrt, rootCrt].map((s) => new X509Certificate(s)) });
    assert.equal(netOk.validChain, true, 'ordered leaf/int/root passes linkage on the network path');
    assert.equal(netOk.leafSubject, 'CN=leaf.example', 'leaf subject rides the leaf-first network report');
    const netBad = netChainToReport({ host: 'leaf.example', port: 443, certs: [intCrt, leafCrt, rootCrt].map((s) => new X509Certificate(s)) });
    assert.equal(netBad.validChain, false, 'mismatched order fails linkage on the network path too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tls: expired cert reports negative days', async (t) => {
  const srv = await startHttpsServer({ days: -5 });
  t.after(srv.close);
  const r = inspectPemChain(srv.cert.crtPem);
  assert.ok(r.daysRemaining <= 0, `days=${r.daysRemaining}`);
});

test('tls: remainingDays calculation matches expected delta', () => {
  const near = new Date(Date.now() + 3 * 86400e3).toUTCString();
  const d = remainingDays(near);
  assert.ok(d >= 2 && d <= 4, `got ${d}`);
});

test('tls: fetchCertChain against real TLS server gives chain', async (t) => {
  const srv = await startHttpsServer({ days: 40 });
  t.after(srv.close);
  const { certs } = await fetchCertChain({ host: '127.0.0.1', port: srv.port, rejectUnauthorized: false, servername: 'fixture.test' });
  const rep = netChainToReport({ host: '127.0.0.1', port: srv.port, certs });
  assert.ok(rep.chain.length >= 1);
  assert.ok(rep.daysRemaining > 0 && rep.daysRemaining <= 40);
  // network chain entries carry the same per-cert fields as inspectPemChain
  assert.ok(rep.chain[0].validFrom, 'chain entries include validFrom (field parity)');
  // network path carries the same chain-validity + leaf-subject semantics as
  // the pem path (inc 69): a single self-signed leaf is a valid chain, and the
  // leaf subject rides the report like inspectPemChain returns it
  assert.equal(rep.validChain, true, 'single self-signed leaf is a valid chain on the network path');
  assert.equal(rep.leafSubject, 'CN=fixture.test', 'leaf subject rides the network report like the pem path');
});

test('tls: fetchCertChain to a refused port rejects with ECONNREFUSED', async (t) => {
  // Runtime edge-path coverage: the socket 'error' handler (check-tls.js:72-77)
  // must surface the raw connect code instead of swallowing it as a TLS error.
  const sink = net.createServer();
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const { port } = sink.address();
  sink.close();
  await assert.rejects(
    fetchCertChain({ host: '127.0.0.1', port, timeoutMs: 2000 }),
    (e) => e.code === 'ECONNREFUSED' && /cert fetch failed/.test(e.message),
    'connection refused carries the ECONNREFUSED code'
  );
});

test('tls: fetchCertChain to a stalling listener aborts on timeout', async (t) => {
  // Runtime edge-path coverage: a server that accepts the TCP connection but
  // never completes the TLS handshake must be aborted by the socket timeout
  // (check-tls.js:68-70) instead of hanging forever.
  let conn;
  const sink = net.createServer((c) => { conn = c; c.on('error', () => {}); /* accept, never handshake */ });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  // server.close() alone waits for the never-handshaken connection to drain;
  // destroy it first so the after-hook always settles (probe showed close() hangs).
  t.after(() => new Promise((resolve) => {
    if (conn) conn.destroy();
    sink.close(resolve);
  }));
  const { port } = sink.address();
  await assert.rejects(
    fetchCertChain({ host: '127.0.0.1', port, timeoutMs: 300 }),
    (e) => /timeout/.test(e.message),
    'stalled handshake aborts with a timeout error'
  );
});

test('tls: malformed PEM block degrades to "no certificates found"', () => {
  // toCert (check-tls.js:26-29) catches X509Certificate construction failures,
  // so a PEM block that is structurally present but not a real DER cert must
  // yield the curated message, never a raw construction error.
  const bad = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n';
  assert.throws(() => inspectPemChain(bad), /no certificates found in PEM content/);
});
