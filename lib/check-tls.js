// TLS certificate expiry scanner.
// Uses node:crypto.X509Certificate + tls.connect to fetch a server's chain.
// Reports days remaining for each chain cert plus a chain-validity summary.

import { connect } from 'node:tls';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';

export const MS_PER_DAY = 86_400_000;

export function remainingDays(validTo, now = Date.now()) {
  const expiry = new Date(validTo).getTime();
  return Math.ceil((expiry - now) / MS_PER_DAY);
}

function toCert(obj) {
  if (!obj) return null;
  let str;
  if (obj instanceof X509Certificate) return obj;
  if (obj.rawCert) str = obj.rawCert.toString('utf8');
  else if (Buffer.isBuffer(obj)) str = obj.toString('utf8');
  else if (typeof obj === 'string') str = obj;
  else return null;
  if (!str.includes('BEGIN CERTIFICATE')) return null;
  try {
    return new X509Certificate(str);
  } catch {
    return null;
  }
}

/**
 * Fetch the TLS certificate chain for host:port over a real socket.
 * opts: { host, port=443, timeoutMs=5000, servername?, rejectUnauthorized? }
 * Resolves { certs: X509Certificate[] } (leaf-first), or throws with a
 * .code of 'TIMEOUT', 'ENOTFOUND'/'ECONNREFUSED', or 'TLS' (handshake/auth fail).
 */
export function fetchCertChain({ host, port = 443, timeoutMs = 5000, servername, rejectUnauthorized = true }) {
  // RFC 6066 forbids SNI for IP literals (Node warns and drops it). When the
  // target is an IP and no explicit servername was given, omit SNI entirely.
  const isIpLiteral = net.isIP(host) !== 0;
  const useSni = servername ?? (isIpLiteral ? undefined : host);
  return new Promise((resolve, reject) => {
    const sock = connect({
      host,
      port,
      ...(useSni ? { servername: useSni } : {}),
      rejectUnauthorized,
      minVersion: 'TLSv1',
    });
    const cleanup = () => { clearTimeout(timer); };
    const timer = setTimeout(() => {
      sock.destroy(new Error(`cert fetch timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.setTimeout(timeoutMs);

    sock.on('secureConnect', () => {
      // Give a tick for getPeerCertificate(true) to fill the full chain.
      setImmediate(() => {
        const chain = sock.getPeerCertificate(true);
        const certs = toCertList(chain);
        cleanup();
        sock.end();
        resolve({ certs });
      });
    });

    sock.on('timeout', () => {
      sock.destroy(new Error(`cert fetch timeout after ${timeoutMs}ms`));
    });

    sock.on('error', (e) => {
      cleanup();
      const err = new Error(`cert fetch failed: ${e.message}`);
      err.code = e.code || 'TLS';
      reject(err);
    });
  });
}

function toCertList(chain) {
  // Node >=20 getPeerCertificate(true) returns an object describing the leaf:
  // { subject, issuer, raw (DER Buffer), ca? (array of cert objects when the
  //   asn1/chain data is present, though with rejectUnauthorized:false it is
  //   usually absent), fingerprint, ... }. Older Node returned an object keyed
  //   by fingerprint. Additionally some environments return an Array.
  if (Array.isArray(chain)) return chain.map(toCert).filter(Boolean);

  if (chain && typeof chain === 'object') {
    // Shape (Node>=20 with details=true): { raw: DER Buffer, subject, issuer,
    // valid_to, ca?, ... }. Older Node: object keyed by fingerprint where each
    // value is { rawCert: Buffer, ... }. Pass raw DER Buffers directly to
    // X509Certificate (it accepts DER) or PEM strings.
    const parse = (obj) => {
      const p = obj?.rawCert ?? obj?.raw ?? obj;
      if (Buffer.isBuffer(p)) {
        try { return new X509Certificate(p); } catch { return null; }
      }
      if (typeof p === 'string' && p.includes('BEGIN CERTIFICATE')) {
        try { return new X509Certificate(p); } catch { return null; }
      }
      if (Array.isArray(p)) return p.map(parse).find(Boolean) || null;
      return null;
    };
    const certs = [];
    if (chain.raw || chain.rawCert) {
      const leaf = parse(chain);
      if (leaf) certs.push(leaf);
    } else {
      // fingerprint-keyed object
      for (const k of Object.keys(chain)) {
        const c = parse(chain[k]);
        if (c) certs.push(c);
      }
    }
    if (Array.isArray(chain.ca)) {
      for (const c of chain.ca) { const p = parse(c); if (p) certs.push(p); }
    }
    return certs;
  }
  return [];
}

/**
 * Inspect a PEM chain string (as pinned by the "tls" cert source or by
 * `--pem-file`). Returns:
 *   { daysRemaining, chain: [{subject, issuer, notAfter, validFrom, daysRemaining, selfSigned}],
 *     validChain, leafSubject }
 */
export function inspectPemChain(pem) {
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const certs = [];
  let m;
  while ((m = re.exec(pem)) !== null) {
    const c = toCert(m[0]);
    if (c) certs.push(c);
  }
  if (!certs.length) throw new Error('no certificates found in PEM content');

  const chain = certs.map((c) => ({
    subject: c.subject,
    issuer: c.issuer,
    notAfter: c.validTo,
    validFrom: c.validFrom,
    daysRemaining: remainingDays(c.validTo),
    selfSigned: c.subject === c.issuer,
  }));

  let validChain = certs.length === 1 || chain.every((cert, i) => i === chain.length - 1 || cert.issuer === chain[i + 1].subject);

  return {
    daysRemaining: chain[0].daysRemaining,
    chain,
    validChain,
    leafSubject: chain[0].subject,
  };
}

export function netChainToReport({ host, port, certs }) {
  const leaf = certs[0];
  return {
    host,
    port,
    daysRemaining: leaf ? remainingDays(leaf.validTo) : null,
    chain: certs.map((c) => ({
      subject: c.subject,
      issuer: c.issuer,
      notAfter: c.validTo,
      validFrom: c.validFrom,
      daysRemaining: remainingDays(c.validTo),
      selfSigned: c.subject === c.issuer,
    })),
    validChain: certs.length > 0,
  };
}
