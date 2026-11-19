// SMTP client tests against a local mock SMTP server (no external deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { sendMail } from '../lib/smtp.js';

function startMockSmtp(opts = {}) {
  const transcript = [];
  let dataMode = false;
  let dataBuf = '';
  const server = createServer((sock) => {
    const send = (line) => sock.write(line + '\r\n');
    send(opts.banner ?? '220 mock smtp ready');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const bare = buf.slice(0, n).replace(/\r$/, '').trimStart();
        buf = buf.slice(n + 1);
        if (dataMode) {
          dataBuf += bare + '\n';
          if (bare === '.') {
            dataMode = false;
            send(opts.afterData ?? '250 message accepted');
          }
          continue;
        }
        transcript.push(bare);
        if (bare.startsWith('EHLO')) send('250-mock\r\n250 AUTH PLAIN');
        else if (bare.startsWith('AUTH')) send(opts.authRelay ?? '235 authentication ok');
        else if (bare.startsWith('MAIL')) send(opts.rejectMail ?? '250 ok');
        else if (bare.startsWith('RCPT')) send('250 ok');
        else if (bare === 'DATA') { dataMode = true; send('354 end with .'); }
        else if (bare === 'QUIT') { send('221 bye'); sock.end(); }
        else if (bare === 'RSET' || bare === 'NOOP') send('250 ok');
        else send('250 ok');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      transcript,
      data: () => dataBuf,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('smtp: sends full envelope through plain connection', async (t) => {
  const mock = await startMockSmtp();
  t.after(mock.close);
  const { port } = mock;
  const res = await sendMail({
    host: '127.0.0.1', port, secure: false,
    from: 'a@example.com', to: 'b@example.com',
    subject: 'apm-watch test alert', text: 'tls certificate expiring soon',
  });
  assert.equal(res.ok, true);
  assert.ok(mock.transcript.some((l) => l.startsWith('EHLO apm-watch')));
  assert.ok(mock.transcript.includes('MAIL FROM:<a@example.com>'));
  assert.ok(mock.transcript.includes('RCPT TO:<b@example.com>'));
  assert.ok(mock.transcript.includes('DATA'));
  assert.ok(mock.transcript.includes('QUIT'));
  const envelope = mock.data();
  assert.match(envelope, /Subject: apm-watch test alert/);
  assert.match(envelope, /tls certificate expiring soon/);
});

test('smtp: AUTH PLAIN with user/pass', async (t) => {
  const mock = await startMockSmtp();
  t.after(mock.close);
  const res = await sendMail({
    host: '127.0.0.1', port: mock.port, secure: false,
    user: 'u1', pass: 's3cret',
    from: 'a@example.com', to: 'b@example.com', subject: 'x', text: 'y',
  });
  assert.equal(res.ok, true);
  assert.ok(mock.transcript.some((l) => l.startsWith('AUTH PLAIN ')));
});

test('smtp: rejected banner surfaces as an error', async (t) => {
  const mock = await startMockSmtp({ banner: '500 go away' });
  t.after(mock.close);
  await assert.rejects(
    sendMail({ host: '127.0.0.1', port: mock.port, from: 'a', to: 'b', subject: '', text: '' }),
    /smtp/i,
  );
});

test('smtp: unexpected command reply rejects send with expected/code detail', async (t) => {
  const mock = await startMockSmtp({ rejectMail: '550 relay denied' });
  t.after(mock.close);
  await assert.rejects(
    sendMail({ host: '127.0.0.1', port: mock.port, from: 'a@example.com', to: 'b@example.com', subject: 'x', text: 'y' }),
    (e) => /expected 250 for mail from/.test(e.message) && /got 550: 550 relay denied/.test(e.message),
    'curated expected/got error from send()',
  );
});

test('smtp: STARTTLS upgrade path works (banner after handshake is not misparsed)', async (t) => {
  const tls = await import('node:tls');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  // cert + key for the TLS side of the mock server
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apmw-smtp-'));
  const keyFile = path.join(dir, 'k.pem');
  const certFile = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.test', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const tlsOptions = {
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    rejectUnauthorized: false,
  };

  const transcript = [];
  let dataBuf = '';
  let dataMode = false;

  // One TCP connection is used for the whole transaction; after STARTTLS the
  // same socket is upgraded to TLS on both sides.
  const server = createServer((sock) => {
    let plainHandler = null;
    let tlsSock = null;

    const serveTls = (s) => {
      const send = (line) => s.write(line + '\r\n');
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString('utf8');
        let n;
        while ((n = buf.indexOf('\n')) >= 0) {
          const bare = buf.slice(0, n).replace(/\r$/, '').trimStart();
          buf = buf.slice(n + 1);
          if (dataMode) {
            dataBuf += bare + '\n';
            if (bare === '.') { dataMode = false; send('250 message accepted'); }
            continue;
          }
          transcript.push(bare);
          if (bare.startsWith('EHLO')) send('250-mock\r\n250 AUTH PLAIN');
          else if (bare.startsWith('MAIL')) send('250 ok');
          else if (bare.startsWith('RCPT')) send('250 ok');
          else if (bare === 'DATA') { dataMode = true; send('354 end with .'); }
          else if (bare === 'QUIT') { send('221 bye'); s.end(); }
          else send('250 ok');
        }
      });
    };

    sock.write('220 mock smtp ready\r\n');
    let buf = '';
    plainHandler = (d) => {
      buf += d.toString('utf8');
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const bare = buf.slice(0, n).replace(/\r$/, '').trimStart();
        buf = buf.slice(n + 1);
        if (bare.startsWith('EHLO')) {
          sock.write('250-mock\r\n250 STARTTLS\r\n');
        } else if (bare === 'STARTTLS') {
          sock.write('220 go ahead\r\n');
          // detach plaintext parser, then upgrade this socket server-side
          sock.removeAllListeners('data');
          tlsSock = new tls.TLSSocket(sock, { isServer: true, ...tlsOptions });
          tlsSock.on('secure', () => serveTls(tlsSock));
        } else {
          sock.write('250 ok\r\n');
        }
      }
    };
    sock.on('data', plainHandler);
  });

  const mock = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      transcript,
      data: () => dataBuf,
      close: async () => {
        await new Promise((r) => server.close(r));
        rmSync(dir, { recursive: true, force: true });
      },
    }));
  });
  t.after(mock.close);

  const res = await sendMail({
    host: '127.0.0.1', port: mock.port, secure: false, tlsReject: false,
    from: 'a@example.com', to: 'b@example.com',
    subject: 'starttls test', text: 'hello over tls',
  });
  assert.equal(res.ok, true);
  assert.ok(mock.transcript.some((l) => l.startsWith('EHLO')), `got ${JSON.stringify(mock.transcript)}`);
  assert.ok(mock.transcript.includes('MAIL FROM:<a@example.com>'));
  assert.match(mock.data(), /hello over tls/);
});

