/**
 * Lưu chat riêng, lịch sử đơn hàng và thống kê vượt link trên GitHub Gist (secret).
 *
 * - Có GITHUB_TOKEN  -> gist cho chat (`gist_chat`), đơn (`gist_orders`) và
 *   link 7 ngày (`gist_links`), mỗi gist 1 file JSON.
 * - Không có token   -> fallback file JSON cục bộ trong ./data (dev/demo).
 *
 * Mặc định: đơn/link giữ 7 ngày, chat giữ 30 ngày. Không log nội dung chat/order.
 */
const fs = require('fs');
const path = require('path');
const db = require('./database');
const github = require('./github');

const KINDS = {
    chat: { kv: 'gist_chat', file: 'nigaria-chat.json', days: 30, field: 'messages', local: 'gist-chat.json' },
    orders: { kv: 'gist_orders', file: 'nigaria-orders.json', days: 7, field: 'orders', local: 'gist-orders.json' },
    links: { kv: 'gist_links', file: 'nigaria-links.json', days: 7, field: 'links', local: 'gist-links.json' },
};
const ALIASES = {
    chat: 'chat', message: 'chat', messages: 'chat',
    order: 'orders', orders: 'orders', history: 'orders', order_history: 'orders',
    link: 'links', links: 'links', link_stats: 'links', weekly: 'links',
};

const queues = {};

function kindFor(namespace) {
    const key = String(namespace || 'chat').toLowerCase();
    return ALIASES[key] || key;
}

function config(kind) {
    return KINDS[kind] || {
        kv: `gist_${kind}`,
        file: `nigaria-${kind}.json`,
        days: null,
        field: 'items',
        local: `gist-${kind}.json`,
    };
}

function empty(kind) {
    return { [config(kind).field]: [] };
}

function dataDir() {
    return process.env.MARKETPLACE_DATA_DIR || path.join(__dirname, 'data');
}

function localPath(kind) {
    return path.join(dataDir(), config(kind).local);
}

function readLocal(kind) {
    try {
        const raw = fs.readFileSync(localPath(kind), 'utf8');
        const data = JSON.parse(raw || '{}');
        return normalize(kind, data);
    } catch (e) {
        return empty(kind);
    }
}

function writeLocal(kind, data) {
    try {
        fs.mkdirSync(dataDir(), { recursive: true });
        const target = localPath(kind);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, target);
    } catch (e) {
        console.error(`[gist-store] không ghi được file local ${kind}:`, e.message);
    }
}

function normalize(kind, data) {
    const field = config(kind).field;
    const rows = data && Array.isArray(data[field]) ? data[field] : [];
    return { ...(data && typeof data === 'object' ? data : {}), [field]: rows };
}

async function read(kind) {
    const cfg = config(kind);
    if (github.hasToken()) {
        try {
            let gistId = await db.getKv(cfg.kv);
            if (!gistId) {
                const gist = await github.createGist(cfg.file, JSON.stringify(empty(kind)), `NIGARIA CLOUD ${kind}`);
                gistId = gist.id;
                await db.setKv(cfg.kv, gistId);
                return empty(kind);
            }
            const raw = await github.readGistFile(gistId, cfg.file);
            return normalize(kind, JSON.parse(raw || '{}'));
        } catch (e) {
            console.error(`[gist-store] đọc ${kind} từ gist lỗi, dùng file local:`, e.message);
        }
    }
    return readLocal(kind);
}

async function write(kind, data) {
    const cfg = config(kind);
    const payload = normalize(kind, data);
    if (github.hasToken()) {
        try {
            let gistId = await db.getKv(cfg.kv);
            if (!gistId) {
                const gist = await github.createGist(cfg.file, JSON.stringify(payload), `NIGARIA CLOUD ${kind}`);
                await db.setKv(cfg.kv, gist.id);
                return payload;
            }
            await github.writeGistFile(gistId, cfg.file, JSON.stringify(payload));
            return payload;
        } catch (e) {
            console.error(`[gist-store] ghi ${kind} lên gist lỗi, dùng file local:`, e.message);
        }
    }
    writeLocal(kind, payload);
    return payload;
}

