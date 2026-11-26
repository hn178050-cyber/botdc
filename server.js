require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./database');
const services = require('./services');
const web = require('./web');
const weekly = require('./weekly');
const gistStore = require('./gist-store');
const shop = require('./shop');
const linkProviders = require('./link-providers');
const pluginEngine = require('./plugin-engine');
const keepAlive = require('./keep-alive');
const { generateUniqueLinkToken, randomId, hashPassword } = require('./utils');

// Marketplace có thể được thêm bởi module khác: require an toàn, gọi phòng thủ.
let marketplace = {};
try {
    marketplace = require('./marketplace') || {};
} catch (e) {
    console.warn('[marketplace] module chưa sẵn sàng:', e.message);
}
const { HANAMI_URL, CLOUD_NAMES, REG_COST, vsphoneReady, buyHanami, regVmosAccount, regVsphoneAccount } = services;
const PAY_MIN = 10;          // số xu tối thiểu mỗi lần /pay
const PAY_FEE_RATE = 0.05;   // phí chuyển 5%
const LEADERBOARD_INTERVAL_MS = 10 * 60 * 1000; // cập nhật bảng xếp hạng mỗi 10 phút
const WEEKLY_PAYOUT_INTERVAL_MS = 10 * 60 * 1000; // kiểm tra trả thưởng tuần mỗi 10 phút
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // dọn seller inactive mỗi 24h
const DEFAULT_EXCHANGE_RATE = 5; // 5 coin = 1 ACOIN (10 coin = 2 ACOIN)
const ACOIN_KV_PREFIX = 'acoin_balance:';
const BOT_SELLER_INDEX_KEY = 'bot_seller_index';
const busyUsers = new Set();
const pendingStarUsers = new Set(); // userId đang chờ admin duyệt nhiệm vụ /star
const STAR_REWARD = 10;
const STAR_DAILY_MAX = 3;
 // chặn bấm lệnh đồng thời (tránh nhận/chuyển xu 2 lần)

const app = express();
const PORT = process.env.PORT || 3000;

// Endpoint nhẹ cho keep-alive / external cron kiểm tra app còn thức.
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Dashboard web + API
app.use(express.static(path.join(__dirname, 'public')));
app.use(web.router);

// Plugin mount động: /plugin/<id>/... (script được load từ Gist)
app.use('/plugin', pluginEngine.dispatcher);

// Load lại plugin từ Gist lúc khởi động (không cần deploy lại khi đổi script)
pluginEngine.reloadAll().catch(e => console.error('[plugin] reloadAll lỗi:', e.message));

/** Fire-and-forget hook cho plugin. emit() tự catch lỗi. */
function hook(event, payload = {}) {
    pluginEngine.emit(event, payload);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    rest: { timeout: 15000, retries: 5 },
});

// Inject nội bộ bot + web cho plugin: api.bot.*, api.web.*, api.users.*...
pluginEngine.attachContext({
    client,
    app,
    web: {
        requireAuth: web.requireAuth,
        requireAdmin: web.requireAdmin,
        balanceKey: web.balanceKey,
        publicUser: web.publicUser,
        COOKIE_NAME: web.COOKIE_NAME,
    },
});

// Lưu avatar/username Discord lúc /connect, /token để web dùng làm avatar user.
async function saveDiscordProfile(discordUser) {
    try {
        if (!discordUser || !discordUser.id) return;
        if (typeof discordUser.displayAvatarURL === 'function') {
            const url = discordUser.displayAvatarURL({ size: 128 });
            if (url) await db.setKv(`discord_avatar:${discordUser.id}`, url);
        }
        const name = discordUser.globalName || discordUser.global_name || discordUser.username;
        if (name) await db.setKv(`discord_name:${discordUser.id}`, name);
        // Lưu cả username gốc để /transfer nhận diện cả tên Discord lẫn tên hiển thị.
        if (discordUser.username) await db.setKv(`discord_username:${discordUser.id}`, discordUser.username);
    } catch (e) {
        console.error('[discord-profile] không lưu được avatar:', e.message);
    }
}

/** Đảm bảo Discord user có tài khoản web liên kết (dùng cho các lệnh đồng bộ web). */
async function ensureWebUserForDiscord(userId, discordUser) {
    await saveDiscordProfile(discordUser);
    let user = await db.getWebUserByDiscordId(userId);
    if (user) {
        if (!user.link_token) {
            const token = await generateUniqueLinkToken(db);
            user = (await db.updateWebUser(user.id, { link_token: token })) || { ...user, link_token: token };
        }
        return user;
    }
    let username;
    do {
        username = `disc_${String(userId).slice(-6)}${crypto.randomBytes(2).toString('hex')}`;
    } while (await db.getWebUserByUsername(username));
    user = await db.createWebUser({
        id: randomId(),
        username,
        password_hash: hashPassword(crypto.randomBytes(24).toString('hex')),
        link_token: await generateUniqueLinkToken(db),
        discord_id: userId,
    });
    hook('bot:user:autolinked', { discordId: userId, webUserId: user.id, username });
    return user;
}

// heartbeat watchdog: nếu bot im lặng quá 2 phút -> relogin
const HEARTBEAT_TIMEOUT = 2 * 60 * 1000;
let _heartbeatTimer = null;
function resetHeartbeat() {
    if (_heartbeatTimer) clearTimeout(_heartbeatTimer);
    _heartbeatTimer = setTimeout(() => {
        console.warn('[BOT] Heartbeat timeout — bot có thể offline, relogin...');
        safeRelogin();
    }, HEARTBEAT_TIMEOUT);
}


// Hàm sinh Gift Code (8 ký tự bao gồm ký tự đặc biệt)
function generateGiftCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let result = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
}

// Lấy danh sách Admin từ .env
function getAdminIds() {
    return (process.env.ADMIN_DISCORD_ID || '').split(',').map(id => id.trim()).filter(id => id);
}

// Lấy ngày hiện tại (UTC+7)
function getTodayString() {
    const now = new Date();
    const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    return vnTime.toISOString().split('T')[0];
}

/** Tổng link đã vượt hôm nay, cộng mọi provider — điều kiện mở quà free. */
async function todayFreeLinkCount(userId, today) {
    const ids = Object.keys(linkProviders.PROVIDERS);
    const counts = await Promise.all(ids.map(id => db.checkDailyLimit(userId, id, today)));
    return counts.reduce((sum, count) => sum + (Number(count) || 0), 0);
}

// ==========================================
// PHẦN 1: WEB SERVER (NHẬN XU)
// ==========================================
const REDEEM_ASSET_VERSION = '20261124r';
const BROWSER_COOKIE = 'nigaria_browser';

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readBrowserCookie(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === BROWSER_COOKIE) return decodeURIComponent(rest.join('='));
    }
    return '';
}

function setBrowserCookie(res, value) {
    res.cookie(BROWSER_COOKIE, value, {
        httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000,
    });
}

