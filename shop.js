/**
 * Quản lý kho hàng của shop.
 *
 * - Có GITHUB_TOKEN  -> lưu kho vào GitHub Gist (secret), tự trích xuất & xoá
 *   tài khoản đã bán khỏi gist.
 * - Không có token    -> lưu tạm trong cột stock_content của bảng shop_items
 *   (chỉ dùng cho dev/demo).
 */
const crypto = require('crypto');
const github = require('./github');
const db = require('./database');

const LOCAL_GIST = 'local';

function useGist() {
    return github.hasToken();
}

function linesFromText(text) {
    return github.parseLines(text);
}

/** Tạo kho cho item mới. Trả về thông tin để lưu vào DB. */
async function createStock(name, accountsText) {
    const lines = linesFromText(accountsText);
    if (!lines.length) throw new Error('Danh sách tài khoản trống.');
    if (useGist()) {
        const filename = github.safeFilename(name);
        const gist = await github.createGist(filename, lines.join('\n'), `NIGARIA CLOUD • ${name}`);
        return { gist_id: gist.id, gist_filename: gist.filename, stock: lines.length, stock_content: null };
    }
    return { gist_id: LOCAL_GIST, gist_filename: null, stock: lines.length, stock_content: lines.join('\n') };
}

/** Thêm tài khoản vào kho hiện có. Trả về { stock, stock_content, gist_id, gist_filename }. */
async function addStock(item, accountsText) {
    const added = linesFromText(accountsText);
    if (!added.length) throw new Error('Danh sách tài khoản trống.');

    if (useGist() && item.gist_id && item.gist_id !== LOCAL_GIST) {
        const current = await github.readGistFile(item.gist_id, item.gist_filename);
        const merged = [...linesFromText(current), ...added];
        await github.writeGistFile(item.gist_id, item.gist_filename, merged.join('\n'));
        return { stock: merged.length, gist_id: item.gist_id, gist_filename: item.gist_filename };
    }

    const current = linesFromText(item.stock_content || '');
    const merged = [...current, ...added];
    return { stock: merged.length, stock_content: merged.join('\n'), gist_id: LOCAL_GIST, gist_filename: null };
}

/**
 * Lấy ra `quantity` tài khoản và xoá khỏi kho.
 * Trả về { accounts, remaining, stockFields } — stockFields dùng để cập nhật DB.
 */
async function takeStock(item, quantity) {
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    if (useGist() && item.gist_id && item.gist_id !== LOCAL_GIST) {
        const current = linesFromText(await github.readGistFile(item.gist_id, item.gist_filename));
        if (current.length < qty) throw new Error(`Kho chỉ còn ${current.length} tài khoản.`);
        const accounts = current.slice(0, qty);
        const remaining = current.slice(qty);
        // GitHub trả 422 missing_field nếu ghi nội dung rỗng. Lưu marker "# HẾT HÀNG"
        // (parseLines bỏ qua dòng # nên vẫn đọc ra 0 tài khoản).
        const nextContent = remaining.length ? remaining.join('\n') : '# HẾT HÀNG\n';
        await github.writeGistFile(item.gist_id, item.gist_filename, nextContent);
        // User Shop đọc tồn từ line_count, Shop hệ thống đọc từ stock -> cập nhật cả hai.
        return {
            accounts,
            remaining: remaining.length,
            stockFields: { stock: remaining.length, line_count: remaining.length },
        };
    }

    const current = linesFromText(item.stock_content || '');
    if (current.length < qty) throw new Error(`Kho chỉ còn ${current.length} tài khoản.`);
    const accounts = current.slice(0, qty);
    const remaining = current.slice(qty);
    return {
        accounts,
        remaining: remaining.length,
        stockFields: {
            stock: remaining.length,
            line_count: remaining.length,
            stock_content: remaining.length ? remaining.join('\n') : '# HẾT HÀNG\n',
        },
    };
}

/** Hoàn kho khi giao dịch thất bại giữa chừng (best-effort). */
async function restoreStock(item, accounts) {
    if (!accounts || !accounts.length) return;
    try { await addStock(item, accounts.join('\n')); } catch (e) { console.error('[shop] hoàn kho thất bại:', e.message); }
}

/** Cập nhật lại stock trong DB sau khi takeStock. */
async function persistStock(item, stockFields) {
    await db.updateShopItem(item.id, stockFields);
}

module.exports = { useGist, createStock, addStock, takeStock, restoreStock, persistStock, LOCAL_GIST, newId: () => crypto.randomUUID() };