function withLock(kind, fn) {
    const prev = queues[kind] || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues[kind] = next.catch(() => {});
    return next;
}

function timestamp(row) {
    const t = Date.parse(row && row.createdAt);
    return Number.isFinite(t) ? t : 0;
}

function pruneRows(kind, rows) {
    const days = config(kind).days;
    if (!days) return rows;
    const keepMs = days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    return rows.filter(row => {
        const t = timestamp(row);
        return !t || now - t <= keepMs;
    });
}

// ==================== API THEO CONTRACT ====================
/** Đọc mảng dữ liệu của namespace ('chat' | 'orders' | tuỳ ý). */
async function readJson(namespace, fallback = []) {
    const kind = kindFor(namespace);
    const data = normalize(kind, await read(kind));
    const field = config(kind).field;
    return Array.isArray(data[field]) ? data[field] : fallback;
}

/** Ghi đè nội dung namespace. Mảng được lưu vào field chính của namespace. */
async function writeJson(namespace, value) {
    const kind = kindFor(namespace);
    const field = config(kind).field;
    const payload = Array.isArray(value)
        ? { [field]: value }
        : normalize(kind, value && typeof value === 'object' ? value : { [field]: [value] });
    await write(kind, payload);
    return value;
}

/** Thêm 1 phần tử vào namespace; maxItems (nếu có) giữ N phần tử cuối. */
async function appendJson(namespace, entry, maxItems = 0) {
    const kind = kindFor(namespace);
    return await withLock(kind, async () => {
        const field = config(kind).field;
        const data = normalize(kind, await read(kind));
        const rows = Array.isArray(data[field]) ? data[field] : [];
        rows.push(entry);
        const parsedCap = parseInt(maxItems, 10);
        const cap = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : 0;
        data[field] = cap ? rows.slice(-cap) : rows;
        await write(kind, data);
        return entry;
    });
}

/** Xoá phần tử cũ hơn `days`, trả về mảng còn lại. */
async function pruneOld(namespace, dateField = 'createdAt', days = 7) {
    const kind = kindFor(namespace);
    return await withLock(kind, async () => {
        const field = config(kind).field;
        const data = normalize(kind, await read(kind));
        const cutoff = Date.now() - Math.max(0, Number(days) || 0) * 86400000;
        const val = row => {
            const t = Date.parse(row && row[dateField]);
            return Number.isFinite(t) ? t : 0;
        };
        data[field] = (Array.isArray(data[field]) ? data[field] : [])
            .filter(row => !val(row) || val(row) >= cutoff);
        await write(kind, data);
        return data[field];
    });
}

// ==================== CHAT ====================
async function listMessages() {
    const data = await read('chat');
    return data.messages.slice().sort((a, b) => timestamp(a) - timestamp(b));
}

async function listConversation(meId, partnerId) {
    const me = String(meId);
    const partner = String(partnerId);
    return (await listMessages()).filter(m =>
        (String(m.from) === me && String(m.to) === partner) ||
        (String(m.from) === partner && String(m.to) === me));
}

async function addMessage(message) {
    const row = {
        id: message.id,
        from: String(message.from),
        to: String(message.to),
        content: String(message.content || ''),
        createdAt: message.createdAt || new Date().toISOString(),
    };
    await appendJson('chat', row, 0);
    await pruneOld('chat', 'createdAt', config('chat').days);
    return row;
}

function unreadFromMessages(messages, me, partner) {
    let lastSent = 0;
    for (const m of messages) {
        if (String(m.from) === me && String(m.to) === partner) lastSent = Math.max(lastSent, timestamp(m));
    }
    return messages.filter(m =>
        String(m.from) === partner && String(m.to) === me && timestamp(m) > lastSent).length;
}

/**
 * Số tin từ partner (hoặc mọi người) mà user CHƯA reply.
 * Mốc so sánh là lần CUỐI user gửi tin cho partner — không phải trạng thái đã đọc.
 */
