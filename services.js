/**
 * Các dịch vụ mua/đăng ký tài khoản (dùng chung cho bot Discord và web).
 */
const crypto = require('crypto');
const nodeFetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

const HANAMI_URL = 'https://hanaminikata.com/dev/buy_device_cloud';
const CLOUD_NAMES = { UG: 'UGPhone', VM: 'VMOS', VS: 'VSPhone' };
const REG_COST = 10;
const DEVICE_LOGOS = {
  VS: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcT_g3u538-aiEWP_68-48toiD36I5eBqhVWVI6V0U0uww&s=10',
  VM: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSnEz_zC4ZHJBI8GYKBKoLB4OArt8V9lVet6fX5Ndv83w&s=10',
};

function vsphoneReady() {
    return !!(process.env.VSPHONE_API_URL && process.env.VSPHONE_API_KEY);
}

async function buyHanami(cloudId, server, inputData) {
    const body = { token: process.env.HANAMI_TOKEN, cloud_id: cloudId, input_data: inputData };
    if (server) body.server = server;
    const result = await requestWithFallback(HANAMI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify(body),
        timeout: 60000,
    }, { useProxy: process.env.HANAMI_USE_PROXY === '1' });
    const raw = result.raw;
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        console.error(`[buycloud] Hanami trả về không phải JSON (HTTP ${result.status}):`, raw.slice(0, 300));
        const snippet = raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        return { ok: false, message: `Hanami trả về HTML thay vì JSON (HTTP ${result.status}): ${snippet.replace(/`/g, "'")}`, source: result.source };
    }
    return { ok: data.code === 0, message: data.message || 'Không rõ', source: result.source };
}

/** Đăng ký 1 tài khoản VMOS. Trả về { account, mail, password }. */
async function regVmosAccount() {
    const response = await fetch('https://wxygtmfttyidwnhjdwdw.supabase.co/functions/v1/get-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: process.env.APIKEY },
        body: JSON.stringify({ clientId: crypto.randomUUID() }),
    });
    const data = await response.json();
    if (!data.content) throw new Error('Không lấy được dữ liệu.');
    const [mail, ...passParts] = data.content.split('|');
    return { account: mail, password: passParts.join('|'), copyText: data.content };
}

/** Đăng ký 1 tài khoản VSPhone. Trả về { account, password, token, userId, copyText }. */
async function regVsphoneAccount() {
    if (!vsphoneReady()) throw new Error('VSPhone chưa được cấu hình (thiếu VSPHONE_API_URL / VSPHONE_API_KEY).');
    const response = await fetch(process.env.VSPHONE_API_URL, {
        headers: { 'x-api-key': process.env.VSPHONE_API_KEY },
        signal: AbortSignal.timeout(90000),
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error(`API VSPhone không trả JSON (HTTP ${response.status})`); }
    if (!data.ok || !data.email || !data.password) {
        throw new Error(data.error || data.message || `API VSPhone trả lỗi (HTTP ${response.status})`);
    }
    const account = {
        account: data.email,
        password: data.password,
        token: data.token || null,
        userId: data.userId || data.user_id || data.userid || null,
    };
    return { ...account, copyText: accountCopyText(account) };
}

/** JSON có thể nằm trong markdown/backtick hoặc bị bọc bởi text ("Nội dung chính: {...}"). */
function parseLooseJson(value) {
    if (typeof value !== 'string') return value;
    let text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(text); } catch (e) { /* thử cắt giữa {} */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { /* không phải JSON */ }
    }
    return null;
}

/** Nhận chuỗi đã copy: email|mật khẩu|token:...|userid:... */
function parseVsphonePipe(raw) {
    const text = String(raw || '').trim();
    if (!text.includes('|')) return null;
    const parts = text.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const email = parts[0];
    const password = parts[1].replace(/^password\s*:\s*/i, '');
    let token = null;
    let userId = null;
    for (const part of parts.slice(2)) {
        const m = /^(token|userid|user_id|user\s*id)\s*:\s*(.+)$/i.exec(part);
        if (!m) continue;
        if (/^token/i.test(m[1])) token = m[2].trim();
        else userId = m[2].trim();
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || !token || !userId) return null;
    return { email, password, token, userId, orderId: null, devices: [] };
}

/** Đọc full response VSPhone Fast-buy mà user dán vào (có thể kèm markdown/~ $). */
function parseVsphoneFastResponse(raw) {
    const piped = parseVsphonePipe(raw);
    if (piped) return piped;
    const parsed = parseLooseJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    let data = parsed.data || parsed.result || parsed.info || parsed;
    if (typeof data === 'string') data = parseLooseJson(data) || data;
    if (!data || typeof data !== 'object') return null;
    const pick = (keys) => {
        for (const key of keys) {
            const value = data[key];
            if (value !== undefined && value !== null && value !== '') return value;
        }
        return null;
    };
    const email = pick(['email', 'account', 'username']);
    const password = pick(['password', 'pass', 'matKhau']);
    const token = pick(['token', 'accessToken', 'access_token']);
    const userId = pick(['userid', 'user_id', 'userId', 'id']);
    if (!email || !password || !token || !userId) return null;
    return {
        ...data,
        email: String(email),
        password: String(password),
        token: String(token),
        userId: String(userId),
        orderId: pick(['orderId', 'order_id']) || null,
        devices: Array.isArray(data.devices) ? data.devices : [],
    };
}

function field(label, value) {
    return { label, value: value === undefined || value === null ? '' : String(value) };
}

/** Copy đầy đủ: email|mật khẩu|token|userid — không làm rơi token/user id. */
function accountCopyText(info = {}) {
    const account = info.account !== undefined && info.account !== null ? info.account : info.email;
    const password = info.password !== undefined && info.password !== null ? info.password : info.pass;
    const parts = [account, password].filter(v => v !== undefined && v !== null && String(v) !== '').map(String);
    if (info.token !== undefined && info.token !== null && String(info.token) !== '') parts.push(`token:${info.token}`);
    if (info.userId !== undefined && info.userId !== null && String(info.userId) !== '') parts.push(`userid:${info.userId}`);
    return parts.join('|');
}

/** Chấp nhận `socks5h://host:port`, `socks5://host:port` hoặc chỉ `host:port` (WARP mặc định 127.0.0.1:40000). */
function normalizeProxy(value) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || /^socks/i.test(raw)) return raw;
    return `socks5h://${raw.replace(/^\/+/, '')}`;
}