function redeemWebBase(req) {
    return (process.env.RENDER_DOMAIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function getRedeemMeta(sid) {
    try { return JSON.parse((await db.getKv(`redeem_meta:${sid}`)) || '{}') || {}; }
    catch (e) { return {}; }
}

async function setRedeemMeta(sid, meta) {
    try { await db.setKv(`redeem_meta:${sid}`, JSON.stringify(meta || {})); }
    catch (e) { console.error('[redeem] không lưu được meta:', e.message); }
}

function redeemProviderInfo(session) {
    const config = linkProviders.get(session && session.provider);
    return {
        reward: config ? config.reward : linkProviders.rewardFor(session && session.provider),
        providerName: config ? config.name : String((session && session.provider) || 'Vượt link'),
    };
}

function renderRedeemError(res, msg, { theme = 'bubble', webUrl = 'https://asynctas.cc.cd' } = {}) {
    const safeTheme = ['bubble', 'classic'].includes(theme) ? theme : 'bubble';
    return res.status(403).send(`<!DOCTYPE html>
<html lang="vi" data-theme="${safeTheme}"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="/styles.css?v=${REDEEM_ASSET_VERSION}" /><title>NIGARIA CLOUD — Lỗi</title></head>
<body><div class="redeem-page"><div class="card redeem-card">
  <div class="redeem-icon">!</div>
  <div class="redeem-title">LỖI TRUY CẬP</div>
  <p class="muted">${escapeHtml(msg)}</p>
  <div class="redeem-actions">
    <a class="btn btn-primary" href="${escapeHtml(webUrl)}">Quay lại web</a>
    <a class="btn btn-ghost" href="https://discord.com/app">Quay lại Discord</a>
  </div>
</div></div></body></html>`);
}

// Trang redeem: render đúng theme đã lưu, chưa cộng xu — chờ xác minh trình duyệt.
app.get('/redeem', async (req, res) => {
    const sid = String(req.query.sid || '').trim();
    const fallbackWeb = redeemWebBase(req);
    if (!sid) return renderRedeemError(res, 'Bạn phải lấy link từ nút "Vượt link" trên web hoặc lệnh /getlink trên Discord.', { webUrl: fallbackWeb });

    try {
        const sessionData = await db.getSession(sid);
        if (!sessionData) return renderRedeemError(res, 'Link này đã được sử dụng hoặc đã hết hạn.', { webUrl: fallbackWeb });

        const meta = await getRedeemMeta(sid);
        const theme = ['bubble', 'classic'].includes(meta.theme) ? meta.theme : 'bubble';
        const webUrl = meta.webUrl || fallbackWeb;
        let browserId = readBrowserCookie(req);
        if (!browserId) {
            browserId = crypto.randomBytes(16).toString('hex');
            setBrowserCookie(res, browserId);
        }
        // Link tạo từ Discord không có trình duyệt gốc: gán lần đầu tiên mở link.
        if (!meta.browserId) {
            meta.browserId = browserId;
            meta.theme = theme;
            meta.webUrl = webUrl;
            await setRedeemMeta(sid, meta);
        }

        const { reward, providerName } = redeemProviderInfo(sessionData);
        res.send(`<!DOCTYPE html>
<html lang="vi" data-theme="${theme}"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>NIGARIA CLOUD — Vượt link</title>
<link rel="icon" type="image/png" href="https://i.postimg.cc/gkbfN52c/Logo-asynctas-1x.png" />
<link rel="stylesheet" href="/styles.css?v=${REDEEM_ASSET_VERSION}" />
<script>try{var th=localStorage.getItem('nigaria_theme');if(th==='bubble'||th==='classic')document.documentElement.dataset.theme=th;}catch(e){}</script>
</head><body>
<div class="redeem-page"><div class="card redeem-card">
  <div class="redeem-icon">🎁</div>
  <div class="redeem-title">${escapeHtml(providerName)}</div>
  <p class="muted">Xác minh đúng trình duyệt đã tạo link để nhận thưởng.</p>
  <div class="redeem-amount" id="redeem-reward">+${reward} xu</div>
  <p class="redeem-stat">Bước 1 — Xác minh trình duyệt</p>
  <p class="redeem-stat">Bước 2 — Nhận xu vào tài khoản</p>
  <div class="redeem-status" id="redeem-status" aria-live="polite">Sẵn sàng xác minh…</div>
  <div class="redeem-actions">
    <button class="btn btn-primary" id="redeem-verify" type="button">Xác minh trình duyệt</button>
    <button class="btn btn-soft hidden" id="redeem-claim" type="button">Nhận ${reward} xu</button>
  </div>
  <div class="redeem-actions">
    <a class="btn btn-soft" href="${escapeHtml(webUrl)}">Quay lại web</a>
    <a class="btn btn-ghost" href="https://discord.com/app">Quay lại Discord</a>
  </div>
</div></div>
<script>
(function(){
  var sid = ${JSON.stringify(sid)};
  var status = document.getElementById('redeem-status');
  var verifyBtn = document.getElementById('redeem-verify');
  var claimBtn = document.getElementById('redeem-claim');
  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'redeem-status' + (kind ? ' ' + kind : '');
  }
  async function post(path) {
    var r = await fetch(path, { method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sid: sid }) });
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok || !d.ok) throw new Error(d.error || ('Lỗi ' + r.status));
    return d;
  }
  verifyBtn.addEventListener('click', async function(){
    verifyBtn.disabled = true;
    setStatus('Đang xác minh trình duyệt…');
    try {
      var d = await post('/redeem/verify');
      setStatus('Xác minh thành công — ' + d.providerName + ' +' + d.reward + ' xu. Bấm nhận xu.', 'ok');
      verifyBtn.classList.add('hidden');
      claimBtn.classList.remove('hidden');
    } catch (e) { setStatus(e.message, 'error'); }
    finally { verifyBtn.disabled = false; }
  });
  claimBtn.addEventListener('click', async function(){
    claimBtn.disabled = true;
    setStatus('Đang cộng xu…');
    try {
      var d = await post('/redeem/claim');
      document.getElementById('redeem-reward').textContent = '+' + d.reward + ' xu';
      setStatus('Nhận thành công! Số dư: ' + d.newBalance + ' xu · Tuần này: ' + d.weeklyCount + '.', 'ok');
      claimBtn.classList.add('hidden');
    } catch (e) { setStatus(e.message, 'error'); }
    finally { claimBtn.disabled = false; }
  });
})();
</script>
</body></html>`);
    } catch (error) {
        console.error('[redeem] lỗi render:', error);
        res.status(500).send('Lỗi Server.');
    }
});

// Bước 1: chỉ kiểm tra cookie trình duyệt, KHÔNG tiêu session / cộng xu.
app.post('/redeem/verify', express.json(), async (req, res) => {
    const sid = String((req.body && req.body.sid) || '').trim();
    const sessionData = await db.getSession(sid).catch(() => null);
    if (!sessionData) return res.status(403).json({ ok: false, error: 'Link này đã được sử dụng hoặc đã hết hạn.' });
    const meta = await getRedeemMeta(sid);
    const browserId = readBrowserCookie(req);
    if (!meta.browserId || !browserId || meta.browserId !== browserId) {
        return res.status(403).json({ ok: false, error: 'Trình duyệt này không khớp với trình duyệt đã tạo link. Hãy mở lại link bằng đúng trình duyệt đã bấm "Vượt link".' });
    }
    const { reward, providerName } = redeemProviderInfo(sessionData);
    return res.json({ ok: true, reward, providerName });
});

// Bước 2: verify lại rồi mới tiêu session và cộng xu.
app.post('/redeem/claim', express.json(), async (req, res) => {
    const sid = String((req.body && req.body.sid) || '').trim();
    const meta = await getRedeemMeta(sid);
    const browserId = readBrowserCookie(req);
    if (!meta.browserId || !browserId || meta.browserId !== browserId) {
        return res.status(403).json({ ok: false, error: 'Xác minh trình duyệt thất bại. Vui lòng tải lại trang và thử lại.' });
    }
    try {
        const sessionData = await db.getAndDeleteSession(sid);
        if (!sessionData) return res.status(403).json({ ok: false, error: 'Link này đã được sử dụng hoặc đã hết hạn.' });

        const { user_id, provider } = sessionData;
        const { reward, providerName } = redeemProviderInfo(sessionData);
        const newBalance = await db.updateCoins(user_id, reward);
        let weeklyCount = 0;
        let period = null;
        try {
            period = await weekly.getLinkPeriod();
            weeklyCount = await db.incrementLinkCount(user_id, period);
            await gistStore.recordLink(user_id, provider, period);
        } catch (e) {
            console.error('[WEB] không cập nhật được BXH vượt link:', e.message);
        }
        await setRedeemMeta(sid, { ...meta, claimed: true });

        hook('bot:link:redeemed', {
            sid, userKey: user_id, provider, providerName,
            reward, newBalance, weeklyCount, period,
        });
        console.log(`[WEB] User ${user_id} vượt link ${provider}. +${reward} xu. Số dư: ${newBalance} | tuần này: ${weeklyCount}`);
        return res.json({ ok: true, reward, newBalance, weeklyCount, providerName, webUrl: meta.webUrl || redeemWebBase(req) });
    } catch (error) {
        console.error('[redeem] lỗi nhận xu:', error);
        return res.status(500).json({ ok: false, error: 'Lỗi Server khi nhận xu.' });
    }
});

app.listen(PORT, () => {
    console.log(`\n✅ Web Server đang chạy: http://localhost:${PORT}`);
    keepAlive.start();
});

// Trả thưởng bảng xếp hạng vượt link tự động vào Chủ nhật hàng tuần (giờ VN)
async function runWeeklyPayoutWithHook(source) {
    try {
        const result = await weekly.runWeeklyPayout();
        hook('bot:weekly:payout', { source, result });
        return result;
    } catch (e) {
        hook('bot:weekly:payout:error', { source, error: e.message });
        throw e;
    }
}
setInterval(() => {
    runWeeklyPayoutWithHook('auto').catch(e => console.error('[weekly] lỗi:', e.message));
}, WEEKLY_PAYOUT_INTERVAL_MS);
runWeeklyPayoutWithHook('startup').catch(e => console.error('[weekly] lỗi:', e.message));

// In IP outbound mỗi lần khởi động (để đưa vào whitelist) + thử xem KingDev có bị Cloudflare chặn không
(async () => {
    try {
        const ip = await (await fetch('https://api.ipify.org?format=json')).json();
        console.log(`[IP] IP outbound hiện tại: ${ip.ip}`);
    } catch (e) { console.log('[IP] Không lấy được IP:', e.message); }
    try {
        const r = await fetch(HANAMI_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({ token: 'probe', cloud_id: 'VM', input_data: 'probe' })
        });
        const t = await r.text();
        console.log(`[IP] Thử Hanami: HTTP ${r.status} - ${t.trim().startsWith('{') ? 'JSON (không bị chặn)' : 'HTML (bị Cloudflare chặn)'}`);
    } catch (e) { console.log('[IP] Thử Hanami lỗi:', e.message); }
})();

// ==========================================
// PHẦN 2: DISCORD BOT
// ==========================================
// ===== ADMIN: Owner (env ADMIN_DISCORD_ID) + admin cấp bằng /op (bảng admins) =====
async function isAdmin(userId) {
    if (getAdminIds().includes(userId)) return true;
    try { return await db.isAdmin(userId); } catch (e) { console.error('[admin] không đọc được bảng admins:', e.message); return false; }
}

// ===== MARKETPLACE: tỷ giá, ACOIN, seller (mọi helper đều có fallback) =====
function toNonNegativeInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

async function readJsonKv(key, fallback) {
    try {
        const raw = await db.getKv(key);
        if (!raw) return fallback;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsed === undefined || parsed === null ? fallback : parsed;
    } catch (e) {
        return fallback;
    }
}

async function getExchangeRateSafe() {
    let raw = null;
    if (typeof marketplace.getExchangeRate === 'function') {
        try { raw = await marketplace.getExchangeRate(); } catch (e) { /* fallback KV */ }
    }
    if (raw === null || raw === undefined) {
        try { raw = await db.getKv('exchange_coin_per_acoin'); } catch (e) { /* dùng mặc định */ }
    }
    const rate = toNonNegativeInt(raw, DEFAULT_EXCHANGE_RATE);
    return rate >= 1 ? rate : DEFAULT_EXCHANGE_RATE;
}

async function readAcoinSafe(discordId) {
    if (typeof marketplace.getAcoin === 'function') {
        try { return toNonNegativeInt(await marketplace.getAcoin(discordId)); } catch (e) { /* thử nguồn khác */ }
    }
    if (typeof db.getAcoin === 'function') {
        try { return toNonNegativeInt(await db.getAcoin(discordId)); } catch (e) { /* fallback KV */ }
    }
    return toNonNegativeInt(await db.getKv(`${ACOIN_KV_PREFIX}${discordId}`));
}

async function adjustAcoin(discordId, delta) {
    const change = Number(delta) || 0;
    // Ưu tiên hàm dùng chung của marketplace để không lệch bảng acoin_balances.
    if (typeof marketplace.adjustAcoin === 'function') {
        try {
            return toNonNegativeInt(await marketplace.adjustAcoin(discordId, change), await readAcoinSafe(discordId));
        } catch (e) {
            console.error('[acoin] marketplace.adjustAcoin lỗi:', e.message);
        }
    }
    if (typeof db.updateAcoin === 'function') {
        const next = await db.updateAcoin(discordId, change);
        return toNonNegativeInt(next, await readAcoinSafe(discordId));
    }
    // Fallback khi DB chưa có helper ACOIN.
    const current = await readAcoinSafe(discordId);
    const next = Math.max(0, current + change);
    await db.setKv(`${ACOIN_KV_PREFIX}${discordId}`, String(next));
    return next;
}

async function readSellerSafe(discordId) {
    if (typeof marketplace.getSeller === 'function') {
        try {
            const row = await marketplace.getSeller(discordId);
            if (row) return row;
        } catch (e) { console.error('[seller] marketplace.getSeller lỗi:', e.message); }
    }
    if (typeof db.getSeller === 'function') {
        try {
            const row = await db.getSeller(discordId);
            if (row) return row;
        } catch (e) { /* fallback KV */ }
    }
    return await readJsonKv(`bot_seller:${discordId}`, null);
}

async function writeSellerSafe(discordId, patch) {
    const current = await readSellerSafe(discordId);
    const record = { ...(current || {}), ...patch, user_id: String(discordId), updated_at: new Date().toISOString() };
    if (!record.created_at) record.created_at = record.updated_at;
    if (typeof db.upsertSeller === 'function') {
        try {
            const saved = await db.upsertSeller(record);
            if (saved) return saved;
        } catch (e) { console.error('[seller] upsert lỗi:', e.message); }
    }
    if (current && typeof db.updateSeller === 'function') {
        try {
            const saved = await db.updateSeller(discordId, patch);
            if (saved) return saved;
        } catch (e) { console.error('[seller] update lỗi:', e.message); }
    }
    // Fallback KV: index + record (không đụng vào key của marketplace module).
    const ids = await readJsonKv(BOT_SELLER_INDEX_KEY, []);
    const list = Array.isArray(ids) ? ids : [];
    if (!list.includes(String(discordId))) list.push(String(discordId));
    await db.setKv(`bot_seller:${discordId}`, JSON.stringify(record));
    await db.setKv(BOT_SELLER_INDEX_KEY, JSON.stringify(list));
    return record;
}

async function listSellersSafe() {
    if (typeof marketplace.listSellers === 'function') {
        try {
            const rows = await marketplace.listSellers();
            if (Array.isArray(rows)) return rows;
        } catch (e) { console.error('[seller] marketplace.listSellers lỗi:', e.message); }
    }
    for (const method of ['getSellers', 'listSellers']) {
        if (typeof db[method] === 'function') {
            try {
                const rows = await db[method]();
                if (Array.isArray(rows)) return rows;
            } catch (e) { console.error(`[seller] ${method} lỗi:`, e.message); }
        }
    }
    const ids = await readJsonKv(BOT_SELLER_INDEX_KEY, []);
    const list = Array.isArray(ids) ? ids : [];
    const rows = await Promise.all(list.map(id => readJsonKv(`bot_seller:${id}`, null)));
    return rows.filter(Boolean);
}

async function requestSellerSafe(discordId) {
    if (typeof marketplace.requestSeller === 'function') {
        try {
            const res = await marketplace.requestSeller(discordId);
            if (res && res.ok !== false) return res;
        } catch (e) { console.error('[seller] requestSeller lỗi:', e.message); }
    }
    const current = await readSellerSafe(discordId);
    if (current && String(current.status) === 'active') {
        return { ok: true, status: 'active', seller: current };
    }
    const seller = await writeSellerSafe(discordId, { status: 'pending' });
    return { ok: true, status: 'pending', seller };
}

async function approveSellerSafe(discordId, adminId) {
    let approved = null;
    if (typeof marketplace.approveSeller === 'function') {
        try { approved = await marketplace.approveSeller(discordId, adminId); } catch (e) { console.error('[seller] approveSeller lỗi:', e.message); }
    }
    const isActive = approved && approved.ok !== false && String((approved.seller || {}).status || 'active') === 'active';
    if (isActive) return approved;
    // Chưa gửi yêu cầu / approve thất bại vẫn được trust: tạo seller active luôn.
    const seller = await writeSellerSafe(discordId, { status: 'active', approved_by: adminId });
    return { ok: true, status: 'active', seller, fallback: true };
}

async function runMarketplaceMaintenance(source = 'manual') {
    if (typeof marketplace.runMaintenance !== 'function') return null;
    const result = await marketplace.runMaintenance();
    console.log(`[marketplace] maintenance (${source}):`, result);
    return result;
}

// ===== BẢNG XẾP HẠNG COIN QUA WEBHOOK =====
async function updateLeaderboard() {
    const url = process.env.LEADERBOARD_WEBHOOK_URL;
    if (!url) return;
    try {
        const top = await db.getTopCoins(10);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = top.length
            ? top.map((u, i) => `${medals[i] || `**${i + 1}.**`} <@${u.user_id}> — **${Number(u.balance).toLocaleString('en-US')}** xu`)
            : ['Chưa có ai trong bảng xếp hạng.'];
        const payload = {
            allowed_mentions: { parse: [] },
            embeds: [{
                title: '🏆 Bảng xếp hạng Coin',
                description: lines.join('\n'),
                color: 0xF1C40F,
                footer: { text: 'Cập nhật mỗi 10 phút' },
                timestamp: new Date().toISOString()
            }]
        };
        const headers = { 'Content-Type': 'application/json' };
        let msgId = null;
        try { msgId = await db.getKv('leaderboard_message_id'); } catch (e) { console.error('[BXH] không đọc được bảng kv:', e.message); }

        if (msgId) {
            const res = await fetch(`${url}/messages/${msgId}`, { method: 'PATCH', headers, body: JSON.stringify(payload) });
            if (res.ok) return;
            if (res.status !== 404) return console.error(`[BXH] sửa tin nhắn lỗi HTTP ${res.status}`);
        }
        const res = await fetch(`${url}?wait=true`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) return console.error(`[BXH] gửi webhook lỗi HTTP ${res.status}`);
        const msg = await res.json();
        try { await db.setKv('leaderboard_message_id', msg.id); } catch (e) { console.error('[BXH] không lưu được message id (bảng kv):', e.message); }
    } catch (e) {
        console.error('[BXH] lỗi cập nhật bảng xếp hạng:', e.message);
    }
}

client.on('shardReady', () => resetHeartbeat());
client.on('shardResume', (id, r) => { console.log(`[BOT] Shard ${id} resume OK (${r} events).`); resetHeartbeat(); });
client.on('interactionCreate', () => resetHeartbeat());
client.on('messageCreate', (message) => {
    resetHeartbeat();
    hook('bot:message', {
        id: message.id, authorId: message.author && message.author.id,
        channelId: message.channelId, guildId: message.guildId,
        content: message.content, isBot: !!(message.author && message.author.bot),
    });
});

client.once('ready', async () => {
    resetHeartbeat(); // bắt đầu watchdog ngay khi bot sẵn sàng
    hook('bot:ready', { botId: client.user.id, username: client.user.username, at: new Date().toISOString() });
    const commands = [
        new SlashCommandBuilder().setName('getlink').setDescription('Lấy link nhận xu (Link4M 50 xu, LayMa 50 xu, bbmkts 25 xu)')
            .addStringOption(opt => opt.setName('provider').setDescription('Chọn dịch vụ rút gọn link').addChoices(
                { name: 'Link4M — 50 xu', value: 'link4m' },
                { name: 'LayMa — 50 xu', value: 'layma' },
                { name: 'bbmkts — 25 xu', value: 'bbmkts' }
            ).setRequired(false)),
        new SlashCommandBuilder().setName('tasks').setDescription('Xem tiến độ nhiệm vụ vượt link hôm nay'),
        new SlashCommandBuilder().setName('vmosfree').setDescription('Lấy 1 VMOS free mỗi ngày (cần vượt 1 link hôm nay)'),
        new SlashCommandBuilder().setName('vsphonefree').setDescription('Lấy 1 VSPhone thường free mỗi ngày (cần vượt 1 link hôm nay)'),
        new SlashCommandBuilder().setName('theme').setDescription('Đổi giao diện web (Bubble / Classic)')
            .addStringOption(o => o.setName('kieu').setDescription('Chọn giao diện').setRequired(true)
                .addChoices({ name: 'Bubble Interface', value: 'bubble' }, { name: 'Classic', value: 'classic' })),
        new SlashCommandBuilder().setName('username').setDescription('Đổi tên tài khoản web đã liên kết Discord')
            .addStringOption(o => o.setName('ten_moi').setDescription('Tên mới 3-24 ký tự, có chữ cái').setRequired(true)),
        new SlashCommandBuilder().setName('history').setDescription('Xem lịch sử mua hàng / chuyển xu trên web')
            .addStringOption(o => o.setName('loai').setDescription('Loại lịch sử').setRequired(true)
                .addChoices({ name: 'Mua hàng', value: 'mua' }, { name: 'Chuyển xu', value: 'chuyen' })),
        new SlashCommandBuilder().setName('buy').setDescription('Mua sản phẩm trong shop bằng xu')
            .addStringOption(o => o.setName('item_id').setDescription('ID sản phẩm (xem /shop)').setRequired(true))
            .addIntegerOption(o => o.setName('soluong').setDescription('Số lượng (1-10)').setRequired(false).setMinValue(1).setMaxValue(10)),
        new SlashCommandBuilder().setName('leaderboard').setDescription('Xem bảng xếp hạng xu hoặc vượt link')
            .addStringOption(o => o.setName('loai').setDescription('Loại bảng xếp hạng').setRequired(true)
                .addChoices(
                    { name: 'Xu', value: 'coins' },
                    { name: 'Vượt link 7 ngày', value: 'week' },
                    { name: 'Vượt link tổng', value: 'all' }
                )),
        new SlashCommandBuilder().setName('wallpaper').setDescription('(Admin) Đổi ảnh nền web')
            .addStringOption(o => o.setName('url').setDescription('URL ảnh http(s), để trống để xem hiện tại').setRequired(false))
            .addBooleanOption(o => o.setName('xoa').setDescription('Đặt lại ảnh nền mặc định').setRequired(false)),
        new SlashCommandBuilder().setName('reg').setDescription('Tạo tài khoản cloud nhanh (Panel chọn dịch vụ)'),
        new SlashCommandBuilder().setName('vi').setDescription('Xem số dư xu của bạn'),
        new SlashCommandBuilder().setName('code').setDescription('Nhập Gift Code để nhận xu')
            .addStringOption(o => o.setName('gift_code').setDescription('Mã quà tặng').setRequired(true)),
        new SlashCommandBuilder().setName('buycloud').setDescription('Mua máy Cloud (Miễn phí)')
            .addStringOption(o => o.setName('provider').setDescription('Loại cloud').setRequired(true)
                .addChoices({ name: 'UGPhone', value: 'UG' }, { name: 'VMOS', value: 'VM' }, { name: 'VSPhone', value: 'VS' }))
            .addStringOption(o => o.setName('server').setDescription('Khu vực (bắt buộc với UGPhone)').setRequired(false)
                .addChoices({ name: 'Singapore', value: 'SG' }, { name: 'Hong Kong', value: 'HK' }, { name: 'Japan', value: 'JP' }, { name: 'Germany', value: 'DE' }, { name: 'US', value: 'US' })),
        new SlashCommandBuilder().setName('shop').setDescription('Xem danh sách hàng hoá và giá trong shop'),
        new SlashCommandBuilder().setName('connect').setDescription('Liên kết tài khoản web với Discord để đồng bộ coin')
            .addStringOption(o => o.setName('token').setDescription('Token 64 ký tự lấy trong mục Hồ sơ trên web').setRequired(true)),
        new SlashCommandBuilder().setName('token').setDescription('Lấy token đăng nhập web cố định của tài khoản Discord này'),
        new SlashCommandBuilder().setName('plugin').setDescription('Gọi lệnh của plugin đã cài (Admin hoặc mọi user tuỳ plugin)')
            .addStringOption(o => o.setName('lenh').setDescription('Tên plugin:lệnh, ví dụ hello:ping').setRequired(true)),
        new SlashCommandBuilder().setName('star').setDescription('Nhận nhiệm vụ đăng ký kênh YouTube để nhận xu'),
        new SlashCommandBuilder().setName('sdone').setDescription('(Admin) Xác nhận user hoàn thành nhiệm vụ /star')
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('adcoin').setDescription('Chỉnh số xu hoặc ACOIN của người dùng (Admin)')
            .addStringOption(o => o.setName('hanhdong').setDescription('Hành động').setRequired(true)
                .addChoices({ name: 'cộng', value: 'cong' }, { name: 'trừ', value: 'tru' }, { name: 'set (đặt bằng)', value: 'set' }))
            .addIntegerOption(o => o.setName('sotien').setDescription('Số tiền').setRequired(true).setMinValue(0))
            .addStringOption(o => o.setName('loai').setDescription('Loại tiền (mặc định: xu)').setRequired(false)
                .addChoices({ name: 'Xu (coin)', value: 'coin' }, { name: 'ACOIN', value: 'acoin' }))
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('daily').setDescription('Nhận quà hàng ngày (ngẫu nhiên 1-20 xu)'),
        new SlashCommandBuilder().setName('pay').setDescription('Chuyển xu cho người khác (phí 5%)')
            .addUserOption(o => o.setName('nguoinhan').setDescription('Người nhận').setRequired(true))
            .addIntegerOption(o => o.setName('sotien').setDescription(`Số xu muốn chuyển (tối thiểu ${PAY_MIN})`).setRequired(true).setMinValue(PAY_MIN)),
        new SlashCommandBuilder().setName('op').setDescription('Cấp quyền admin (Owner)')
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('unop').setDescription('Thu hồi quyền admin (Owner)')
            .addUserOption(o => o.setName('user').setDescription('Chọn người dùng').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoặc nhập ID Discord').setRequired(false)),
        new SlashCommandBuilder().setName('gen').setDescription('Tạo Gift Code (Admin)')
            .addIntegerOption(o => o.setName('soluong').setDescription('Số lượng code').setRequired(true))
            .addIntegerOption(o => o.setName('xuthuong').setDescription('Số xu mỗi code').setRequired(true)),
        new SlashCommandBuilder().setName('clear').setDescription('Xóa tin nhắn của Bot cũ hơn 2 giờ (Admin)'),
        new SlashCommandBuilder().setName('seller').setDescription('Yeu cau lam seller, admin duyet hoac xem danh sach')
            .addStringOption(o => o.setName('hanhdong').setDescription('request / trust / list').setRequired(true)
                .addChoices(
                    { name: 'request - gui yeu cau', value: 'request' },
                    { name: 'trust - admin duyet seller', value: 'trust' },
                    { name: 'list - admin xem danh sach', value: 'list' }
                ))
            .addUserOption(o => o.setName('user').setDescription('Nguoi can duyet (trust)').setRequired(false))
            .addStringOption(o => o.setName('id').setDescription('Hoac ID Discord (trust)').setRequired(false)),
        new SlashCommandBuilder().setName('exchange').setDescription('Doi coin sang ACOIN hoac nguoc lai')
            .addStringOption(o => o.setName('loai').setDescription('Chieu doi').setRequired(true)
                .addChoices({ name: 'coin -> ACOIN', value: 'coin' }, { name: 'ACOIN -> coin', value: 'acoin' }))
            .addIntegerOption(o => o.setName('soluong').setDescription('So coin (coin->ACOIN) hoac so ACOIN (ACOIN->coin)').setRequired(true).setMinValue(1)),
        new SlashCommandBuilder().setName('acoin').setDescription('Xem so du ACOIN va ty le quy doi'),
        new SlashCommandBuilder().setName('shops').setDescription('Tim kiem shop trong marketplace')
            .addStringOption(o => o.setName('q').setDescription('Tu khoa ten shop').setRequired(false))
            .addStringOption(o => o.setName('filter').setDescription('Cach sap xep').setRequired(false)
                .addChoices(
                    { name: 'recommended', value: 'recommended' },
                    { name: 'newest', value: 'newest' },
                    { name: 'oldest', value: 'oldest' },
                    { name: 'cheapest', value: 'cheapest' },
                    { name: 'priciest', value: 'priciest' },
                    { name: 'topRated', value: 'topRated' },
                    { name: 'bestSelling', value: 'bestSelling' }
                )),
        new SlashCommandBuilder().setName('appeal').setDescription('(Admin) Chap nhan/tu choi review hoac khieu nai')
            .addStringOption(o => o.setName('loai').setDescription('Loai can xu ly').setRequired(true)
                .addChoices({ name: 'review', value: 'review' }, { name: 'complaint', value: 'complaint' }))
            .addStringOption(o => o.setName('id').setDescription('ID cua review/complaint').setRequired(true))
            .addBooleanOption(o => o.setName('approve').setDescription('true = chap nhan, false = tu choi').setRequired(true))
            .addStringOption(o => o.setName('note').setDescription('Ghi chu').setRequired(false))
    ].map(c => c.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`✅ Bot online: ${client.user.tag}`);
        console.log(`✅ Đã đăng ký lệnh Slash!`);
    } catch (error) {
        console.error('Lỗi đăng ký lệnh:', error);
    }

    // Dọn seller không hoạt động: chạy lúc startup + mỗi 24h (ready event nên DISABLE_BOT=1 tự bỏ qua).
    runMarketplaceMaintenance('startup').catch(e => console.error('[marketplace] maintenance lỗi:', e.message));
    setInterval(() => {
        runMarketplaceMaintenance('auto').catch(e => console.error('[marketplace] maintenance lỗi:', e.message));
    }, MAINTENANCE_INTERVAL_MS);

    if (process.env.LEADERBOARD_WEBHOOK_URL) {
        updateLeaderboard();
        setInterval(updateLeaderboard, LEADERBOARD_INTERVAL_MS);
    }
});

// ===== MUA CLOUD QUA HANAMI (dùng services.buyHanami) =====

async function handleBuycloudModal(interaction) {
    const [, cloudId, serverRaw] = interaction.customId.split(':');
    const server = serverRaw === '-' ? null : serverRaw;
    const inputData = interaction.fields.getTextInputValue('input_data').trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        if (!process.env.HANAMI_TOKEN) return await interaction.editReply({ content: '❌ Bot chưa cấu hình HANAMI_TOKEN.' });
        if (cloudId !== 'UG' && cloudId !== 'VS' && !inputData.includes('|')) {
            return await interaction.editReply({ content: '❌ Sai định dạng. Nhập theo dạng: `tài khoản|mật khẩu`' });
        }
        const result = await buyHanami(cloudId, server, inputData);
        if (result.ok) {
            await interaction.editReply({ content: `✅ **Mua ${CLOUD_NAMES[cloudId]} thành công!**${server ? ` (${server})` : ''}\n${result.message}` });
        } else {
            await interaction.editReply({ content: `❌ Lỗi từ Hanami: ${result.message}`.slice(0, 1900) });
        }
    } catch (error) {
        console.error('[buycloud] lỗi:', error, error.cause);
        await interaction.editReply({ content: `❌ Lỗi kết nối: ${error.message}${error.cause ? ' - ' + (error.cause.code || error.cause.message) : ''}` });
    }
}

