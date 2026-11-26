/**
 * Web dashboard: API + phục vụ giao diện tĩnh.
 *
 * Đăng ký / đăng nhập tài khoản web riêng, liên kết Discord bằng token 64 ký tự,
 * shop (kho lưu trên GitHub Gist), mua device, nhiệm vụ vượt link, bảng xếp hạng,
 * chuyển coin, hồ sơ và trang admin.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const db = require('./database');
const services = require('./services');
const shop = require('./shop');
const github = require('./github');
const weekly = require('./weekly');
const pluginEngine = require('./plugin-engine');
const linkProviders = require('./link-providers');
const marketplace = require('./marketplace');
const gmailTasks = require('./gmail-tasks');
const { getTodayString, generateUniqueLinkToken, sha256, randomId, hashPassword, verifyPassword } = require('./utils');

const router = express.Router();
const COOKIE_NAME = 'nigaria_session';
const SESSION_DAYS = 30;
const PAY_MIN = 10;
const PAY_FEE_RATE = 0.05;
const REG_COST = services.REG_COST;
const busyUsers = new Set();
const lastActiveWrites = new Map();
const LAST_ACTIVE_TTL_MS = 60 * 1000;

// ==================== TIỆN ÍCH ====================
function ah(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Fire-and-forget hook cho plugin. emit() tự catch lỗi, không làm chậm request. */
function hook(event, payload = {}) {
    pluginEngine.emit(event, payload);
}

/** Tổng link user đã vượt trong ngày (cộng mọi provider), dùng cho quà free. */
async function todayLinkCount(key, today) {
    const ids = Object.keys(linkProviders.PROVIDERS);
    const counts = await Promise.all(ids.map(id => db.checkDailyLimit(key, id, today)));
    return counts.reduce((sum, count) => sum + (Number(count) || 0), 0);
}

/**
 * Quà free hôm nay: VMOS thường hoặc VSPhone thường (không phải VIP).
 * Mỗi ngày phải vượt lại ít nhất 1 link, và chỉ lấy được 1 trong 2.
 */
async function claimFreeDevice(key, today, type) {
    const [vmosClaimed, vsphoneClaimed, linkCount] = await Promise.all([
        db.checkDailyLimit(key, 'vmos_free', today),
        db.checkDailyLimit(key, 'vsphone_free', today),
        todayLinkCount(key, today),
    ]);
    if (vmosClaimed > 0 || vsphoneClaimed > 0) {
        throw new Error('Hôm nay bạn đã lấy quà free rồi (VMOS hoặc VSPhone). Quay lại sau 0h giờ VN nhé!');
    }
    if (linkCount < 1) {
        throw new Error('Bạn cần vượt ít nhất 1 link hôm nay để mở quà free.');
    }
    const result = type === 'vsphone' ? await services.regVsphoneAccount() : await services.regVmosAccount();
    await db.increaseDailyLimit(key, type === 'vsphone' ? 'vsphone_free' : 'vmos_free', today);
    return { result, linkCount };
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(val);
    }
    return out;
}

