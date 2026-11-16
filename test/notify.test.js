// Notification channel tests against local mock receivers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { webhookNotification } from '../lib/notify.js';

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