test('smtp: implicit TLS (secure: true) connects directly over TLS', async (t) => {
  const tls = await import('node:tls');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'apmw-smtps-'));
  const keyFile = path.join(dir, 'k.pem');
  const certFile = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.test', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const serverOpts = { key: readFileSync(keyFile), cert: readFileSync(certFile) };

  const transcript = [];
  let dataBuf = '';
  let dataMode = false;
  // TLS from the first byte: unlike STARTTLS, the plaintext phase never happens.
  const server = tls.createServer(serverOpts, (sock) => {
    const send = (line) => sock.write(line + '\r\n');
    send('220 tls mock ready');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const bare = buf.slice(0, n).replace(/\r$/, '').trimStart();
        buf = buf.slice(n + 1);
        if (dataMode) {
          dataBuf += bare + '\n';
          if (bare === '.') { dataMode = false; send('250 message accepted'); }
          continue;
        }
        transcript.push(bare);
        if (bare.startsWith('EHLO')) send('250-mock\r\n250 AUTH PLAIN');
        else if (bare.startsWith('AUTH')) send('235 authentication ok');
        else if (bare.startsWith('MAIL')) send('250 ok');
        else if (bare.startsWith('RCPT')) send('250 ok');
        else if (bare === 'DATA') { dataMode = true; send('354 end with .'); }
        else if (bare === 'QUIT') { send('221 bye'); sock.end(); }
        else send('250 ok');
      }
    });
  });

  const mock = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      transcript,
      data: () => dataBuf,
      close: async () => {
        await new Promise((r) => server.close(r));
        rmSync(dir, { recursive: true, force: true });
      },
    }));
  });
  t.after(mock.close);

  const res = await sendMail({
    host: '127.0.0.1', port: mock.port, secure: true, tlsReject: false,
    from: 'a@example.com', to: 'b@example.com',
    subject: 'implicit tls test', text: 'hello over implicit tls',
  });
  assert.equal(res.ok, true);
  assert.ok(mock.transcript.some((l) => l.startsWith('EHLO apm-watch')), `got ${JSON.stringify(mock.transcript)}`);
  assert.ok(mock.transcript.includes('MAIL FROM:<a@example.com>'));
  assert.ok(mock.transcript.includes('QUIT'));
  assert.match(mock.data(), /hello over implicit tls/);
});

test('smtp: unsolicited server line rejects as unexpected', async (t) => {
  // The mock writes a second line back-to-back with the banner, so by the time
  // the client parses it the pending-command queue is already empty.
  const mock = await startMockSmtp({ banner: '220 mock ready\r\n250 surprise' });
  t.after(mock.close);
  await assert.rejects(
    sendMail({
      host: '127.0.0.1', port: mock.port, connectTimeoutMs: 500,
      from: 'a@example.com', to: 'b@example.com', subject: 'x', text: 'y',
    }),
    /smtp: unexpected 250 surprise/,
    'protocol violation is surfaced, not silently consumed',
  );
});