// ===== /reg PANEL (VMOS / VSPhone / UGPhone) =====

// Logo nút: đặt ID emoji (Developer Portal -> Emojis) hoặc <:ten:id> vào env; không có thì dùng emoji mặc định
function regEmoji(envName, fallback) {
    const v = (process.env[envName] || '').trim();
    if (/^\d{15,25}$/.test(v)) return { id: v, name: 'logo' };
    if (/^<a?:\w+:\d+>$/.test(v)) return v;
    return fallback;
}
function regButton(customId, label, style, envName, fallbackEmoji, disabled) {
    const btn = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
    try { btn.setEmoji(regEmoji(envName, fallbackEmoji)); } catch (e) { btn.setEmoji(fallbackEmoji); }
    return btn;
}
function buildRegPanel(ownerId) {
    const vsReady = vsphoneReady();
    const logos = services.DEVICE_LOGOS || {};
    const main = new EmbedBuilder()
        .setTitle('📋 Reg Panel')
        .setDescription([
            'Chọn dịch vụ bên dưới để tạo tài khoản nhanh gọn.',
            '',
            '**Đăng ký tài khoản**',
            `• VMOS Cloud — ${REG_COST} xu`,
            '• VMOS Free — 0 xu (1 link/ngày)',
            `• VSPhone — ${vsReady ? `${REG_COST} xu` : 'Sắp có'}`,
            `• VSPhone Free — 0 xu${vsReady ? ' (1 link/ngày)' : ' (sắp có)'}`,
            '',
            '',
            '💰 Chỉ trừ xu khi tạo thành công.',
            '',
            '*Panel chỉ dùng được bởi người đã mở lệnh.*'
        ].join('\n'))
        .setColor(0x00B0F4)
        .setFooter({ text: 'NIGARIA CLOUD • Reg System' });
    if (logos.VM) main.setThumbnail(logos.VM);

    const vsEmbed = new EmbedBuilder()
        .setTitle('VSPhone — Đăng ký')
        .setDescription(`• VSPhone thường — **${REG_COST} xu**${vsReady ? '' : ' (sắp có)'}`)
        .setColor(0x39F58A);
    if (logos.VS) vsEmbed.setThumbnail(logos.VS);

    const paidRow = new ActionRowBuilder().addComponents(
        regButton(`reg:vmos:${ownerId}`, `VMOS Cloud · ${REG_COST} xu`, ButtonStyle.Success, 'REG_EMOJI_VMOS', '🌐', false),
        regButton(`reg:vsphone:${ownerId}`, vsReady ? `VSPhone · ${REG_COST} xu` : 'VSPhone • Sắp có', vsReady ? ButtonStyle.Success : ButtonStyle.Secondary, 'REG_EMOJI_VSPHONE', '🥽', !vsReady)
    );
    const freeRow = new ActionRowBuilder().addComponents(
        regButton(`reg:vmos-free:${ownerId}`, 'VMOS Free · 0 xu', ButtonStyle.Secondary, 'REG_EMOJI_VMOS', '🌐', false),
        regButton(`reg:vsphone-free:${ownerId}`, vsReady ? 'VSPhone Free · 0 xu' : 'VSPhone Free • Sắp có', ButtonStyle.Secondary, 'REG_EMOJI_VSPHONE', '🥽', !vsReady)
    );
    return { embeds: [main, vsEmbed], components: [paidRow, freeRow] };
}

