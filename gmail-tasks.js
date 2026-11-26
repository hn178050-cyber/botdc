/**
 * Nhiệm vụ tạo Gmail — duyệt thủ công.
 *
 * Lưu chính trong bảng PostgreSQL `gmail_tasks`. Nếu bảng chưa được tạo trên
 * DB chính, module tự fallback sang bảng `kv` để web vẫn chạy; khi bảng có
 * sẵn, mọi bài gửi mới đi thẳng vào PostgreSQL.
 */
const crypto = require('crypto');
const db = require('./database');
const gistStore = require('./gist-store');

const REWARD = 180;
const PASSWORD = 'Domixi3667khoga@';
const PREFIX = 'gmail_task:';
const SYSTEM_ID = 'system';
const MAX_REASON = 500;

const busy = new Set();
let pgMissing = false;
let pgRetryAt = 0;

/** Tạm fallback KV khi bảng chưa có; tự thử lại PostgreSQL sau 60s. */
function pgReady() {
    if (!pgMissing) return true;
    if (Date.now() < pgRetryAt) return false;
    pgMissing = false;
    return true;
}

function markPgMissing(e) {
    pgMissing = true;
    pgRetryAt = Date.now() + 60 * 1000;
    console.error('[gmail] PostgreSQL chưa sẵn sàng, dùng KV tạm:', e.message);
}

function parseJson(value) {
    if (!value) return null;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        return null;
    }
}

function toTask(row, storage) {
    if (!row) return null;
    return {
        id: String(row.id),
        userId: String(row.user_id != null ? row.user_id : (row.userId || '')),
        userKey: String(row.user_key != null ? row.user_key : (row.userKey || '')),
        username: String(row.username || ''),
        email: String(row.email || '').toLowerCase(),
        password: String(row.password || ''),
        reward: Number(row.reward) || REWARD,
        status: row.status === 'approved' || row.status === 'rejected' ? row.status : 'pending',
        pinned: row.pinned === true || row.pinned === 'true',
        rejectReason: row.reject_reason != null ? row.reject_reason : (row.rejectReason || null),
        reviewedBy: row.reviewed_by != null ? row.reviewed_by : (row.reviewedBy || null),
        reviewedAt: row.reviewed_at || row.reviewedAt || null,
        notified: row.notified === true || row.notified === 'true',
        coinAfter: row.coin_after != null ? Number(row.coin_after) : null,
        createdAt: row.created_at || row.createdAt || new Date().toISOString(),
        _storage: storage,
    };
}

function toPg(task) {
    return {
        id: task.id,
        user_id: task.userId,
        user_key: task.userKey,
        username: task.username,
        email: task.email,
        password: task.password,
        reward: task.reward,
        status: task.status,
        pinned: !!task.pinned,
        reject_reason: task.rejectReason || null,
        reviewed_by: task.reviewedBy || null,
        reviewed_at: task.reviewedAt || null,
        notified: !!task.notified,
        coin_after: task.coinAfter == null ? null : task.coinAfter,
        created_at: task.createdAt,
    };
}

function publicTask(task) {
    const { _storage, password, ...rest } = task;
    return { ...rest, hasPassword: !!password };
}

async function save(task) {
    if (task._storage !== 'kv' && pgReady()) {
        try {
            await db.updateGmailTask(task.id, toPg(task));
            return task;
        } catch (e) {
            if (/duplicate|unique/i.test(e.message)) throw e;
            markPgMissing(e);
        }
    }
    await db.setKv(`${PREFIX}${task.id}`, JSON.stringify(toPg(task)));
    task._storage = 'kv';
    return task;
}

async function insert(task) {
    if (pgReady()) {
        try {
            const saved = await db.addGmailTask(toPg(task));
            if (saved) return toTask(saved, 'pg');
        } catch (e) {
            if (/duplicate|unique/i.test(e.message)) {
                throw new Error('Gmail này đã được gửi trước đó. Không gửi trùng tài khoản Google.');
            }
            markPgMissing(e);
        }
    }
    await db.setKv(`${PREFIX}${task.id}`, JSON.stringify(toPg(task)));
    return { ...task, _storage: 'kv' };
}

async function readOne(id) {
    if (pgReady()) {
        try {
            const row = await db.getGmailTask(id);
            if (row) return toTask(row, 'pg');
        } catch (e) {
            markPgMissing(e);
        }
    }
    return toTask(parseJson(await db.getKv(`${PREFIX}${id}`)), 'kv');
}

/** Chuẩn hoá `email|mật khẩu`; trả { email, password } hoặc ném lỗi tiếng Việt. */
function parseSubmission(raw) {
    const text = String(raw || '').trim().replace(/^`+|`+$/g, '').trim();
    if (!text) throw new Error('Dán Gmail và mật khẩu theo dạng email|mật khẩu.');
    const parts = text.split('|');
    if (parts.length !== 2) throw new Error('Định dạng phải là email|mật khẩu.');
    const email = parts[0].trim().toLowerCase();
    const password = parts[1].trim();
    if (!/^[a-z0-9]+@gmail\.com$/.test(email)) {
        throw new Error('Gmail không hợp lệ: chỉ chữ/số, không dấu chấm, phải kết thúc bằng @gmail.com.');
    }
    if (password !== PASSWORD) {
        throw new Error(`Mật khẩu bắt buộc là ${PASSWORD}.`);
    }
    return { email, password };
}

