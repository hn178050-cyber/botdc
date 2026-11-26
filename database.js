/**
 * Lớp truy cập dữ liệu — CHỈ dùng file JSON cục bộ ./data/local-db.json.
 *
 * Các nguồn khác (Neon, VMOS DB, GitHub Gist) nằm ở dịch vụ/module riêng và
 * không bị chi phối bởi lớp này.
 */
const fs = require('fs');
const path = require('path');

const LOCAL_FILE = process.env.LOCAL_DB_FILE || path.join(__dirname, 'data', 'local-db.json');
/** Nhãn cập nhật theo từng user: web so sánh nhãn này để auto reload khi coin đổi. */
const COIN_VERSION_PREFIX = 'coin_version:';

const EMPTY_DB = {
    user_coins: [],
    sessions: [],
    gift_codes: [],
    daily_limits: [],
    admins: [],
    kv: [],
    web_users: [],
    web_sessions: [],
    link_stats: [],
    shop_items: [],
    purchases: [],
    transfers: [],
    payouts: [],
    plugins: [],
    // Marketplace / seller / ACOIN
    sellers: [],
    shops: [],
    orders: [],
    reviews: [],
    complaints: [],
    acoin_balances: [],
    device_accounts: [],
    gmail_tasks: [],
};

let local = null;