// Lưu tài khoản tạm vào KV để nút "Copy" gửi lại đúng nội dung (có thể thêm nút copy phụ).
async function sendAccountWithCopy(interaction, { header, copyText, lines, extraCopy = null, copyLabel = 'Copy acc|pass' }) {
    const save = async (text) => {
        const copyId = crypto.randomBytes(8).toString('hex');
        try {
            await db.setKv(`copyacc:${copyId}`, JSON.stringify({ text, exp: Date.now() + 24 * 60 * 60 * 1000 }));
        } catch (e) {
            console.error('[copy] không lưu được dữ liệu copy:', e.message);
        }
        return copyId;
    };
    const buttons = [];
    if (extraCopy && extraCopy.text) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`copy:${await save(extraCopy.text)}`)
            .setLabel(extraCopy.label || 'Copy email|pass')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋'));
    }
    buttons.push(new ButtonBuilder()
        .setCustomId(`copy:${await save(copyText)}`)
        .setLabel(copyLabel)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📋'));
    const row = new ActionRowBuilder().addComponents(...buttons);
    return interaction.editReply({ content: [`✅ ${header}`, ...lines].join('\n'), components: [row] });
}

/** Quà free hôm nay: VMOS hoặc VSPhone thường. Mỗi ngày phải vượt link lại, chỉ lấy 1 trong 2. */
async function claimFreeDeviceForUser(interaction, userId, type) {
    const today = getTodayString();
    const isVsphone = type === 'vsphone';
    const [vmosClaimed, vsphoneClaimed, linkCount] = await Promise.all([
        db.checkDailyLimit(userId, 'vmos_free', today),
        db.checkDailyLimit(userId, 'vsphone_free', today),
        todayFreeLinkCount(userId, today),
    ]);
    if (vmosClaimed > 0 || vsphoneClaimed > 0) {
        return interaction.editReply({ content: '⏰ Hôm nay bạn đã lấy quà free rồi (VMOS hoặc VSPhone). Quay lại sau 0h giờ VN nhé!' });
    }
    if (linkCount < 1) {
        return interaction.editReply({ content: '🔒 Bạn cần vượt ít nhất **1 link hôm nay** để mở quà free.' });
    }
    const result = isVsphone ? await services.regVsphoneAccount() : await services.regVmosAccount();
    await db.increaseDailyLimit(userId, isVsphone ? 'vsphone_free' : 'vmos_free', today);
    hook(isVsphone ? 'bot:device:vsphone-free' : 'bot:device:vmos-free', { userId, linkCount, date: today });
    const lines = [
        `📧 \`${result.account}\``,
        `🔑 \`${result.password}\``,
    ];
    if (isVsphone && result.token) lines.push(`🎫 token: \`${result.token}\``);
    if (isVsphone && result.userId) lines.push(`🆔 userid: \`${result.userId}\``);
    lines.push(`🔗 Đã vượt ${linkCount} link hôm nay.`);
    return await sendAccountWithCopy(interaction, {
        header: isVsphone ? '🎁 VSPhone thường free hôm nay' : '🎁 VMOS free hôm nay',
        copyText: result.copyText,
        lines,
    });
}

/** Dùng chung cho /vmosfree và nút VMOS Free trong /reg. */
async function claimVmosFreeForUser(interaction, userId) {
    return claimFreeDeviceForUser(interaction, userId, 'vmos');
}

/** Dùng chung cho /vsphonefree và nút VSPhone Free trong /reg. */
async function claimVsphoneFreeForUser(interaction, userId) {
    return claimFreeDeviceForUser(interaction, userId, 'vsphone');
}

async function regVmos(interaction, userId) {
    const currentCoins = await db.getCoins(userId);
    if (currentCoins < REG_COST) {
        return interaction.editReply({ content: `❌ Bạn không đủ xu (Cần ${REG_COST} xu). Số dư: **${currentCoins} xu**.` });
    }
    const result = await regVmosAccount();
    const newBalance = await db.updateCoins(userId, -REG_COST);
    return sendAccountWithCopy(interaction, {
        header: `Tạo VMOS thành công! (Đã trừ ${REG_COST} xu)`,
        copyText: result.copyText,
        lines: [
            `📧 \`${result.account}\``,
            `🔑 \`${result.password}\``,
            `💰 Số dư còn lại: **${newBalance} xu**`,
        ],
    });
}

async function regVsphone(interaction, userId) {
    if (!vsphoneReady()) {
        return interaction.editReply({ content: '❌ VSPhone chưa được cấu hình (thiếu VSPHONE_API_URL / VSPHONE_API_KEY).' });
    }
    const currentCoins = await db.getCoins(userId);
    if (currentCoins < REG_COST) {
        return interaction.editReply({ content: `❌ Bạn không đủ xu (Cần ${REG_COST} xu). Số dư: **${currentCoins} xu**.` });
    }
    const result = await regVsphoneAccount();
    const newBalance = await db.updateCoins(userId, -REG_COST);
    const lines = [
        `📧 \`${result.account}\``,
        `🔑 \`${result.password}\``,
    ];
    if (result.token) lines.push(`🎫 Token: \`${result.token}\``);
    if (result.userId) lines.push(`🆔 User ID: \`${result.userId}\``);
    lines.push(`💰 Số dư còn lại: **${newBalance} xu**`);
    return sendAccountWithCopy(interaction, {
        header: `Tạo VSPhone thành công! (Đã trừ ${REG_COST} xu)`,
        copyText: result.copyText,
        lines,
        extraCopy: result.account && result.password
            ? { text: `${result.account}|${result.password}`, label: 'Copy email|pass' }
            : null,
        copyLabel: 'Copy đầy đủ',
    });
}

