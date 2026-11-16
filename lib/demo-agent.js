// APM demo agent: a self-contained "service" that reports latency/error spans
// to a local apm-watch collector endpoint, simulating a slow-but-bursty API.

export function startDemoAgent({ target, name = 'demo', intervalMs = 1000, baseLatencyMs = 40, jitterMs = 120, errorRate = 0.03, fetchFn = globalThis.fetch, log = console.log }) {
  let stopped = false;
  const post = async () => {
    const latency = Math.max(1, baseLatencyMs + Math.floor(Math.random() * jitterMs) + (Math.random() < 0.05 ? 400 : 0));
    const error = Math.random() < errorRate;
    try {
      const res = await fetchFn(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, latency_ms: latency, error }),
      });
      if (res.ok) log?.(`agent → ${latency}ms${error ? ' ERR' : ''}`);
    } catch (e) {
      log?.(`agent post failed: ${e.message}`);
    }
  };
  (async () => {
    for (;;) {
      if (stopped) return;
      await post();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return {
    stop() { stopped = true; },
  };
}