async function listAll() {
    const map = new Map();
    if (pgReady()) {
        try {
            for (const row of await db.listGmailTasks(500)) {
                const task = toTask(row, 'pg');
                if (task) map.set(task.id, task);
            }
        } catch (e) {
            markPgMissing(e);
        }
    }
    try {
        for (const row of await db.listKv(PREFIX)) {
            const task = toTask(parseJson(row.value), 'kv');
            if (task && !map.has(task.id)) map.set(task.id, task);
        }
    } catch (e) { /* KV dự phòng không bắt buộc */ }
    return [...map.values()].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ap = a.status === 'pending' ? 0 : 1;
        const bp = b.status === 'pending' ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
}

async function listForUser(userId) {
    return (await listAll()).filter(t => String(t.userId) === String(userId));
}

async function submit(user, raw) {
    const { email, password } = parseSubmission(raw);
    const all = await listAll();
    if (all.some(t => t.email === email)) {
        throw new Error('Gmail này đã được gửi trước đó. Không gửi trùng tài khoản Google.');
    }
    const task = {
        id: crypto.randomBytes(10).toString('hex'),
        userId: String(user.id),
        userKey: user.discord_id ? String(user.discord_id) : `web_${user.id}`,
        username: String(user.username || ''),
        email,
        password,
        reward: REWARD,
        status: 'pending',
        pinned: false,
        rejectReason: null,
        reviewedBy: null,
        reviewedAt: null,
        notified: false,
        coinAfter: null,
        createdAt: new Date().toISOString(),
        _storage: 'pg',
    };
    return publicTask(await insert(task));
}

async function approve(id, adminKey) {
    if (busy.has(id)) throw new Error('Gmail này đang được xử lý.');
    busy.add(id);
    try {
        const task = await readOne(id);
        if (!task) throw new Error('Không tìm thấy Gmail.');
        if (task.status !== 'pending') throw new Error('Gmail này đã được xử lý.');
        task.coinAfter = await db.updateCoins(task.userKey, REWARD);
        task.status = 'approved';
        task.reviewedAt = new Date().toISOString();
        task.reviewedBy = String(adminKey || '');
        await save(task);
        return publicTask(task);
    } finally {
        busy.delete(id);
    }
}

async function reject(id, adminKey, reason) {
    if (busy.has(id)) throw new Error('Gmail này đang được xử lý.');
    busy.add(id);
    try {
        const task = await readOne(id);
        if (!task) throw new Error('Không tìm thấy Gmail.');
        if (task.status !== 'pending') throw new Error('Gmail này đã được xử lý.');
        task.rejectReason = String(reason || '').trim().slice(0, MAX_REASON)
            || 'Gmail không hợp lệ hoặc không sử dụng được.';
        task.status = 'rejected';
        task.reviewedAt = new Date().toISOString();
        task.reviewedBy = String(adminKey || '');
        await save(task);
        try {
            await gistStore.addMessage({
                id: `gmail_reject_${task.id}`,
                from: SYSTEM_ID,
                to: task.userId,
                content: [
                    'Yêu cầu Gmail bị từ chối.',
                    `Gmail: ${task.email}`,
                    `Lý do: ${task.rejectReason}`,
                    'Bạn có thể tạo Gmail mới và gửi lại nhiệm vụ.',
                ].join('\n'),
                createdAt: new Date().toISOString(),
            });
            task.notified = true;
            await save(task);
        } catch (e) {
            console.error('[gmail] không gửi được thông báo system:', e.message);
        }
        return publicTask(task);
    } finally {
        busy.delete(id);
    }
}

async function setPinned(id, pinned) {
    const task = await readOne(id);
    if (!task) throw new Error('Không tìm thấy Gmail.');
    task.pinned = !!pinned;
    await save(task);
    return publicTask(task);
}

/** Số Gmail đã duyệt theo từng user — dùng cho bảng xếp hạng. */
async function leaderboard(limit = 10) {
    const counts = new Map();
    for (const task of await listAll()) {
        if (task.status !== 'approved') continue;
        const key = String(task.userKey || '');
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([user_id, count]) => ({ user_id, count, coins: count * REWARD }))
        .sort((a, b) => b.count - a.count || String(a.user_id).localeCompare(String(b.user_id)))
        .slice(0, Math.max(1, Math.min(100, Number(limit) || 10)));
}

async function summary(userId) {
    const rows = await listForUser(userId);
    const count = status => rows.filter(t => t.status === status).length;
    return {
        reward: REWARD,
        password: PASSWORD,
        submissions: rows.map(publicTask),
        pending: count('pending'),
        approved: count('approved'),
        rejected: count('rejected'),
    };
}

module.exports = {
    REWARD,
    PASSWORD,
    SYSTEM_ID,
    parseSubmission,
    listAll: async () => (await listAll()).map(publicTask),
    listAdmin: async () => (await listAll()).map(({ _storage, ...task }) => task),
    listForUser: async userId => (await listForUser(userId)).map(publicTask),
    submit,
    approve,
    reject,
    setPinned,
    leaderboard,
    summary,
};
