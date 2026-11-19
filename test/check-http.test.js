import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkEndpoint } from '../lib/check-http.js';
import { startHttpServer } from './helpers/fixtures.js';

test('http checker: 200 with expected status passes', async (t) => {
  const srv = await startHttpServer({ '/ok': { status: 200, body: 'hello world' } });
  t.after(srv.close);
  const res = await checkEndpoint({ url: srv.url + '/ok', assert: { statusCode: 200 } });
  assert.equal(res.status, 'ok');
  assert.equal(res.statusCode, 200);
  assert.equal(res.expectedStatusCode, 200, 'the judged-against status rides the result');
  assert.equal(res.bodyIncludes, null, 'unconfigured body assertion stays null');
  assert.equal(res.method, 'GET', 'default verb surfaces as GET');
  assert.ok(res.latencyMs >= 0);
});

test('http checker: custom method is applied and reported', async (t) => {
  const srv = await startHttpServer({ '/post': { status: 201, body: 'created' } });
  t.after(srv.close);
  const res = await checkEndpoint({ url: srv.url + '/post', method: 'post', assert: { statusCode: 201 } });
  assert.equal(res.status, 'ok');
  assert.equal(res.statusCode, 201);
  assert.equal(res.method, 'POST', 'configured verb is normalized and reported');
});

test('http checker: 404 reported as error', async (t) => {
  const srv = await startHttpServer({ '/missing': { status: 404, body: 'nope' } });
  t.after(srv.close);
  // no assertion
  const res = await checkEndpoint({ url: srv.url + '/missing' });
  assert.ok(['ok', 'error'].includes(res.status), `status ${res.status}`);
  // with statusCode:404 assertion it should pass
  const ok = await checkEndpoint({ url: srv.url + '/missing', assert: { statusCode: 404 } });
  assert.equal(ok.status, 'ok');
  // with expected 200 it fails
  const bad = await checkEndpoint({ url: srv.url + '/missing', assert: { statusCode: 200 } });
  assert.equal(bad.status, 'error');
  assert.match(bad.detail, /expected status 200/);
});

test('http checker: body substring assertion', async (t) => {
  const srv = await startHttpServer({ '/a': { status: 200, body: 'the quick brown fox' } });
  t.after(srv.close);
  const hit = await checkEndpoint({ url: srv.url + '/a', assert: { bodyIncludes: 'brown fox' } });
  assert.equal(hit.status, 'ok');
  assert.equal(hit.bodyIncludes, 'brown fox', 'the required body substring rides the result');
  const miss = await checkEndpoint({ url: srv.url + '/a', assert: { bodyIncludes: 'purple' } });
  assert.equal(miss.status, 'error');
  assert.equal(miss.bodyIncludes, 'purple');
  assert.match(miss.detail, /missing/);
});

test('http checker: non-responding target times out -> error', async (t) => {
  // a server that never responds
  const srv = await startHttpServer({ '/hang': { status: 200, hang: true } });
  t.after(srv.close);
  const res = await checkEndpoint({ url: srv.url + '/hang', timeoutMs: 300 });
  assert.equal(res.status, 'error');
  assert.match(res.detail, /timeout/i);
  assert.equal(res.timeoutMs, 300, 'configured abort timeout surfaces on the result');
});

test('http checker: default timeout surfaces on the result', async (t) => {
  const srv = await startHttpServer({ '/ok': { status: 200, body: 'hello' } });
  t.after(srv.close);
  const res = await checkEndpoint({ url: srv.url + '/ok' });
  assert.equal(res.timeoutMs, 5000, 'unset timeoutMs resolves to the 5000 default');
  assert.equal(res.expectedStatusCode, null, 'no assert configured -> judged status stays null');
  assert.equal(res.bodyIncludes, null, 'no assert configured -> body marker stays null');
});

test('http checker: connection refused -> error', async () => {
  const res = await checkEndpoint({ url: 'http://127.0.0.1:1/nope', timeoutMs: 300 });
  assert.equal(res.status, 'error');
  assert.ok(res.detail);
});

