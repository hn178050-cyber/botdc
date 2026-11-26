/**
 * Plugin engine — plugin viết bằng JavaScript (CommonJS), chạy trong Node vm sandbox.
 *
 * Admin dán link raw script trong Admin → Plugin. Script được tải về, lưu thành
 * 1 secret Gist, gist_id lưu ở DB. Khi restart/reload, engine đọc lại từ Gist.
 *
 * Ngôn ngữ plugin: JavaScript / CommonJS — không cần build, không dependency.
 *
 * Script mẫu:
 *   api.get('/hello', (req, res) => res.json({ ok: true }));
 *   api.command('ping', async ({ interaction }) => interaction.editReply('pong'));
 *
 * Web:     /plugin/<plugin-id>/<path>
 * Discord: /plugin <ten>:<lenh>
 *
 * LƯU Ý: vm sandbox dùng để hạn chế, KHÔNG phải hàng rào bảo mật tuyệt đối.
 * Chỉ cài plugin từ nguồn tin cậy.
 */
const vm = require('vm');
const express = require('express');
const crypto = require('crypto');
const db = require('./database');
const github = require('./github');
const services = require('./services');
const weekly = require('./weekly');
const shop = require('./shop');
const linkProviders = require('./link-providers');
const utils = require('./utils');

/** Tổng link trong ngày, cộng mọi provider — plugin daily dùng chung rule quà free. */
async function todayFreeLinkCount(key, today) {
    const ids = Object.keys(linkProviders.PROVIDERS);
    const counts = await Promise.all(ids.map(id => db.checkDailyLimit(key, id, today)));
    return counts.reduce((sum, count) => sum + (Number(count) || 0), 0);
}

/** VMOS/VSPhone free: 1 trong 2 mỗi ngày, đều cần vượt lại link trong ngày. */
async function claimFreeDeviceForPlugin(key, type) {
    const today = utils.getTodayString();
    const isVsphone = type === 'vsphone';
    const [vmosClaimed, vsphoneClaimed, links] = await Promise.all([
        db.checkDailyLimit(key, 'vmos_free', today),
        db.checkDailyLimit(key, 'vsphone_free', today),
        todayFreeLinkCount(key, today),
    ]);
    if (vmosClaimed > 0 || vsphoneClaimed > 0) throw new Error('Hôm nay đã lấy quà free rồi (VMOS hoặc VSPhone).');
    if (links < 1) throw new Error('Cần vượt ít nhất 1 link hôm nay.');
    const acc = isVsphone ? await services.regVsphoneAccount() : await services.regVmosAccount();
    await db.increaseDailyLimit(key, isVsphone ? 'vsphone_free' : 'vmos_free', today);
    return { ...acc, date: today, linkCount: links };
}

const CORE_VERSION = '1.0.0';
const CALL_TIMEOUT_MS = 10000;

const loaded = new Map();      // pluginId -> runtime entry
const eventBus = new Map();    // event -> Set<{ pluginId, handler }>
const exposedApi = new Map();  // pluginId -> Map<method, handler>
const unloadHooks = new Map(); // pluginId -> fn[]
const pluginTimers = new Map(); // pluginId -> Set<timerId>
let context = { client: null, app: null, web: {} }; // do server.js inject vào

function safeRequire(name) {
    const allowed = ['crypto', 'path', 'url', 'util', 'querystring'];
    if (!allowed.includes(String(name))) {
        throw new Error(`Module "${name}" không được phép trong plugin.`);
    }
    return require(name);
}

