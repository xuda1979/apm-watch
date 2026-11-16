// Minimal SMTP client: plain, implicit TLS (secure), STARTTLS, AUTH PLAIN.
// No external deps.

import net from 'node:net';
import tls from 'node:tls';
import { Buffer } from 'node:buffer';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

export function sendMail(opts) {
  const {
    host, port = 587, secure = false, tlsReject = true,
    from, to, subject, text, user, pass, connectTimeoutMs = 8000,
  } = opts;

  return new Promise((resolve, reject) => {
    let stream;
    let closed = false;
    let timer = null;
    let buf = '';
    const pending = [];

    const fail = (err) => {
      if (closed) return;
      closed = true; clearTimer();
      try { stream?.end(); } catch {}
      try { stream?.destroy(); } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const armTimer = (what) => {
      clearTimer();
      timer = setTimeout(() => fail(new Error(`smtp: timeout waiting for ${what}`)), connectTimeoutMs);
    };

    function attach(s) {
      s.on('data', (d) => {
        buf += d.toString('utf8');
        // Note: use a proper match (not search) so we slice past the *entire*
        // line terminator. buf.search(/\r?\n/) returns the index of the '\r'
        // for a '\r\n' sequence, and slice(n+1) would leave a stray '\n' that
        // then parses as a bogus empty line and kills an otherwise good
        // connection with 'unexpected '.
        let m;
        while ((m = buf.match(/\r?\n/)) !== null) {
          const line = buf.slice(0, m.index).trim();
          buf = buf.slice(m.index + m[0].length);
          if (line.length >= 4 && line[3] === '-') continue; // multi-line continue
          const code = Number(line.slice(0, 3));
          const waiter = pending[0];
          if (!waiter) { fail(new Error('smtp: unexpected ' + line)); return; }
          pending.shift();
          waiter(code, line);
        }
      });
      s.on('error', (e) => fail(new Error('smtp: ' + e.message)));
      s.on('close', () => { if (!closed) fail(new Error('smtp: connection closed')); });
    }

    function send(line, expected, what) {
      return new Promise((res, rej) => {
        pending.push((code, raw) => {
          const exp = Array.isArray(expected) ? expected : [expected];
          if (exp.includes(code)) {
            clearTimer();
            res({ code, line: raw });
          } else {
            fail(new Error(`smtp: expected ${exp.join('/')} for ${what}, got ${code}: ${raw}`));
            rej(new Error(`smtp: ${what} got ${code}`));
          }
        });
        armTimer(what);
        stream.write(line + '\r\n');
      });
    }

    function recv(expected, what) {
      return new Promise((res, rej) => {
        pending.push((code, raw) => {
          const exp = Array.isArray(expected) ? expected : [expected];
          if (exp.includes(code)) { clearTimer(); res({ code, line: raw }); }
          else { fail(new Error(`smtp: ${what} got ${code}: ${raw}`)); rej(new Error(`smtp: ${what} got ${code}`)); }
        });
        armTimer(what);
      });
    }

    stream = secure
      ? tls.connect({ host, port, rejectUnauthorized: tlsReject })
      : net.connect({ host, port });
    attach(stream);

    (async () => {
      let r = await recv([220], 'banner');
      r = await send('EHLO apm-watch', [250], 'ehlo');
      const caps = r.line;

      if (caps.includes('STARTTLS')) {
        r = await send('STARTTLS', [220], 'starttls');
        // Detach the plaintext parser before wrapping. Node currently strips a
        // wrapped socket's existing 'data' listeners (undocumented), but doing
        // it explicitly makes correct parsing independent of that behavior and
        // guards against double-reads on versions that don't strip them.
        stream.removeAllListeners('data');
        buf = '';
        const upgraded = tls.connect({ socket: stream, rejectUnauthorized: tlsReject });
        await new Promise((res, rej) => {
          upgraded.once('secureConnect', res);
          upgraded.once('error', rej);
        });
        stream = upgraded;
        attach(upgraded);
        r = await send('EHLO apm-watch', [250], 'ehlo');
      }

      if (user && pass) {
        r = await send('AUTH PLAIN ' + b64('\u0000' + user + '\u0000' + pass), [235], 'auth');
      }

      await send('MAIL FROM:<' + from + '>', [250], 'mail from');
      await send('RCPT TO:<' + to + '>', [250, 251], 'rcpt to');
      await send('DATA', [354], 'data');
      await send(messageEnvelope({ from, to, subject, text }) + '\r\n.', [250], 'send');
      await send('QUIT', [221], 'quit');
      clearTimer();
      resolve({ ok: true });
    })().catch(fail);
  });
}

function messageEnvelope({ from, to, subject, text }) {
  return [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Date: ' + new Date().toUTCString(),
    '',
    text,
  ].join('\r\n');
}
