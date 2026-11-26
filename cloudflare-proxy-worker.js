/**
 * Cloudflare Worker proxy cho NIGARIA CLOUD.
 * Cách dùng: Cloudflare Dashboard -> Workers & Pages -> Create Worker -> dán file này.
 * Chỉ cho phép hanaminikata.com để tránh biến thành open proxy.
 *
 * Tuỳ chọn bảo mật:
 *   - Đặt secret PROXY_KEY trên Worker.
 *   - Đặt API_PROXY_KEY cùng giá trị trong .env trên Render.
 */

const ALLOWED_HOSTS = new Set(['hanaminikata.com']);

export default {
  async fetch(request, env) {
    if (env.PROXY_KEY && request.headers.get('x-proxy-key') !== env.PROXY_KEY) {
      return new Response('Forbidden', { status: 403 });
    }

    const incoming = new URL(request.url);
    const targetRaw = incoming.searchParams.get('url');
    if (!targetRaw) return new Response('Missing ?url=', { status: 400 });

    let target;
    try {
      target = new URL(targetRaw);
    } catch (e) {
      return new Response('Bad url', { status: 400 });
    }
    if (!ALLOWED_HOSTS.has(target.hostname)) {
      return new Response('Host not allowed', { status: 403 });
    }

    const headers = new Headers(request.headers);
    for (const name of ['host', 'x-proxy-key', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray']) {
      headers.delete(name);
    }

    const init = { method: request.method, headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      init.body = await request.arrayBuffer();
    }

    const res = await fetch(target.toString(), init);
    const out = new Headers(res.headers);
    out.set('access-control-allow-origin', '*');
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: out,
    });
  },
};