function proxyKeyHeaders() {
    const key = String(process.env.API_PROXY_KEY || '').trim();
    return key ? { 'x-proxy-key': key } : {};
}

async function getProxyUrl() {
    return normalizeProxy(process.env.API_PROXY || '');
}

async function getRequestSources({ useProxy = true } = {}) {
    const proxyUrl = useProxy ? await getProxyUrl() : '';
    const sources = [];
    if (proxyUrl) {
        if (/^https?:\/\//i.test(proxyUrl)) {
            sources.push({ name: 'worker', kind: 'worker', url: proxyUrl });
        } else {
            sources.push({ name: 'warp', kind: 'socks', proxyUrl });
            // Nếu người dùng dán nhầm "host:port" của HTTP proxy (không có http://),
            // normalizeProxy sẽ ra socks5h://... → thử thêm dạng http:// cùng địa chỉ.
            try {
                const httpUrl = new URL(proxyUrl.replace(/^socks5h?:\/\//i, 'http://'));
                httpUrl.username = '';
                httpUrl.password = '';
                sources.push({ name: 'proxy', kind: 'worker', url: httpUrl.toString() });
            } catch (e) { /* bỏ qua */ }
        }
    }
    sources.push({ name: 'direct', kind: 'direct' });
    return sources;
}

function isBlockedResponse(response, raw, source) {
    if (response.status === 403) return true;
    if (source.kind === 'worker' && response.status === 404) return true; // Worker cũ/sai route
    return /Just a moment|cf-challenge|cloudflare/i.test(String(raw || '').slice(0, 500));
}

async function requestFromSource(source, targetUrl, options) {
    const headers = { ...(options.headers || {}) };
    let url = targetUrl;

    if (source.kind === 'worker') {
        const u = new URL(source.url);
        u.searchParams.set('url', targetUrl);
        url = u.toString();
        Object.assign(headers, proxyKeyHeaders());
    } else if (source.kind === 'socks') {
        const nodeOptions = { ...options, headers };
        delete nodeOptions.signal; // node-fetch v2 dùng timeout thay vì AbortSignal.timeout
        return nodeFetch(targetUrl, {
            ...nodeOptions,
            agent: new SocksProxyAgent(source.proxyUrl),
            timeout: Number(nodeOptions.timeout) || 60000,
        });
    }

    return fetch(url, { ...options, headers, redirect: 'manual' });
}

async function requestWithFallback(targetUrl, options = {}, { useProxy = true, parse = null } = {}) {
    const sources = await getRequestSources({ useProxy });
    const failures = [];

    for (const source of sources) {
        let response;
        let raw;
        try {
            response = await requestFromSource(source, targetUrl, options);
            raw = await response.text();
        } catch (e) {
            failures.push(`${source.name}: ${e.message}`);
            continue;
        }

        if (isBlockedResponse(response, raw, source)) {
            const challenge = /Just a moment/i.test(raw);
            failures.push(`${source.name}: HTTP ${response.status}${challenge ? ' (Cloudflare challenge)' : ''}`);
            continue;
        }
        const parsed = parse ? parse(raw) : null;
        if (!response.ok || (parse && (!parsed || parsed.success === false))) {
            return { raw, status: response.status, ok: false, source: source.name, parsed: null, failures };
        }
        return { raw, status: response.status, ok: true, source: source.name, parsed, failures };
    }
    throw new Error(failures.join(' · ') || 'Không gọi được API');
}

module.exports = {
    HANAMI_URL,
    CLOUD_NAMES,
    REG_COST,
    DEVICE_LOGOS,
    vsphoneReady,
    buyHanami,
    regVmosAccount,
    regVsphoneAccount,
    parseLooseJson,
    parseVsphoneFastResponse,
    parseVsphonePipe,
    accountCopyText,
};