async function fetchScript(url) {
    const value = String(url || '').trim();
    let parsed;
    try { parsed = new URL(value); } catch (e) { throw new Error('Link script không hợp lệ.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Chỉ hỗ trợ link http/https.');

    const res = await fetch(value, {
        headers: { 'User-Agent': 'nigaria-plugin-loader' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Không tải được script (HTTP ${res.status}).`);
    const text = await res.text();
    if (text.length > 200 * 1024) throw new Error('Script quá lớn (tối đa 200KB).');
    if (!text.trim()) throw new Error('Script rỗng.');
    return text;
}

/** Inject Bot client / Express app / web helpers để plugin gọi API nội bộ. */
function attachContext(next = {}) {
    context = { ...context, ...next };
}

function publicEnv(name) {
    const map = {
        PORT: process.env.PORT || '3000',
        RENDER_DOMAIN: process.env.RENDER_DOMAIN || '',
        ADMIN_DISCORD_ID: process.env.ADMIN_DISCORD_ID || '',
        NODE_ENV: process.env.NODE_ENV || '',
        DISABLE_BOT: process.env.DISABLE_BOT || '',
        DB_MODE: db.mode,
        DISCORD_READY: !!process.env.DISCORD_TOKEN,
        GITHUB_READY: !!process.env.GITHUB_TOKEN,
        HANAMI_READY: !!process.env.HANAMI_TOKEN,
        LINK4M_READY: !!process.env.LINK4M_API_KEY,
        LAYMA_READY: !!process.env.LAYMA_TOKEN,
        BBMKTS_READY: !!(process.env.BBMKTS_API_TOKEN || process.env.VUOTNHANH_API_TOKEN),
    };
    const key = String(name || '');
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

// ==================== EVENT BUS ====================
function on(event, handler, pluginId = 'core') {
    const key = String(event || '');
    if (!key || typeof handler !== 'function') return () => {};
    if (!eventBus.has(key)) eventBus.set(key, new Set());
    const sub = { pluginId: String(pluginId), handler };
    eventBus.get(key).add(sub);
    return () => {
        const set = eventBus.get(key);
        if (set) set.delete(sub);
    };
}

function off(event, handler, pluginId = 'core') {
    const set = eventBus.get(String(event || ''));
    if (!set) return;
    for (const sub of [...set]) {
        if (String(pluginId) !== String(sub.pluginId)) continue;
        if (handler && sub.handler !== handler) continue;
        set.delete(sub);
    }
}

async function emit(event, payload = {}) {
    const set = eventBus.get(String(event || ''));
    if (!set || !set.size) return [];
    const settled = await Promise.allSettled([...set].map(async sub => {
        try {
            return await sub.handler(payload, { event: String(event), pluginId: sub.pluginId });
        } catch (e) {
            console.error(`[plugin:${sub.pluginId}] event ${event}:`, e.message);
            return { error: e.message };
        }
    }));
    return settled.map(r => r.status === 'fulfilled' ? r.value : { error: String(r.reason && r.reason.message || r.reason) });
}

function listEvents() {
    return [...eventBus.entries()].map(([event, set]) => ({ event, subscribers: set.size }));
}

// ==================== PLUGIN-TO-PLUGIN ====================
function findEntry(ref) {
    const key = String(ref || '').trim().toLowerCase();
    if (!key) return null;
    for (const entry of loaded.values()) {
        if (entry.id.toLowerCase() === key || String(entry.name).toLowerCase() === key) return entry;
    }
    return null;
}

async function callPlugin(ref, method, payload = {}, opts = {}) {
    const entry = findEntry(ref);
    if (!entry) throw new Error(`Plugin "${ref}" chưa được load.`);
    const table = exposedApi.get(entry.id);
    const fn = table && table.get(String(method));
    if (typeof fn !== 'function') throw new Error(`Plugin "${entry.name}" không expose API "${method}".`);

    const work = Promise.resolve().then(() => fn(payload, { from: opts.from || 'core', method: String(method) }));
    let timer;
    try {
        return await Promise.race([
            work,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Gọi plugin ${entry.name}.${method} quá ${CALL_TIMEOUT_MS}ms.`)), CALL_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// ==================== TIMERS / CLEANUP ====================
function trackTimer(pluginId, id) {
    if (!pluginTimers.has(pluginId)) pluginTimers.set(pluginId, new Set());
    pluginTimers.get(pluginId).add(id);
    return id;
}

function trackedSetTimeout(pluginId, fn, ms, ...args) {
    const id = setTimeout(() => {
        const set = pluginTimers.get(pluginId);
        if (set) set.delete(id);
        fn(...args);
    }, ms);
    return trackTimer(pluginId, id);
}

function trackedSetInterval(pluginId, fn, ms, ...args) {
    const id = setInterval(fn, ms, ...args);
    return trackTimer(pluginId, id);
}

function trackedClear(pluginId, id) {
    clearTimeout(id);
    clearInterval(id);
    const set = pluginTimers.get(pluginId);
    if (set) set.delete(id);
}

function unload(id) {
    const pluginId = String(id);
    for (const fn of unloadHooks.get(pluginId) || []) {
        try { fn(); } catch (e) { console.error(`[plugin:${pluginId}] onUnload:`, e.message); }
    }
    for (const timer of pluginTimers.get(pluginId) || []) {
        clearTimeout(timer);
        clearInterval(timer);
    }
    unloadHooks.delete(pluginId);
    pluginTimers.delete(pluginId);
    exposedApi.delete(pluginId);

    for (const set of eventBus.values()) {
        for (const sub of [...set]) if (sub.pluginId === pluginId) set.delete(sub);
    }
    loaded.delete(pluginId);
}

// ==================== LOAD ====================
async function loadPlugin(row) {
    const pluginId = String(row.id);
    let code;
    try {
        code = row.gist_id
            ? await github.readGistFile(row.gist_id, row.gist_filename)
            : await fetchScript(row.source_url);
    } catch (e) {
        await db.updatePlugin(pluginId, { error: e.message }).catch(() => {});
        unload(pluginId);
        throw e;
    }

    unload(pluginId); // dọn listener/timer/API của bản cũ trước khi nạp bản mới
    const router = express.Router();
    const commands = new Map();
    const eventNames = new Set();
    const apiNames = new Set();

    const kv = async (key, value) => {
        const full = `plugin:${pluginId}:${key}`;
        if (value === undefined) return db.getKv(full);
        await db.setKv(full, value);
        return value;
    };
    kv.global = async (key, value) => {
        if (value === undefined) return db.getKv(String(key));
        await db.setKv(String(key), value);
        return value;
    };
    kv.remove = async (key) => {
        await db.setKv(`plugin:${pluginId}:${key}`, '');
        return true;
    };

    const log = (...args) => console.log(`[plugin:${row.name}]`, ...args);
    log.warn = (...args) => console.warn(`[plugin:${row.name}]`, ...args);
    log.error = (...args) => console.error(`[plugin:${row.name}]`, ...args);

    // Nhận 1 hoặc nhiều handler: api.get('/x', auth, handler)
    const route = (method, path, ...handlers) => {
        const list = handlers.length ? handlers : [(req, res) => res.status(500).json({ error: 'Thiếu handler.' })];
        return router[String(method).toLowerCase()](path, ...list.map(wrap));
    };

    const api = {
        // --- legacy / tương thích ---
        db,
        crypto,
        get: (...args) => route('get', ...args),
        post: (...args) => route('post', ...args),
        put: (...args) => route('put', ...args),
        patch: (...args) => route('patch', ...args),
        delete: (...args) => route('delete', ...args),
        route,
        command: (name, execute, description = '') => {
            commands.set(String(name), { name: String(name), execute, description, pluginId });
        },
        log,
        kv,
        store: kv,
        webhook: async (payload) => {
            const url = process.env.LEADERBOARD_WEBHOOK_URL;
            if (!url) return false;
            const res = await fetch(`${url}?wait=true`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            return res.ok;
        },

        // --- core / info ---
        core: {
            version: CORE_VERSION,
            language: 'JavaScript (CommonJS)',
            now: () => new Date().toISOString(),
            dbMode: db.mode,
            env: publicEnv,
            events: listEvents,
            pluginId,
        },
        plugin: { id: pluginId, name: row.name, sourceUrl: row.source_url || '' },

        // --- routes / commands ---
        all: (path, handler) => route('all', path, handler),
        middleware: (handler) => router.use(wrap(handler)),
        routes: { list: () => router.stack.filter(l => l.route).map(l => ({
            method: Object.keys(l.route.methods)[0].toUpperCase(), path: l.route.path,
        })) },
        commands: {
            list: () => [...commands.values()].map(c => ({ ...c })),
            get: (name) => commands.get(String(name)) || null,
        },

        // --- events: hook vào bot/web và emit event của riêng plugin ---
        events: {
            on: (event, handler) => {
                eventNames.add(String(event));
                return on(event, handler, pluginId);
            },
            off: (event, handler) => off(event, handler, pluginId),
            emit,
            list: listEvents,
        },

        // --- gọi API giữa các plugin qua API gốc ---
        plugins: {
            list,
            get: (ref) => {
                const entry = findEntry(ref);
                return entry ? { ...entry.meta } : null;
            },
            call: (ref, method, payload) => callPlugin(ref, method, payload, { from: pluginId }),
            expose: (method, handler) => {
                if (!exposedApi.has(pluginId)) exposedApi.set(pluginId, new Map());
                exposedApi.get(pluginId).set(String(method), handler);
                apiNames.add(String(method));
                return true;
            },
            unexpose: (method) => {
                const table = exposedApi.get(pluginId);
                if (table) table.delete(String(method));
                apiNames.delete(String(method));
                return true;
            },
        },
        expose: (method, handler) => api.plugins.expose(method, handler),

        // --- Discord bot ---
        bot: {
            client: () => context.client || null,
            ready: () => !!(context.client && context.client.user),
            user: async (id) => {
                if (!context.client) throw new Error('Bot chưa sẵn sàng.');
                return context.client.users.fetch(String(id));
            },
            channel: async (id) => {
                if (!context.client) throw new Error('Bot chưa sẵn sàng.');
                return context.client.channels.fetch(String(id));
            },
            send: async (channelId, content, options = {}) => {
                if (!context.client) throw new Error('Bot chưa sẵn sàng.');
                const ch = await context.client.channels.fetch(String(channelId));
                return ch.send(content, options);
            },
            dm: async (userId, content) => {
                if (!context.client) throw new Error('Bot chưa sẵn sàng.');
                const u = await context.client.users.fetch(String(userId));
                return u.send(content);
            },
            isAdmin: async (id) => {
                const raw = String(id || '');
                if (!raw) return false;
                if ((process.env.ADMIN_DISCORD_ID || '').split(',').map(s => s.trim()).includes(raw)) return true;
                return db.isAdmin(raw);
            },
            leaderboard: () => list().flatMap(p => p.commands.map(c => ({ ...c, plugin: p.id }))),
        },

        // --- Web ---
        web: {
            requireAuth: () => context.web.requireAuth || null,
            requireAdmin: () => context.web.requireAdmin || null,
            balanceKey: (user) => context.web.balanceKey
                ? context.web.balanceKey(user)
                : (user && user.discord_id ? String(user.discord_id) : `web_${user && user.id}`),
            cookieName: () => context.web.COOKIE_NAME || 'nigaria_session',
            me: async (req) => {
                const u = req && req.webUser;
                if (!u) return null;
                if (context.web.publicUser) return context.web.publicUser(u);
                return { id: u.id, username: u.username, discordId: u.discord_id || null };
            },
        },

        // --- Coin / user ---
        coins: {
            get: (key) => db.getCoins(key),
            add: (key, amount) => db.updateCoins(key, Number(amount) || 0),
            take: async (key, amount) => {
                const n = Math.max(0, Number(amount) || 0);
                const balance = await db.getCoins(key);
                if (balance < n) throw new Error(`Không đủ xu (có ${balance}, cần ${n}).`);
                return db.updateCoins(key, -n);
            },
            transfer: async (from, to, amount) => {
                const n = Math.max(0, Number(amount) || 0);
                if (!n) return 0;
                const balance = await db.getCoins(from);
                if (balance < n) throw new Error('Số dư không đủ để chuyển.');
                await db.updateCoins(from, -n);
                return db.updateCoins(to, n);
            },
            top: (limit) => db.getTopCoins(limit),
        },
        users: {
            getById: (id) => db.getWebUserById(id),
            getByDiscord: (id) => db.getWebUserByDiscordId(String(id)),
            getByToken: (token) => db.getWebUserByLinkToken(String(token)),
            list: (limit) => db.listWebUsers(limit),
            public: async (user) => {
                if (context.web.publicUser) return context.web.publicUser(user);
                return { id: user.id, username: user.username, discordId: user.discord_id || null };
            },
            displayName: async (id) => {
                const saved = await db.getKv(`discord_name:${id}`);
                if (saved) return saved;
                if (!process.env.DISCORD_TOKEN) return null;
                const res = await fetch(`https://discord.com/api/v10/users/${id}`, {
                    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
                    signal: AbortSignal.timeout(5000),
                });
                if (!res.ok) return null;
                const data = await res.json();
                return data.global_name || data.username || null;
            },
            avatar: (id) => db.getKv(`discord_avatar:${id}`),
            isAdmin: (id) => api.bot.isAdmin(id),
            balanceKey: (user) => api.web.balanceKey(user),
            linkCount: async (key) => db.getLinkCount(key, await weekly.getLinkPeriod()),
        },

        // --- Shop / kho ---
        shop: {
            useGist: shop.useGist,
            list: (activeOnly = true) => db.getShopItems(activeOnly),
            get: (id) => db.getShopItem(id),
            create: (item) => db.createShopItem(item),
            addStock: (item, text) => shop.addStock(item, text),
            takeStock: (item, quantity) => shop.takeStock(item, quantity),
            persistStock: (item, fields) => shop.persistStock(item, fields),
            restoreStock: (item, accounts) => shop.restoreStock(item, accounts),
            purchases: (webUserId, limit) => db.getPurchasesByUser(webUserId, limit),
        },

        // --- Dịch vụ device / cloud ---
        services: {
            cloudNames: services.CLOUD_NAMES,
            costs: { reg: services.REG_COST },
            regVmos: () => services.regVmosAccount(),
            regVsphone: () => services.regVsphoneAccount(),
            buyHanami: (provider, server, input) => services.buyHanami(provider, server, input),
        },

        // --- Link / BXH / thưởng ---
        link: {
            period: () => weekly.getLinkPeriod(),
            rewards: () => weekly.getRewards(),
            providers: linkProviders.PROVIDERS,
            get: (id) => linkProviders.get(id),
            reward: (id) => linkProviders.rewardFor(id),
            dailyMax: (id) => linkProviders.dailyMaxFor(id),
            shorten: (id, url) => linkProviders.shorten(id, url),
            count: (key, period) => period ? db.getLinkCount(key, period) : db.getAllTimeLinkCount(key),
            allTime: (key) => db.getAllTimeLinkCount(key),
            leaderboard: (period, limit) => db.getLinkLeaderboard(period, limit),
            allTimeLeaderboard: (limit) => db.getAllTimeLinkLeaderboard(limit),
            payout: (opts) => weekly.runWeeklyPayout(opts),
        },
        gift: {
            redeem: (code) => db.redeemGiftCode(code),
            create: (code, amount) => db.createGiftCode(code, amount),
        },
        daily: {
            today: () => utils.getTodayString(),
            status: async (key) => {
                const today = utils.getTodayString();
                const [claimed, freeVmosClaimed, freeVsphoneClaimed, links] = await Promise.all([
                    db.checkDailyLimit(key, 'daily', today),
                    db.checkDailyLimit(key, 'vmos_free', today),
                    db.checkDailyLimit(key, 'vsphone_free', today),
                    todayFreeLinkCount(key, today),
                ]);
                return {
                    date: today,
                    claimed: claimed > 0,
                    freeVmosClaimed: freeVmosClaimed > 0,
                    freeVsphoneClaimed: freeVsphoneClaimed > 0,
                    freeDeviceClaimed: freeVmosClaimed > 0 || freeVsphoneClaimed > 0,
                    linkCount: links,
                };
            },
            claim: async (key) => {
                const today = utils.getTodayString();
                if (await db.checkDailyLimit(key, 'daily', today) > 0) throw new Error('Hôm nay đã claim rồi.');
                const reward = crypto.randomInt(1, 21);
                await db.increaseDailyLimit(key, 'daily', today);
                return { reward, balance: await db.updateCoins(key, reward), date: today };
            },
            claimVmos: async (key) => claimFreeDeviceForPlugin(key, 'vmos'),
            claimVsphone: async (key) => claimFreeDeviceForPlugin(key, 'vsphone'),
        },

        // --- tiện ích ---
        format: {
            num: (n) => Number(n || 0).toLocaleString('vi-VN'),
            date: (d) => new Date(d || Date.now()).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
            esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
            truncate: (s, n = 100) => String(s || '').slice(0, n),
        },
        http: {
            request: async (url, opts = {}) => {
                const parsed = new URL(String(url));
                if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Chỉ hỗ trợ http/https.');
                const res = await fetch(parsed.href, {
                    method: opts.method || 'GET',
                    headers: opts.headers || {},
                    body: opts.body,
                    signal: AbortSignal.timeout(opts.timeout || 10000),
                });
                const text = await res.text();
                let data = text;
                try { data = JSON.parse(text); } catch (e) { /* giữ text */ }
                return { ok: res.ok, status: res.status, data, text };
            },
            get: (url, opts = {}) => api.http.request(url, { ...opts, method: 'GET' }),
            post: (url, body, opts = {}) => api.http.request(url, { ...opts, method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }),
        },
        onUnload: (fn) => {
            if (typeof fn === 'function') unloadHooks.set(pluginId, [...(unloadHooks.get(pluginId) || []), fn]);
        },
    };

    function wrap(handler) {
        return (req, res, next) => {
            Promise.resolve(handler(req, res, next, { db, api, plugin: row, context })).catch(next);
        };
    }

    const sandbox = {
        console: {
            log,
            warn: log.warn,
            error: log.error,
        },
        module: { exports: {} },
        exports: {},
        require: safeRequire,
        api,
        db,
        crypto,
        fetch,
        URL,
        Buffer,
        setTimeout: (fn, ms, ...args) => trackedSetTimeout(pluginId, fn, ms, ...args),
        clearTimeout: (id) => trackedClear(pluginId, id),
        setInterval: (fn, ms, ...args) => trackedSetInterval(pluginId, fn, ms, ...args),
        clearInterval: (id) => trackedClear(pluginId, id),
    };
    sandbox.exports = sandbox.module.exports;

    try {
        const vmContext = vm.createContext(sandbox, { name: `plugin:${row.name}` });
        vm.runInContext(code, vmContext, { timeout: 5000, filename: `${row.name}.plugin.js` });
        if (typeof sandbox.module.exports === 'function') {
            await sandbox.module.exports(api);
        } else if (sandbox.module.exports && typeof sandbox.module.exports.register === 'function') {
            await sandbox.module.exports.register(api);
        }
    } catch (e) {
        await db.updatePlugin(pluginId, { error: e.message }).catch(() => {});
        unload(pluginId);
        throw e;
    }

    const meta = {
        id: pluginId,
        name: row.name,
        routes: api.routes.list(),
        commands: api.commands.list().map(c => ({ name: c.name, description: c.description })),
        events: [...eventNames],
        apis: [...apiNames],
    };
    loaded.set(pluginId, { id: pluginId, name: row.name, router, commands, api, meta });
    await db.updatePlugin(pluginId, { error: null, last_loaded_at: new Date().toISOString() }).catch(() => {});
    return meta;
}

async function reloadAll() {
    const plugins = await db.getPlugins();
    let ok = 0;
    for (const p of plugins) {
        if (p.enabled === false) { unload(String(p.id)); continue; }
        try { await loadPlugin(p); ok++; }
        catch (e) { console.error(`[plugin] ${p.name}: ${e.message}`); }
    }
    console.log(`[plugin] Đã load ${ok}/${plugins.length} plugin.`);
}

function dispatcher(req, res, next) {
    const match = /^\/([^/?]+)(.*)$/.exec(req.url || '');
    if (!match) return res.status(400).json({ error: 'Thiếu plugin id.' });
    let id;
    try { id = decodeURIComponent(match[1]); } catch (e) { return res.status(400).json({ error: 'Plugin id không hợp lệ.' }); }
    const entry = loaded.get(id);
    if (!entry) return res.status(404).json({ error: 'Plugin không tồn tại hoặc chưa được load.' });

    const originalUrl = req.url;
    const originalBase = req.baseUrl;
    req.url = match[2] || '/';
    if (!req.url.startsWith('/')) req.url = `/${req.url}`;
    req.baseUrl = `${originalBase || ''}/plugin/${id}`;
    return entry.router(req, res, (err) => {
        req.url = originalUrl;
        req.baseUrl = originalBase;
        next(err);
    });
}

function getCommand(name, pluginName) {
    const key = String(name || '').trim();
    const filter = String(pluginName || '').trim().toLowerCase();
    for (const entry of loaded.values()) {
        if (filter && entry.name.toLowerCase() !== filter && entry.id.toLowerCase() !== filter) continue;
        const cmd = entry.commands.get(key);
        if (cmd) return cmd;
    }
    return null;
}

function list() {
    return [...loaded.entries()].map(([id, entry]) => ({ id, ...entry.meta }));
}

function apiFor(pluginId) {
    const entry = loaded.get(String(pluginId));
    return entry ? entry.api : null;
}

async function remove(id) {
    const pluginId = String(id);
    unload(pluginId);
    const row = await db.getPlugin(pluginId);
    if (row && row.gist_id) await github.deleteGist(row.gist_id);
    await db.deletePlugin(pluginId);
}

module.exports = {
    loaded,
    loadPlugin,
    reloadAll,
    dispatcher,
    getCommand,
    list,
    apiFor,
    unload,
    remove,
    fetchScript,
    attachContext,
    emit,
    on,
    off,
    listEvents,
    callPlugin,
};