function envAdminIds() {
    return (process.env.ADMIN_DISCORD_ID || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** IP admin (tuỳ chọn) hoàn toàn không bị rate limit: ADMIN_IP_WHITELIST=1.2.3.4,5.6.7.8 */
function isWhitelistedAdminIp(req) {
    const list = (process.env.ADMIN_IP_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
    const ip = String(req.ip || '');
    const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
    return list.includes(ip) || (!!forwarded && list.includes(forwarded));
}

async function isDiscordAdmin(discordId) {
    if (!discordId) return false;
    if (envAdminIds().includes(String(discordId))) return true;
    try { return await db.isAdmin(discordId); } catch (e) { return false; }
}

async function isAdminUser(user) {
    if (!user) return false;
    return isDiscordAdmin(user.discord_id);
}

function balanceKey(user) {
    return user.discord_id ? String(user.discord_id) : `web_${user.id}`;
}

/** 1 device/browser chỉ gắn với 1 tài khoản. Admin được phép chiếm lại device đang test. */
async function bindDevice(req, res, userId, allowRebind = false) {
    const deviceId = String(req.body.deviceId || req.get('x-device-id') || '').trim();
    if (!deviceId || typeof db.getDeviceAccount !== 'function') return true;
    const existing = await db.getDeviceAccount(deviceId);
    if (existing && String(existing.user_id) !== String(userId)) {
        if (!allowRebind) {
            res.status(409).json({ error: 'Thiết bị này đã gắn với tài khoản khác. Hãy dùng tài khoản đó hoặc thiết bị khác.' });
            return false;
        }
        // Admin đăng nhập từ device đang gắn tài khoản test -> chuyển quyền sở hữu device.
        await db.bindDeviceAccount(deviceId, userId);
        return true;
    }
    if (!existing && typeof db.bindDeviceAccount === 'function') {
        await db.bindDeviceAccount(deviceId, userId);
    }
    return true;
}

// Nền mặc định cho toàn dashboard (admin đổi trong Quản trị → Giao diện).
const DEFAULT_BACKGROUND_URL = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQl1K8O2o7bsOUGL4ZqQVEkPiYlc5Mqd8XvTHgLND1FZA&s=10';
const DEFAULT_YOUTUBE_URL = 'https://youtube.com';
const DEFAULT_DISCORD_URL = 'https://discord.com';
const avatarCache = new Map();

/** avatar Discord: ưu tiên kv (lưu lúc /connect, /token), fallback gọi Discord API bằng bot token. */
async function discordAvatar(discordId) {
    if (!discordId) return null;
    try {
        const saved = await db.getKv(`discord_avatar:${discordId}`);
        if (saved) return saved;
    } catch (e) { /* bỏ qua */ }
    if (avatarCache.has(discordId)) return avatarCache.get(discordId);
    try {
        const res = await fetch(`https://discord.com/api/v10/users/${discordId}`, {
            headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN || ''}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        let url;
        if (data.avatar) {
            const ext = String(data.avatar).startsWith('a_') ? 'gif' : 'png';
            url = `https://cdn.discordapp.com/avatars/${discordId}/${data.avatar}.${ext}?size=128`;
        } else {
            const index = Number((BigInt(discordId) >> 22n) % 6n);
            url = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
        }
        avatarCache.set(discordId, url);
        try { await db.setKv(`discord_avatar:${discordId}`, url); } catch (e) { /* bỏ qua */ }
        return url;
    } catch (e) {
        return null;
    }
}

async function publicUser(user) {
    const balance = await db.getCoins(balanceKey(user));
    const admin = await isDiscordAdmin(user.discord_id);
    const extra = await marketplace.summaryForUser(user);
    let theme = 'bubble';
    let background = DEFAULT_BACKGROUND_URL;
    let youtubeUrl = DEFAULT_YOUTUBE_URL;
    let discordUrl = DEFAULT_DISCORD_URL;
    try {
        theme = (await db.getKv(`theme:${user.id}`)) === 'classic' ? 'classic' : 'bubble';
        background = (await db.getKv('admin_background_url')) || DEFAULT_BACKGROUND_URL;
        youtubeUrl = (await db.getKv('youtube_url')) || DEFAULT_YOUTUBE_URL;
        discordUrl = (await db.getKv('discord_url')) || DEFAULT_DISCORD_URL;
    } catch (e) { /* bỏ qua */ }
    return {
        id: user.id,
        username: user.username,
        discordId: user.discord_id || null,
        linked: !!user.discord_id,
        isAdmin: admin,
        balance,
        linkToken: user.link_token,
        createdAt: user.created_at,
        theme,
        avatar: await discordAvatar(user.discord_id),
        background,
        youtubeUrl,
        discordUrl,
        ...extra,
    };
}

function setSessionCookie(req, res, rawToken) {
    const secure = process.env.COOKIE_SECURE === '1' || req.secure;
    const maxAge = SESSION_DAYS * 24 * 60 * 60;
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(rawToken)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

async function createSession(req, res, userId) {
    const raw = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.createWebSession(sha256(raw), userId, expiresAt);
    setSessionCookie(req, res, raw);
    return sha256(raw);
}

async function refreshSessionUser(req) {
    if (req.webUser) req.webUser = await db.getWebUserById(req.webUser.id);
}

// rate limit đơn giản trong bộ nhớ
const rateBuckets = new Map();
function rateLimit(key, max, windowMs, bypass = false) {
    // Admin không bị giới hạn bởi IP/device — kể cả khi đang test bằng tài khoản khác.
    if (bypass) return true;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now > bucket.reset) {
        rateBuckets.set(key, { count: 1, reset: now + windowMs });
        return true;
    }
    if (bucket.count >= max) return false;
    bucket.count++;
    return true;
}

router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: true }));

// nạp user từ cookie cho mọi request
router.use(ah(async (req, res, next) => {
    req.webUser = null;
    req.sessionId = null;
    const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (raw) {
        const session = await db.getWebSession(sha256(raw));
        if (session) {
            const user = await db.getWebUserById(session.user_id);
            if (user) {
                req.webUser = user;
                req.sessionId = sha256(raw);
                // Chỉ lưu timestamp (không log request). Bỏ qua API auth & throttle 60s.
                const key = `last_active:${user.id}`;
                const now = Date.now();
                if (!/^\/api\/auth\//.test(req.path) && now - (lastActiveWrites.get(key) || 0) > LAST_ACTIVE_TTL_MS) {
                    lastActiveWrites.set(key, now);
                    Promise.resolve(db.setKv(key, new Date(now).toISOString())).catch(() => {});
                }
            }
        }
    }
    next();
}));

function requireAuth(req, res, next) {
    if (!req.webUser) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
    next();
}

async function requireAdmin(req, res, next) {
    if (!req.webUser) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
    if (!(await isDiscordAdmin(req.webUser.discord_id))) {
        return res.status(403).json({ error: 'Chỉ admin (đã liên kết Discord) mới truy cập được.' });
    }
    next();
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

// Tên đăng nhập phải có ít nhất 1 chữ cái
function usernameHasLetter(value) {
    return /[A-Za-z]/.test(String(value || ''));
}

// Lấy tên Discord thật để hiển thị BXH (cache trong RAM)
// Bot đã lưu tên vào KV discord_name:<id> — ưu tiên KV, kể cả tên toàn ký tự đặc biệt.
async function discordNameFromKv(id) {
    try {
        const saved = await db.getKv(`discord_name:${id}`);
        return saved && String(saved).trim() ? String(saved) : null;
    } catch (e) {
        return null;
    }
}

const discordNameCache = new Map();
async function discordUsername(id) {
    const key = String(id || '');
    if (!/^\d{15,25}$/.test(key)) return null;
    if (discordNameCache.has(key)) return discordNameCache.get(key);
    const token = process.env.DISCORD_TOKEN;
    if (!token) return null;
    try {
        const res = await fetch(`https://discord.com/api/v10/users/${key}`, {
            headers: { Authorization: `Bot ${token}` },
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) { discordNameCache.set(key, null); return null; }
        const data = await res.json();
        const name = data.global_name || data.username || null;
        discordNameCache.set(key, name);
        return name;
    } catch (e) {
        return null;
    }
}

// ==================== AUTH ====================
router.post('/api/auth/register', ah(async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!rateLimit(`reg:${ip}`, 10, 60 * 60 * 1000, isWhitelistedAdminIp(req))) {
        return res.status(429).json({ error: 'Quá nhiều lần thử, vui lòng đợi.' });
    }

    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        return res.status(400).json({ error: 'Tên đăng nhập 3-24 ký tự, chỉ gồm chữ, số và dấu gạch dưới.' });
    }
    if (!usernameHasLetter(username)) {
        return res.status(400).json({ error: 'Tên đăng nhập phải có ít nhất 1 chữ cái.' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự.' });

    const existing = await db.getWebUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });

    const deviceId = String(req.body.deviceId || req.get('x-device-id') || '').trim();
    if (deviceId && typeof db.getDeviceAccount === 'function') {
        const bound = await db.getDeviceAccount(deviceId);
        if (bound) return res.status(409).json({ error: 'Thiết bị này đã gắn với tài khoản khác. Hãy đăng nhập tài khoản đó hoặc dùng thiết bị khác.' });
    }

    const linkToken = await generateUniqueLinkToken(db);
    const user = await db.createWebUser({
        id: randomId(),
        username,
        password_hash: hashPassword(password),
        link_token: linkToken,
    });
    if (!(await bindDevice(req, res, user.id))) return;
    await createSession(req, res, user.id);
    hook('web:user:registered', { id: user.id, username: user.username, ip: req.ip });
    res.json({ user: await publicUser(user) });
}));

router.post('/api/auth/login', ah(async (req, res) => {
    const ip = req.ip || 'unknown';
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = await db.getWebUserByUsername(username);
    // Admin không bị chặn bởi số lần thử theo IP hay theo device đã gắn tài khoản test.
    const adminBypass = (await isAdminUser(user)) || isWhitelistedAdminIp(req);
    if (!rateLimit(`login:${ip}`, 20, 15 * 60 * 1000, adminBypass)) {
        return res.status(429).json({ error: 'Quá nhiều lần thử, vui lòng đợi.' });
    }
    if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
    }
    if (!usernameHasLetter(user.username)) {
        return res.status(403).json({
            error: 'Tên đăng nhập của bạn chỉ có số. Hãy đổi tên trước khi tiếp tục.',
            requiresUsernameChange: true,
            currentUsername: user.username,
        });
    }
    if (!(await bindDevice(req, res, user.id, adminBypass))) return;
    await createSession(req, res, user.id);
    hook('web:user:login', { id: user.id, username: user.username, method: 'password', ip: req.ip });
    res.json({ user: await publicUser(user) });
}));

// Đổi tên cho tài khoản cũ chỉ toàn số (chưa cần session, dùng mật khẩu để xác thực)
router.post('/api/auth/claim-username', ah(async (req, res) => {
    const currentUsername = String(req.body.currentUsername || '').trim();
    const newUsername = String(req.body.newUsername || '').trim();
    const password = String(req.body.password || '');
    const token = String(req.body.token || '').trim();

    const user = await db.getWebUserByUsername(currentUsername);
    if (!user) return res.status(401).json({ error: 'Thông tin xác thực không đúng.' });
    const tokenUser = token ? await db.getWebUserByLinkToken(token) : null;
    if (!verifyPassword(password, user.password_hash) && !(tokenUser && tokenUser.id === user.id)) {
        return res.status(401).json({ error: 'Thông tin xác thực không đúng.' });
    }
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(newUsername) || !usernameHasLetter(newUsername)) {
        return res.status(400).json({ error: 'Tên mới 3-24 ký tự, có ít nhất 1 chữ cái.' });
    }
    const exists = await db.getWebUserByUsername(newUsername);
    if (exists && exists.id !== user.id) return res.status(409).json({ error: 'Tên này đã được dùng.' });

    await db.updateWebUser(user.id, { username: newUsername, username_lower: newUsername.toLowerCase() });
    user.username = newUsername;
    user.username_lower = newUsername.toLowerCase();
    await createSession(req, res, user.id);
    hook('web:user:renamed', { id: user.id, from: currentUsername, to: newUsername });
    res.json({ user: await publicUser(user) });
}));

