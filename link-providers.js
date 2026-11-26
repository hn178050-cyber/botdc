/**
 * Cấu hình chung cho các dịch vụ rút gọn link ở cả web và Discord bot.
 * Mỗi provider có reward + số lượt/ngày riêng. /redeem đọc reward từ đây
 * nên web và bot luồng đồng nhất.
 */
const PROVIDERS = {
    link4m: {
        id: 'link4m',
        name: 'Link4M',
        reward: 50,
        dailyMax: 2,
        color: 0xffc107,
        logo: 'https://www.google.com/s2/favicons?domain=link4m.com&sz=128',
    },
    layma: {
        id: 'layma',
        name: 'LayMa',
        reward: 50,
        dailyMax: 2,
        color: 0x8b5cf6,
        logo: 'https://layma.net/assets/favicon.ico',
    },
    bbmkts: {
        id: 'bbmkts',
        name: 'bbmkts',
        reward: 25,
        dailyMax: 1,
        color: 0x22c55e,
        logo: 'https://bbmkts.com/images/iconbb.png',
    },
};

function get(id) {
    return PROVIDERS[String(id || '').toLowerCase()] || null;
}

function rewardFor(id) {
    const p = get(id);
    return p ? p.reward : 50;
}

function dailyMaxFor(id) {
    const p = get(id);
    return p ? p.dailyMax : 2;
}

function tokenFor(id) {
    switch (String(id)) {
        case 'bbmkts':
            return process.env.BBMKTS_API_TOKEN || process.env.VUOTNHANH_API_TOKEN || '';
        case 'link4m':
            return process.env.LINK4M_API_KEY || '';
        case 'layma':
            return process.env.LAYMA_TOKEN || '';
        default:
            return '';
    }
}

function ready(id) {
    return !!tokenFor(id);
}

/** Đọc message lỗi từ response provider (nếu có) để FE biết lý do thật. */
function reasonOf(raw, data) {
    if (data && (data.message || data.error || data.status)) {
        return String(data.message || data.error || data.status);
    }
    return String(raw || '').slice(0, 120);
}

/** Rút gọn targetUrl. Ném lỗi nếu provider chưa cấu hình hoặc API trả về rỗng. */
async function shorten(id, longUrl) {
    const provider = get(id);
    if (!provider) throw new Error('Dịch vụ không hợp lệ.');
    const target = String(longUrl || '');
    if (!target) throw new Error('Thiếu URL cần rút gọn.');

    if (provider.id === 'bbmkts') {
        const token = tokenFor('bbmkts');
        if (!token) throw new Error('bbmkts chưa được cấu hình (BBMKTS_API_TOKEN).');
        const apiUrl = `https://bbmkts.com/dapi?token=${encodeURIComponent(token)}&longurl=${encodeURIComponent(target)}&format=text`;
        const res = await fetch(apiUrl, {
            headers: { 'User-Agent': 'nigaria-link', Accept: 'text/plain, application/json' },
            signal: AbortSignal.timeout(15000),
        });
        const raw = (await res.text()).trim();
        if (!res.ok || !raw) throw new Error(`Lỗi từ bbmkts (${res.status}): ${reasonOf(raw)}`);

        // API có thể trả TEXT hoặc JSON tuỳ bản; hỗ trợ cả hai.
        try {
            const data = JSON.parse(raw);
            if (data.status === 'success' && data.bbmktsUrl && /^https?:\/\//i.test(String(data.bbmktsUrl))) {
                return String(data.bbmktsUrl);
            }
            throw new Error(`Lỗi từ bbmkts: ${reasonOf(raw, data)}`);
        } catch (e) {
            if (/^Lỗi từ bbmkts:/.test(e.message)) throw e;
        }
        if (/^https?:\/\//i.test(raw)) return raw;
        throw new Error(`Lỗi từ bbmkts: ${reasonOf(raw)}`);
    }

    if (provider.id === 'link4m') {
        const token = tokenFor('link4m');
        if (!token) throw new Error('Link4M chưa được cấu hình (LINK4M_API_KEY).');
        const apiUrl = `https://link4m.co/api-shorten/v2?api=${encodeURIComponent(token)}&url=${encodeURIComponent(target)}`;
        const res = await fetch(apiUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
        });
        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* xử lý bên dưới */ }
        if (!res.ok) throw new Error(`Lỗi từ Link4M (${res.status}): ${reasonOf(raw, data)}`);
        if (data && data.status === 'success' && data.shortenedUrl) return data.shortenedUrl;
        throw new Error(`Lỗi từ Link4M: ${reasonOf(raw, data)}`);
    }

    // LayMa: GET quicklink?tokenUser=...&format=json -> { success, html }
    const token = tokenFor('layma');
    if (!token) throw new Error('LayMa chưa được cấu hình (LAYMA_TOKEN).');
    const apiUrl = `https://api.layma.net/api/admin/shortlink/quicklink?tokenUser=${encodeURIComponent(token)}&format=json&url=${encodeURIComponent(target)}`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* xử lý bên dưới */ }
    if (!res.ok) throw new Error(`Lỗi từ LayMa (${res.status}): ${reasonOf(raw, data)}`);
    if (data && data.success === true && data.html) return data.html;
    throw new Error(`Lỗi từ LayMa: ${reasonOf(raw, data)}`);
}

module.exports = {
    PROVIDERS,
    get,
    rewardFor,
    dailyMaxFor,
    tokenFor,
    ready,
    shorten,
};