// Xử lý nút Copy acc|pass
async function handleCopyButton(interaction) {
    const id = interaction.customId.split(':')[1];
    let data = null;
    try {
        const raw = await db.getKv(`copyacc:${id}`);
        if (raw) data = JSON.parse(raw);
    } catch (e) {
        console.error('[copy] lỗi đọc dữ liệu:', e.message);
    }
    if (!data || !data.text || (data.exp && data.exp < Date.now())) {
        return interaction.reply({ content: '❌ Dữ liệu copy đã hết hạn. Hãy tạo lại.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
        content: `📋 **Tài khoản của bạn** (bấm giữ / Ctrl+C để copy):\n\`\`\`\n${data.text}\n\`\`\``,
        flags: MessageFlags.Ephemeral,
    });
}

async function handleRegButton(interaction) {
    const [, service, ownerId] = interaction.customId.split(':');
    const userId = interaction.user.id;
    if (userId !== ownerId) {
        return interaction.reply({ content: '❌ Panel này không phải của bạn. Dùng `/reg` để mở panel riêng.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (busyUsers.has(userId)) {
        return interaction.editReply({ content: '⏳ Bạn đang có thao tác khác, thử lại sau giây lát.' });
    }
    busyUsers.add(userId);
    try {
        if (service === 'vmos-free') {
            await claimVmosFreeForUser(interaction, userId);
            return;
        }
        if (service === 'vsphone-free') {
            await claimVsphoneFreeForUser(interaction, userId);
            return;
        }
        if (service === 'vmos') await regVmos(interaction, userId);
        else if (service === 'vsphone') await regVsphone(interaction, userId);
        else await interaction.editReply({ content: '🚧 Dịch vụ này sắp có.' });
        const regCost = REG_COST;
        hook('bot:device:reg', { service, userId, cost: regCost });
    } catch (error) {
        console.error(`[reg:${service}] lỗi:`, error, error.cause);
        await interaction.editReply({ content: `❌ ${error.message}${error.cause ? ' - ' + (error.cause.code || error.cause.message) : ''} (Chưa bị trừ xu).` }).catch(() => {});
    } finally {
        busyUsers.delete(userId);
    }
}

client.on('interactionCreate', async interaction => {
    if (interaction.isModalSubmit() && interaction.customId.startsWith('buycloud:')) return handleBuycloudModal(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('reg:')) return handleRegButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('copy:')) return handleCopyButton(interaction);
    if (!interaction.isChatInputCommand()) return;
    const adminIds = getAdminIds();
    const userId = interaction.user.id;
    hook('bot:interaction', {
        id: interaction.id, command: interaction.commandName, userId,
        channelId: interaction.channelId, guildId: interaction.guildId,
    });

    // LỆNH /shop
    if (interaction.commandName === 'shop') {
        await interaction.deferReply();
        try {
            const items = (await db.getShopItems(true)).filter(i => i.active !== false);
            const base = (process.env.RENDER_DOMAIN || `http://localhost:${PORT}`).replace(/\/$/, '');
            if (!items.length) {
                return interaction.editReply({ content: `🛒 Shop hiện chưa có sản phẩm nào. Quay lại sau nhé!\n👉 Mở dashboard: ${base}` });
            }
            const embeds = items.slice(0, 10).map(item => {
                const e = new EmbedBuilder()
                    .setTitle(`${item.name} — ${Number(item.price).toLocaleString('en-US')} xu`)
                    .setDescription((item.description || 'Không có mô tả.').slice(0, 300))
                    .addFields({ name: '📦 Kho', value: `${Number(item.stock) || 0} sản phẩm`, inline: true });
                const logo = String(item.logo_url || '');
                if (/^https?:\/\//i.test(logo)) {
                    try { e.setThumbnail(logo); } catch (err) { /* logo không hợp lệ */ }
                }
                return e;
            });
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Mua trên Web').setStyle(ButtonStyle.Link).setURL(`${base}/#shop`).setEmoji('🛒')
            );
            return interaction.editReply({ embeds, components: [row] });
        } catch (error) {
            console.error('[shop] lỗi:', error);
            return interaction.editReply({ content: `❌ Lỗi tải shop: ${error.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /connect <token>
    if (interaction.commandName === 'connect') {
        const token = interaction.options.getString('token').trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (!/^[A-Za-z0-9]{64}$/.test(token)) {
                return interaction.editReply({ content: '❌ Token phải gồm đúng 64 ký tự chữ và số.' });
            }
            const webUser = await db.getWebUserByLinkToken(token);
            if (!webUser) return interaction.editReply({ content: '❌ Token không tồn tại. Hãy kiểm tra lại trong mục Hồ sơ trên web.' });
            if (webUser.discord_id && String(webUser.discord_id) !== userId) {
                return interaction.editReply({ content: '❌ Token này đã được liên kết với một tài khoản Discord khác.' });
            }
            const existingLink = await db.getWebUserByDiscordId(userId);
            if (existingLink && existingLink.id !== webUser.id) {
                return interaction.editReply({ content: '❌ Tài khoản Discord này đã liên kết với một tài khoản web khác.' });
            }
            if (String(webUser.discord_id) === userId) {
                return interaction.editReply({ content: `✅ Tài khoản web **${webUser.username}** đã liên kết với Discord này rồi.` });
            }

            // Gộp coin: coin web (web_<id>) + coin Discord -> coin Discord
            const webKey = `web_${webUser.id}`;
            const webBalance = await db.getCoins(webKey);
            let newBalance = await db.getCoins(userId);
            if (webBalance > 0) {
                newBalance = await db.updateCoins(userId, webBalance);
                await db.updateCoins(webKey, -webBalance);
            }
            await db.updateWebUser(webUser.id, { discord_id: userId });
            await saveDiscordProfile(interaction.user);

            // Gộp số link đã vượt của tài khoản web vào Discord trong kỳ hiện tại
            try {
                const period = await weekly.getLinkPeriod();
                await db.mergeLinkStats(`web_${webUser.id}`, userId, period);
            } catch (e) {
                console.error('[connect] không gộp được BXH vượt link:', e.message);
            }

            hook('bot:user:connected', {
                discordId: userId, webUserId: webUser.id,
                username: webUser.username, newBalance, mergedWebBalance: webBalance,
            });
            const adminNote = (await isAdmin(userId)) ? '\n🛡️ Bạn là **admin**, mục Quản trị đã mở trên web.' : '';
            return interaction.editReply({
                content: `✅ Liên kết thành công với tài khoản web **${webUser.username}**!\n💰 Coin đã đồng bộ: **${newBalance} xu**${adminNote}`
            });
        } catch (error) {
            console.error('[connect] lỗi:', error);
            return interaction.editReply({ content: `❌ Lỗi liên kết: ${error.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /token — lấy token web cố định (cùng link_token dùng cho /connect)
    if (interaction.commandName === 'token') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const user = await ensureWebUserForDiscord(userId, interaction.user);

            const sync = await db.getCoins(userId);
            const needRename = !/[A-Za-z]/.test(String(user.username || ''));
            hook('bot:user:token', {
                discordId: userId, webUserId: user.id,
                username: user.username, needsRename: needRename,
            });
            return interaction.editReply({
                content: [
                    '🔑 **Token đăng nhập web của bạn** (cố định, dùng cả cho `/connect`):',
                    `\`\`\`${user.link_token}\`\`\``,
                    `👤 Tài khoản web: **${user.username}**`,
                    `💰 Số dư Discord: **${sync} xu**`,
                    needRename ? '⚠️ Tên tài khoản hiện chỉ có số. Khi đăng nhập web bạn sẽ được yêu cầu đổi tên.' : '',
                    '🌐 Dán token ở tab **Token Discord** trên web để đăng nhập.',
                ].filter(Boolean).join('\n'),
            });
        } catch (error) {
            console.error('[token] lỗi:', error);
            return interaction.editReply({ content: `❌ Lỗi lấy token: ${error.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /plugin <ten>:<lenh> — gọi lệnh do plugin đăng ký
    if (interaction.commandName === 'plugin') {
        const raw = String(interaction.options.getString('lenh') || '').trim();
        const idx = raw.indexOf(':');
        const pluginName = idx === -1 ? raw : raw.slice(0, idx).trim();
        const commandName = idx === -1 ? raw : raw.slice(idx + 1).trim();
        if (!pluginName || !commandName) {
            return interaction.reply({ content: '❌ Dùng định dạng `/plugin tên:lệnh`, ví dụ `/plugin hello:ping`.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const cmd = pluginEngine.getCommand(commandName, pluginName);
            if (!cmd) {
                const available = pluginEngine.list()
                    .map(p => `${p.name}: ${p.commands.map(c => c.name).join(', ') || '(không có lệnh)'}`)
                    .join('\n') || '(chưa có plugin nào)';
                return interaction.editReply({ content: `❌ Không tìm thấy lệnh \`${commandName}\` trong plugin \`${pluginName}\`.\n\nLệnh có sẵn:\n${available}`.slice(0, 1900) });
            }
            hook('bot:plugin:command', {
                pluginId: cmd.pluginId, pluginName, commandName, userId,
            });
            await cmd.execute({ interaction, db, api: pluginEngine.apiFor(cmd.pluginId) });
            hook('bot:plugin:executed', {
                pluginId: cmd.pluginId, pluginName, commandName, userId,
            });
        } catch (error) {
            console.error(`[plugin:${commandName}] lỗi:`, error);
            const msg = `❌ Lỗi plugin: ${error.message}`.slice(0, 1900);
            if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg }).catch(() => {});
            else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
    }

    // LỆNH /getlink
    if (interaction.commandName === 'getlink') {
        const provider = linkProviders.get(interaction.options.getString('provider') || 'link4m');
        if (!provider) {
            return interaction.reply({ content: '❌ Dịch vụ không hợp lệ.', flags: MessageFlags.Ephemeral });
        }
        const today = getTodayString();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const currentCount = await db.checkDailyLimit(userId, provider.id, today);
            if (currentCount >= provider.dailyMax) {
                return await interaction.editReply({ content: `❌ Bạn đã đạt giới hạn **${provider.dailyMax} lần/ngày** cho dịch vụ này.` });
            }

            const sessionId = crypto.randomBytes(16).toString('hex');
            await db.createSession(sessionId, userId, provider.id);
            const base = (process.env.RENDER_DOMAIN || `http://localhost:${PORT}`).replace(/\/$/, '');
            const targetUrl = `${base}/redeem?sid=${sessionId}`;

            // Link từ Discord chưa có trình duyệt gốc: lưu theme setting, để trang redeem gán trình duyệt lần đầu mở.
            let botTheme = 'bubble';
            try {
                const webUser = await db.getWebUserByDiscordId(userId);
                if (webUser && (await db.getKv(`theme:${webUser.id}`)) === 'classic') botTheme = 'classic';
            } catch (e) { /* giữ bubble mặc định */ }
            await db.setKv(`redeem_meta:${sessionId}`, JSON.stringify({ browserId: null, theme: botTheme, webUrl: base }));

            let finalUrl;
            try {
                finalUrl = await linkProviders.shorten(provider.id, targetUrl);
            } catch (e) {
                await db.getAndDeleteSession(sessionId).catch(() => {});
                await db.setKv(`redeem_meta:${sessionId}`, '').catch(() => {});
                throw e;
            }

            await db.increaseDailyLimit(userId, provider.id, today);
            hook('bot:link:start', {
                userId, provider: provider.id, providerName: provider.name,
                reward: provider.reward, dailyMax: provider.dailyMax,
                sid: sessionId, targetUrl, finalUrl,
            });

            const embed = new EmbedBuilder()
                .setColor(provider.color)
                .setTitle(`🔗 LINK NHẬN XU (${provider.name})`)
                .setDescription(`Bấm vào link để vượt nhiệm vụ và nhận **${provider.reward} xu**.\nBạn còn **${provider.dailyMax - currentCount - 1}** lượt cho hôm nay.`)
                .addFields({ name: 'Link nhiệm vụ', value: finalUrl });
            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            await interaction.editReply({ content: `❌ ${e.message}` });
        }
    }

    // LỆNH /tasks — tiến độ từng provider (đồng bộ GET /api/tasks)
    if (interaction.commandName === 'tasks') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const today = getTodayString();
            const providers = Object.values(linkProviders.PROVIDERS);
            const counts = await Promise.all(providers.map(p => db.checkDailyLimit(userId, p.id, today)));
            const lines = providers.map((p, i) => {
                const used = Number(counts[i]) || 0;
                return `${p.name}: **${used}/${p.dailyMax}** · +${p.reward} xu/lần · còn ${Math.max(0, p.dailyMax - used)} lượt`;
            });
            const embed = new EmbedBuilder()
                .setColor(0x39f58a)
                .setTitle('📊 Nhiệm vụ vượt link hôm nay')
                .setDescription(`Ngày ${today}\n${lines.join('\n')}`)
                .setFooter({ text: 'Dùng /getlink để lấy link nhiệm vụ.' });
            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            return interaction.editReply({ content: `❌ Lỗi tải tiến độ: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /vmosfree — đồng bộ POST /api/device/vmos-free
    if (interaction.commandName === 'vmosfree') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId)) {
            return interaction.editReply({ content: '⏳ Bạn đang có thao tác khác, thử lại sau giây lát.' });
        }
        busyUsers.add(userId);
        try {
            return await claimVmosFreeForUser(interaction, userId);
        } catch (e) {
            console.error('[vmosfree] lỗi:', e);
            return interaction.editReply({ content: `❌ ${e.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(userId);
        }
    }

    // LỆNH /vsphonefree — VSPhone thường, đồng bộ POST /api/device/vsphone-free
    if (interaction.commandName === 'vsphonefree') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId)) {
            return interaction.editReply({ content: '⏳ Bạn đang có thao tác khác, thử lại sau giây lát.' });
        }
        busyUsers.add(userId);
        try {
            return await claimVsphoneFreeForUser(interaction, userId);
        } catch (e) {
            console.error('[vsphonefree] lỗi:', e);
            return interaction.editReply({ content: `❌ ${e.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(userId);
        }
    }

    // LỆNH /theme — đồng bộ POST /api/profile/theme
    if (interaction.commandName === 'theme') {
        const theme = String(interaction.options.getString('kieu') || '').toLowerCase();
        if (!['bubble', 'classic'].includes(theme)) {
            return interaction.reply({ content: '❌ Theme không hợp lệ.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const webUser = await ensureWebUserForDiscord(userId, interaction.user);
            await db.setKv(`theme:${webUser.id}`, theme);
            hook('bot:profile:theme', { userId, webUserId: webUser.id, theme });
            return interaction.editReply({ content: theme === 'bubble' ? '🫧 Đã dùng **Bubble Interface** trên web.' : '🪟 Đã dùng giao diện **Classic** trên web.' });
        } catch (e) {
            return interaction.editReply({ content: `❌ Lỗi đổi giao diện: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /username — đồng bộ POST /api/profile/username
    if (interaction.commandName === 'username') {
        const name = String(interaction.options.getString('ten_moi') || '').trim();
        if (!/^[a-zA-Z0-9_]{3,24}$/.test(name) || !/[A-Za-z]/.test(name)) {
            return interaction.reply({ content: '❌ Tên mới phải 3-24 ký tự, chỉ dùng chữ cái, số, gạch dưới và có ít nhất 1 chữ cái.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const webUser = await ensureWebUserForDiscord(userId, interaction.user);
            const exists = await db.getWebUserByUsername(name);
            if (exists && String(exists.id) !== String(webUser.id)) {
                return interaction.editReply({ content: '❌ Tên này đã được người khác dùng.' });
            }
            await db.updateWebUser(webUser.id, { username: name, username_lower: name.toLowerCase() });
            hook('bot:profile:username', { userId, webUserId: webUser.id, username: name });
            return interaction.editReply({ content: `✅ Đã đổi tên tài khoản web thành **${name}**.` });
        } catch (e) {
            return interaction.editReply({ content: `❌ Lỗi đổi tên: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /history — đồng bộ GET /api/purchases + GET /api/transfers
    if (interaction.commandName === 'history') {
        const type = interaction.options.getString('loai');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const webUser = await ensureWebUserForDiscord(userId, interaction.user);
            if (type === 'chuyen') {
                const list = await db.getTransfersByUser(webUser.id, 10);
                if (!list.length) return interaction.editReply({ content: '📭 Chưa có lịch sử chuyển xu nào.' });
                const lines = list.map(t => `• ${Number(t.amount) || 0} xu → ${t.to_label || '?'} (phí ${Number(t.fee) || 0}) · ${String(t.created_at || '').slice(0, 10)}`);
                return interaction.editReply({ content: `💸 **Lịch sử chuyển xu**\n${lines.join('\n')}`.slice(0, 1900) });
            }
            const list = await db.getPurchasesByUser(webUser.id, 10);
            if (!list.length) return interaction.editReply({ content: '📭 Chưa có lịch sử mua hàng nào.' });
            const lines = list.map(p => `• ${p.item_name || '?'} ×${Number(p.quantity) || 1} — ${Number(p.total_price) || 0} xu · ${String(p.created_at || '').slice(0, 10)}`);
            return interaction.editReply({ content: `🛒 **Lịch sử mua hàng**\n${lines.join('\n')}`.slice(0, 1900) });
        } catch (e) {
            return interaction.editReply({ content: `❌ Lỗi tải lịch sử: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /buy — đồng bộ POST /api/shop/buy
    if (interaction.commandName === 'buy') {
        const itemId = String(interaction.options.getString('item_id') || '');
        const quantity = interaction.options.getInteger('soluong') || 1;
        if (quantity < 1 || quantity > 10) {
            return interaction.reply({ content: '❌ Số lượng từ 1-10.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId)) {
            return interaction.editReply({ content: '⏳ Bạn đang có thao tác khác, thử lại sau giây lát.' });
        }
        busyUsers.add(userId);
        try {
            const item = await db.getShopItem(itemId);
            if (!item || item.active === false) return interaction.editReply({ content: '❌ Sản phẩm không tồn tại.' });
            if (Number(item.stock) < quantity) return interaction.editReply({ content: `❌ Kho chỉ còn ${item.stock} sản phẩm.` });

            const total = Number(item.price) * quantity;
            const balance = await db.getCoins(userId);
            if (balance < total) {
                return interaction.editReply({ content: `❌ Bạn không đủ xu (cần **${total}**). Số dư: **${balance} xu**.` });
            }

            let taken;
            try {
                taken = await shop.takeStock(item, quantity);
            } catch (e) {
                return interaction.editReply({ content: `❌ ${e.message}`.slice(0, 1900) });
            }
            const newBalance = await db.updateCoins(userId, -total);
            try {
                await shop.persistStock(item, taken.stockFields);
                const webUser = await ensureWebUserForDiscord(userId, interaction.user);
                await db.createPurchase({
                    id: randomId(),
                    web_user_id: webUser.id,
                    item_id: item.id,
                    item_name: item.name,
                    quantity,
                    unit_price: Number(item.price),
                    total_price: total,
                    accounts: taken.accounts.join('\n'),
                });
            } catch (e) {
                await db.updateCoins(userId, total).catch(() => {});
                await shop.restoreStock(item, taken.accounts);
                throw e;
            }
            hook('bot:shop:purchase', {
                userId, itemId: item.id, itemName: item.name,
                quantity, total, remaining: taken.remaining, newBalance,
            });
            return await sendAccountWithCopy(interaction, {
                header: `Mua ${item.name} thành công!`,
                copyText: taken.accounts.join('\n'),
                lines: [
                    `📦 Số lượng: **${quantity}** · Kho còn: **${taken.remaining}**`,
                    `💰 Đã trừ: **${total} xu** · Số dư: **${newBalance} xu**`,
                ],
            });
        } catch (e) {
            console.error('[buy] lỗi:', e);
            return interaction.editReply({ content: `❌ Lỗi khi mua: ${e.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(userId);
        }
    }

    // LỆNH /leaderboard — đồng bộ 4 API bảng xếp hạng của web
    if (interaction.commandName === 'leaderboard') {
        const type = interaction.options.getString('loai');
        await interaction.deferReply();
        try {
            let rows = [];
            let title = '🏆 Bảng xếp hạng';
            if (type === 'week' || type === 'all') {
                const period = type === 'week' ? await weekly.getLinkPeriod() : null;
                rows = type === 'week'
                    ? await db.getLinkLeaderboard(period, 10)
                    : await db.getAllTimeLinkLeaderboard(10);
                title = type === 'week' ? `🔗 Vượt link 7 ngày — ${period}` : '🏅 Vượt link tổng';
            } else {
                rows = await db.getTopCoins(10);
                title = '💰 Bảng xếp hạng xu';
            }
            const lines = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const key = String(row.user_id || row.user || '');
                const valueKey = type === 'coins' ? 'balance' : 'count';
                let name = key.startsWith('web_') ? key : `<@${key}>`;
                if (key.startsWith('web_')) {
                    const u = await db.getWebUserById(key.slice(4));
                    if (u && u.username) name = u.username;
                }
                const value = Number(row[valueKey]) || Number(row.balance) || Number(row.count) || 0;
                lines.push(`${i + 1}. **${name}** — ${value}${type === 'coins' ? ' xu' : ' link'}`);
            }
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0x39f58a).setTitle(title).setDescription(lines.join('\n') || 'Chưa có dữ liệu.')],
            });
        } catch (e) {
            return interaction.editReply({ content: `❌ Lỗi tải bảng xếp hạng: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH ADMIN /wallpaper — đổi ảnh nền web
    if (interaction.commandName === 'wallpaper') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const reset = interaction.options.getBoolean('xoa') === true;
            const url = reset ? '' : String(interaction.options.getString('url') || '').trim();
            if (!reset && url && !/^https?:\/\//i.test(url)) {
                return interaction.editReply({ content: '❌ URL ảnh phải bắt đầu bằng http:// hoặc https://' });
            }
            if (interaction.options.getString('url') === null && !reset) {
                const current = await db.getKv('admin_background_url');
                return interaction.editReply({ content: `🖼️ Ảnh nền hiện tại: ${current || '(mặc định)'}` });
            }
            await db.setKv('admin_background_url', url);
            hook('bot:admin:background', { url, by: userId });
            return interaction.editReply({ content: url ? `✅ Đổi ảnh nền web thành \`${url}\`.` : '✅ Đặt lại ảnh nền mặc định.' });
        } catch (e) {
            return interaction.editReply({ content: `❌ Lỗi cài đặt: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /vi
    if (interaction.commandName === 'vi') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const coins = await db.getCoins(userId);
            await interaction.editReply({ content: `💰 Số dư của bạn: **${coins} xu**` });
        } catch (error) {
            await interaction.editReply({ content: `❌ Lỗi khi lấy số dư.` });
        }
    }

    // LỆNH /code
    if (interaction.commandName === 'code') {
        const giftCode = interaction.options.getString('gift_code').trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const amount = await db.redeemGiftCode(giftCode);
            if (!amount) return await interaction.editReply({ content: `❌ Gift Code không hợp lệ hoặc đã được sử dụng.` });

            const newBalance = await db.updateCoins(userId, amount);
            hook('bot:giftcode', { userId, code: giftCode, amount, newBalance });
            await interaction.editReply({ content: `✅ Nhập code thành công! Bạn nhận được **${amount} xu**.\n💰 Số dư mới: **${newBalance} xu**` });
        } catch (error) {
            await interaction.editReply({ content: `❌ Lỗi khi nhập code.` });
        }
    }

    // LỆNH /reg - mở panel chọn dịch vụ
    if (interaction.commandName === 'reg') {
        hook('bot:device:reg:panel', { userId });
        return interaction.reply({ ...buildRegPanel(userId), flags: MessageFlags.Ephemeral });
    }

    // LỆNH /buycloud (mở bảng nhập dữ liệu)
    if (interaction.commandName === 'buycloud') {
        const cloudId = interaction.options.getString('provider');
        const server = interaction.options.getString('server');
        if (cloudId === 'UG' && !server) {
            return interaction.reply({ content: '❌ UGPhone cần chọn thêm **server** (khu vực).', flags: MessageFlags.Ephemeral });
        }
        const isUG = cloudId === 'UG';
        const isVS = cloudId === 'VS';
        const usesLocalStorage = isUG || isVS;
        const input = new TextInputBuilder()
            .setCustomId('input_data')
            .setLabel(usesLocalStorage ? `Local Storage (cookie) của ${CLOUD_NAMES[cloudId]}` : 'Tài khoản|Mật khẩu')
            .setStyle(usesLocalStorage ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setPlaceholder(usesLocalStorage ? 'Dán chuỗi Local Storage vào đây' : 'mail|matkhau hoặc user|matkhau')
            .setRequired(true)
            .setMaxLength(4000);
        const modal = new ModalBuilder()
            .setCustomId(`buycloud:${cloudId}:${usesLocalStorage ? (server || '-') : '-'}`)
            .setTitle(`Mua ${CLOUD_NAMES[cloudId]}${usesLocalStorage && server ? ' - ' + server : ''}`)
            .addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    // LỆNH /daily
    if (interaction.commandName === 'daily') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId)) return interaction.editReply({ content: '⏳ Bạn đang có thao tác khác, thử lại sau giây lát.' });
        busyUsers.add(userId);
        try {
            const today = getTodayString();
            const claimed = await db.checkDailyLimit(userId, 'daily', today);
            if (claimed > 0) {
                return await interaction.editReply({ content: '⏰ Hôm nay bạn đã nhận quà rồi. Quay lại vào ngày mai (sau 0h giờ VN) nhé!' });
            }
            const reward = crypto.randomInt(1, 21); // 1-20
            await db.increaseDailyLimit(userId, 'daily', today); // đánh dấu đã nhận trước để chống nhận 2 lần
            const newBalance = await db.updateCoins(userId, reward);
            hook('bot:daily:claim', { userId, reward, newBalance, date: today });
            await interaction.editReply({ content: `🎁 Quà hàng ngày: bạn nhận được **${reward} xu**!\n💰 Số dư: **${newBalance} xu**` });
        } catch (error) {
            console.error('[daily] lỗi:', error);
            await interaction.editReply({ content: '❌ Lỗi khi nhận quà hàng ngày.' });
        } finally {
            busyUsers.delete(userId);
        }
    }

    // LỆNH /pay (phí 5%, người gửi bị trừ đủ số xu, người nhận được số xu sau khi trừ phí)
    if (interaction.commandName === 'pay') {
        const target = interaction.options.getUser('nguoinhan');
        const amount = interaction.options.getInteger('sotien');
        if (target.bot) return interaction.reply({ content: '❌ Không thể chuyển xu cho bot.', flags: MessageFlags.Ephemeral });
        if (target.id === userId) return interaction.reply({ content: '❌ Bạn không thể tự chuyển xu cho chính mình.', flags: MessageFlags.Ephemeral });
        if (amount < PAY_MIN) return interaction.reply({ content: `❌ Số xu tối thiểu mỗi lần chuyển là **${PAY_MIN}**.`, flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId) || busyUsers.has(target.id)) {
            return interaction.editReply({ content: '⏳ Một trong hai người đang có giao dịch khác, thử lại sau giây lát.' });
        }
        busyUsers.add(userId); busyUsers.add(target.id);
        try {
            const balance = await db.getCoins(userId);
            if (balance < amount) {
                return await interaction.editReply({ content: `❌ Bạn không đủ xu. Số dư: **${balance} xu**.` });
            }
            const fee = Math.ceil(amount * PAY_FEE_RATE);
            const received = amount - fee;
            const newBalance = await db.updateCoins(userId, -amount);
            try {
                await db.updateCoins(target.id, received);
            } catch (e) {
                await db.updateCoins(userId, amount).catch(() => {}); // hoàn xu nếu cộng cho người nhận thất bại
                throw e;
            }
            // Lưu lịch sử để /history và web /api/transfers cùng thấy (best-effort).
            try {
                const senderWeb = await ensureWebUserForDiscord(userId, interaction.user);
                await db.createTransfer({
                    id: randomId(),
                    from_user_id: senderWeb.id,
                    from_label: interaction.user.username || userId,
                    to_label: target.username || target.id,
                    to_balance_key: target.id,
                    amount,
                    fee,
                });
            } catch (e) {
                console.error('[pay] không lưu được lịch sử chuyển xu:', e.message);
            }
            hook('bot:transfer', { from: userId, to: target.id, amount, fee, received, newBalance });
            await interaction.editReply({ content: `✅ Đã chuyển **${amount} xu** (phí ${fee} xu).\n💰 Số dư còn lại: **${newBalance} xu**` });
            await interaction.followUp({ content: `💸 <@${userId}> đã chuyển cho <@${target.id}> **${received} xu** (phí 5%: ${fee} xu).` }).catch(() => {});
        } catch (error) {
            console.error('[pay] lỗi:', error);
            await interaction.editReply({ content: '❌ Lỗi khi chuyển xu, giao dịch đã được hủy.' });
        } finally {
            busyUsers.delete(userId); busyUsers.delete(target.id);
        }
    }

    // LỆNH /op và /unop (chỉ Owner trong ADMIN_DISCORD_ID)
    if (interaction.commandName === 'op' || interaction.commandName === 'unop') {
        if (!adminIds.includes(userId)) {
            return interaction.reply({ content: '❌ Chỉ Owner mới dùng được lệnh này.', flags: MessageFlags.Ephemeral });
        }
        const pickedUser = interaction.options.getUser('user');
        const targetId = pickedUser ? pickedUser.id : (interaction.options.getString('id') || '').trim();
        if (!/^\d{15,25}$/.test(targetId)) {
            return interaction.reply({ content: '❌ Hãy chọn user hoặc nhập ID Discord hợp lệ (chỉ gồm số).', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (adminIds.includes(targetId)) {
                return await interaction.editReply({ content: `❗ <@${targetId}> là Owner (cấu hình ở ADMIN_DISCORD_ID), không đổi được bằng lệnh này.` });
            }
            const already = await db.isAdmin(targetId);
            if (interaction.commandName === 'op') {
                if (already) return await interaction.editReply({ content: `❗ <@${targetId}> đã là admin rồi.` });
                await db.addAdmin(targetId, userId);
                await interaction.editReply({ content: `✅ Đã cấp quyền admin cho <@${targetId}>.` });
            } else {
                if (!already) return await interaction.editReply({ content: `❗ <@${targetId}> không phải admin.` });
                await db.removeAdmin(targetId);
                await interaction.editReply({ content: `✅ Đã thu hồi quyền admin của <@${targetId}>.` });
            }
        } catch (error) {
            console.error('[op/unop] lỗi:', error);
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /star - nhận nhiệm vụ đăng ký kênh YouTube
    if (interaction.commandName === 'star') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const today = getTodayString();
            const done = await db.checkDailyLimit(userId, 'star', today);
            if (done >= STAR_DAILY_MAX) {
                return await interaction.editReply({ content: `⏰ Hôm nay bạn đã hoàn thành tối đa **${STAR_DAILY_MAX} nhiệm vụ** rồi. Quay lại vào ngày mai nhé!` });
            }
            if (pendingStarUsers.has(userId)) {
                return await interaction.editReply({ content: '⏳ Bạn đang có nhiệm vụ chờ duyệt. Hãy đợi admin xác nhận trước khi nhận thêm.' });
            }
            const ytbUrl = process.env.YTB_CHANNEL_URL || 'https://youtube.com';
            pendingStarUsers.add(userId);
            await interaction.editReply({
                content: [
                    `📋 **NHIỆM VỤ: Đăng ký kênh YouTube**`,
                    ``,
                    `**Bước 1:** Truy cập kênh YouTube: ${ytbUrl}`,
                    `**Bước 2:** Bấm nút **Đăng ký** (Subscribe) 🔔`,
                    `**Bước 3:** Chụp màn hình xác nhận đã đăng ký`,
                    `**Bước 4:** Gửi ảnh chụp vào kênh **#${process.env.STAR_CHANNEL_NAME || 'star'}** để admin duyệt`,
                    ``,
                    `💰 Phần thưởng: **${STAR_REWARD} xu** sau khi admin xác nhận`,
                    `📆 Hạn mức: **${STAR_DAILY_MAX - done} lần** còn lại hôm nay`,
                    ``,
                    `⚠️ **Cảnh báo:** Gian lận (ảnh fake/chỉnh sửa) sẽ bị **trừ 20 xu** và hủy nhiệm vụ.`,
                ].join('\n')
            });
        } catch (error) {
            console.error('[star] lỗi:', error);
            pendingStarUsers.delete(userId);
            await interaction.editReply({ content: '❌ Lỗi khi nhận nhiệm vụ.' });
        }
    }

    // LỆNH /sdone - admin xác nhận hoàn thành nhiệm vụ /star
    if (interaction.commandName === 'sdone') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        const pickedUser = interaction.options.getUser('user');
        const targetId = pickedUser ? pickedUser.id : (interaction.options.getString('id') || '').trim();
        if (!/^\d{15,25}$/.test(targetId)) {
            return interaction.reply({ content: '❌ Hãy chọn user hoặc nhập ID Discord hợp lệ.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(targetId)) {
            return interaction.editReply({ content: '⏳ Người này đang có giao dịch khác, thử lại sau giây lát.' });
        }
        busyUsers.add(targetId);
        try {
            if (!pendingStarUsers.has(targetId)) {
                return await interaction.editReply({ content: `❗ <@${targetId}> không có nhiệm vụ nào đang chờ duyệt.` });
            }
            const today = getTodayString();
            const done = await db.checkDailyLimit(targetId, 'star', today);
            if (done >= STAR_DAILY_MAX) {
                pendingStarUsers.delete(targetId);
                return await interaction.editReply({ content: `❗ <@${targetId}> đã đạt giới hạn **${STAR_DAILY_MAX} nhiệm vụ** hôm nay.` });
            }
            await db.increaseDailyLimit(targetId, 'star', today);
            const newBalance = await db.updateCoins(targetId, STAR_REWARD);
            pendingStarUsers.delete(targetId);
            console.log(`[sdone] ${userId} duyệt ${targetId} (+${STAR_REWARD} xu, hôm nay: ${done + 1}/${STAR_DAILY_MAX})`);
            await interaction.editReply({ content: `✅ Đã xác nhận nhiệm vụ cho <@${targetId}>. Cộng **${STAR_REWARD} xu**. (Hôm nay: ${done + 1}/${STAR_DAILY_MAX})` });
            await interaction.followUp({
                content: `🎉 <@${targetId}> đã hoàn thành nhiệm vụ đăng ký kênh YouTube! Nhận **${STAR_REWARD} xu**. 💰 Số dư: **${newBalance} xu**`
            }).catch(() => {});
        } catch (error) {
            console.error('[sdone] lỗi:', error);
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(targetId);
        }
    }

    // LỆNH /adcoin <set|cong|tru> <số> (Admin)
    if (interaction.commandName === 'adcoin') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        const action = interaction.options.getString('hanhdong');
        const amount = interaction.options.getInteger('sotien');
        const currency = interaction.options.getString('loai') || 'coin';
        if (!['coin', 'acoin'].includes(currency)) {
            return interaction.reply({ content: '❌ Loại tiền không hợp lệ.', flags: MessageFlags.Ephemeral });
        }
        const unit = currency === 'acoin' ? 'ACOIN' : 'xu';
        const pickedUser = interaction.options.getUser('user');
        const targetId = pickedUser ? pickedUser.id : (interaction.options.getString('id') || '').trim();
        if (!/^\d{15,25}$/.test(targetId)) {
            return interaction.reply({ content: '❌ Hãy chọn user hoặc nhập ID Discord hợp lệ (chỉ gồm số).', flags: MessageFlags.Ephemeral });
        }
        if (action !== 'set' && amount < 1) {
            return interaction.reply({ content: `❌ Số ${unit} phải lớn hơn 0.`, flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(targetId)) {
            return interaction.editReply({ content: '⏳ Người này đang có giao dịch khác, thử lại sau giây lát.' });
        }
        busyUsers.add(targetId);
        try {
            const current = currency === 'acoin' ? await readAcoinSafe(targetId) : await db.getCoins(targetId);
            let delta;
            if (action === 'set') delta = amount - current;
            else if (action === 'cong') delta = amount;
            else delta = -Math.min(amount, current); // trừ không xuống dưới 0
            if (delta !== 0) {
                if (currency === 'acoin') await adjustAcoin(targetId, delta);
                else await db.updateCoins(targetId, delta);
            }
            // Đọc lại sau khi ghi để số báo ra luôn khớp số dư thực tế.
            const newBalance = currency === 'acoin' ? await readAcoinSafe(targetId) : await db.getCoins(targetId);
            console.log(`[ADMIN] ${userId} ${action} ${amount} ${unit} -> ${targetId} (${current} => ${newBalance})`);
            const verb = action === 'set' ? 'Đặt' : (action === 'cong' ? 'Cộng' : 'Trừ');
            await interaction.editReply({ content: `✅ ${verb} **${action === 'set' ? amount : Math.abs(delta)} ${unit}** cho <@${targetId}>.\n💰 Số dư: **${current} → ${newBalance} ${unit}**` });
        } catch (error) {
            console.error('[adcoin] lỗi:', error);
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(targetId);
        }
    }

    // LỆNH /gen
    if (interaction.commandName === 'gen') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        const count = interaction.options.getInteger('soluong');
        const coinAmount = interaction.options.getInteger('xuthuong');

        if (count <= 0 || count > 50 || coinAmount <= 0) {
            return interaction.reply({ content: '❌ Số lượng từ 1-50, số xu > 0.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const giftCodes = [];
            for (let i = 0; i < count; i++) {
                const code = generateGiftCode();
                giftCodes.push(`${code} (${coinAmount} xu)`);
                await db.createGiftCode(code, coinAmount);
            }
            await interaction.editReply({
                content: `✅ Đã tạo **${count}** Gift Code (Mỗi code ${coinAmount} xu):`,
                files: [{ attachment: Buffer.from(giftCodes.join('\n')), name: `giftcodes_${count}.txt` }]
            });
        } catch (error) {
            console.error('[gen] lỗi:', error, error.cause);
            await interaction.editReply({ content: `❌ Lỗi tạo code: ${error.message}${error.cause ? ' - ' + (error.cause.code || error.cause.message) : ''}`.slice(0, 1800) });
        }
    }

    // LỆNH /clear
    if (interaction.commandName === 'clear') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '❌ Không có quyền.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const channel = interaction.channel;
            const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
            const messages = await channel.messages.fetch({ limit: 100 });
            const messagesToDelete = messages.filter(msg => msg.author.id === client.user.id && msg.createdTimestamp < twoHoursAgo);

            if (messagesToDelete.size === 0) {
                return await interaction.editReply({ content: 'ℹ️ Không có tin nhắn nào của Bot cũ hơn 2 giờ.' });
            }
            await channel.bulkDelete(messagesToDelete, true);
            await interaction.editReply({ content: `✅ Đã xóa **${messagesToDelete.size}** tin nhắn.` });
        } catch (error) {
            await interaction.editReply({ content: `❌ Lỗi: ${error.message}` });
        }
    }

    // LỆNH /seller — gửi yêu cầu / admin duyệt / danh sách seller
    if (interaction.commandName === 'seller') {
        const action = String(interaction.options.getString('hanhdong') || '').toLowerCase();
        if (!['request', 'trust', 'list'].includes(action)) {
            return interaction.reply({ content: '[FAIL] Hanh dong khong hop le.', flags: MessageFlags.Ephemeral });
        }
        if (action !== 'request' && !(await isAdmin(userId))) {
            return interaction.reply({ content: '[FAIL] Chi admin duoc dung hanh dong nay.', flags: MessageFlags.Ephemeral });
        }
        let targetId = null;
        if (action === 'trust') {
            const picked = interaction.options.getUser('user');
            targetId = picked ? picked.id : String(interaction.options.getString('id') || '').trim();
            if (!/^\d{15,25}$/.test(targetId)) {
                return interaction.reply({ content: '[FAIL] Chon user hoac nhap ID Discord hop le.', flags: MessageFlags.Ephemeral });
            }
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId) || (targetId && busyUsers.has(targetId))) {
            return interaction.editReply({ content: '[WAIT] Dang co thao tac khac, thu lai sau giay lat.' });
        }
        busyUsers.add(userId);
        if (targetId) busyUsers.add(targetId);
        try {
            if (action === 'request') {
                const res = await requestSellerSafe(userId);
                const ok = !res || res.ok !== false;
                const status = (res && (res.status || (res.seller && res.seller.status))) || 'pending';
                hook('bot:seller:request', { userId, ok, status });
                return interaction.editReply({ content: ok
                    ? `[OK] Da gui yeu cau lam seller. Trang thai: ${status}.`
                    : `[FAIL] ${String((res && (res.message || res.error)) || 'Khong gui duoc yeu cau.').slice(0, 300)}` });
            }
            if (action === 'trust') {
                const res = await approveSellerSafe(targetId, userId);
                const status = (res && (res.status || (res.seller && res.seller.status))) || 'active';
                hook('bot:seller:trust', { adminId: userId, targetId, ok: true, status, seller: (res && res.seller) || null });
                return interaction.editReply({ content: `[OK] Da duyet seller <@${targetId}>. Trang thai: ${status}.` });
            }
            const rows = await listSellersSafe();
            const lines = rows.slice(0, 20).map((row, i) => {
                const rawId = String(row.user_id || row.discord_id || row.discordId || row.id || '?');
                const label = /^\d{15,25}$/.test(rawId) ? `<@${rawId}>` : rawId;
                const status = String(row.status || 'pending');
                const name = row.name || row.shop_name || row.username;
                return `${i + 1}. [${status}] ${label}${name ? ' | ' + String(name).slice(0, 40) : ''}`;
            });
            const pending = rows.filter(r => String(r.status) === 'pending').length;
            const active = rows.filter(r => String(r.status) === 'active').length;
            const embed = new EmbedBuilder()
                .setColor(0x39f58a)
                .setTitle('[SELLER] Danh sach')
                .setDescription(lines.join('\n') || 'Chua co seller nao.')
                .addFields({ name: 'Tong hop', value: `pending: ${pending} | active: ${active} | tong: ${rows.length}` });
            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error('[seller] lỗi:', e);
            return interaction.editReply({ content: `[FAIL] Loi xu ly seller: ${e.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(userId);
            if (targetId) busyUsers.delete(targetId);
        }
    }

    // LỆNH /exchange — đổi coin <-> ACOIN (không cho số dư âm)
    if (interaction.commandName === 'exchange') {
        const loai = String(interaction.options.getString('loai') || '');
        const amount = interaction.options.getInteger('soluong');
        if (!['coin', 'acoin'].includes(loai) || !Number.isInteger(amount) || amount <= 0) {
            return interaction.reply({ content: '[FAIL] Chon loai va so luong > 0.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (busyUsers.has(userId)) {
            return interaction.editReply({ content: '[WAIT] Ban dang co thao tac khac, thu lai sau.' });
        }
        busyUsers.add(userId);
        try {
            const rate = await getExchangeRateSafe();
            if (loai === 'coin') {
                // Theo hợp đồng: đổi coin -> ACOIN nhận floor(amount / rate).
                const acoinGain = Math.floor(amount / rate);
                if (acoinGain < 1) {
                    return interaction.editReply({ content: `[FAIL] Can it nhat **${rate} coin** de doi 1 ACOIN (ty le hien tai: ${rate}:1).` });
                }
                const coinBefore = await db.getCoins(userId);
                if (coinBefore < amount) {
                    return interaction.editReply({ content: `[FAIL] Khong du coin. Can **${amount} coin** de doi ${acoinGain} ACOIN (ty le ${rate}:1). Hien co: **${coinBefore} coin**.` });
                }
                const newCoin = await db.updateCoins(userId, -amount);
                let newAcoin;
                try {
                    newAcoin = await adjustAcoin(userId, acoinGain);
                } catch (e) {
                    await db.updateCoins(userId, amount).catch(() => {}); // hoàn coin nếu cộng ACOIN thất bại
                    throw e;
                }
                hook('bot:exchange', { userId, from: 'coin', to: 'acoin', amount, rate, acoinGain, coinDelta: -amount, newCoin, newAcoin });
                return interaction.editReply({ content: `[OK] Da doi **${amount} coin** -> **${acoinGain} ACOIN**. Ty le: ${rate} coin = 1 ACOIN.\n> Coin: ${newCoin} | ACOIN: ${newAcoin}` });
            }
            const acoinBefore = await readAcoinSafe(userId);
            if (acoinBefore < amount) {
                return interaction.editReply({ content: `[FAIL] Khong du ACOIN. Can **${amount}**, hien co **${acoinBefore}**.` });
            }
            const coinGain = amount * rate;
            const newAcoin = await adjustAcoin(userId, -amount);
            let newCoin;
            try {
                newCoin = await db.updateCoins(userId, coinGain);
            } catch (e) {
                await adjustAcoin(userId, amount).catch(() => {}); // hoàn ACOIN nếu cộng coin thất bại
                throw e;
            }
            hook('bot:exchange', { userId, from: 'acoin', to: 'coin', amount, rate, coinGain, acoinDelta: -amount, coinDelta: coinGain, newCoin, newAcoin });
            return interaction.editReply({ content: `[OK] Da doi **${amount} ACOIN** -> **${coinGain} coin**. Ty le: ${rate} coin = 1 ACOIN.\n> Coin: ${newCoin} | ACOIN: ${newAcoin}` });
        } catch (e) {
            console.error('[exchange] lỗi:', e);
            return interaction.editReply({ content: `[FAIL] Loi doi: ${e.message}`.slice(0, 1900) });
        } finally {
            busyUsers.delete(userId);
        }
    }

    // LỆNH /acoin — số dư + tỷ giá
    if (interaction.commandName === 'acoin') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const [balance, rate] = await Promise.all([readAcoinSafe(userId), getExchangeRateSafe()]);
            return interaction.editReply({ content: [
                `[ACOIN] So du: **${balance} ACOIN**`,
                `> Ty le: **${rate} coin = 1 ACOIN** (10 coin = 2 ACOIN)`,
                `> Doi coin: /exchange coin ${rate} (nhan 1 ACOIN) | Doi ACOIN: /exchange acoin 1 (nhan ${rate} coin)`,
                '> Gia $100 = 100 ACOIN',
            ].join('\n') });
        } catch (e) {
            console.error('[acoin] lỗi:', e);
            return interaction.editReply({ content: `[FAIL] Loi doc so du: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /shops — tìm shop marketplace (tối đa 10)
    if (interaction.commandName === 'shops') {
        const q = String(interaction.options.getString('q') || '').replace(/[<>\n@`]/g, ' ').trim().slice(0, 80);
        const filter = String(interaction.options.getString('filter') || 'all');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            let shops = [];
            let page = 1, totalPages = 1, total = 0, source = 'marketplace';
            if (typeof marketplace.searchShops === 'function') {
                const res = await marketplace.searchShops({ q, filter, page: 1 });
                shops = (res && Array.isArray(res.shops)) ? res.shops : [];
                page = Number(res && res.page) || 1;
                totalPages = Number(res && res.totalPages) || Math.max(1, Math.ceil(shops.length / 10));
                total = Number(res && res.total) || shops.length;
            } else if (typeof db.getShopItems === 'function') {
                const items = await db.getShopItems(true);
                shops = (items || [])
                    .filter(i => !q || String(i.name || '').toLowerCase().includes(q.toLowerCase()))
                    .map(i => ({ id: i.id, name: i.name, rating: null, sales: null, price: i.price }));
                source = 'shop_items';
                total = shops.length;
                totalPages = Math.max(1, Math.ceil(total / 10));
            }
            const top = shops.slice(0, 10);
            if (!top.length) {
                return interaction.editReply({ content: `[SHOP] Khong tim thay shop${q ? ' cho "' + q + '"' : ''}.` });
            }
            const lines = top.map((s, i) => {
                const name = String(s.name || s.shop_name || s.id || '?').replace(/[<>\n@`]/g, ' ').slice(0, 60);
                const id = String(s.id || s.shop_id || '-').slice(0, 40);
                const rating = (s.rating === null || s.rating === undefined) ? '-' : Number(s.rating).toFixed(1);
                const sales = Number(s.sales || s.total_sales || 0);
                const price = (s.price === null || s.price === undefined) ? '' : ` | gia: ${s.price}`;
                return `${i + 1}. **${name}** | id: \`${id}\` | danh gia: ${rating} | ban: ${sales}${price}`;
            });
            const embed = new EmbedBuilder()
                .setColor(0x39f58a)
                .setTitle('[SHOP] Marketplace')
                .setDescription(lines.join('\n').slice(0, 4000))
                .setFooter({ text: `filter: ${filter} | Trang ${page}/${totalPages} | Tong: ${total} | nguon: ${source}` });
            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error('[shops] lỗi:', e);
            return interaction.editReply({ content: `[FAIL] Loi tim shop: ${e.message}`.slice(0, 1900) });
        }
    }

    // LỆNH /appeal — admin override review/complaint
    if (interaction.commandName === 'appeal') {
        if (!(await isAdmin(userId))) {
            return interaction.reply({ content: '[FAIL] Chi admin duoc dung lenh nay.', flags: MessageFlags.Ephemeral });
        }
        const type = String(interaction.options.getString('loai') || '');
        const id = String(interaction.options.getString('id') || '').trim();
        const approve = interaction.options.getBoolean('approve');
        const note = String(interaction.options.getString('note') || '').replace(/[<>\n@]/g, ' ').trim().slice(0, 500);
        if (!['review', 'complaint'].includes(type) || !id || typeof approve !== 'boolean') {
            return interaction.reply({ content: '[FAIL] Thieu loai, id hoac approve.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const decision = {
                status: approve ? 'approved' : 'rejected',
                approved: approve,
                note,
                decided_by: userId,
                decided_at: new Date().toISOString(),
            };
            const mpMethod = type === 'review' ? 'decideReview' : 'decideComplaint';
            const dbMethod = type === 'review' ? 'updateReview' : 'updateComplaint';
            let decidedVia = null;
            // Ưu tiên hàm dùng chung của marketplace (cùng luật với web).
            if (typeof marketplace[mpMethod] === 'function') {
                try {
                    const res = await marketplace[mpMethod](id, approve, note);
                    if (!res || res.ok !== false) decidedVia = 'marketplace';
                } catch (e) {
                    console.error(`[appeal] marketplace.${mpMethod} lỗi:`, e.message);
                }
            }
            if (!decidedVia && typeof db[dbMethod] === 'function') {
                try {
                    await db[dbMethod](id, decision);
                    decidedVia = 'db';
                } catch (e) {
                    console.error(`[appeal] ${dbMethod} lỗi:`, e.message);
                }
            }
            if (!decidedVia) {
                await db.setKv(`bot_appeal:${type}:${id}`, JSON.stringify(decision));
                decidedVia = 'kv';
            }
            hook('bot:appeal:decision', { adminId: userId, type, id, approve, note, decidedVia, updatedInDb: decidedVia === 'db' });
            return interaction.editReply({ content: `[OK] Da ${approve ? 'chap nhan' : 'tu choi'} ${type} \`${id}\`. Ghi chu: ${note || '-'}.${decidedVia === 'kv' ? ' (Da luu KV vi cac helper chua san sang)' : ''}` });
        } catch (e) {
            console.error('[appeal] lỗi:', e);
            return interaction.editReply({ content: `[FAIL] Loi xu ly appeal: ${e.message}`.slice(0, 1900) });
        }
    }
});

if (process.env.DISABLE_BOT === '1') {
    console.log('[BOT] DISABLE_BOT=1 — bỏ qua đăng nhập Discord (chỉ chạy web).');
} else {
    client.login(process.env.DISCORD_TOKEN);
}


// ==========================================
// AUTO REJOIN — tự reconnect khi bị disconnect
// ==========================================
client.on('disconnect', () => {
    console.warn('[BOT] Bị disconnect. Đang thử reconnect...');
});

client.on('shardDisconnect', (event, shardId) => {
    console.warn(`[BOT] Shard ${shardId} disconnect (code ${event.code}). Đang thử reconnect...`);
});

client.on('shardReconnecting', (shardId) => {
    console.log(`[BOT] Shard ${shardId} đang reconnect...`);
});

client.on('shardResume', (shardId, replayedEvents) => {
    console.log(`[BOT] Shard ${shardId} resume OK (${replayedEvents} events replayed).`);
});

client.on('error', (err) => {
    console.error('[BOT] Lỗi client:', err.message);
});

// fallback: nếu ws chết hoàn toàn thì destroy + login lại
async function safeRelogin(attempt = 1) {
    const MAX = 10;
    const delay = Math.min(5000 * attempt, 60000); // 5s, 10s, ... tối đa 60s
    console.log(`[BOT] Thử relogin lần ${attempt}/${MAX} sau ${delay / 1000}s...`);
    await new Promise(r => setTimeout(r, delay));
    try {
        await client.destroy();
        await client.login(process.env.DISCORD_TOKEN);
        console.log('[BOT] Relogin thành công.');
    } catch (err) {
        console.error(`[BOT] Relogin thất bại (lần ${attempt}):`, err.message);
        if (attempt < MAX) return safeRelogin(attempt + 1);
        console.error('[BOT] Hết lần thử, dừng relogin.');
    }
}

client.ws.on('INVALIDATED', () => {
    console.error('[BOT] Session bị invalidate — relogin...');
    safeRelogin();
});

// bắt unhandledRejection để bot không crash
process.on('unhandledRejection', (err) => {
    console.error('[BOT] unhandledRejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('[BOT] uncaughtException:', err?.message || err);
});