test('http checker: latencyThresholdMs demotes slow-but-ok to warn', async (t) => {
  // simulate a 200 response that crosses the threshold
  const srv = await startHttpServer({ '/slow': { status: 200, body: 'ok', delayMs: 80 } });
  t.after(srv.close);
  const fast = await checkEndpoint({ url: srv.url + '/slow', latencyThresholdMs: 400 });
  assert.equal(fast.status, 'ok', 'fast response under threshold stays ok');
  assert.equal(fast.latencyThresholdMs, 400, 'configured threshold surfaces on the result');
  const slow = await checkEndpoint({ url: srv.url + '/slow', latencyThresholdMs: 1 });
  assert.equal(slow.status, 'warn', 'slow response over threshold demotes to warn');
  assert.match(slow.detail, /slow:/);
  assert.equal(slow.latencyThresholdMs, 1, 'configured threshold surfaces on the result');
  // unresolved threshold (or one defined under assert) mirrors the engine resolution
  const viaAssert = await checkEndpoint({ url: srv.url + '/slow', assert: { latencyThresholdMs: 0 } });
  assert.equal(viaAssert.latencyThresholdMs, 0, 'assert.latencyThresholdMs resolves like the engine');
  const unset = await checkEndpoint({ url: srv.url + '/slow' });
  assert.equal(unset.latencyThresholdMs, null, 'no threshold configured -> null, not undefined');
});

test('http checker: latency warn does not mask hard errors', async (t) => {
  const srv = await startHttpServer({ '/missing': { status: 404, body: 'nope' } });
  t.after(srv.close);
  const res = await checkEndpoint({ url: srv.url + '/missing', assert: { statusCode: 200 }, latencyThresholdMs: 1 });
  assert.equal(res.status, 'error', 'status assertion failure stays error');
  assert.equal(res.expectedStatusCode, 200, 'the judged-against status rides even a failing result');
  assert.equal(res.bodyIncludes, null, 'status-only assert leaves the body marker null');
  assert.match(res.detail, /expected status 200/);
});

test('http checker: redirect policy and request body forward to the fetch call', async () => {
  // stub the fetch fn (checkEndpoint's documented opts hook) so the forwarded
  // options object can be pinned exactly — no real network or redirect needed
  const calls = [];
  async function stubFetch(url, opts) {
    calls.push({ url, opts });
    // a minimal Response-shaped object: body null means the no-assert branch
    // skips the body cancel entirely (res.body?.cancel?.(...) is a no-op)
    return { status: 200, text: async () => 'rendered', body: null };
  }

  // configured redirect resolves to `follow` (the line-46 forward half)
  const follow = await checkEndpoint(
    { url: 'http://bucket.test/redir', redirect: true, assert: { statusCode: 200 } },
    { fetchFn: stubFetch },
  );
  assert.equal(follow.status, 'ok');
  assert.equal(calls[0].opts.redirect, 'follow', 'configured redirect: true resolves to follow');

  // a configured body is forwarded verbatim with the normalized verb
  const post = await checkEndpoint(
    { url: 'http://bucket.test/pay', method: 'post', body: '{"a":1}', assert: { statusCode: 200 } },
    { fetchFn: stubFetch },
  );
  assert.equal(post.status, 'ok');
  assert.equal(calls[1].opts.body, '{"a":1}', 'a configured body forwards to the fetch call');
  assert.equal(calls[1].opts.method, 'POST', 'the verb is normalized before forwarding');

  // unconfigured complement halves stay pinned: manual redirect, no body key,
  // empty headers object
  const plain = await checkEndpoint(
    { url: 'http://bucket.test/plain', assert: { statusCode: 200 } },
    { fetchFn: stubFetch },
  );
  assert.equal(plain.status, 'ok');
  assert.equal(calls[2].opts.redirect, 'manual', 'an unconfigured redirect stays manual');
  assert.ok(!('body' in calls[2].opts), 'no body configured -> the fetch call carries no body key');
  assert.deepEqual(calls[2].opts.headers, {}, 'headers default to an empty object');
});
