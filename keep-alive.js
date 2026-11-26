'use strict';

const fetch = require('node-fetch');

// Render free spin-down sau ~15 phút không có request -> ping trước ngưỡng đó.
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const TIMEOUT_MS = 15 * 1000;

/** URL công khai cần giữ thức. Ưu tiên KEEP_ALIVE_URL, fallback RENDER_DOMAIN. */
function targetUrl() {
  const raw = String(process.env.KEEP_ALIVE_URL || process.env.RENDER_DOMAIN || '').trim().replace(/\/+$/, '');
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  // Không ping localhost: chỉ có ích khi chạy thật trên Render/public host.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(raw)) return null;
  return `${raw}/api/health`;
}

function intervalMs() {
  const value = Number(process.env.KEEP_ALIVE_INTERVAL_MS);
  if (!Number.isFinite(value) || value < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS;
  return value;
}

/** Tự ping /api/health để Render không ngủ. Gọi sau khi app.listen thành công. */
function start() {
  const url = targetUrl();
  if (!url) {
    console.log('[keep-alive] Bỏ qua: chưa có KEEP_ALIVE_URL/RENDER_DOMAIN công khai.');
    return null;
  }

  const every = intervalMs();
  let busy = false;

  async function ping() {
    if (busy) return;
    busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'asynctas-keepalive/1.0' },
      });
      console.log(`[keep-alive] ${new Date().toISOString()} -> ${res.status}`);
    } catch (err) {
      console.warn(`[keep-alive] ping lỗi: ${err.message}`);
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  }

  const timer = setInterval(ping, every);
  if (timer.unref) timer.unref();
  console.log(`[keep-alive] Tự ping ${url} mỗi ${Math.round(every / 60000)} phút.`);
  ping().catch(() => {});
  return { ping, stop: () => clearInterval(timer) };
}

module.exports = { start, targetUrl, intervalMs, DEFAULT_INTERVAL_MS };