async function getUnreadCount(userId, partnerId = null) {
    const me = String(userId);
    const messages = await listMessages();
    const partners = partnerId
        ? [String(partnerId)]
        : [...new Set(messages
            .filter(m => String(m.to) === me || String(m.from) === me)
            .map(m => String(m.from) === me ? String(m.to) : String(m.from))
            .filter(id => id && id !== me))];
    return partners.reduce((sum, partner) => sum + unreadFromMessages(messages, me, partner), 0);
}

async function listContacts(userId, resolveDisplay = null) {
    const me = String(userId);
    const messages = (await listMessages()).filter(m => String(m.from) === me || String(m.to) === me);
    const partners = [...new Set(messages.map(m => String(m.from) === me ? String(m.to) : String(m.from)))];
    const contacts = [];
    for (const partner of partners) {
        if (!partner || partner === me) continue;
        const thread = messages.filter(m =>
            (String(m.from) === me && String(m.to) === partner) ||
            (String(m.from) === partner && String(m.to) === me));
        const last = thread[thread.length - 1];
        if (!last) continue;
        contacts.push({
            userId: partner,
            display: typeof resolveDisplay === 'function' ? await resolveDisplay(partner) : partner,
            lastMessage: String(last.content || ''),
            updatedAt: last.createdAt,
            unread: unreadFromMessages(messages, me, partner),
        });
    }
    contacts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return contacts;
}

// ==================== LỊCH SỬ ĐƠN HÀNG ====================
async function listOrders(userId = null) {
    let orders = (await read('orders')).orders.slice();
    if (userId != null) {
        const me = String(userId);
        orders = orders.filter(o => String(o.buyer_id) === me || String(o.seller_id) === me);
    }
    return orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getOrder(id) {
    return (await read('orders')).orders.find(o => String(o.id) === String(id)) || null;
}

async function upsertOrder(order) {
    return await withLock('orders', async () => {
        const data = await read('orders');
        const row = { ...order };
        if (!row.createdAt) row.createdAt = new Date().toISOString();
        const idx = data.orders.findIndex(o => String(o.id) === String(row.id));
        if (idx >= 0) data.orders[idx] = { ...data.orders[idx], ...row };
        else data.orders.push(row);
        data.orders = pruneRows('orders', data.orders);
        await write('orders', data);
        return row;
    });
}

// ==================== LINK STATS 7 NGÀY ====================
/** Ghi 1 lần vượt link kèm kỳ; gist giữ 7 ngày rồi tự prune. */
async function recordLink(userId, provider, period) {
    if (!userId) return null;
    const row = {
        userId: String(userId),
        provider: String(provider || ''),
        period: period ? String(period) : '',
        createdAt: new Date().toISOString(),
    };
    await appendJson('links', row, 0);
    await pruneOld('links', 'createdAt', 7);
    return row;
}

async function linkEvents(period = null) {
    const rows = await readJson('links');
    if (period == null) return rows;
    return rows.filter(r => !r.period || String(r.period) === String(period));
}

/** Tổng số link theo user trong 1 kỳ — dùng để khôi phục khi deploy mất DB local. */
async function aggregateLinkCounts(period) {
    const map = new Map();
    for (const row of await linkEvents(period)) {
        const id = String(row.userId || row.user_id || '');
        if (!id) continue;
        map.set(id, (map.get(id) || 0) + 1);
    }
    return [...map].map(([user_id, count]) => ({ user_id, period: String(period || ''), count }));
}

async function userLinkCount(userId, period) {
    const id = String(userId);
    return (await linkEvents(period)).filter(r => String(r.userId || r.user_id) === id).length;
}

module.exports = {
    // API theo CONTRACT.md
    readJson,
    writeJson,
    appendJson,
    pruneOld,
    // Link stats 7 ngày
    recordLink,
    linkEvents,
    aggregateLinkCounts,
    userLinkCount,
    // Helper nội bộ cho marketplace
    read,
    write,
    getUnreadCount,
    listMessages,
    listConversation,
    addMessage,
    listContacts,
    listOrders,
    getOrder,
    upsertOrder,
};
