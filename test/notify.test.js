// Notification channel tests against local mock receivers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { webhookNotification, desktopNotification, emailNotification } from '../lib/notify.js';

// Tracks a fake notify-send child: returns a plain object with an `on`
// EventEmitter-like surface that the test drives through close/error,
// covering both the ok and error resolutions of desktopNotification.
function fakeSpawn() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const handlers = {};
    const child = {
      on(name, fn) { handlers[name] = fn; },
      emit(name, ...args) { if (handlers[name]) handlers[name](...args); },
    };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawnFn, calls };
}

test('notify: webhook POST delivers JSON payload', async (t) => {
  const received = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ path: req.url, ct: req.headers['content-type'], body: JSON.parse(b) });
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const payload = { kind: 'tls', target: 'x', status: 'warn', detail: 'expires in 12d', ts: 123 };
  const res = await webhookNotification(`http://127.0.0.1:${server.address().port}/hook`, payload);
  assert.equal(res.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/hook');
  assert.match(received[0].ct, /application\/json/);
  assert.deepEqual(received[0].body, payload);
});

test('notify: webhook non-2xx reported as failure', async (t) => {
  const server = createServer((req, res) => { res.writeHead(500).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await webhookNotification(`http://127.0.0.1:${server.address().port}/hook`, { a: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test('notify: unreachable webhook reported as failure', async (t) => {
  const res = await webhookNotification('http://127.0.0.1:9/hook', { a: 1 }, { timeoutMs: 500 });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('notify: webhook times out against a stalled receiver', async () => {
  // Real fetch rejects on abort; the stub must honor the signal the same way,
  // otherwise the await never settles and the timeout is not observed.
  const res = await webhookNotification(
    'http://127.0.0.1:9/hook',
    { a: 1 },
    {
      timeoutMs: 30,
      fetchFn: (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')));
      }),
    }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /timeout/);
});

test('notify: webhook rejection that is not an Error resolves through the String(err) fallback', async () => {
  // catch (err) -> { ok:false, error: err.message || String(err) }: the abort
  // and network-reject tests above all reject with Error objects carrying a
  // message, so the `|| String(err)` half never fires. A bare non-Error
  // rejection must resolve through that fallback, never throw on err.message.
  const res = await webhookNotification('http://127.0.0.1:1/hook', { a: 1 }, {
    fetchFn: () => Promise.reject('connect boom'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'connect boom');
});

test('notify: desktop notification spawns notify-send and resolves ok on exit 0', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const p = desktopNotification({ title: 't', message: 'm', urgency: 'critical' }, { spawnFn });
  const { cmd, args, child } = calls[0];
  assert.equal(cmd, 'notify-send');
  assert.deepEqual(args, ['-u', 'critical', 't', 'm']);
  child.emit('close', 0);
  const res = await p;
  assert.deepEqual(res, { ok: true, code: 0 });
});

test('notify: desktop notification reports failure on nonzero exit', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const p = desktopNotification({ title: 't', message: 'm' }, { spawnFn });
  const { child } = calls[0];
  child.emit('close', 1);
  const res = await p;
  assert.deepEqual(res, { ok: false, code: 1 });
});

test('notify: desktop notification resolves error when spawn fails', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const p = desktopNotification({ title: 't', message: 'm' }, { spawnFn });
  const { child } = calls[0];
  child.emit('error', new Error('notify-send not found'));
  const res = await p;
  assert.deepEqual(res, { ok: false, error: 'notify-send not found' });
});

test('notify: emailNotification passes through to sendMail', async () => {
  // emailNotification is a thin passthrough to sendMail; the full SMTP mock
  // dialogue is covered in smtp.test.js. Here we pin the passthrough contract.
  const { sendMail } = await import('../lib/smtp.js');
  const cfg = { host: '127.0.0.1', port: 6999, secure: false, from: 'a@x', to: 'b@x', subject: 's', text: 'body' };
  // A refused port makes sendMail reject -> passthrough rejects with the same error.
  await assert.rejects(emailNotification(cfg), /smtp/);
});

test('notify: emailNotification returns ok on a healthy SMTP dialogue', async (t) => {
  const net = await import('node:net');
  const lines = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.write('220 apm-watch-test ESMTP\r\n');
    let inData = false;
    sock.on('data', (d) => {
      for (const raw of d.toString('utf8').split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line) continue;
        lines.push(line);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 OK\r\n'); }
          continue;
        }
        if (/^EHLO/.test(line)) sock.write('250-apm-watch-test\r\n250 OK\r\n');
        else if (/^MAIL FROM/.test(line) || /^RCPT TO/.test(line)) sock.write('250 OK\r\n');
        else if (/^DATA\s*$/.test(line)) { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (/^QUIT/.test(line)) sock.write('221 Bye\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // sendMail keeps the client socket open after QUIT, so server.close() alone
  // would wait on the live connection; destroy tracked sockets first.
  t.after(() => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(resolve);
  }));
  const res = await emailNotification({ host: '127.0.0.1', port: server.address().port, secure: false, from: 'a@x', to: 'b@x', subject: 's', text: 'body' });
  assert.equal(res.ok, true);
  assert.ok(lines.some((l) => /^MAIL FROM/.test(l)), 'SMTP dialogue executed');
});
