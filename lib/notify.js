// Notifications: desktop (notify-send), webhook (POST JSON), email (SMTP).

import { spawn } from 'node:child_process';
import { sendMail } from './smtp.js';

export function desktopNotification({ title, message, urgency = 'normal' }) {
  return new Promise((resolve) => {
    const child = spawn('notify-send', ['-u', urgency, title, message], { stdio: 'ignore' });
    let finished = false;
    const done = (r) => { if (!finished) { finished = true; resolve(r); } };
    child.on('error', (e) => done({ ok: false, error: e.message }));
    child.on('close', (code) => done({ ok: code === 0, code }));
    child.on('spawn', () => {});
  });
}

export async function webhookNotification(url, payload, { fetchFn = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('webhook timeout')), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function emailNotification(cfg) {
  return sendMail(cfg);
}