function localDb() {
    if (local) return local;
    try {
        if (fs.existsSync(LOCAL_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
            local = { ...EMPTY_DB, ...parsed };
        } else {
            local = JSON.parse(JSON.stringify(EMPTY_DB));
        }
    } catch (e) {
        console.error('[DB] Không đọc được local db, tạo mới:', e.message);
        local = JSON.parse(JSON.stringify(EMPTY_DB));
    }
    return local;
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
        const tmp = `${LOCAL_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(local, null, 2));
        fs.renameSync(tmp, LOCAL_FILE);
    } catch (e) {
        console.error('[DB] Không ghi được local db:', e.message);
    }
}

function table(name) {
    const db = localDb();
    if (!Array.isArray(db[name])) db[name] = [];
    return db[name];
}

function same(a, b) {
    if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
    return String(a) === String(b);
}

function findOne(name, filter) {
    return table(name).find(row => Object.entries(filter).every(([k, v]) => same(row[k], v))) || null;
}

function findMany(name, filter = {}) {
    return table(name).filter(row => Object.entries(filter).every(([k, v]) => same(row[k], v)));
}

function insert(name, row) {
    const record = { ...row };
    table(name).push(record);
    persist();
    return record;
}

function patchRows(name, filter, patch) {
    const rows = findMany(name, filter);
    for (const row of rows) Object.assign(row, patch);
    if (rows.length) persist();
    return rows;
}

function removeRows(name, filter) {
    const db = localDb();
    const before = db[name].length;
    db[name] = db[name].filter(row => !Object.entries(filter).every(([k, v]) => same(row[k], v)));
    if (db[name].length !== before) persist();
    return before - db[name].length;
}

// ---- Helper dùng chung cho các bảng mới (seller / marketplace) ----
function sortRows(rows, order) {
    if (!order) return rows;
    const [field, dir] = String(order).split('.');
    return [...rows].sort((a, b) => {
        const av = a[field] == null ? '' : a[field];
        const bv = b[field] == null ? '' : b[field];
        const cmp = String(av).localeCompare(String(bv));
        return dir === 'desc' ? -cmp : cmp;
    });
}

async function listRows(name, filter = {}, order = null, limit = 1000) {
    const n = Math.min(5000, Math.max(1, parseInt(limit, 10) || 1000));
    let rows = findMany(name, filter);
    if (order) rows = sortRows(rows, order);
    return rows.slice(0, n);
}

async function getRow(name, filter) {
    const rows = await listRows(name, filter, null, 1);
    return rows[0] || null;
}

async function insertRow(name, row) {
    return insert(name, row);
}

async function patchRowsGeneric(name, filter, patch) {
    return patchRows(name, filter, patch);
}

async function removeRowsGeneric(name, filter) {
    return removeRows(name, filter);
}

async function upsertRow(name, filter, row) {
    const existing = await getRow(name, filter);
    if (existing) {
        const updated = await patchRowsGeneric(name, filter, row);
        return (updated && updated[0]) || { ...existing, ...row };
    }
    return await insertRow(name, row);
}

module.exports = {
    mode: 'local',

    // ==================== XU ====================
    async getCoins(userId) {
        const row = findOne('user_coins', { user_id: String(userId) });
        return row ? Number(row.balance) || 0 : 0;
    },

    async updateCoins(userId, amount) {
        const delta = Number(amount) || 0;
        let row = findOne('user_coins', { user_id: String(userId) });
        if (!row) {
            row = { user_id: String(userId), balance: 0 };
            table('user_coins').push(row);
        }
        row.balance = (Number(row.balance) || 0) + delta;
        if (row.balance < 0) row.balance = 0;
        persist();
        await module.exports.bumpCoinVersion(userId);
        return row.balance;
    },

    async getTopCoins(limit = 10) {
        const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
        return findMany('user_coins')
            .filter(r => Number(r.balance) > 0)
            .sort((a, b) => Number(b.balance) - Number(a.balance))
            .slice(0, n)
            .map(r => ({ user_id: r.user_id, balance: Number(r.balance) }));
    },

    // ==================== SESSION VƯỢT LINK ====================
    /** Đọc session mà không xóa — dùng cho bước xác minh trình duyệt trước khi nhận xu. */
    async getSession(sid) {
        return findOne('sessions', { id: String(sid) }) || null;
    },

    async getAndDeleteSession(sid) {
        const row = findOne('sessions', { id: String(sid) });
        if (!row) return null;
        removeRows('sessions', { id: String(sid) });
        return row;
    },

    async createSession(sid, userId, provider) {
        return insert('sessions', { id: String(sid), user_id: String(userId), provider, created_at: new Date().toISOString() });
    },

    // ==================== GIFT CODE ====================
    async redeemGiftCode(code) {
        const row = findOne('gift_codes', { code: String(code), is_used: false });
        if (!row) return null;
        row.is_used = true;
        persist();
        return Number(row.amount);
    },

    async createGiftCode(code, amount) {
        return insert('gift_codes', { code, amount: Number(amount), is_used: false, created_at: new Date().toISOString() });
    },

    // ==================== GIỚI HẠN NGÀY ====================
    async checkDailyLimit(userId, provider, dateStr) {
        const row = findOne('daily_limits', { user_id: String(userId), provider, date_str: dateStr });
        return row ? Number(row.count) || 0 : 0;
    },

    async increaseDailyLimit(userId, provider, dateStr) {
        let row = findOne('daily_limits', { user_id: String(userId), provider, date_str: dateStr });
        if (!row) {
            row = { user_id: String(userId), provider, date_str: dateStr, count: 0 };
            table('daily_limits').push(row);
        }
        row.count = (Number(row.count) || 0) + 1;
        persist();
        return row.count;
    },

    // ==================== ADMIN DISCORD ====================
    async isAdmin(userId) {
        return !!findOne('admins', { user_id: String(userId) });
    },
    async addAdmin(userId, addedBy) {
        if (findOne('admins', { user_id: String(userId) })) return;
        return insert('admins', { user_id: String(userId), added_by: String(addedBy || ''), created_at: new Date().toISOString() });
    },
    async removeAdmin(userId) {
        return removeRows('admins', { user_id: String(userId) });
    },
    async listAdmins() {
        return findMany('admins');
    },

    // ==================== KV ====================
    async getKv(key) {
        const row = findOne('kv', { key: String(key) });
        return row ? row.value : null;
    },
    async setKv(key, value) {
        let row = findOne('kv', { key: String(key) });
        if (!row) {
            row = { key: String(key), value: String(value) };
            table('kv').push(row);
        } else {
            row.value = String(value);
        }
        persist();
        return;
    },
    /** Tăng nhãn coin của 1 user; web âm thầm so sánh nhãn và reload khi khác nhau. */
    async bumpCoinVersion(userId) {
        try {
            const key = COIN_VERSION_PREFIX + String(userId);
            const current = Number(await module.exports.getKv(key)) || 0;
            await module.exports.setKv(key, String(current + 1));
        } catch (e) { /* không làm hỏng giao dịch coin */ }
    },
    async getCoinVersion(userId) {
        try { return String(await module.exports.getKv(COIN_VERSION_PREFIX + String(userId)) || '0'); }
        catch (e) { return '0'; }
    },
    /** Liệt kê KV theo prefix (dùng để tìm Discord theo tên, kể cả tên lạ). */
    async listKv(prefix = '') {
        const p = String(prefix || '');
        return table('kv')
            .filter(row => !p || String(row.key).startsWith(p))
            .map(row => ({ key: String(row.key), value: row.value }));
    },

    // ==================== WEB USER ====================
    async createWebUser(user) {
        const record = {
            id: user.id,
            username: user.username,
            username_lower: user.username.toLowerCase(),
            password_hash: user.password_hash,
            link_token: user.link_token,
            discord_id: user.discord_id || null,
            created_at: user.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return insert('web_users', record);
    },

    async getWebUserById(id) {
        return findOne('web_users', { id: String(id) });
    },

    async getWebUserByUsername(username) {
        return findOne('web_users', { username_lower: String(username).toLowerCase() });
    },

    async getWebUserByLinkToken(token) {
        return findOne('web_users', { link_token: String(token) });
    },

    async getWebUserByDiscordId(discordId) {
        return findOne('web_users', { discord_id: String(discordId) });
    },

    async updateWebUser(id, patch) {
        const data = { ...patch, updated_at: new Date().toISOString() };
        const rows = patchRows('web_users', { id: String(id) }, data);
        return rows[0] || null;
    },

    async listWebUsers(limit = 500) {
        const n = Math.min(2000, Math.max(1, parseInt(limit, 10) || 500));
        return [...table('web_users')]
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, n);
    },

    async getWebUsersByIds(ids) {
        const list = [...new Set((ids || []).filter(Boolean).map(String))];
        if (!list.length) return [];
        return findMany('web_users').filter(u => list.includes(String(u.id)));
    },

    async getWebUsersByDiscordIds(ids) {
        const list = [...new Set((ids || []).filter(Boolean).map(String))];
        if (!list.length) return [];
        return findMany('web_users').filter(u => list.includes(String(u.discord_id)));
    },

    // ==================== WEB SESSION ====================
    async createWebSession(id, userId, expiresAt) {
        const record = { id, user_id: String(userId), expires_at: expiresAt, created_at: new Date().toISOString() };
        return insert('web_sessions', record);
    },

    async getWebSession(id) {
        const row = findOne('web_sessions', { id: String(id) });
        if (!row) return null;
        if (new Date(row.expires_at).getTime() < Date.now()) {
            removeRows('web_sessions', { id: String(id) });
            return null;
        }
        return row;
    },

    async deleteWebSession(id) {
        return removeRows('web_sessions', { id: String(id) });
    },

    async deleteWebSessionsForUser(userId, exceptId = null) {
        const db = localDb();
        const before = db.web_sessions.length;
        db.web_sessions = db.web_sessions.filter(s => String(s.user_id) !== String(userId) || (exceptId && s.id === exceptId));
        if (db.web_sessions.length !== before) persist();
        return;
    },

    // ==================== LINK STATS (BXH vượt link) ====================
    async incrementLinkCount(userId, period) {
        let row = findOne('link_stats', { user_id: String(userId), period: String(period) });
        if (!row) {
            row = { user_id: String(userId), period: String(period), count: 0, updated_at: new Date().toISOString() };
            table('link_stats').push(row);
        }
        row.count = (Number(row.count) || 0) + 1;
        row.updated_at = new Date().toISOString();
        persist();
        return row.count;
    },

    async getLinkCount(userId, period) {
        const row = findOne('link_stats', { user_id: String(userId), period: String(period) });
        return row ? Number(row.count) || 0 : 0;
    },

    /** BXH tuần: mặc định chỉ lấy user có >=5 link. Truyền minCount=0 để lấy mọi người. */
    async getLinkLeaderboard(period, limit = 10, minCount = 5) {
        const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
        const min = Math.max(0, parseInt(minCount, 10) || 0);
        return findMany('link_stats', { period: String(period) })
            .filter(r => Number(r.count) >= Math.max(1, min))
            .sort((a, b) => Number(b.count) - Number(a.count))
            .slice(0, n)
            .map(r => ({ user_id: r.user_id, period: r.period, count: Number(r.count) }));
    },

    /** Gộp số link của key cũ (web_<id>) sang key mới (discord id) trong 1 kỳ. */
    async mergeLinkStats(fromKey, toKey, period) {
        if (String(fromKey) === String(toKey)) return;
        const from = findOne('link_stats', { user_id: String(fromKey), period: String(period) });
        if (!from || Number(from.count) <= 0) return;
        let to = findOne('link_stats', { user_id: String(toKey), period: String(period) });
        if (!to) {
            to = { user_id: String(toKey), period: String(period), count: 0, updated_at: new Date().toISOString() };
            table('link_stats').push(to);
        }
        to.count = (Number(to.count) || 0) + Number(from.count);
        to.updated_at = new Date().toISOString();
        from.count = 0;
        persist();
        return;
    },
    // ==================== SHOP ITEMS ====================
    async createShopItem(item) {
        const record = {
            id: item.id,
            name: item.name,
            description: item.description || '',
            price: Number(item.price) || 0,
            logo_url: item.logo_url || '',
            category: item.category || 'shop',
            gist_id: item.gist_id || null,
            gist_filename: item.gist_filename || null,
            stock: Number(item.stock) || 0,
            stock_content: item.stock_content || null,
            active: item.active !== false,
            // Marketplace: sản phẩm thuộc shop của seller (null = item/admin cũ)
            shop_id: item.shop_id || null,
            currency: item.currency === 'acoin' ? 'acoin' : 'coin',
            price_value: item.price_value === undefined ? Number(item.price) || 0 : Number(item.price_value) || 0,
            max_lines: Math.min(2000, Math.max(1, parseInt(item.max_lines, 10) || 2000)),
            line_count: Number(item.line_count) || 0,
            created_by: item.created_by || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return insert('shop_items', record);
    },

    async getShopItems(activeOnly = true) {
        return [...table('shop_items')]
            .filter(i => !activeOnly || i.active !== false)
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },

    async getShopItem(id) {
        return findOne('shop_items', { id: String(id) });
    },

    /** Sản phẩm của 1 user-shop (không lẫn item/admin). */
    async getShopItemsByShop(shopId, activeOnly = true) {
        return findMany('shop_items', { shop_id: String(shopId) })
            .filter(i => !activeOnly || i.active !== false)
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },

    async updateShopItem(id, patch) {
        const data = { ...patch, updated_at: new Date().toISOString() };
        const rows = patchRows('shop_items', { id: String(id) }, data);
        return rows[0] || null;
    },

    async deleteShopItem(id) {
        return removeRows('shop_items', { id: String(id) });
    },

    // ==================== PURCHASES ====================
    async createPurchase(purchase) {
        const record = {
            id: purchase.id,
            web_user_id: String(purchase.web_user_id),
            item_id: String(purchase.item_id),
            item_name: purchase.item_name,
            quantity: Number(purchase.quantity) || 1,
            unit_price: Number(purchase.unit_price) || 0,
            total_price: Number(purchase.total_price) || 0,
            accounts: purchase.accounts || '',
            created_at: new Date().toISOString(),
        };
        return insert('purchases', record);
    },

    async getPurchasesByUser(webUserId, limit = 100) {
        const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
        return findMany('purchases', { web_user_id: String(webUserId) })
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, n);
    },

    async getAllPurchases(limit = 200) {
        const n = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
        return [...table('purchases')]
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, n);
    },

    // ==================== TRANSFERS ====================
    async createTransfer(transfer) {
        const record = {
            id: transfer.id,
            from_user_id: String(transfer.from_user_id),
            from_label: transfer.from_label || '',
            to_label: transfer.to_label || '',
            to_balance_key: String(transfer.to_balance_key || ''),
            amount: Number(transfer.amount) || 0,
            fee: Number(transfer.fee) || 0,
            created_at: new Date().toISOString(),
        };
        return insert('transfers', record);
    },

    async getTransfersByUser(webUserId, limit = 50) {
        const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
        return findMany('transfers', { from_user_id: String(webUserId) })
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, n);
    },

    // ==================== PAYOUTS ====================
    async createPayout(payout) {
        const record = {
            id: payout.id,
            period: String(payout.period),
            total: Number(payout.total) || 0,
            details: typeof payout.details === 'string' ? payout.details : JSON.stringify(payout.details || []),
            created_at: new Date().toISOString(),
        };
        return insert('payouts', record);
    },

    async getPayouts(limit = 50) {
        const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
        return [...table('payouts')]
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, n);
    },

    // ==================== BXH VƯỢT LINK TỔNG (mọi kỳ) ====================
    /** Tổng số link đã vượt của 1 user qua mọi kỳ (dùng để mở quà VMOS free). */
    async getAllTimeLinkCount(userId) {
        const key = String(userId);
        const rows = findMany('link_stats', { user_id: key });
        return (rows || []).reduce((sum, row) => sum + (Number(row.count) || 0), 0);
    },

    async getAllTimeLinkLeaderboard(limit = 10) {
        const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
        const rows = findMany('link_stats');
        const totals = new Map();
        for (const row of rows || []) {
            const key = String(row.user_id);
            totals.set(key, (totals.get(key) || 0) + (Number(row.count) || 0));
        }
        return [...totals.entries()]
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([user_id, count]) => ({ user_id, count }));
    },

    // ==================== PLUGIN MODULE ====================
    async createPlugin(plugin) {
        const record = {
            id: plugin.id,
            name: plugin.name,
            source_url: plugin.source_url || '',
            gist_id: plugin.gist_id || null,
            gist_filename: plugin.gist_filename || null,
            enabled: plugin.enabled !== false,
            last_loaded_at: plugin.last_loaded_at || null,
            error: plugin.error || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return insert('plugins', record);
    },

    async getPlugin(id) {
        return findOne('plugins', { id: String(id) });
    },

    async getPlugins(limit = 100) {
        const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
        return [...table('plugins')]
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, n);
    },

    async updatePlugin(id, patch) {
        const data = { ...patch, updated_at: new Date().toISOString() };
        const rows = patchRows('plugins', { id: String(id) }, data);
        return rows[0] || null;
    },

    async deletePlugin(id) {
        return removeRows('plugins', { id: String(id) });
    },

    // ==================== SELLER / MARKETPLACE ====================
    async getSeller(userId) {
        return await getRow('sellers', { user_id: String(userId) });
    },
    async upsertSeller(seller) {
        const row = {
            user_id: String(seller.user_id),
            status: seller.status || 'pending',
            note: seller.note || '',
            created_at: seller.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return await upsertRow('sellers', { user_id: row.user_id }, row);
    },
    async updateSeller(userId, patch) {
        const rows = await patchRowsGeneric('sellers', { user_id: String(userId) }, { ...patch, updated_at: new Date().toISOString() });
        return rows && rows[0];
    },
    async listSellers() {
        return await listRows('sellers', {}, 'created_at.desc', 2000);
    },
    async deleteSeller(userId) {
        return await removeRowsGeneric('sellers', { user_id: String(userId) });
    },

    async createShop(record) {
        const row = {
            id: record.id,
            owner_id: String(record.owner_id),
            name: record.name,
            description: record.description || '',
            logo_url: record.logo_url || '',
            background_url: record.background_url || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return await insertRow('shops', row);
    },
    async getShop(id) {
        return await getRow('shops', { id: String(id) });
    },
    async getShopsByOwner(userId) {
        return await listRows('shops', { owner_id: String(userId) }, 'created_at.desc', 200);
    },
    async listShops() {
        return await listRows('shops', {}, 'created_at.desc', 2000);
    },
    async updateShop(id, patch) {
        const rows = await patchRowsGeneric('shops', { id: String(id) }, { ...patch, updated_at: new Date().toISOString() });
        return rows && rows[0];
    },
    async deleteShop(id) {
        return await removeRowsGeneric('shops', { id: String(id) });
    },

    async createOrder(record) {
        const row = {
            id: record.id,
            buyer_id: String(record.buyer_id),
            seller_id: String(record.seller_id),
            shop_id: String(record.shop_id),
            shop_name: record.shop_name || '',
            product_id: String(record.product_id),
            item_name: record.item_name || '',
            quantity: Number(record.quantity) || 1,
            total: Number(record.total) || 0,
            currency: record.currency === 'acoin' ? 'acoin' : 'coin',
            status: record.status || 'pending',
            viewed: !!record.viewed,
            payout_state: record.payout_state || 'pending',
            seller_amount: Number(record.seller_amount) || 0,
            hold_until: record.hold_until || null,
            accounts: record.accounts || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return await insertRow('orders', row);
    },
    async getOrder(id) {
        return await getRow('orders', { id: String(id) });
    },
    async listOrders(filter = {}, limit = 2000) {
        return await listRows('orders', filter, 'created_at.desc', limit);
    },
    async updateOrder(id, patch) {
        const rows = await patchRowsGeneric('orders', { id: String(id) }, { ...patch, updated_at: new Date().toISOString() });
        return rows && rows[0];
    },

    async createReview(record) {
        const row = {
            id: record.id,
            shop_id: String(record.shop_id),
            product_id: String(record.product_id),
            order_id: String(record.order_id),
            buyer_id: String(record.buyer_id),
            stars: Number(record.stars) || 0,
            content: String(record.content || ''),
            status: record.status || 'visible',
            admin_reply: record.admin_reply || null,
            appealed: !!record.appealed,
            appeal_reason: record.appeal_reason || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return await insertRow('reviews', row);
    },
    async getReview(id) {
        return await getRow('reviews', { id: String(id) });
    },
    async listReviews(filter = {}) {
        return await listRows('reviews', filter, 'created_at.desc', 2000);
    },
    async updateReview(id, patch) {
        const rows = await patchRowsGeneric('reviews', { id: String(id) }, { ...patch, updated_at: new Date().toISOString() });
        return rows && rows[0];
    },

    async createComplaint(record) {
        const row = {
            id: record.id,
            order_id: String(record.order_id),
            shop_id: String(record.shop_id),
            seller_id: String(record.seller_id),
            buyer_id: String(record.buyer_id),
            reason: String(record.reason || ''),
            status: record.status || 'pending',
            note: record.note || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        return await insertRow('complaints', row);
    },
    async getComplaint(id) {
        return await getRow('complaints', { id: String(id) });
    },
    async listComplaints(filter = {}) {
        return await listRows('complaints', filter, 'created_at.desc', 2000);
    },
    async updateComplaint(id, patch) {
        const rows = await patchRowsGeneric('complaints', { id: String(id) }, { ...patch, updated_at: new Date().toISOString() });
        return rows && rows[0];
    },

    // ==================== ACOIN ====================
    async getAcoin(userId) {
        const row = findOne('acoin_balances', { user_id: String(userId) });
        return row ? Number(row.balance) || 0 : 0;
    },
    async updateAcoin(userId, amount) {
        const delta = Number(amount) || 0;
        let row = findOne('acoin_balances', { user_id: String(userId) });
        if (!row) {
            row = { user_id: String(userId), balance: 0, updated_at: new Date().toISOString() };
            table('acoin_balances').push(row);
        }
        row.balance = Math.max(0, (Number(row.balance) || 0) + delta);
        row.updated_at = new Date().toISOString();
        persist();
        return row.balance;
    },

    /** BXH ACOIN: lấy từ acoin_balances, chỉ user có số dư > 0. */
    async getTopAcoin(limit = 10) {
        const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
        return findMany('acoin_balances')
            .filter(r => Number(r.balance) > 0)
            .sort((a, b) => Number(b.balance) - Number(a.balance))
            .slice(0, n)
            .map(r => ({ user_id: r.user_id, balance: Number(r.balance) }));
    },

    // ==================== GMAIL TASKS (duyệt thủ công) ====================
    async addGmailTask(task) {
        return await insertRow('gmail_tasks', task);
    },

    async getGmailTask(id) {
        return await getRow('gmail_tasks', { id: String(id) });
    },

    async updateGmailTask(id, patch) {
        const rows = await patchRowsGeneric('gmail_tasks', { id: String(id) }, patch);
        return (rows && rows[0]) || null;
    },

    async listGmailTasks(limit = 500) {
        return await listRows('gmail_tasks', {}, 'created_at.desc', limit);
    },

    // ==================== DEVICE -> ACCOUNT ====================
    async getDeviceAccount(deviceId) {
        return await getRow('device_accounts', { device_id: String(deviceId) });
    },
    async bindDeviceAccount(deviceId, userId) {
        const row = { device_id: String(deviceId), user_id: String(userId), created_at: new Date().toISOString() };
        return await upsertRow('device_accounts', { device_id: row.device_id }, row);
    },
    async deleteDeviceAccountsForUser(userId) {
        return await removeRowsGeneric('device_accounts', { user_id: String(userId) });
    },

    /** Xoá tài khoản web inactive: local. */
    async deleteWebUserCascade(userId) {
        const id = String(userId);
        const keys = [`last_active:${id}`, `lang:${id}`];
        removeRows('web_sessions', { user_id: id });
        removeRows('user_coins', { user_id: id });
        removeRows('user_coins', { user_id: `web_${id}` });
        removeRows('acoin_balances', { user_id: id });
        removeRows('acoin_balances', { user_id: `web_${id}` });
        removeRows('device_accounts', { user_id: id });
        removeRows('sellers', { user_id: id });
        const shopIds = findMany('shops', { owner_id: id }).map(s => String(s.id));
        removeRows('shops', { owner_id: id });
        for (const sid of shopIds) removeRows('shop_items', { shop_id: sid });
        removeRows('shop_items', { created_by: id });
        for (const key of keys) removeRows('kv', { key });
        removeRows('web_users', { id });
        return;
    },
};
