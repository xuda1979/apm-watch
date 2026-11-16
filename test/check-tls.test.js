import { test } from 'node:test';
import assert from 'node:assert/strict';
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
});