// Đăng nhập bằng token Discord (token cố định = link_token trên web)
router.post('/api/auth/discord-token', ah(async (req, res) => {
    const ip = req.ip || 'unknown';
    const adminBypass = isWhitelistedAdminIp(req);
    if (!rateLimit(`tok:${ip}`, 20, 15 * 60 * 1000, adminBypass)) {
        return res.status(429).json({ error: 'Quá nhiều lần thử, vui lòng đợi.' });
    }

    const token = String(req.body.token || '').trim();
    if (!/^[A-Za-z0-9]{64}$/.test(token)) {
        return res.status(400).json({ error: 'Token phải đúng 64 ký tự chữ và số.' });
    }
    const user = await db.getWebUserByLinkToken(token);
    if (!user) return res.status(401).json({ error: 'Token không hợp lệ.' });
    if (!usernameHasLetter(user.username)) {
        return res.status(403).json({
            error: 'Tên đăng nhập của bạn chỉ có số. Hãy đổi tên trước khi tiếp tục.',
            requiresUsernameChange: true,
            currentUsername: user.username,
            token,
        });
    }
    const tokenAdmin = (await isAdminUser(user)) || adminBypass;
    if (!(await bindDevice(req, res, user.id, tokenAdmin))) return;
    await createSession(req, res, user.id);
    hook('web:user:login', { id: user.id, username: user.username, method: 'discord-token', discordId: user.discord_id || null });
    res.json({ user: await publicUser(user) });
}));

router.post('/api/auth/logout', ah(async (req, res) => {
    if (req.sessionId) await db.deleteWebSession(req.sessionId);
    clearSessionCookie(res);
    hook('web:user:logout', { id: req.webUser && req.webUser.id });
    res.json({ ok: true });
}));

/** Nhãn bản cập nhật của riêng user: FE gọi âm thầm, khác nhãn thì reload để lấy số dư mới. */
router.get('/api/version', ah(async (req, res) => {
    if (!req.webUser) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
    res.set('Cache-Control', 'no-store');
    res.json({ version: await db.getCoinVersion(balanceKey(req.webUser)) });
}));

router.get('/api/me', ah(async (req, res) => {
    if (!req.webUser) return res.json({ user: null });
    const user = await publicUser(req.webUser);
    const extra = await marketplace.summaryForUser(req.webUser);
    const { language, acoin, exchangeRate, sellerStatus, isSeller, unreadMessages } = extra;
    // FE đọc cả 2 dạng: me.user.acoin và me.acoin.
    // contacts.unread (số tin chưa reply) được tính trong GET /api/messages/contacts.
    res.json({ user, language, acoin, exchangeRate, sellerStatus, isSeller, unreadMessages });
}));

// ==================== HỒ SƠ ====================
router.post('/api/profile/password', requireAuth, ah(async (req, res) => {
    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    if (!verifyPassword(current, req.webUser.password_hash)) return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
    if (next.length < 6) return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 6 ký tự.' });
    await db.updateWebUser(req.webUser.id, { password_hash: hashPassword(next) });
    await db.deleteWebSessionsForUser(req.webUser.id, req.sessionId);
    hook('web:profile:password', { id: req.webUser.id });
    res.json({ ok: true });
}));

router.post('/api/profile/token', requireAuth, ah(async (req, res) => {
    if (req.webUser.discord_id) return res.status(400).json({ error: 'Tài khoản đã liên kết Discord, không cần token nữa.' });
    const token = await generateUniqueLinkToken(db);
    const updated = await db.updateWebUser(req.webUser.id, { link_token: token });
    hook('web:profile:token', { id: req.webUser.id });
    res.json({ linkToken: updated.link_token });
}));

router.post('/api/profile/username', requireAuth, ah(async (req, res) => {
    const newUsername = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!verifyPassword(password, req.webUser.password_hash)) return res.status(400).json({ error: 'Mật khẩu không đúng.' });
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(newUsername) || !usernameHasLetter(newUsername)) {
        return res.status(400).json({ error: 'Tên mới 3-24 ký tự, có ít nhất 1 chữ cái.' });
    }
    const exists = await db.getWebUserByUsername(newUsername);
    if (exists && exists.id !== req.webUser.id) return res.status(409).json({ error: 'Tên này đã được dùng.' });
    await db.updateWebUser(req.webUser.id, { username: newUsername, username_lower: newUsername.toLowerCase() });
    await refreshSessionUser(req);
    hook('web:profile:username', { id: req.webUser.id, username: newUsername });
    res.json({ ok: true, username: newUsername });
}));

router.post('/api/profile/theme', requireAuth, ah(async (req, res) => {
    const theme = String(req.body.theme || '').toLowerCase();
    if (!['bubble', 'classic'].includes(theme)) return res.status(400).json({ error: 'Theme không hợp lệ.' });
    await db.setKv(`theme:${req.webUser.id}`, theme);
    hook('web:profile:theme', { id: req.webUser.id, theme });
    res.json({ ok: true, theme });
}));

// ==================== CHUYỂN COIN ====================
async function resolveTarget(to, selfUser) {
    let raw = String(to || '').trim().replace(/^@/, '').trim();
    if (!raw) throw new Error('Nhập người nhận.');

    // 1) ID Discord (có thể là key số dư trực tiếp)
    if (/^\d{15,25}$/.test(raw)) {
        if (selfUser.discord_id && selfUser.discord_id === raw) throw new Error('Không thể tự chuyển cho chính mình.');
        return { key: raw, label: `Discord ${raw}` };
    }

    // 2) Username web
    const target = await db.getWebUserByUsername(raw);
    if (target) {
        if (target.id === selfUser.id) throw new Error('Không thể tự chuyển cho chính mình.');
        return { key: balanceKey(target), label: target.username };
    }

    // 3) Tên Discord đã lưu từ bot (global name / username). Không lọc ký tự đặc biệt:
    //    tên toàn ký tự lạ vẫn phải nhận diện được, so sánh không phân biệt hoa thường.
    const candidates = [...new Set([raw, raw.split('#')[0]].filter(Boolean))]
        .map(s => s.toLowerCase());
    const matches = new Map(); // discordId -> tên hiển thị
    try {
        const kvs = (await db.listKv('discord_name:')).concat(await db.listKv('discord_username:'));
        for (const kv of kvs) {
            const id = String(kv.key || '').split(':').pop();
            if (!/^\d{15,25}$/.test(id)) continue;
            if (selfUser.discord_id && id === String(selfUser.discord_id)) continue;
            const value = String(kv.value || '').trim();
            if (!value) continue;
            const valueLower = value.toLowerCase();
            if (candidates.includes(valueLower) || candidates.includes(valueLower.split('#')[0])) {
                if (!matches.has(id)) matches.set(id, value);
            }
        }
    } catch (e) { /* KV chưa sẵn sàng thì báo không tìm thấy ở dưới */ }

    if (matches.size === 1) {
        const [id, label] = [...matches.entries()][0];
        return { key: id, label };
    }
    if (matches.size > 1) {
        throw new Error('Có nhiều người Discord trùng tên. Hãy nhập ID Discord (15-25 chữ số) để chuyển chính xác.');
    }
    throw new Error('Không tìm thấy người nhận. Nhập username web, tên Discord đã dùng bot, hoặc ID Discord.');
}

