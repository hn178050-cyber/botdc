/**
 * Marketplace user-shop, ACOIN, chat riêng, seller & quản trị đơn hàng.
 *
 * Module này chỉ phụ thuộc vào database/shop/gist-store/plugin-engine để tránh
 * vòng lặp require với web.js. web.js mount `router` vào router chính.
 */
const express = require('express');
const crypto = require('crypto');

const db = require('./database');
const shop = require('./shop');
const github = require('./github');
const gistStore = require('./gist-store');
const pluginEngine = require('./plugin-engine');
const { randomId } = require('./utils');

const router = express.Router();

const DEFAULT_RATE = 5;
const RATE_KV = 'exchange_coin_per_acoin';
const HOLD_MS = 3 * 24 * 60 * 60 * 1000;
const FEE_RATE = 0.1;
const REFUND_RATE = 0.9;
const SHOP_LIMIT = 3;
const PAGE_SIZE = 20;
const FILTERS = ['recommended', 'newest', 'oldest', 'cheapest', 'priciest', 'topRated', 'bestSelling'];
const SELLER_STATUSES = ['none', 'pending', 'active', 'suspended'];

// ==================== TIỆN ÍCH ====================
function ah(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function hook(event, payload = {}) {
    pluginEngine.emit(event, payload);
}

async function safe(fn, fallback) {
    try {
        const value = await fn();
        return value === undefined || value === null ? fallback : value;
    } catch (e) {
        return fallback;
    }
}

function toInt(value, fallback = 0) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function validHttpUrl(value) {
    try {
        const u = new URL(String(value));
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

function balanceKey(user) {
    return user && user.discord_id ? String(user.discord_id) : `web_${user && user.id}`;
}

function time(value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
}

function requireAuth(req, res, next) {
    if (!req.webUser) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
    next();
}

async function isAdmin(discordId) {
    if (!discordId) return false;
    const envIds = (process.env.ADMIN_DISCORD_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    if (envIds.includes(String(discordId))) return true;
    return await safe(() => db.isAdmin(discordId), false);
}

/** key có thể là Discord ID hoặc `web_<id>` (dùng trong chat/đánh giá/BXH). */
async function isAdminUserKey(key) {
    if (!key) return false;
    const raw = String(key);
    const discordId = raw.startsWith('web_')
        ? ((await safe(() => db.getWebUserById(raw.slice(4)), null)) || {}).discord_id
        : raw;
    return isAdmin(discordId);
}

async function requireAdmin(req, res, next) {
    if (!req.webUser) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
    if (!(await isAdmin(req.webUser.discord_id))) {
        return res.status(403).json({ error: 'Chỉ admin mới truy cập được.' });
    }
    next();
}

async function requireSeller(req, res, next) {
    const seller = await safe(() => db.getSeller(req.webUser.id), null);
    if (!seller || seller.status !== 'active') {
        return res.status(403).json({ error: 'Bạn chưa phải seller được duyệt.' });
    }
    req.seller = seller;
    next();
}

async function getExchangeRate() {
    const stored = toInt(await safe(() => db.getKv(RATE_KV), ''), 0);
    if (stored >= 1) return stored;
    const env = toInt(process.env.EXCHANGE_COIN_PER_ACOIN, 0);
    return env >= 1 ? env : DEFAULT_RATE;
}

async function setExchangeRate(coinPerAcoin) {
    const rate = toInt(coinPerAcoin, 0);
    if (rate < 1) throw new Error('Tỷ giá tối thiểu là 1 coin/ACOIN.');
    await db.setKv(RATE_KV, rate);
    return rate;
}

/** Bot truyền Discord id; web truyền web user id. Trả về key dùng trong DB. */
async function resolveUserId(idOrDiscord) {
    const raw = String(idOrDiscord || '').trim();
    if (!raw) return raw;
    const byId = await safe(() => db.getWebUserById(raw), null);
    if (byId) return String(byId.id);
    const byDiscord = await safe(() => db.getWebUserByDiscordId(raw), null);
    if (byDiscord) return String(byDiscord.id);
    return raw;
}

/** Số ACOIN của 1 user (bot thường truyền Discord id). */
async function getAcoin(discordId) {
    return Number(await safe(() => db.getAcoin(String(discordId)), 0)) || 0;
}

async function requestSeller(discordId) {
    const userId = await resolveUserId(discordId);
    const current = await safe(() => db.getSeller(userId), null);
    if (current && current.status !== 'none') return { ok: true, status: current.status };
    const seller = await db.upsertSeller({ user_id: userId, status: 'pending', note: '' });
    hook('web:seller:request', { id: userId });
    return { ok: true, status: 'pending', seller };
}

async function approveSeller(sellerIdOrDiscordId, adminId = null) {
    const userId = await resolveUserId(sellerIdOrDiscordId);
    let seller = await db.getSeller(userId);
    if (seller) seller = await db.updateSeller(userId, { status: 'active' }) || { ...seller, status: 'active' };
    else seller = await db.upsertSeller({ user_id: userId, status: 'active' });
    hook('web:seller:approved', { id: userId, by: adminId });
    return { ok: true, seller: { ...seller, status: 'active' } };
}

/** Chỉnh ACOIN trực tiếp trên bảng acoin_balances (bot /exchange dùng). */
async function adjustAcoin(discordId, delta) {
    const amount = Math.floor(Number(delta) || 0);
    const balance = await db.updateAcoin(String(discordId), amount);
    return Number(balance) || 0;
}

async function getSeller(discordId) {
    const userId = await resolveUserId(discordId);
    return await safe(() => db.getSeller(userId), null);
}

async function listSellers() {
    return await safe(() => db.listSellers(), []);
}

/** Dùng chung cho route admin và bot /appeal. */
async function decideReview(reviewId, approve, note = '') {
    const review = await db.getReview(reviewId);
    if (!review) throw new Error('Không tìm thấy đánh giá.');
    const accepted = approve === true || String(approve) === 'true';
    const patch = { status: accepted ? 'visible' : 'hidden', appealed: accepted ? false : !!review.appealed };
    const text = String(note || '').trim();
    if (text) patch.admin_reply = text;
    await db.updateReview(review.id, patch);
    return { ok: true, review: { ...review, ...patch } };
}

async function decideComplaint(complaintId, approve, note = '') {
    const complaint = await db.getComplaint(complaintId);
    if (!complaint) throw new Error('Không tìm thấy khiếu nại.');
    const accepted = approve === true || String(approve) === 'true';
    const text = String(note || '').trim();
    const status = accepted ? 'approved' : 'rejected';
    await db.updateComplaint(complaint.id, { status, note: text });
    const updatedComplaint = { ...complaint, status, note: text };
    const order = await db.getOrder(complaint.order_id);
    if (order) {
        if (accepted) {
            // Seller mất tiền: không giải ngân khoản đang giữ.
            await updateOrderAndHistory(order, { payout_state: 'lost' });
        } else {
            // Bác bỏ: seller được nhận tiền (nếu chưa trả).
            let updated = await updateOrderAndHistory(order, { status: 'completed' });
            updated = await releasePayout(updated);
            if (updated.payout_state !== 'released' && Number(updated.seller_amount) > 0) {
                const user = await safe(() => db.getWebUserById(updated.seller_id), null);
                const key = user ? balanceKey(user) : `web_${updated.seller_id}`;
                if (updated.currency === 'acoin') await db.updateAcoin(key, Number(updated.seller_amount));
                else await db.updateCoins(key, Number(updated.seller_amount));
                await updateOrderAndHistory(updated, { payout_state: 'released' });
            }
        }
    }
    return { ok: true, complaint: updatedComplaint };
}

/** Thông tin bổ sung cho GET /api/me (publicUser cũng dùng hàm này). */
async function summaryForUser(user) {
    const fallback = { language: 'vi', acoin: 0, exchangeRate: DEFAULT_RATE, sellerStatus: 'none', isSeller: false, unreadMessages: 0 };
    if (!user) return fallback;
    const [languageRaw, acoin, exchangeRate, seller, unreadMessages] = await Promise.all([
        safe(() => db.getKv(`lang:${user.id}`), ''),
        safe(() => db.getAcoin(balanceKey(user)), 0),
        getExchangeRate(),
        safe(() => db.getSeller(user.id), null),
        safe(() => gistStore.getUnreadCount(user.id), 0),
    ]);
    const language = languageRaw === 'en' ? 'en' : 'vi';
    const sellerStatus = seller && SELLER_STATUSES.includes(seller.status) ? seller.status : 'none';
    return {
        language,
        acoin: Number(acoin) || 0,
        exchangeRate,
        sellerStatus,
        isSeller: sellerStatus === 'active',
        unreadMessages: Number(unreadMessages) || 0,
    };
}

async function getUnreadCount(userId, partnerId = null) {
    return await gistStore.getUnreadCount(userId, partnerId || null);
}

/** Tên hiển thị an toàn cho user (không trả dữ liệu nhạy cảm). */
async function displayName(userId) {
    if (!userId) return 'Người dùng';
    if (String(userId) === 'system') return 'Hệ thống';
    const user = await safe(() => db.getWebUserById(String(userId)), null);
    if (user && user.username) return user.username;
    const short = String(userId).slice(0, 8);
    return `Người dùng ${short}`;
}

async function persistOrder(order) {
    try { await gistStore.upsertOrder(order); } catch (e) { /* lịch sử Gist best-effort */ }
}

function publicHistoryOrder(order, viewerId = null) {
    const out = {
        id: order.id,
        shopId: order.shop_id || order.shopId || '',
        productId: order.product_id || order.productId || '',
        itemName: order.item_name || order.itemName || '',
        shopName: order.shop_name || order.shopName || '',
        quantity: Number(order.quantity) || 0,
        total: Number(order.total) || 0,
        currency: order.currency === 'acoin' ? 'acoin' : 'coin',
        status: order.status || 'pending',
        createdAt: order.createdAt || order.created_at,
    };
    if (viewerId && String(order.buyer_id) === String(viewerId)) {
        out.accounts = Array.isArray(order.accounts) ? order.accounts : String(order.accounts || '').split('\n').filter(Boolean);
    }
    return out;
}

function publicOrder(order, forBuyer = false) {
    const out = {
        id: order.id,
        shopId: order.shop_id,
        shopName: order.shop_name,
        productId: order.product_id,
        itemName: order.item_name,
        quantity: Number(order.quantity) || 1,
        total: Number(order.total) || 0,
        currency: order.currency === 'acoin' ? 'acoin' : 'coin',
        status: order.status,
        viewed: !!order.viewed,
        createdAt: order.created_at || order.createdAt,
    };
    if (forBuyer) out.accounts = String(order.accounts || '').split('\n').filter(Boolean);
    return out;
}

/** Tồn thực tế: ưu tiên số nhỏ hơn giữa stock và line_count để sửa dữ liệu cũ bị lệch. */
function effectiveStock(item) {
    const values = [Number(item && item.stock), Number(item && item.line_count)]
        .filter(Number.isFinite).map(v => Math.max(0, v));
    return values.length ? Math.min(...values) : 0;
}

function publicProduct(item) {
    return {
        id: item.id,
        name: item.name,
        description: item.description || '',
        price: Number(item.price_value === undefined ? item.price : item.price_value) || 0,
        currency: item.currency === 'acoin' ? 'acoin' : 'coin',
        priceText: item.currency === 'acoin' ? `$${Number(item.price_value === undefined ? item.price : item.price_value)}` : String(Number(item.price_value === undefined ? item.price : item.price_value)),
        stock: effectiveStock(item),
        active: item.active !== false,
        logoUrl: item.logo_url || '',
        maxLines: Math.min(2000, Math.max(1, parseInt(item.max_lines, 10) || 2000)),
        createdAt: item.created_at,
    };
}

function publicReview(review) {
    return {
        id: review.id,
        buyer: review.buyer_name || review.buyer_id,
        buyerIsAdmin: !!review.buyer_is_admin,
        stars: Number(review.stars) || 0,
        content: String(review.content || ''),
        status: review.status || 'visible',
        adminReply: review.admin_reply || null,
        appealed: !!review.appealed,
        createdAt: review.created_at,
    };
}

function parsePrice(text) {
    const raw = String(text || '').trim();
    if (raw.startsWith('$')) {
        return { currency: 'acoin', price: Math.max(0, Number(raw.slice(1).replace(/[^\d.]/g, '')) || 0) };
    }
    return { currency: 'coin', price: Math.max(0, Number(raw.replace(/[^\d.]/g, '')) || 0) };
}

// ==================== HỒ SƠ / ACOIN ====================
router.post('/api/profile/language', requireAuth, ah(async (req, res) => {
    const language = String(req.body.language || '').toLowerCase();
    if (!['vi', 'en'].includes(language)) return res.status(400).json({ error: 'Ngôn ngữ không hợp lệ.' });
    await db.setKv(`lang:${req.webUser.id}`, language);
    res.json({ ok: true, language });
}));

router.post('/api/exchange', requireAuth, ah(async (req, res) => {
    const from = String(req.body.from || '');
    const amount = Number(req.body.amount);
    if (!['coin', 'acoin'].includes(from) || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Số lượng phải lớn hơn 0 và loại phải là coin hoặc acoin.' });
    }
    const rate = await getExchangeRate();
    const key = balanceKey(req.webUser);

    if (from === 'coin') {
        const coin = Math.floor(amount);
        const acoin = Math.floor(coin / rate);
        if (coin < 1 || acoin < 1) return res.status(400).json({ error: `Cần ít nhất ${rate} coin để đổi 1 ACOIN.` });
        const balance = await db.getCoins(key);
        if (balance < coin) return res.status(400).json({ error: `Bạn không đủ coin. Số dư: ${balance}.` });
        const [newCoin, newAcoin] = await Promise.all([
            db.updateCoins(key, -coin),
            db.updateAcoin(key, acoin),
        ]);
        hook('web:exchange', { id: req.webUser.id, from, coin, acoin, rate });
        return res.json({ ok: true, coin, acoin, newCoin, newAcoin });
    }

    const acoin = Math.floor(amount);
    const coin = acoin * rate;
    if (acoin < 1) return res.status(400).json({ error: 'Số ACOIN phải lớn hơn 0.' });
    const balance = await db.getAcoin(key);
    if (balance < acoin) return res.status(400).json({ error: `Bạn không đủ ACOIN. Số dư: ${balance}.` });
    const [newAcoin, newCoin] = await Promise.all([
        db.updateAcoin(key, -acoin),
        db.updateCoins(key, coin),
    ]);
    hook('web:exchange', { id: req.webUser.id, from, coin, acoin, rate });
    res.json({ ok: true, coin, acoin, newCoin, newAcoin });
}));

router.get('/api/admin/exchange-rate', requireAdmin, ah(async (req, res) => {
    res.json({ coinPerAcoin: await getExchangeRate() });
}));

router.post('/api/admin/exchange-rate', requireAdmin, ah(async (req, res) => {
    const coinPerAcoin = toInt(req.body.coinPerAcoin, 0);
    if (coinPerAcoin < 1) return res.status(400).json({ error: 'Tỷ giá tối thiểu là 1 coin/ACOIN.' });
    await setExchangeRate(coinPerAcoin);
    res.json({ ok: true, coinPerAcoin });
}));

// ==================== LỊCH SỬ ĐƠN (GIST) ====================
router.get('/api/orders/history', requireAuth, ah(async (req, res) => {
    const orders = await gistStore.listOrders(req.webUser.id);
    res.json({ orders: orders.map(o => publicHistoryOrder(o, req.webUser.id)) });
}));

// ==================== CHAT RIÊNG ====================
router.get('/api/messages/contacts', requireAuth, ah(async (req, res) => {
    const contacts = await gistStore.listContacts(req.webUser.id, displayName);
    const withCrown = await Promise.all(contacts.map(async c => ({ ...c, isAdmin: await isAdminUserKey(c.userId) })));
    res.json({ contacts: withCrown });
}));

router.get('/api/messages', requireAuth, ah(async (req, res) => {
    const partnerId = String(req.query.with || '');
    if (!partnerId) return res.json({ messages: [] });
    const messages = await gistStore.listConversation(req.webUser.id, partnerId);
    // KHÔNG đánh dấu đã đọc: unread chỉ giảm khi user gửi reply.
    res.json({ messages: messages.map(m => ({
        id: m.id, from: String(m.from), to: String(m.to), content: m.content, createdAt: m.createdAt,
    })) });
}));

router.post('/api/messages', requireAuth, ah(async (req, res) => {
    const to = String(req.body.to || '').trim();
    const content = String(req.body.content || '');
    if (!to) return res.status(400).json({ error: 'Nhập người nhận.' });
    if (to === String(req.webUser.id)) return res.status(400).json({ error: 'Không thể tự nhắn cho chính mình.' });
    if (!content.trim()) return res.status(400).json({ error: 'Nội dung không được rỗng.' });
    if (content.length > 2000) return res.status(400).json({ error: 'Tin nhắn tối đa 2000 ký tự.' });
    const message = await gistStore.addMessage({
        id: randomId(), from: req.webUser.id, to, content, createdAt: new Date().toISOString(),
    });
    hook('web:message:sent', { id: message.id, from: req.webUser.id, to });
    res.json({ ok: true, message });
}));

// ==================== SELLER ====================
router.post('/api/seller/request', requireAuth, ah(async (req, res) => {
    const result = await requestSeller(req.webUser.id);
    res.json({ ok: true, status: result.status });
}));

function shopSummary(shopRow, products = []) {
    return {
        id: shopRow.id,
        name: shopRow.name,
        description: shopRow.description || '',
        logoUrl: shopRow.logo_url || '',
        backgroundUrl: shopRow.background_url || '',
        productCount: products.length,
        createdAt: shopRow.created_at,
    };
}

function revenueSeries(orders, type) {
    const make = (label, filter) => {
        const rows = orders.filter(filter);
        return {
            label,
            value: rows.reduce((s, o) => s + (Number(o.total) || 0), 0),
            net: rows.reduce((s, o) => s + (Number(o.seller_amount) || 0), 0),
        };
    };
    if (type === 'week') {
        return Array.from({ length: 7 }, (_, i) => {
            const d = new Date(Date.now() - (6 - i) * 86400000);
            const label = d.toISOString().slice(5, 10);
            return make(label, o => String(o.createdAt || o.created_at || '').slice(0, 10) === label);
        });
    }
    if (type === 'month') {
        return Array.from({ length: 4 }, (_, i) => {
            const start = Date.now() - (3 - i) * 7 * 86400000;
            const label = `T${i + 1}`;
            return make(label, o => {
                const t = time(o.createdAt || o.created_at);
                return t > start - 7 * 86400000 && t <= start;
            });
        });
    }
    if (type === 'quarter') {
        return Array.from({ length: 13 }, (_, i) => {
            const start = Date.now() - (12 - i) * 7 * 86400000;
            const label = new Date(start - 3 * 86400000).toISOString().slice(5, 10);
            return make(label, o => {
                const t = time(o.createdAt || o.created_at);
                return t > start - 7 * 86400000 && t <= start;
            });
        });
    }
    return Array.from({ length: 12 }, (_, i) => {
        const d = new Date();
        d.setMonth(d.getMonth() - (11 - i));
        const label = `${String(d.getMonth() + 1).padStart(2, '0')}`;
        return make(label, o => String(o.createdAt || o.created_at || '').slice(5, 7) === label);
    });
}

router.get('/api/seller/dashboard', requireAuth, requireSeller, ah(async (req, res) => {
    const shops = await safe(() => db.getShopsByOwner(req.webUser.id), []);
    const productsByShop = await Promise.all(shops.map(s => safe(() => db.getShopItemsByShop(s.id, false), [])));
    const products = productsByShop.flat();
    const orders = await safe(() => db.listOrders({ seller_id: String(req.webUser.id) }), []);
    const reviews = await safe(() => db.listReviews(), []);
    const complaints = await safe(() => db.listComplaints({ seller_id: String(req.webUser.id) }), []);

    const completed = orders.filter(o => o.status === 'completed');
    const returned = orders.filter(o => o.status === 'returned');
    const pendingOrders = orders.filter(o => o.status === 'pending');
    const pct = (n) => Number(((n / Math.max(1, orders.length)) * 100).toFixed(1));
    const shopIds = new Set(shops.map(s => String(s.id)));
    const relevantReviews = reviews.filter(r => shopIds.has(String(r.shop_id)));

    const releasedOrders = orders.filter(o => o.payout_state === 'released');
    const heldOrders = orders.filter(o => o.payout_state === 'pending' && o.status !== 'returned');
    const gross = list => list.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const net = list => list.reduce((s, o) => s + (Number(o.seller_amount) || 0), 0);
    const statusCounts = {
        pending: orders.filter(o => o.status === 'pending').length,
        completed: completed.length,
        complained: orders.filter(o => o.status === 'complained').length,
        returned: returned.length,
    };
    const activeProducts = products.filter(p => p.active !== false);

    const stats = {
        accountsImported: products.reduce((s, p) => s + effectiveStock(p), 0),
        shops: shops.length,
        activeShops: shops.length,
        pendingCoin: net(heldOrders),
        processedCoin: net(releasedOrders),
        grossReceived: gross(releasedOrders),
        grossPending: gross(heldOrders),
        totalOrders: orders.length,
        pendingOrders: pendingOrders.length,
        activeProducts: activeProducts.length,
        inactiveProducts: products.length - activeProducts.length,
        complainants: complaints.length,
        complaintPercent: pct(complaints.length),
        completedOrders: completed.length,
        completedPercent: pct(completed.length),
        returns: returned.length,
        returnPercent: pct(returned.length),
    };

    const soldByItem = {};
    orders.forEach(o => {
        const key = String(o.product_id || '');
        if (key) soldByItem[key] = (soldByItem[key] || 0) + (Number(o.quantity) || 1);
    });
    const buyerIds = [...new Set(orders.slice(0, 8).map(o => String(o.buyer_id || '')).filter(Boolean))];
    const buyers = await Promise.all(buyerIds.map(id => safe(() => db.getWebUserById(id), null)));
    const buyerNames = Object.fromEntries(buyerIds.map((id, i) => [id, (buyers[i] && (buyers[i].username || buyers[i].discord_id)) || id.slice(0, 8)]));
    const recentOrders = orders.slice(0, 8).map(o => ({
        id: o.id,
        itemName: o.item_name || '',
        buyer: buyerNames[String(o.buyer_id || '')] || String(o.buyer_id || '').slice(0, 8),
        total: Number(o.total) || 0,
        sellerAmount: Number(o.seller_amount) || 0,
        quantity: Number(o.quantity) || 1,
        currency: o.currency || 'coin',
        status: o.status,
        payoutState: o.payout_state || '',
        holdDays: o.hold_until ? Math.max(0, Math.ceil((new Date(o.hold_until).getTime() - Date.now()) / 86400000)) : 0,
        createdAt: o.createdAt || o.created_at,
    }));

    res.json({
        stats,
        revenue: {
            week: revenueSeries(orders, 'week'),
            month: revenueSeries(orders, 'month'),
            quarter: revenueSeries(orders, 'quarter'),
            year: revenueSeries(orders, 'year'),
        },
        orders: { total: orders.length, pending: pendingOrders.length, statusCounts, recent: recentOrders },
        soldByItem,
        shops: shops.map((s, i) => shopSummary(s, productsByShop[i])),
        reviews: relevantReviews.length,
    });
}));

function validateShopBody(body) {
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();
    const logoUrl = String(body.logoUrl || '').trim();
    const backgroundUrl = String(body.backgroundUrl || '').trim();
    if (name.length < 2) return { error: 'Tên shop tối thiểu 2 ký tự.' };
    if (logoUrl && !validHttpUrl(logoUrl)) return { error: 'Logo phải là link http(s).' };
    if (backgroundUrl && !validHttpUrl(backgroundUrl)) return { error: 'Ảnh nền phải là link http(s).' };
    return { name, description, logoUrl, backgroundUrl };
}

router.post('/api/seller/shop', requireAuth, requireSeller, ah(async (req, res) => {
    const data = validateShopBody(req.body);
    if (data.error) return res.status(400).json({ error: data.error });
    const existing = await safe(() => db.getShopsByOwner(req.webUser.id), []);
    if (existing.length >= SHOP_LIMIT) return res.status(400).json({ error: `Mỗi seller chỉ tạo tối đa ${SHOP_LIMIT} shop.` });
    const row = await db.createShop({
        id: randomId(), owner_id: req.webUser.id, name: data.name, description: data.description,
        logo_url: data.logoUrl, background_url: data.backgroundUrl,
    });
    res.json({ ok: true, shop: shopSummary(row, []) });
}));

router.post('/api/seller/shop/:id', requireAuth, requireSeller, ah(async (req, res) => {
    const row = await db.getShop(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy shop.' });
    if (String(row.owner_id) !== String(req.webUser.id)) return res.status(403).json({ error: 'Bạn không phải chủ shop này.' });
    const data = validateShopBody(req.body);
    if (data.error) return res.status(400).json({ error: data.error });
    const updated = await db.updateShop(row.id, {
        name: data.name, description: data.description, logo_url: data.logoUrl, background_url: data.backgroundUrl,
    });
    res.json({ ok: true, shop: shopSummary({ ...row, ...(updated || {}) }) });
}));

router.post('/api/seller/shop/:id/product', requireAuth, requireSeller, ah(async (req, res) => {
    const row = await db.getShop(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy shop.' });
    if (String(row.owner_id) !== String(req.webUser.id)) return res.status(403).json({ error: 'Bạn không phải chủ shop này.' });

    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const accountsText = String(req.body.accountsText || '');
    const maxLines = Math.min(2000, Math.max(1, toInt(req.body.maxLines, 2000)));
    const { currency, price } = parsePrice(req.body.priceText);
    if (name.length < 2) return res.status(400).json({ error: 'Tên sản phẩm tối thiểu 2 ký tự.' });
    if (price <= 0) return res.status(400).json({ error: 'Giá sản phẩm phải lớn hơn 0.' });
    const lines = github.parseLines(accountsText);
    if (!lines.length) return res.status(400).json({ error: 'Danh sách tài khoản trống.' });
    if (lines.length > maxLines) return res.status(400).json({ error: `Số tài khoản vượt quá ${maxLines} dòng.` });

    const stockInfo = await shop.createStock(name, accountsText);
    const item = await db.createShopItem({
        id: randomId(), name, description, price, price_value: price, currency,
        shop_id: row.id, max_lines: maxLines, line_count: stockInfo.stock,
        logo_url: String(req.body.logoUrl || '').trim() || row.logo_url || '',
        category: 'user-shop', created_by: req.webUser.id,
        ...stockInfo,
    });
    res.json({ ok: true, product: publicProduct(item) });
}));

/** Nạp thêm tài khoản vào kho của 1 sản phẩm (nút "Nhập tài khoản" trong temp). */
router.post('/api/seller/product/:id/accounts', requireAuth, requireSeller, ah(async (req, res) => {
    const item = await db.getShopItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
    const owner = await db.getShop(item.shop_id);
    if (!owner || String(owner.owner_id) !== String(req.webUser.id)) return res.status(403).json({ error: 'Bạn không phải chủ sản phẩm này.' });

    const accountsText = String(req.body.accountsText || '');
    const added = github.parseLines(accountsText);
    if (!added.length) return res.status(400).json({ error: 'Danh sách tài khoản trống.' });
    const maxLines = Math.min(2000, Math.max(1, parseInt(item.max_lines, 10) || 2000));
    const currentStock = effectiveStock(item);
    if (currentStock + added.length > maxLines) return res.status(400).json({ error: `Tối đa ${maxLines} tài khoản cho mỗi sản phẩm.` });

    const updatedStock = await shop.addStock(item, accountsText);
    const patch = { stock: updatedStock.stock, line_count: updatedStock.stock };
    if (updatedStock.stock_content !== undefined) patch.stock_content = updatedStock.stock_content;
    if (updatedStock.gist_id) { patch.gist_id = updatedStock.gist_id; patch.gist_filename = updatedStock.gist_filename; }
    const row = await db.updateShopItem(item.id, patch);
    res.json({ ok: true, added: added.length, product: publicProduct({ ...item, ...patch, ...(row || {}) }) });
}));

async function ownedSellerProduct(req) {
    const item = await db.getShopItem(req.params.id);
    if (!item) return { status: 404, error: 'Không tìm thấy sản phẩm.' };
    const owner = await db.getShop(item.shop_id);
    if (!owner || String(owner.owner_id) !== String(req.webUser.id)) return { status: 403, error: 'Bạn không phải chủ sản phẩm này.' };
    return { item };
}

/** Sửa thông tin sản phẩm: các nút edit/toggle trong bảng sản phẩm của temp. */
router.post('/api/seller/product/:id', requireAuth, requireSeller, ah(async (req, res) => {
    const owned = await ownedSellerProduct(req);
    if (!owned.item) return res.status(owned.status).json({ error: owned.error });
    const patch = {};
    if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (name.length < 2) return res.status(400).json({ error: 'Tên sản phẩm tối thiểu 2 ký tự.' });
        patch.name = name;
    }
    if (req.body.description !== undefined) patch.description = String(req.body.description).trim();
    if (req.body.logoUrl !== undefined) patch.logo_url = String(req.body.logoUrl).trim();
    if (req.body.priceText !== undefined) {
        const { currency, price } = parsePrice(req.body.priceText);
        if (price <= 0) return res.status(400).json({ error: 'Giá sản phẩm phải lớn hơn 0.' });
        patch.price = price; patch.price_value = price; patch.currency = currency;
    }
    if (req.body.active !== undefined) patch.active = !!req.body.active;
    const row = await db.updateShopItem(req.params.id, patch);
    res.json({ ok: true, product: publicProduct({ ...owned.item, ...patch, ...(row || {}) }) });
}));

router.post('/api/seller/product/:id/toggle', requireAuth, requireSeller, ah(async (req, res) => {
    const owned = await ownedSellerProduct(req);
    if (!owned.item) return res.status(owned.status).json({ error: owned.error });
    const active = owned.item.active === false;
    const row = await db.updateShopItem(req.params.id, { active });
    res.json({ ok: true, product: publicProduct({ ...owned.item, active, ...(row || {}) }) });
}));

/** Ẩn sản phẩm thay vì xoá cứng để không mất lịch sử đơn hàng. */
router.post('/api/seller/product/:id/delete', requireAuth, requireSeller, ah(async (req, res) => {
    const owned = await ownedSellerProduct(req);
    if (!owned.item) return res.status(owned.status).json({ error: owned.error });
    await db.deleteShopItem(owned.item.id);
    res.json({ ok: true });
}));

/** Xoá gian hàng (chỉ chủ shop). Lịch sử đơn hàng vẫn giữ shop_name/item_name. */
router.post('/api/seller/shop/:id/delete', requireAuth, requireSeller, ah(async (req, res) => {
    const row = await db.getShop(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy shop.' });
    if (String(row.owner_id) !== String(req.webUser.id)) return res.status(403).json({ error: 'Bạn không phải chủ shop này.' });
    await db.deleteShop(row.id);
    res.json({ ok: true });
}));

router.get('/api/seller/shop/:id/products', requireAuth, requireSeller, ah(async (req, res) => {
    const row = await db.getShop(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy shop.' });
    if (String(row.owner_id) !== String(req.webUser.id)) return res.status(403).json({ error: 'Bạn không phải chủ shop này.' });
    const products = await safe(() => db.getShopItemsByShop(row.id, false), []);
    res.json({ products: products.map(publicProduct) });
}));

// ==================== MARKETPLACE ====================
async function loadMarketData() {
    const shops = await safe(() => db.listShops(), []);
    const byShop = await Promise.all(shops.map(s => safe(() => db.getShopItemsByShop(s.id, true), [])));
    const [reviews, orders, complaints] = await Promise.all([
        safe(() => db.listReviews(), []),
        safe(() => db.listOrders(), []),
        safe(() => db.listComplaints(), []),
    ]);
    return { shops, byShop, reviews, orders, complaints };
}

/** Seller có tối đa 3 shop: cả 3 dùng chung điểm TB của seller. */
function sellerRatingInfo(ownerId, shops, reviews) {
    const shopIds = new Set(shops.filter(s => String(s.owner_id) === String(ownerId)).map(s => String(s.id)));
    const sellerReviews = reviews.filter(r => shopIds.has(String(r.shop_id)));
    const counted = sellerReviews.filter(r => r.status !== 'hidden' && !r.appealed);
    return {
        rating: counted.length
            ? Number((counted.reduce((s, r) => s + (Number(r.stars) || 0), 0) / counted.length).toFixed(2))
            : 0,
        reviewCount: sellerReviews.filter(r => r.status !== 'hidden').length,
    };
}

function shopMetrics(shopRow, products, reviews, orders, complaints, sellerInfo) {
    const shopId = String(shopRow.id);
    const shopReviews = reviews.filter(r => String(r.shop_id) === shopId);
    const counted = shopReviews.filter(r => r.status !== 'hidden' && !r.appealed);
    const shopOrders = orders.filter(o => String(o.shop_id) === shopId);
    const sales = shopOrders.filter(o => o.status === 'completed')
        .reduce((s, o) => s + (Number(o.quantity) || 0), 0);
    const complaintsCount = complaints.filter(c => String(c.shop_id) === shopId && c.status !== 'rejected').length;
    const cheapest = products.slice().sort((a, b) => (Number(a.price_value === undefined ? a.price : a.price_value)) - (Number(b.price_value === undefined ? b.price : b.price_value)))[0];
    const ageDays = Math.max(0, (Date.now() - time(shopRow.created_at)) / 86400000);
    const rating = sellerInfo ? sellerInfo.rating : (counted.length
        ? Number((counted.reduce((s, r) => s + (Number(r.stars) || 0), 0) / counted.length).toFixed(2))
        : 0);
    const score = rating * 20 + Math.log10(1 + sales) * 15 + Math.min(ageDays, 365) * 0.05 - complaintsCount * 5;
    return {
        id: shopRow.id,
        name: shopRow.name,
        description: shopRow.description || '',
        logoUrl: shopRow.logo_url || '',
        backgroundUrl: shopRow.background_url || '',
        rating,
        reviewCount: sellerInfo ? sellerInfo.reviewCount : shopReviews.filter(r => r.status !== 'hidden').length,
        minPrice: cheapest ? Number(cheapest.price_value === undefined ? cheapest.price : cheapest.price_value) || 0 : 0,
        currency: cheapest && cheapest.currency === 'acoin' ? 'acoin' : 'coin',
        sales,
        createdAt: shopRow.created_at,
        _score: score,
    };
}

function sortShops(shops, filter) {
    const sorted = shops.slice();
    switch (filter) {
        case 'newest': return sorted.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        case 'oldest': return sorted.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        case 'cheapest': return sorted.sort((a, b) => a.minPrice - b.minPrice);
        case 'priciest': return sorted.sort((a, b) => b.minPrice - a.minPrice);
        case 'topRated': return sorted.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
        case 'bestSelling': return sorted.sort((a, b) => b.sales - a.sales);
        default: return sorted.sort((a, b) => b._score - a._score);
    }
}

async function searchShops({ q = '', filter = 'recommended', page = 1 } = {}) {
    const selected = FILTERS.includes(filter) ? filter : 'recommended';
    const currentPage = Math.max(1, toInt(page, 1));
    const tokens = String(q || '').toLowerCase().split(/\s+/).map(s => s.trim()).filter(Boolean);
    const { shops, byShop, reviews, orders, complaints } = await loadMarketData();

    let list = shops.map((s, i) => shopMetrics(
        s, byShop[i] || [], reviews, orders, complaints, sellerRatingInfo(s.owner_id, shops, reviews)));
    if (tokens.length) {
        list = list.filter((s, i) => {
            const haystack = [
                s.name, s.description,
                ...(byShop[i] || []).map(p => `${p.name || ''} ${p.description || ''}`),
            ].join(' ').toLowerCase();
            return tokens.some(t => haystack.includes(t));
        });
    }
    list = sortShops(list, selected);
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageShops = list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(s => {
        const { _score, ...rest } = s;
        return rest;
    });
    return { shops: pageShops, page: currentPage, totalPages, total };
}

router.get('/api/user-shop', ah(async (req, res) => {
    const result = await searchShops(req.query);
    res.json({ ...result, filter: FILTERS.includes(req.query.filter) ? req.query.filter : 'recommended' });
}));

router.get('/api/user-shop/:id', ah(async (req, res) => {
    const row = await db.getShop(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy shop.' });
    const [products, reviews, sellerRow, allShops] = await Promise.all([
        safe(() => db.getShopItemsByShop(row.id, true), []),
        safe(() => db.listReviews({ shop_id: String(row.id) }), []),
        safe(() => db.getSeller(row.owner_id), null),
        safe(() => db.listShops(), []),
    ]);
    const owner = await safe(() => db.getWebUserById(row.owner_id), null);
    const ratingInfo = sellerRatingInfo(row.owner_id, allShops, reviews);
    const seller = {
        id: row.owner_id,
        username: owner ? owner.username : await displayName(row.owner_id),
        sellerStatus: sellerRow ? sellerRow.status : 'none',
        rating: ratingInfo.rating,
        reviewCount: ratingInfo.reviewCount,
    };
    const reviewsOut = await Promise.all(reviews.map(async review =>
        publicReview({
            ...review,
            buyer_name: await displayName(review.buyer_id),
            buyer_is_admin: await isAdminUserKey(review.buyer_id),
        })));
    res.json({
        shop: shopSummary(row, products),
        products: products.map(publicProduct),
        reviews: reviewsOut,
        seller,
    });
}));

async function loadBuyContext(req, res) {
    const shopRow = await db.getShop(req.params.id);
    if (!shopRow) { res.status(404).json({ error: 'Không tìm thấy shop.' }); return null; }
    const seller = await safe(() => db.getSeller(shopRow.owner_id), null);
    if (!seller || seller.status !== 'active') {
        res.status(403).json({ error: 'Shop này hiện không bán hàng.' });
        return null;
    }
    return shopRow;
}

router.post('/api/user-shop/:id/buy', requireAuth, ah(async (req, res) => {
    const shopRow = await loadBuyContext(req, res);
    if (!shopRow) return;
    const product = await db.getShopItem(req.body.productId);
    if (!product || String(product.shop_id) !== String(shopRow.id) || product.active === false) {
        return res.status(404).json({ error: 'Sản phẩm không tồn tại trong shop này.' });
    }
    const quantity = toInt(req.body.quantity, 1);
    if (quantity < 1 || quantity > 50) return res.status(400).json({ error: 'Số lượng từ 1-50.' });
    const stock = effectiveStock(product);
    if (stock < quantity) return res.status(400).json({ error: `Kho chỉ còn ${stock} sản phẩm.` });
    const total = (Number(product.price_value === undefined ? product.price : product.price_value) || 0) * quantity;
    if (total <= 0) return res.status(400).json({ error: 'Giá sản phẩm không hợp lệ.' });
    const currency = product.currency === 'acoin' ? 'acoin' : 'coin';
    const key = balanceKey(req.webUser);
    const current = currency === 'acoin' ? await db.getAcoin(key) : await db.getCoins(key);
    if (current < total) {
        return res.status(400).json({ error: `Bạn không đủ ${currency === 'acoin' ? 'ACOIN' : 'coin'} (cần ${total}). Số dư: ${current}.` });
    }

    if (currency === 'acoin') await db.updateAcoin(key, -total);
    else await db.updateCoins(key, -total);

    let taken;
    try {
        taken = await shop.takeStock(product, quantity);
    } catch (e) {
        if (currency === 'acoin') await db.updateAcoin(key, total).catch(() => {});
        else await db.updateCoins(key, total).catch(() => {});
        return res.status(400).json({ error: e.message });
    }
    await db.updateShopItem(product.id, taken.stockFields);

    const order = await db.createOrder({
        id: randomId(),
        buyer_id: req.webUser.id,
        seller_id: shopRow.owner_id,
        shop_id: shopRow.id,
        shop_name: shopRow.name,
        product_id: product.id,
        item_name: product.name,
        quantity,
        total,
        currency,
        status: 'pending',
        viewed: false,
        payout_state: 'pending',
        seller_amount: Math.floor(total * (1 - FEE_RATE)),
        hold_until: new Date(Date.now() + HOLD_MS).toISOString(),
        accounts: taken.accounts.join('\n'),
    });
    await persistOrder({ ...order, accounts: taken.accounts, createdAt: order.created_at });
    hook('web:order:purchase', { id: order.id, shopId: shopRow.id, sellerId: shopRow.owner_id, total, currency });
    res.json({ ok: true, order: publicOrder(order, true) });
}));

async function loadOwnOrder(req, res, { seller = false } = {}) {
    const order = await db.getOrder(req.params.id);
    if (!order) { res.status(404).json({ error: 'Không tìm thấy đơn hàng.' }); return null; }
    if (seller) {
        const shopRow = await db.getShop(order.shop_id);
        if (!shopRow || String(shopRow.owner_id) !== String(req.webUser.id)) {
            res.status(403).json({ error: 'Bạn không phải seller của đơn này.' });
            return null;
        }
    } else if (String(order.buyer_id) !== String(req.webUser.id)) {
        res.status(403).json({ error: 'Bạn không phải người mua của đơn này.' });
        return null;
    }
    return order;
}

async function updateOrderAndHistory(order, patch) {
    const updated = { ...order, ...patch };
    await db.updateOrder(order.id, patch);
    await persistOrder({ ...updated, createdAt: updated.created_at || updated.createdAt });
    return updated;
}

async function releasePayout(order) {
    if (!order || order.payout_state !== 'pending' || Number(order.seller_amount) <= 0) return order;
    const user = await safe(() => db.getWebUserById(order.seller_id), null);
    const key = user ? balanceKey(user) : `web_${order.seller_id}`;
    if (order.currency === 'acoin') await db.updateAcoin(key, Number(order.seller_amount));
    else await db.updateCoins(key, Number(order.seller_amount));
    return await updateOrderAndHistory(order, { payout_state: 'released' });
}

router.post('/api/orders/:id/complete', requireAuth, ah(async (req, res) => {
    const order = await loadOwnOrder(req, res);
    if (!order) return;
    if (order.status !== 'pending') return res.status(400).json({ error: 'Đơn này đã được xử lý.' });
    let updated = await updateOrderAndHistory(order, { status: 'completed' });
    if (updated.payout_state === 'pending' && time(updated.hold_until) <= Date.now()) {
        updated = await releasePayout(updated);
    }
    hook('web:order:complete', { id: order.id, sellerId: order.seller_id });
    res.json({ ok: true, order: publicOrder(updated, true) });
}));

router.post('/api/orders/:id/view', requireAuth, ah(async (req, res) => {
    const order = await loadOwnOrder(req, res);
    if (!order) return;
    await updateOrderAndHistory(order, { viewed: true });
    res.json({ ok: true });
}));

router.post('/api/orders/:id/complain', requireAuth, ah(async (req, res) => {
    const order = await loadOwnOrder(req, res);
    if (!order) return;
    if (!['pending', 'completed'].includes(order.status)) return res.status(400).json({ error: 'Đơn này không khiếu nại được.' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Nhập lý do khiếu nại.' });
    const complaint = await db.createComplaint({
        id: randomId(), order_id: order.id, shop_id: order.shop_id, seller_id: order.seller_id,
        buyer_id: order.buyer_id, reason, status: 'pending',
    });
    await updateOrderAndHistory(order, { status: 'complained', payout_state: 'complained' });
    hook('web:order:complain', { id: complaint.id, orderId: order.id });
    res.json({ ok: true, complaint });
}));

router.post('/api/orders/:id/return', requireAuth, ah(async (req, res) => {
    const order = await loadOwnOrder(req, res);
    if (!order) return;
    if (order.status !== 'pending' || order.viewed) {
        return res.status(400).json({ error: 'Chỉ hoàn đơn còn chờ và chưa xem.' });
    }
    const refund = Math.floor(Number(order.total) * REFUND_RATE);
    const key = balanceKey(req.webUser);
    if (order.currency === 'acoin') await db.updateAcoin(key, refund);
    else await db.updateCoins(key, refund);

    const product = await safe(() => db.getShopItem(order.product_id), null);
    if (product) {
        const accounts = String(order.accounts || '').split('\n').filter(Boolean);
        try {
            const info = await shop.addStock(product, accounts.join('\n'));
            if (info) await db.updateShopItem(product.id, info);
        } catch (e) { /* hoàn kho best-effort */ }
    }
    await updateOrderAndHistory(order, { status: 'returned', payout_state: 'returned', seller_amount: 0 });
    hook('web:order:return', { id: order.id, refund });
    res.json({ ok: true, refund });
}));

router.post('/api/orders/:id/appeal', requireAuth, requireSeller, ah(async (req, res) => {
    const order = await loadOwnOrder(req, res, { seller: true });
    if (!order) return;
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Nhập lý do kháng nghị.' });
    const complaints = await safe(() => db.listComplaints({ order_id: String(order.id) }), []);
    const complaint = complaints.find(c => c.status === 'pending' || c.status === 'appealed');
    if (!complaint) return res.status(404).json({ error: 'Không tìm thấy khiếu nại để kháng nghị.' });
    await db.updateComplaint(complaint.id, { status: 'appealed', note: reason });
    res.json({ ok: true, complaint: { ...complaint, status: 'appealed' } });
}));

// ==================== ĐÁNH GIÁ ====================
router.post('/api/user-shop/:id/review', requireAuth, ah(async (req, res) => {
    const row = await db.getShop(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy shop.' });
    if (String(row.owner_id) === String(req.webUser.id)) return res.status(400).json({ error: 'Không thể đánh giá shop của chính mình.' });
    const content = String(req.body.content || '').trim();
    const stars = toInt(req.body.stars, 0);
    if (!content) return res.status(400).json({ error: 'Nhập nội dung đánh giá.' });
    if (stars < 1 || stars > 5) return res.status(400).json({ error: 'Số sao từ 1-5.' });
    const productId = String(req.body.productId || '');
    const order = await db.getOrder(req.body.orderId);
    if (!order || String(order.buyer_id) !== String(req.webUser.id) || order.status !== 'completed'
        || String(order.shop_id) !== String(row.id) || String(order.product_id) !== productId) {
        return res.status(400).json({ error: 'Bạn cần một đơn đã hoàn thành của sản phẩm này.' });
    }
    const existing = await safe(() => db.listReviews({ buyer_id: String(req.webUser.id) }), []);
    if (existing.some(r => String(r.shop_id) === String(row.id) || String(r.product_id) === productId)) {
        return res.status(409).json({ error: 'Bạn đã đánh giá sản phẩm/shop này rồi.' });
    }
    const review = await db.createReview({
        id: randomId(), shop_id: row.id, product_id: productId, order_id: order.id,
        buyer_id: req.webUser.id, stars, content, status: 'visible',
    });
    hook('web:review:created', { id: review.id, shopId: row.id, stars });
    res.json({ ok: true, review: publicReview({ ...review, buyer_is_admin: await isAdminUserKey(req.webUser.id) }) });
}));

async function loadShopForOwner(req, res) {
    const row = await db.getShop(req.params.id);
    if (!row) { res.status(404).json({ error: 'Không tìm thấy shop.' }); return null; }
    if (String(row.owner_id) !== String(req.webUser.id) && !(await isAdmin(req.webUser.discord_id))) {
        res.status(403).json({ error: 'Bạn không phải chủ shop này.' });
        return null;
    }
    return row;
}

router.post('/api/user-shop/:id/review/:reviewId/reply', requireAuth, ah(async (req, res) => {
    if (!(await loadShopForOwner(req, res))) return;
    const review = await db.getReview(req.params.reviewId);
    if (!review || String(review.shop_id) !== String(req.params.id)) return res.status(404).json({ error: 'Không tìm thấy đánh giá.' });
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Nhập nội dung phản hồi.' });
    const updated = await db.updateReview(review.id, { admin_reply: content });
    res.json({ ok: true, review: publicReview({ ...review, ...(updated || {}), buyer_is_admin: await isAdminUserKey(review.buyer_id) }) });
}));

router.post('/api/user-shop/:id/review/:reviewId/appeal', requireAuth, ah(async (req, res) => {
    const row = await db.getShop(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy shop.' });
    if (String(row.owner_id) !== String(req.webUser.id)) return res.status(403).json({ error: 'Bạn không phải chủ shop này.' });
    const review = await db.getReview(req.params.reviewId);
    if (!review || String(review.shop_id) !== String(row.id)) return res.status(404).json({ error: 'Không tìm thấy đánh giá.' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Nhập lý do kháng nghị.' });
    const updated = await db.updateReview(review.id, { status: 'appealed', appealed: true, appeal_reason: reason });
    hook('web:review:appealed', { id: review.id, shopId: row.id });
    res.json({ ok: true, review: publicReview({ ...review, ...(updated || {}), buyer_is_admin: await isAdminUserKey(review.buyer_id) }) });
}));

// ==================== ADMIN ====================
router.get('/api/admin/sellers', requireAdmin, ah(async (req, res) => {
    const sellers = await listSellers();
    const shops = await safe(() => db.listShops(), []);
    const out = [];
    for (const s of sellers) {
        const owner = await safe(() => db.getWebUserById(s.user_id), null);
        out.push({
            id: s.user_id, userId: s.user_id,
            username: owner ? owner.username : s.user_id,
            status: s.status || 'pending',
            note: s.note || '',
            shops: shops.filter(x => String(x.owner_id) === String(s.user_id)).length,
            createdAt: s.created_at,
        });
    }
    res.json({ sellers: out });
}));

router.post('/api/admin/sellers/:id/approve', requireAdmin, ah(async (req, res) => {
    await approveSeller(req.params.id, req.webUser.id);
    hook('web:admin:seller:approved', { id: req.params.id, by: req.webUser.id });
    res.json({ ok: true });
}));

router.post('/api/admin/reviews/:id/decision', requireAdmin, ah(async (req, res) => {
    try {
        await decideReview(req.params.id, req.body.approve, req.body.note);
    } catch (e) {
        return res.status(404).json({ error: e.message });
    }
    res.json({ ok: true });
}));

router.post('/api/admin/complaints/:id/decision', requireAdmin, ah(async (req, res) => {
    try {
        await decideComplaint(req.params.id, req.body.approve, req.body.note);
    } catch (e) {
        return res.status(404).json({ error: e.message });
    }
    res.json({ ok: true });
}));

// ==================== BẢO TRÌ ====================
/**
 * - Seller inactive >30 ngày -> suspended.
 * - Web account inactive >180 ngày -> xoá an toàn (local).
 * - Giải ngân đơn đã quá hạn giữ 3 ngày và không có khiếu nại.
 */
async function runMaintenance() {
    const now = Date.now();
    const result = { demoted: 0, deleted: 0 };

    const sellers = await safe(() => db.listSellers(), []);
    for (const seller of sellers) {
        if (seller.status !== 'active') continue;
        const lastRaw = await safe(() => db.getKv(`last_active:${seller.user_id}`), '');
        const user = await safe(() => db.getWebUserById(seller.user_id), null);
        const last = time(lastRaw) || time(seller.updated_at) || time(user && user.updated_at) || time(user && user.created_at);
        if (last && now - last > 30 * 86400000) {
            await db.updateSeller(seller.user_id, { status: 'suspended' });
            result.demoted++;
        }
    }

    const users = await safe(() => db.listWebUsers(2000), []);
    for (const user of users) {
        if (await isAdmin(user.discord_id)) continue;
        const lastRaw = await safe(() => db.getKv(`last_active:${user.id}`), '');
        const last = time(lastRaw) || time(user.updated_at) || time(user.created_at);
        if (last && now - last > 180 * 86400000) {
            await db.deleteWebUserCascade(user.id);
            result.deleted++;
        }
    }

    const pending = await safe(() => db.listOrders({ payout_state: 'pending' }), []);
    for (const order of pending) {
        if (order.status !== 'completed' || time(order.hold_until) > now) continue;
        await releasePayout(order);
    }
    return result;
}

module.exports = {
    // ==== Hợp đồng CONTRACT.md (bot/FE gọi trực tiếp) ====
    approveSeller,
    requestSeller,
    searchShops,
    getAcoin,
    adjustAcoin,
    getExchangeRate,
    setExchangeRate,
    getSeller,
    listSellers,
    decideReview,
    decideComplaint,
    getUnreadCount,
    runMaintenance,
    // ==== Helper cho web.js / internal ====
    router,
    ah,
    balanceKey,
    summaryForUser,
    publicProduct,
    publicShop: shopSummary,
    publicOrder,
    requireSeller,
};