router.post('/api/transfers', requireAuth, ah(async (req, res) => {
    const amount = toInt(req.body.amount, 0);
    if (amount < PAY_MIN) return res.status(400).json({ error: `Số coin tối thiểu mỗi lần chuyển là ${PAY_MIN}.` });

    let target;
    try { target = await resolveTarget(req.body.to, req.webUser); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const fromKey = balanceKey(req.webUser);
    const balance = await db.getCoins(fromKey);
    if (balance < amount) return res.status(400).json({ error: `Bạn không đủ coin. Số dư: ${balance}.` });

    const fee = Math.ceil(amount * PAY_FEE_RATE);
    const received = amount - fee;

    const newBalance = await db.updateCoins(fromKey, -amount);
    try {
        await db.updateCoins(target.key, received);
    } catch (e) {
        await db.updateCoins(fromKey, amount).catch(() => {});
        throw e;
    }
    const transfer = await db.createTransfer({
        id: randomId(),
        from_user_id: req.webUser.id,
        from_label: req.webUser.username,
        to_label: target.label,
        to_balance_key: target.key,
        amount,
        fee,
    });
    hook('web:transfer', { id: transfer.id, from: req.webUser.id, to: target.key, amount, fee });
    res.json({ ok: true, newBalance, fee, received, to: target.label });
}));

router.get('/api/transfers', requireAuth, ah(async (req, res) => {
    const list = await db.getTransfersByUser(req.webUser.id, 50);
    res.json({ transfers: list });
}));

// ==================== GIFT CODE ====================
router.post('/api/giftcode', requireAuth, ah(async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!rateLimit(`gift:${ip}`, 30, 15 * 60 * 1000)) return res.status(429).json({ error: 'Quá nhiều lần thử, vui lòng đợi.' });

    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Nhập mã gift code.' });
    const amount = await db.redeemGiftCode(code);
    if (!amount) return res.status(400).json({ error: 'Gift code không hợp lệ hoặc đã được dùng.' });

    const key = balanceKey(req.webUser);
    const newBalance = await db.updateCoins(key, amount);
    hook('web:giftcode', { code, amount, userKey: key });
    res.json({ ok: true, amount, newBalance });
}));

// ==================== SHOP ====================
function publicItem(item) {
    return {
        id: item.id,
        name: item.name,
        description: item.description || '',
        price: Number(item.price) || 0,
        logoUrl: item.logo_url || '',
        category: item.category || 'shop',
        stock: Number(item.stock) || 0,
        active: item.active !== false,
    };
}

router.get('/api/shop', requireAuth, ah(async (req, res) => {
    // Tab Shop chính (#shop-grid) là hàng hệ thống/admin.
    // Hàng seller có shop_id chỉ được phục vụ qua /api/user-shop/:id.
    const allItems = await db.getShopItems(true);
    const items = allItems.filter(i => !i.shop_id);
    res.json({ items: items.map(publicItem), gistEnabled: shop.useGist() });
}));

router.post('/api/shop/buy', requireAuth, ah(async (req, res) => {
    const itemId = String(req.body.itemId || '');
    const quantity = toInt(req.body.quantity, 1);
    if (quantity < 1 || quantity > 50) return res.status(400).json({ error: 'Số lượng từ 1-50.' });

    const item = await db.getShopItem(itemId);
    if (!item || item.active === false) return res.status(404).json({ error: 'Sản phẩm không tồn tại.' });
    // Không cho mua hàng user-shop qua luồng Shop hệ thống.
    if (item.shop_id) return res.status(400).json({ error: 'Sản phẩm/user-shop chỉ mua tại User Shop.' });
    if (Number(item.stock) < quantity) return res.status(400).json({ error: `Kho chỉ còn ${item.stock} sản phẩm.` });

    const total = Number(item.price) * quantity;
    const key = balanceKey(req.webUser);
    const balance = await db.getCoins(key);
    if (balance < total) return res.status(400).json({ error: `Bạn không đủ coin (cần ${total}). Số dư: ${balance}.` });

    const newBalance = await db.updateCoins(key, -total);
    let taken;
    try {
        taken = await shop.takeStock(item, quantity);
    } catch (e) {
        await db.updateCoins(key, total).catch(() => {});
        return res.status(400).json({ error: e.message });
    }
    await shop.persistStock(item, taken.stockFields);
    const purchase = await db.createPurchase({
        id: randomId(),
        web_user_id: req.webUser.id,
        item_id: item.id,
        item_name: item.name,
        quantity,
        unit_price: Number(item.price),
        total_price: total,
        accounts: taken.accounts.join('\n'),
    });
    hook('web:shop:purchase', {
        purchaseId: purchase.id, userId: req.webUser.id, itemId: item.id,
        itemName: item.name, quantity, total, remaining: taken.remaining,
    });
    res.json({
        ok: true,
        purchaseId: purchase.id,
        accounts: taken.accounts,
        remaining: taken.remaining,
        total,
        newBalance,
    });
}));

router.get('/api/purchases', requireAuth, ah(async (req, res) => {
    const purchases = await db.getPurchasesByUser(req.webUser.id, 100);
    res.json({
        purchases: purchases.map(p => ({
            id: p.id,
            itemName: p.item_name,
            quantity: Number(p.quantity) || 0,
            unitPrice: Number(p.unit_price) || 0,
            totalPrice: Number(p.total_price) || 0,
            accounts: String(p.accounts || '').split('\n').filter(Boolean),
            createdAt: p.created_at,
        })),
    });
}));

// ==================== DEVICE ====================
router.post('/api/device/buycloud', requireAuth, ah(async (req, res) => {
    const provider = String(req.body.provider || '').toUpperCase();
    const server = req.body.server ? String(req.body.server).toUpperCase() : null;
    const inputData = String(req.body.inputData || '').trim();

    if (!['UG', 'VM', 'VS'].includes(provider)) return res.status(400).json({ error: 'Provider không hợp lệ.' });
    if (provider === 'UG' && !server) return res.status(400).json({ error: 'UGPhone cần chọn server.' });
    if (!inputData) return res.status(400).json({ error: 'Nhập dữ liệu (tài khoản|mật khẩu hoặc Local Storage).' });
    if (provider === 'VM' && !inputData.includes('|')) return res.status(400).json({ error: 'Định dạng: tài khoản|mật khẩu' });

    const result = await services.buyHanami(provider, server, inputData);
    if (!result.ok) return res.status(400).json({ error: result.message });
    res.json({ ok: true, message: result.message, provider: services.CLOUD_NAMES[provider], server });
}));

router.post('/api/device/reg', requireAuth, ah(async (req, res) => {
    const service = String(req.body.service || '').toLowerCase();
    if (!['vmos', 'vsphone'].includes(service)) return res.status(400).json({ error: 'Dịch vụ không hợp lệ.' });

    const key = balanceKey(req.webUser);
    if (busyUsers.has(key)) return res.status(409).json({ error: 'Bạn đang có thao tác khác, thử lại sau.' });

    const balance = await db.getCoins(key);
    if (balance < REG_COST) return res.status(400).json({ error: `Bạn không đủ coin (cần ${REG_COST}). Số dư: ${balance}.` });

    busyUsers.add(key);
    try {
        const result = service === 'vmos' ? await services.regVmosAccount() : await services.regVsphoneAccount();
        const newBalance = await db.updateCoins(key, -REG_COST);
        hook('web:device:reg', { service, userKey: key, cost: REG_COST, newBalance });
        res.json({
            ok: true,
            service,
            account: result.account,
            password: result.password,
            token: result.token || null,
            userId: result.userId || null,
            copyText: result.copyText,
            newBalance,
        });
    } finally {
        busyUsers.delete(key);
    }
}));

// ==================== ĐIỂM DANH HÀNG NGÀY / QUÀ FREE ====================
router.post('/api/daily/claim', requireAuth, ah(async (req, res) => {
    const key = balanceKey(req.webUser);
    if (busyUsers.has(key)) return res.status(409).json({ error: 'Bạn đang có thao tác khác, thử lại sau.' });
    const today = getTodayString();
    busyUsers.add(key);
    try {
        if (await db.checkDailyLimit(key, 'daily', today) > 0) {
            return res.status(400).json({ error: 'Hôm nay bạn đã nhận quà rồi. Quay lại sau 0h giờ VN nhé!' });
        }
        const reward = crypto.randomInt(1, 21); // 1-20 xu, cùng luồng /daily Discord
        await db.increaseDailyLimit(key, 'daily', today); // đánh dấu trước để chống nhận 2 lần
        const newBalance = await db.updateCoins(key, reward);
        hook('web:daily:claim', { userKey: key, reward, newBalance, date: today });
        res.json({ ok: true, reward, newBalance, date: today });
    } finally {
        busyUsers.delete(key);
    }
}));

/** 1 VMOS mới mỗi ngày, không trừ xu. Điều kiện: vượt ít nhất 1 link trong ngày. */
router.post('/api/device/vmos-free', requireAuth, ah(async (req, res) => {
    const key = balanceKey(req.webUser);
    if (busyUsers.has(key)) return res.status(409).json({ error: 'Bạn đang có thao tác khác, thử lại sau.' });
    const today = getTodayString();
    busyUsers.add(key);
    try {
        const { result, linkCount } = await claimFreeDevice(key, today, 'vmos');
        hook('web:device:vmos-free', { userKey: key, linkCount, date: today });
        res.json({
            ok: true,
            service: 'vmos',
            account: result.account,
            password: result.password,
            copyText: result.copyText,
            linkCount,
            date: today,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    } finally {
        busyUsers.delete(key);
    }
}));

/** 1 VSPhone thường mới mỗi ngày (không phải VIP), không trừ xu. Chọn 1 trong 2 với VMOS. */
router.post('/api/device/vsphone-free', requireAuth, ah(async (req, res) => {
    const key = balanceKey(req.webUser);
    if (busyUsers.has(key)) return res.status(409).json({ error: 'Bạn đang có thao tác khác, thử lại sau.' });
    const today = getTodayString();
    busyUsers.add(key);
    try {
        const { result, linkCount } = await claimFreeDevice(key, today, 'vsphone');
        hook('web:device:vsphone-free', { userKey: key, linkCount, date: today });
        res.json({
            ok: true,
            service: 'vsphone',
            account: result.account,
            password: result.password,
            token: result.token || null,
            userId: result.userId || null,
            copyText: result.copyText,
            linkCount,
            date: today,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    } finally {
        busyUsers.delete(key);
    }
}));

// ==================== NHIỆM VỤ VƯỢT LINK ====================
router.get('/api/tasks', requireAuth, ah(async (req, res) => {
    const key = balanceKey(req.webUser);
    const today = getTodayString();
    const period = await weekly.getLinkPeriod();
    const providerIds = Object.keys(linkProviders.PROVIDERS);
    const [star, weeklyCount, dailyClaimed, freeVmosClaimed, freeVsphoneClaimed, linkCountAllTime, ...counts] = await Promise.all([
        db.checkDailyLimit(key, 'star', today),
        weekly.userLinkCount(key, period),
        db.checkDailyLimit(key, 'daily', today),
        db.checkDailyLimit(key, 'vmos_free', today),
        db.checkDailyLimit(key, 'vsphone_free', today),
        db.getAllTimeLinkCount(key),
        ...providerIds.map(id => db.checkDailyLimit(key, id, today)),
    ]);
    const daily = Object.fromEntries(providerIds.map((id, i) => [id, Number(counts[i]) || 0]));
    const linkCountToday = Object.values(daily).reduce((sum, count) => sum + count, 0);
    const providers = Object.values(linkProviders.PROVIDERS).map(p => {
        const used = daily[p.id] || 0;
        return {
            ...p,
            used,
            remaining: Math.max(0, p.dailyMax - used),
            ready: linkProviders.ready(p.id, req),
        };
    });
    const gmail = await gmailTasks.summary(req.webUser.id);
    res.json({
        reward: linkProviders.rewardFor('link4m'), // giữ field cũ cho client cũ
        dailyMax: linkProviders.dailyMaxFor('link4m'),
        providers,
        daily,
        weeklyCount,
        gmail,
        gmailTop: await decorate(await gmailTasks.leaderboard(10), 'count'),
        period,
        star,
        rewards: await weekly.getRewards(),
        link4mReady: linkProviders.ready('link4m'),
        laymaReady: linkProviders.ready('layma'),
        bbmktsReady: linkProviders.ready('bbmkts'),
        date: today,
        dailyClaimed: dailyClaimed > 0,
        freeVmosClaimed: freeVmosClaimed > 0,
        freeVsphoneClaimed: freeVsphoneClaimed > 0,
        freeDeviceClaimed: freeVmosClaimed > 0 || freeVsphoneClaimed > 0,
        linkCountToday,
        linkCountAllTime,
    });
}));

router.post('/api/tasks/link', requireAuth, ah(async (req, res) => {
    const provider = linkProviders.get(req.body.provider || 'link4m');
    if (!provider) return res.status(400).json({ error: 'Dịch vụ không hợp lệ.' });

    const key = balanceKey(req.webUser);
    const today = getTodayString();
    const count = await db.checkDailyLimit(key, provider.id, today);
    if (count >= provider.dailyMax) {
        return res.status(400).json({ error: `Bạn đã đạt giới hạn ${provider.dailyMax} lần/ngày cho dịch vụ này.` });
    }

    const sid = crypto.randomBytes(16).toString('hex');
    await db.createSession(sid, key, provider.id);
    const base = (process.env.RENDER_DOMAIN || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const targetUrl = `${base}/redeem?sid=${sid}`;

    // Gắn trình duyệt tạo link vào cookie httpOnly + lưu theme đang dùng cho trang redeem.
    let browserId = String(req.get('x-device-id') || (req.body && req.body.browserId) || '').trim();
    if (!browserId) browserId = crypto.randomBytes(16).toString('hex');
    res.cookie('nigaria_browser', browserId, {
        httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    let theme = String((req.body && req.body.theme) || '').toLowerCase();
    if (!['bubble', 'classic'].includes(theme)) {
        theme = (await db.getKv(`theme:${req.webUser.id}`)) === 'classic' ? 'classic' : 'bubble';
    }
    await db.setKv(`redeem_meta:${sid}`, JSON.stringify({ browserId, theme, webUrl: base }));

    let finalUrl;
    try {
        finalUrl = await linkProviders.shorten(provider.id, targetUrl, req);
    } catch (e) {
        await db.getAndDeleteSession(sid).catch(() => {});
        await db.setKv(`redeem_meta:${sid}`, '').catch(() => {});
        return res.status(400).json({ error: e.message });
    }

    await db.increaseDailyLimit(key, provider.id, today);
    hook('web:link:start', {
        userKey: key, provider: provider.id, providerName: provider.name,
        reward: provider.reward, dailyMax: provider.dailyMax,
        sid, targetUrl, finalUrl,
    });
    res.json({
        ok: true,
        url: finalUrl,
        provider: provider.id,
        reward: provider.reward,
        remaining: provider.dailyMax - count - 1,
    });
}));

// Nhiệm vụ tạo Gmail — gửi bài, chờ admin duyệt thủ công.
router.post('/api/tasks/gmail', requireAuth, ah(async (req, res) => {
    const key = balanceKey(req.webUser);
    if (busyUsers.has(`gmail:${key}`)) return res.status(409).json({ error: 'Bạn đang gửi Gmail, thử lại sau giây lát.' });
    busyUsers.add(`gmail:${key}`);
    try {
        const task = await gmailTasks.submit(req.webUser, req.body.account);
        hook('web:gmail:submit', { userKey: key, email: task.email });
        res.json({ ok: true, task, reward: gmailTasks.REWARD, message: 'Đã gửi Gmail, chờ admin duyệt.' });
    } finally {
        busyUsers.delete(`gmail:${key}`);
    }
}));

// ==================== BẢNG XẾP HẠNG ====================
async function decorate(rows, valueKey) {
    const keys = rows.map(r => String(r.user_id));
    const discordIds = keys.filter(k => !k.startsWith('web_'));
    const webIds = keys.filter(k => k.startsWith('web_')).map(k => k.slice(4));
    const [byDiscord, byId] = await Promise.all([
        db.getWebUsersByDiscordIds(discordIds),
        db.getWebUsersByIds(webIds),
    ]);
    const map = new Map();
    byDiscord.forEach(u => map.set(String(u.discord_id), u.username));
    byId.forEach(u => map.set(`web_${u.id}`, u.username));

    // Ưu tiên tên đã lưu từ bot (có thể chứa ký tự đặc biệt), rồi đến Discord API.
    // Không dùng usernameHasLetter ở đây — tên lạ vẫn phải hiển thị.
    const kvNames = await Promise.all(discordIds.map(id => discordNameFromKv(id)));
    kvNames.forEach((name, i) => { if (name) map.set(discordIds[i], name); });

    const unresolved = discordIds.filter(id => !map.has(id));
    if (unresolved.length) {
        const names = await Promise.all(unresolved.map(id => discordUsername(id)));
        names.forEach((name, i) => {
            if (name && String(name).trim()) map.set(unresolved[i], String(name));
            else map.set(unresolved[i], `Discord ${unresolved[i]}`);
        });
    }

    const adminFlags = await Promise.all(rows.map(async r => {
        const key = String(r.user_id);
        const discordId = key.startsWith('web_')
            ? (byId.find(u => `web_${u.id}` === key) || {}).discord_id
            : key;
        return discordId ? isDiscordAdmin(discordId) : false;
    }));
    return rows.map((r, i) => ({
        rank: i + 1,
        userId: String(r.user_id),
        display: map.get(String(r.user_id)) || (String(r.user_id).startsWith('web_') ? 'Người dùng web' : `Discord ${r.user_id}`),
        value: Number(r[valueKey]) || 0,
        isAdmin: !!adminFlags[i],
    }));
}

router.get('/api/leaderboard/coins', requireAuth, ah(async (req, res) => {
    const top = await db.getTopCoins(10);
    res.json({ leaderboard: await decorate(top, 'balance') });
}));

/** BXH số dư ACOIN (1 ACOIN = exchangeRate coin, khác BXH coin). */
router.get('/api/leaderboard/acoin', requireAuth, ah(async (req, res) => {
    const top = await db.getTopAcoin(10);
    res.json({ leaderboard: await decorate(top, 'balance') });
}));

/** BXH tuần chỉ nhận user có >=5 link trong kỳ. */
function weeklyQualified(rows) {
    const min = weekly.MIN_WEEKLY_LINKS || 5;
    return (rows || []).filter(row => Number(row.count) >= min);
}

router.get('/api/leaderboard/links', requireAuth, ah(async (req, res) => {
    const period = await weekly.getLinkPeriod();
    const top = weeklyQualified(await weekly.mergedLeaderboard(period, 100));
    res.json({ leaderboard: await decorate(top.slice(0, 10), 'count'), period, rewards: await weekly.getRewards() });
}));

// Bảng vượt link 7 ngày (có thưởng, reset sau mỗi kỳ thanh toán)
router.get('/api/leaderboard/links/week', requireAuth, ah(async (req, res) => {
    const period = await weekly.getLinkPeriod();
    const top = weeklyQualified(await weekly.mergedLeaderboard(period, 100));
    res.json({ leaderboard: await decorate(top.slice(0, 10), 'count'), period, rewards: await weekly.getRewards() });
}));

// Bảng vượt link tổng (không có thưởng)
router.get('/api/leaderboard/links/all', requireAuth, ah(async (req, res) => {
    const top = await db.getAllTimeLinkLeaderboard(10);
    res.json({ leaderboard: await decorate(top, 'count'), rewards: null });
}));

/** BXH Gmail đã duyệt: mỗi Gmail hợp lệ = 1 điểm (180 coin). */
router.get('/api/leaderboard/gmail', requireAuth, ah(async (req, res) => {
    const top = await gmailTasks.leaderboard(10);
    res.json({
        leaderboard: await decorate(top, 'count'),
        reward: gmailTasks.REWARD,
        rewards: null,
    });
}));

// ==================== ADMIN ====================
router.get('/api/admin/overview', requireAdmin, ah(async (req, res) => {
    const [users, items, purchases, payouts] = await Promise.all([
        db.listWebUsers(1000),
        db.getShopItems(false),
        db.getAllPurchases(200),
        db.getPayouts(20),
    ]);
    const revenue = purchases.reduce((s, p) => s + (Number(p.total_price) || 0), 0);
    const coins = await Promise.all(users.map(u => db.getCoins(balanceKey(u))));
    const totalCoins = coins.reduce((s, c) => s + (Number(c) || 0), 0);
    res.json({
        stats: {
            users: users.length,
            linked: users.filter(u => u.discord_id).length,
            items: items.filter(i => i.active !== false).length,
            purchases: purchases.length,
            revenue,
            totalCoins,
            gistEnabled: shop.useGist(),
        },
        recentPurchases: purchases.slice(0, 10).map(p => ({
            itemName: p.item_name, quantity: Number(p.quantity), totalPrice: Number(p.total_price), createdAt: p.created_at,
        })),
        payouts: payouts.map(p => ({ period: p.period, total: Number(p.total), createdAt: p.created_at, details: JSON.parse(p.details || '[]') })),
    });
}));

router.get('/api/admin/items', requireAdmin, ah(async (req, res) => {
    // Admin chỉ quản lý hàng hệ thống ở bảng chính; hàng của user-shop tách riêng
    // để không lẫn vào danh sách tạo từ admin.
    const [allItems, shops] = await Promise.all([db.getShopItems(false), db.listShops()]);
    const shopNames = new Map(shops.map(s => [String(s.id), s.name]));
    const system = allItems.filter(i => !i.shop_id);
    const userItems = allItems.filter(i => !!i.shop_id).map(i => ({
        ...publicItem(i),
        shopId: String(i.shop_id),
        shopName: shopNames.get(String(i.shop_id)) || '',
        ownerId: i.created_by ? String(i.created_by) : '',
    }));
    res.json({
        items: system.map(publicItem),
        userItems,
        shops: shops.map(s => ({ id: String(s.id), name: s.name })),
    });
}));

router.post('/api/admin/items', requireAdmin, ah(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const price = toInt(req.body.price, 0);
    const logoUrl = String(req.body.logoUrl || '').trim();
    const category = ['shop', 'device'].includes(req.body.category) ? req.body.category : 'shop';
    const accounts = String(req.body.accounts || '');

    if (name.length < 2) return res.status(400).json({ error: 'Tên sản phẩm tối thiểu 2 ký tự.' });
    if (price < 1) return res.status(400).json({ error: 'Giá phải lớn hơn 0.' });
    if (logoUrl && !validHttpUrl(logoUrl)) return res.status(400).json({ error: 'Logo phải là link http(s).' });

    const stockInfo = await shop.createStock(name, accounts);
    const item = await db.createShopItem({
        id: randomId(),
        name,
        description,
        price,
        logo_url: logoUrl,
        category,
        created_by: req.webUser.id,
        ...stockInfo,
    });
    res.json({ ok: true, item: publicItem(item) });
}));

router.post('/api/admin/items/:id/stock', requireAdmin, ah(async (req, res) => {
    const item = await db.getShopItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
    const accounts = String(req.body.accounts || '');
    const info = await shop.addStock(item, accounts);
    const updated = await db.updateShopItem(item.id, info);
    res.json({ ok: true, item: publicItem(updated) });
}));

router.patch('/api/admin/items/:id', requireAdmin, ah(async (req, res) => {
    const item = await db.getShopItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body.description !== undefined) patch.description = String(req.body.description).trim();
    if (req.body.price !== undefined) {
        const price = toInt(req.body.price, 0);
        if (price < 1) return res.status(400).json({ error: 'Giá phải lớn hơn 0.' });
        patch.price = price;
    }
    if (req.body.logoUrl !== undefined) {
        const logoUrl = String(req.body.logoUrl).trim();
        if (logoUrl && !validHttpUrl(logoUrl)) return res.status(400).json({ error: 'Logo phải là link http(s).' });
        patch.logo_url = logoUrl;
    }
    if (req.body.category !== undefined) patch.category = ['shop', 'device'].includes(req.body.category) ? req.body.category : 'shop';
    if (req.body.active !== undefined) patch.active = Boolean(req.body.active);
    const updated = await db.updateShopItem(item.id, patch);
    res.json({ ok: true, item: publicItem(updated) });
}));

router.delete('/api/admin/items/:id', requireAdmin, ah(async (req, res) => {
    await db.deleteShopItem(req.params.id);
    res.json({ ok: true });
}));

router.get('/api/admin/users', requireAdmin, ah(async (req, res) => {
    const users = await db.listWebUsers(1000);
    const out = [];
    for (const u of users) {
        out.push({
            id: u.id,
            username: u.username,
            discordId: u.discord_id || null,
            balance: await db.getCoins(balanceKey(u)),
            acoin: await db.getAcoin(balanceKey(u)),
            isAdmin: await isDiscordAdmin(u.discord_id),
            createdAt: u.created_at,
        });
    }
    res.json({ users: out });
}));

router.post('/api/admin/coins', requireAdmin, ah(async (req, res) => {
    const action = String(req.body.action || 'cong');
    const currency = String(req.body.currency || 'coin').toLowerCase();
    const amount = toInt(req.body.amount, 0);
    const target = String(req.body.target || '').trim();
    if (!['set', 'cong', 'tru'].includes(action)) return res.status(400).json({ error: 'Hành động không hợp lệ.' });
    if (!['coin', 'acoin'].includes(currency)) return res.status(400).json({ error: 'Loại tiền không hợp lệ.' });
    if (action !== 'set' && amount < 1) return res.status(400).json({ error: `Số ${currency === 'acoin' ? 'ACOIN' : 'coin'} phải > 0.` });

    let key;
    if (/^\d{15,25}$/.test(target)) key = target;
    else {
        const u = await db.getWebUserByUsername(target);
        if (!u) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
        key = balanceKey(u);
    }
    const read = currency === 'acoin' ? db.getAcoin : db.getCoins;
    const write = currency === 'acoin' ? db.updateAcoin : db.updateCoins;
    const current = await read(key);
    let delta;
    if (action === 'set') delta = amount - current;
    else if (action === 'cong') delta = amount;
    else delta = -Math.min(amount, current);
    if (delta !== 0) await write(key, delta);
    // Đọc lại từ nguồn dữ liệu để số trả về (dùng để hiển thị/toast) khớp số đã lưu.
    const newBalance = await read(key);
    res.json({ ok: true, currency, current, newBalance });
}));

// ==================== ADMIN: NHIỆM VỤ GMAIL ====================
router.get('/api/admin/gmail', requireAdmin, ah(async (req, res) => {
    const tasks = await gmailTasks.listAdmin();
    res.json({
        tasks,
        reward: gmailTasks.REWARD,
        password: gmailTasks.PASSWORD,
        pending: tasks.filter(t => t.status === 'pending').length,
        approved: tasks.filter(t => t.status === 'approved').length,
        rejected: tasks.filter(t => t.status === 'rejected').length,
    });
}));

router.post('/api/admin/gmail/:id/approve', requireAdmin, ah(async (req, res) => {
    const task = await gmailTasks.approve(req.params.id, req.webUser.discord_id || req.webUser.id);
    hook('web:gmail:approve', { email: task.email, userKey: task.userKey, reward: task.reward });
    res.json({ ok: true, task });
}));

router.post('/api/admin/gmail/:id/reject', requireAdmin, ah(async (req, res) => {
    const task = await gmailTasks.reject(req.params.id, req.webUser.discord_id || req.webUser.id, req.body.reason);
    hook('web:gmail:reject', { email: task.email, userKey: task.userKey, reason: task.rejectReason });
    res.json({ ok: true, task });
}));

router.post('/api/admin/gmail/:id/pin', requireAdmin, ah(async (req, res) => {
    const pinned = Boolean(req.body.pinned);
    const task = await gmailTasks.setPinned(req.params.id, pinned);
    res.json({ ok: true, task });
}));

router.get('/api/admin/purchases', requireAdmin, ah(async (req, res) => {
    const purchases = await db.getAllPurchases(200);
    res.json({
        purchases: purchases.map(p => ({
            id: p.id,
            itemName: p.item_name,
            quantity: Number(p.quantity),
            totalPrice: Number(p.total_price),
            accounts: String(p.accounts || '').split('\n').filter(Boolean),
            createdAt: p.created_at,
        })),
    });
}));

router.get('/api/admin/payouts', requireAdmin, ah(async (req, res) => {
    const payouts = await db.getPayouts(50);
    res.json({ payouts: payouts.map(p => ({ period: p.period, total: Number(p.total), createdAt: p.created_at, details: JSON.parse(p.details || '[]') })) });
}));

router.post('/api/admin/payout', requireAdmin, ah(async (req, res) => {
    const result = await weekly.runWeeklyPayout({ force: true });
    hook('web:admin:payout', { by: req.webUser.id, result });
    res.json({ ok: true, result });
}));

// Admin chỉnh mức thưởng tuần (lưu KV, có hiệu lực kỳ trả thưởng sau).
router.get('/api/admin/weekly-rewards', requireAdmin, ah(async (req, res) => {
    res.json({
        rewards: await weekly.getRewards(),
        defaults: weekly.DEFAULT_REWARDS,
        minLinks: weekly.MIN_WEEKLY_LINKS,
    });
}));

router.post('/api/admin/weekly-rewards', requireAdmin, ah(async (req, res) => {
    let rewards;
    try { rewards = await weekly.setRewards(req.body.rewards); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    hook('web:admin:weekly-rewards', { by: req.webUser.id, rewards });
    res.json({ ok: true, rewards, defaults: weekly.DEFAULT_REWARDS });
}));

router.delete('/api/admin/weekly-rewards', requireAdmin, ah(async (req, res) => {
    const rewards = await weekly.resetRewards();
    res.json({ ok: true, rewards, defaults: weekly.DEFAULT_REWARDS });
}));

// ==================== ADMIN: GIAO DIỆN ====================
router.get('/api/admin/background', requireAdmin, ah(async (req, res) => {
    res.json({
        url: (await db.getKv('admin_background_url')) || DEFAULT_BACKGROUND_URL,
        defaultUrl: DEFAULT_BACKGROUND_URL,
    });
}));

router.post('/api/admin/background', requireAdmin, ah(async (req, res) => {
    const url = String(req.body.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL ảnh phải bắt đầu bằng http:// hoặc https://' });
    await db.setKv('admin_background_url', url);
    hook('web:admin:background', { url, by: req.webUser.id });
    res.json({ ok: true, url: url || DEFAULT_BACKGROUND_URL });
}));

router.delete('/api/admin/background', requireAdmin, ah(async (req, res) => {
    await db.setKv('admin_background_url', '');
    res.json({ ok: true, url: DEFAULT_BACKGROUND_URL });
}));

// Link nút YouTube / Discord trên dashboard (admin đổi, mọi user thấy ngay).
router.get('/api/admin/social-links', requireAdmin, ah(async (req, res) => {
    res.json({
        youtubeUrl: (await db.getKv('youtube_url')) || DEFAULT_YOUTUBE_URL,
        discordUrl: (await db.getKv('discord_url')) || DEFAULT_DISCORD_URL,
        defaultYoutubeUrl: DEFAULT_YOUTUBE_URL,
        defaultDiscordUrl: DEFAULT_DISCORD_URL,
    });
}));

router.post('/api/admin/social-links', requireAdmin, ah(async (req, res) => {
    const youtubeUrl = String(req.body.youtubeUrl || '').trim();
    const discordUrl = String(req.body.discordUrl || '').trim();
    const valid = value => !value || /^https?:\/\//i.test(value);
    if (!valid(youtubeUrl) || !valid(discordUrl)) {
        return res.status(400).json({ error: 'Link phải bắt đầu bằng http:// hoặc https://' });
    }
    await db.setKv('youtube_url', youtubeUrl);
    await db.setKv('discord_url', discordUrl);
    const result = {
        youtubeUrl: youtubeUrl || DEFAULT_YOUTUBE_URL,
        discordUrl: discordUrl || DEFAULT_DISCORD_URL,
    };
    hook('web:admin:social-links', { ...result, by: req.webUser.id });
    res.json({ ok: true, ...result });
}));

router.delete('/api/admin/social-links', requireAdmin, ah(async (req, res) => {
    await db.setKv('youtube_url', '');
    await db.setKv('discord_url', '');
    res.json({ ok: true, youtubeUrl: DEFAULT_YOUTUBE_URL, discordUrl: DEFAULT_DISCORD_URL });
}));

// ==================== ADMIN: PLUGIN ====================
router.get('/api/admin/plugins', requireAdmin, ah(async (req, res) => {
    const rows = await db.getPlugins();
    const runtime = new Map(pluginEngine.list().map(p => [String(p.id), p]));
    res.json({
        plugins: rows.map(p => ({
            id: p.id,
            name: p.name,
            sourceUrl: p.source_url,
            gistId: p.gist_id,
            gistUrl: p.gist_id ? `https://gist.github.com/${p.gist_id}` : null,
            enabled: p.enabled !== false,
            error: p.error || null,
            lastLoadedAt: p.last_loaded_at || null,
            runtime: runtime.get(String(p.id)) || null,
        })),
    });
}));

router.post('/api/admin/plugins', requireAdmin, ah(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const sourceUrl = String(req.body.url || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Tên plugin tối thiểu 2 ký tự.' });

    const code = await pluginEngine.fetchScript(sourceUrl);
    const filename = github.safeFilename(`${name}-plugin`);
    const gist = await github.createGist(filename, code, `NIGARIA CLOUD plugin • ${name}`);
    const row = await db.createPlugin({
        id: randomId(),
        name,
        source_url: sourceUrl,
        gist_id: gist.id,
        gist_filename: gist.filename,
        enabled: true,
    });
    const meta = await pluginEngine.loadPlugin(row);
    hook('web:plugin:installed', { id: row.id, name: row.name, meta });
    res.json({ ok: true, plugin: { id: row.id, name: row.name, gistUrl: gist.url }, runtime: meta });
}));

router.post('/api/admin/plugins/:id/reload', requireAdmin, ah(async (req, res) => {
    const row = await db.getPlugin(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy plugin.' });
    if (row.enabled === false) return res.status(400).json({ error: 'Plugin đang bị tắt.' });
    const meta = await pluginEngine.loadPlugin(row);
    hook('web:plugin:reloaded', { id: row.id, name: row.name, meta });
    res.json({ ok: true, runtime: meta });
}));

router.post('/api/admin/plugins/:id/source', requireAdmin, ah(async (req, res) => {
    const row = await db.getPlugin(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy plugin.' });
    const sourceUrl = String(req.body.url || row.source_url || '').trim();
    const code = await pluginEngine.fetchScript(sourceUrl);
    if (row.gist_id) {
        await github.writeGistFile(row.gist_id, row.gist_filename, code);
    } else {
        const gist = await github.createGist(github.safeFilename(`${row.name}-plugin`), code, `NIGARIA CLOUD plugin • ${row.name}`);
        row.gist_id = gist.id;
        row.gist_filename = gist.filename;
    }
    await db.updatePlugin(row.id, { source_url: sourceUrl, gist_id: row.gist_id, gist_filename: row.gist_filename });
    const meta = await pluginEngine.loadPlugin({ ...row, source_url: sourceUrl });
    hook('web:plugin:source', { id: row.id, name: row.name, sourceUrl, meta });
    res.json({ ok: true, runtime: meta });
}));

router.patch('/api/admin/plugins/:id', requireAdmin, ah(async (req, res) => {
    const row = await db.getPlugin(req.params.id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy plugin.' });
    const enabled = req.body.enabled === undefined ? row.enabled !== false : Boolean(req.body.enabled);
    await db.updatePlugin(row.id, { enabled });
    if (!enabled) pluginEngine.unload(row.id);
    else await pluginEngine.loadPlugin({ ...row, enabled: true });
    hook('web:plugin:toggle', { id: row.id, name: row.name, enabled });
    res.json({ ok: true, enabled });
}));

router.delete('/api/admin/plugins/:id', requireAdmin, ah(async (req, res) => {
    const id = req.params.id;
    await pluginEngine.remove(id);
    hook('web:plugin:removed', { id });
    res.json({ ok: true });
}));

// ==================== MARKETPLACE / SELLER / CHAT / ACOIN ====================
// FE/Bot gọi trực tiếp các path dưới đây. Alias chỉ chuyển tiếp tới
// marketplace.router để giữ một luật xử lý duy nhất (không nhân bản logic).
// GET /api/profile/language?, /api/exchange?, /api/admin/exchange-rate,
// /api/orders/history, /api/messages/contacts, /api/messages,
// /api/seller/request, /api/seller/dashboard, /api/seller/shop,
// /api/user-shop, /api/admin/sellers.
const MARKETPLACE_ALIASES = [
    ['post', '/api/profile/language'],
    ['post', '/api/exchange'],
    ['get', '/api/admin/exchange-rate'],
    ['post', '/api/admin/exchange-rate'],
    ['get', '/api/orders/history'],
    ['get', '/api/messages/contacts'],
    ['get', '/api/messages'],
    ['post', '/api/messages'],
    ['post', '/api/seller/request'],
    ['get', '/api/seller/dashboard'],
    ['post', '/api/seller/shop'],
    ['get', '/api/user-shop'],
    ['get', '/api/admin/sellers'],
];
function forwardToMarketplace(req, res, next) {
    return marketplace.router.handle(req, res, next);
}
for (const [method, route] of MARKETPLACE_ALIASES) router[method](route, forwardToMarketplace);

// BXH tuần: count >= 5 mới được lên bảng và nhận thưởng.
router.use(marketplace.router);

// ==================== DEBUG GITHUB (cần đăng nhập) ====================
// Tự tạo 1 gist test rồi xóa, trả nguyên response lỗi để xác định đúng nguyên nhân 422.
router.get('/api/debug/github', requireAuth, ah(async (req, res) => {
    const before = github.getLastError();
    let created = null;
    let createError = null;
    try {
        created = await github.createGist(
            `nigaria-debug-${Date.now().toString(16)}.js`,
            '// NIGARIA gist debug\nconsole.log("ok");\n',
            'NIGARIA debug',
        );
    } catch (e) {
        createError = { message: e.message, raw: github.getLastError() };
    }
    if (created) await github.deleteGist(created.id).catch(() => {});
    res.json({
        hasToken: github.hasToken(),
        tokenPrefix: String(process.env.GITHUB_TOKEN || '').trim().slice(0, 4),
        created,
        createError,
        previousError: before,
    });
}));

// ==================== LỖI ====================
router.use((err, req, res, next) => {
    console.error('[web] lỗi:', err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message || 'Lỗi server.' });
});

module.exports = { router, isDiscordAdmin, balanceKey, COOKIE_NAME, requireAuth, requireAdmin, publicUser };
