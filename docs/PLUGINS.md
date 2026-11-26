# Plugin NIGARIA CLOUD

Plugin dùng để thêm route web, lệnh Discord và logic mới **mà không deploy lại bot/web**.

## Ngôn ngữ

**JavaScript / CommonJS**. Không cần build, không cài dependency, không TypeScript runtime.
Script chạy trong `vm` của Node.js nên cú pháp là JS thường:

```js
const x = 1;                    // OK
module.exports = function (api) { /* ... */ };  // OK
```

Không dùng `import`/`export`, không dùng package ngoài (trừ danh sách `require` cho phép bên dưới).

---

## 1. Cài plugin

1. Đăng nhập web bằng tài khoản **admin đã liên kết Discord**.
2. Vào **Quản trị → Plugin**.
3. Nhập **Tên plugin** (tối thiểu 2 ký tự) và **Link raw script** (`http://` hoặc `https://`).
4. Bấm **Tải & kích hoạt**.

Hệ thống sẽ:

1. Tải script (tối đa **200KB**, timeout **15s**).
2. Lưu nội dung vào một **secret Gist**; `gist_id` lưu ở bảng `plugins`.
3. Chạy script trong sandbox `vm` và mount route tại `/plugin/<plugin-id>/...`.
4. Load lại từ **Gist** lúc restart hoặc khi bấm **Reload**.

> Đổi link script bằng nút **Đổi link** sẽ ghi đè nội dung Gist. Reload luôn đọc Gist, không đọc lại URL cũ.

Các nút quản lý: **Reload**, **Đổi link**, **Bật/Tắt**, **Xoá**. Khi tắt/xoá, timer, listener và API plugin được dọn tự động.

---

## 2. Ba cách viết script

### Cách 1 — đăng ký trực tiếp

```js
api.get('/hello', (req, res) => res.json({ ok: true, msg: 'Hello' }));
api.command('ping', async ({ interaction }) => {
  await interaction.editReply('pong'); // interaction đã được deferReply
});
```

### Cách 2 — export function (khuyên dùng)

```js
module.exports = function (api) {
  api.get('/hello', (req, res) => res.json({ ok: true }));
};
```

### Cách 3 — export object có `register`

```js
module.exports = {
  async register(api) {
    api.get('/hello', (req, res) => res.json({ ok: true }));
  },
};
```

Gọi từ web: `GET /plugin/<plugin-id>/hello`.
Gọi từ Discord: `/plugin <ten-plugin>:ping` (tên plugin hoặc id, không phân biệt hoa thường).

---

## 3. Script mẫu đầy đủ

```js
module.exports = function (api) {
  const { log, kv, events } = api;

  // Route public
  api.get('/hello', (req, res) => {
    res.json({ ok: true, plugin: api.plugin.name, user: req.webUser?.username || null });
  });

  // Route cần đăng nhập (plugin tự kiểm tra)
  api.get('/me', async (req, res) => {
    if (!req.webUser) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
    res.json({ user: await api.web.me(req), balance: await api.coins.get(api.web.balanceKey(req.webUser)) });
  });

  // Route có middleware (api.get nhận nhiều handler)
  const auth = (req, res, next) => req.webUser ? next() : res.status(401).json({ error: 'Cần đăng nhập.' });
  api.get('/protected', auth, (req, res) => res.json({ ok: true }));

  // Discord command
  api.command('ping', async ({ interaction }) => {
    await interaction.editReply(`🏓 pong từ ${api.plugin.name}`);
  });

  // Hook event của bot/web
  const off = events.on('web:daily:claim', (payload) => {
    log('Có người claim daily:', payload.userKey, payload.reward);
  });

  // Emit event cho plugin khác
  api.post('/notify', async (req, res) => {
    const results = await events.emit('myplugin:notify', { message: String(req.body.message || '') });
    res.json({ ok: true, results });
  });

  // Expose API cho plugin khác
  api.plugins.expose('greet', async ({ name }) => `Xin chào ${name || 'bạn'}!`);

  // Dọn dẹp khi reload/tắt plugin
  api.onUnload(() => off());
};
```

Plugin khác gọi API của plugin trên:

```js
module.exports = function (api) {
  api.get('/call-hello', async (req, res) => {
    const msg = await api.plugins.call('hello', 'greet', { name: 'Quan' });
    res.json({ msg });
  });
};
```

---

## 4. API trong sandbox

Biến toàn cục có sẵn: `api`, `db`, `crypto`, `fetch`, `URL`, `Buffer`, `console`,
`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `module`, `exports`, `require`.

`require` chỉ cho phép: `crypto`, `path`, `url`, `util`, `querystring`.
Không có `process`, `fs`, `child_process`, `http`, `net`, `os`, `express`, `discord.js`.

### 4.1 Core & thông tin

| API | Mô tả |
|---|---|
| `api.core.version` | Phiên bản API core (hiện tại `1.0.0`). |
| `api.core.language` | `'JavaScript (CommonJS)'`. |
| `api.core.now()` | ISO timestamp. |
| `api.core.dbMode` | `'neon'` khi có `DATABASE_URL`, ngược lại `'local'` (file JSON). |
| `api.core.env(name)` | Đọc biến môi trường **đã whitelist** (`PORT`, `RENDER_DOMAIN`, `DB_MODE`, `DISCORD_READY`, `GITHUB_READY`, ...). Không trả secret. |
| `api.core.events()` | Danh sách event đang có subscriber. |
| `api.core.pluginId` | ID plugin hiện tại. |
| `api.plugin` | `{ id, name, sourceUrl }`. |
| `api.log(...)` / `.warn` / `.error` | Log có prefix `[plugin:<tên>]`. |

### 4.2 Route & lệnh

| API | Mô tả |
|---|---|
| `api.get/post/put/patch/delete(path, ...handlers)` | Đăng ký route trên router riêng. Handler có thể nhiều cái (middleware trước, handler sau). |
| `api.all(path, ...handlers)` | Mọi method. |
| `api.route(method, path, ...handlers)` | Đăng ký động. |
| `api.middleware(fn)` | Middleware áp dụng cho mọi route của plugin. |
| `api.routes.list()` | Liệt kê route đã đăng ký. |
| `api.command(name, fn, description?)` | Đăng ký lệnh Discord, gọi qua `/plugin <ten>:<name>`. `fn` nhận `{ interaction, db, api }`. |
| `api.commands.list()` / `.get(name)` | Xem lệnh đã đăng ký. |

Handler route nhận `(req, res, next, ctx)` với `ctx = { db, api, plugin, context }`.
Plugin route **không tự động require auth**, nhưng `req.webUser` và `req.sessionId` đã có sẵn (web router chạy trước). Tự kiểm tra hoặc dùng middleware như ví dụ.

### 4.3 Event bus

| API | Mô tả |
|---|---|
| `api.events.on(event, handler)` | Đăng ký listener. Trả về hàm `off()` để huỷ. |
| `api.events.off(event, handler?)` | Huỷ listener của chính plugin. |
| `api.events.emit(event, payload)` | Emit event (có thể chờ `Promise.allSettled`). Trả về mảng kết quả. |
| `api.events.list()` | Xem số subscriber của từng event. |

Listener nhận `(payload, meta)` với `meta = { event, pluginId }`.
Hook từ core (`web:*`, `bot:*`) là **fire-and-forget**: core không chờ plugin, lỗi chỉ được log, không làm hỏng request/lệnh gốc.

### 4.4 Gọi API giữa plugin

| API | Mô tả |
|---|---|
| `api.plugins.expose(method, handler)` | Expose API tên `method` cho plugin khác. |
| `api.plugins.unexpose(method)` | Gỡ API đã expose. |
| `api.expose(method, handler)` | Alias của `expose`. |
| `api.plugins.call(ref, method, payload)` | Gọi API plugin khác theo **id hoặc tên** (không phân biệt hoa thường). Timeout **10s**. |
| `api.plugins.list()` | Danh sách plugin đang load kèm `routes`, `commands`, `events`, `apis`. |
| `api.plugins.get(ref)` | Meta của 1 plugin. |

Handler expose nhận `(payload, meta)` với `meta = { from, method }`.
Khi reload/tắt plugin, API expose và listener của bản cũ bị gỡ hết.

### 4.5 Bot Discord

| API | Mô tả |
|---|---|
| `api.bot.client()` | Raw discord.js `Client` (hoặc `null` nếu chưa inject). Dùng cẩn thận. |
| `api.bot.ready()` | Bot đã sẵn sàng chưa. |
| `api.bot.user(id)` | `client.users.fetch(id)`. |
| `api.bot.channel(id)` | `client.channels.fetch(id)`. |
| `api.bot.send(channelId, content, options?)` | Gửi tin nhắn tới channel. |
| `api.bot.dm(userId, content)` | Gửi DM. |
| `api.bot.isAdmin(id)` | Kiểm tra admin (env + bảng `admins`). |
| `api.bot.leaderboard()` | Liệt kê mọi lệnh plugin đã đăng ký. |

### 4.6 Web / user

| API | Mô tả |
|---|---|
| `api.web.requireAuth()` / `.requireAdmin()` | Lấy middleware gốc nếu server đã inject. |
| `api.web.balanceKey(user)` | `discord_id` nếu đã liên kết, nếu không thì `web_<id>`. |
| `api.web.cookieName()` | Tên cookie session. |
| `api.web.me(req)` | Thông tin public của `req.webUser` (đã ẩn hash/token). |
| `api.users.getById/getByDiscord/getByToken/list(limit?)` | Truy vấn user. |
| `api.users.public(user)` | Đổi sang dạng public. |
| `api.users.displayName(id)` | Tên Discord (ưu tiên kv đã lưu, có fallback fetch API). |
| `api.users.avatar(id)` | URL avatar Discord đã lưu lúc login/connect. |
| `api.users.isAdmin(id)` | Alias `api.bot.isAdmin`. |
| `api.users.balanceKey(user)` | Alias `api.web.balanceKey`. |
| `api.users.linkCount(key)` | Số link trong kỳ hiện tại. |

> `api.db` là DB module **đầy đủ**, bao gồm cả dữ liệu nhạy cảm (`password_hash`, `link_token`, cookie kv, ...). Chỉ cài plugin từ nguồn tin cậy.

### 4.7 Coin

```js
await api.coins.get(key);            // số dư
await api.coins.add(key, 10);        // cộng (+ có âm)
await api.coins.take(key, 10);       // trừ, throw nếu không đủ
await api.coins.transfer(from, to, 10);
await api.coins.top(10);             // BXH coin
```

### 4.8 Storage KV

```js
await kv.get('foo');       // hoặc kv('foo')
await kv.set('foo', 'bar'); // hoặc kv('foo', 'bar')
await kv.remove('foo');
await kv.global('shared_key');          // KV dùng chung toàn hệ thống
await kv.global('shared_key', 'value');
```

Key plugin được tự động prefix thành `plugin:<plugin-id>:<key>`.

### 4.9 Shop & kho

| API | Mô tả |
|---|---|
| `api.shop.useGist()` | Đang dùng Gist hay DB local. |
| `api.shop.list(activeOnly?)` / `.get(id)` / `.create(item)` | Quản lý sản phẩm. |
| `api.shop.addStock(item, text)` / `.takeStock(item, qty)` / `.persistStock(item, fields)` / `.restoreStock(item, accounts)` | Thao tác kho. |
| `api.shop.purchases(webUserId, limit?)` | Lịch sử mua. |

### 4.10 Dịch vụ device / cloud

| API | Mô tả |
|---|---|
| `api.services.costs.reg` | Chi phí reg VMOS/VSPhone (10 xu). |
| `api.services.regVmos()` / `.regVsphone()` | Tạo tài khoản cloud. |
| `api.services.buyHanami(provider, server, input)` | Mua cloud Hanami. |

### 4.11 Link / BXH / gift / daily

```js
await api.link.period();                  // kỳ BXH hiện tại
api.link.rewards;                          // [300,150,75,40,...]
api.link.providers;                        // link4m / layma / bbmkts (reward, dailyMax)
api.link.get('bbmkts');                    // config của 1 provider
api.link.reward('bbmkts');                 // 25
api.link.dailyMax('bbmkts');               // 1
await api.link.shorten('bbmkts', url);     // rút gọn bằng token chung web+bot
await api.link.count(key);                 // link kỳ hiện tại
await api.link.allTime(key);               // link mọi kỳ
await api.link.leaderboard(period, limit);
await api.link.allTimeLeaderboard(limit);
await api.link.payout({ force: true });    // trả thưởng thủ công

await api.gift.redeem(code);
await api.gift.create(code, amount);

await api.daily.today();                   // YYYY-MM-DD giờ VN
await api.daily.status(key);               // { date, claimed, freeVmosClaimed, linkCount }
await api.daily.claim(key);                // 1-20 xu, chống claim 2 lần
await api.daily.claimVmos(key);            // 1 VMOS free/ngày, cần >= 1 link
```

### 4.12 HTTP, format, unload

```js
await api.http.get(url, { timeout: 5000 });
await api.http.post(url, { a: 1 });        // trả { ok, status, data, text }

api.format.num(1234);       // "1.234"
api.format.date();          // giờ VN
api.format.esc('<b>');      // escape HTML
api.format.truncate(text, 100);

api.onUnload(() => { /* clear listener, timer, socket... */ });
```

Timer tạo qua `setTimeout`/`setInterval` trong sandbox được engine theo dõi và tự clear khi unload.

---

## 5. Danh sách hook có sẵn

### Web (`web:*`)

| Event | Payload chính |
|---|---|
| `web:user:registered` | `id`, `username`, `ip` |
| `web:user:login` | `id`, `username`, `method` (`password`/`discord-token`), `ip`, `discordId` |
| `web:user:renamed` | `id`, `from`, `to` |
| `web:user:logout` | `id` |
| `web:profile:password` | `id` |
| `web:profile:token` | `id` |
| `web:profile:username` | `id`, `username` |
| `web:profile:theme` | `id`, `theme` |
| `web:transfer` | `id`, `from`, `to`, `amount`, `fee` |
| `web:giftcode` | `code`, `amount`, `userKey` |
| `web:shop:purchase` | `purchaseId`, `userId`, `itemId`, `itemName`, `quantity`, `total`, `remaining` |
| `web:device:reg` | `service`, `userKey`, `cost`, `newBalance` |
| `web:daily:claim` | `userKey`, `reward`, `newBalance`, `date` |
| `web:device:vmos-free` | `userKey`, `linkCount`, `date` |
| `web:link:start` | `userKey`, `provider`, `providerName`, `reward`, `dailyMax`, `sid`, `targetUrl`, `finalUrl` |
| `web:admin:payout` | `by`, `result` |
| `web:admin:background` | `url`, `by` |
| `web:plugin:installed` | `id`, `name`, `meta` |
| `web:plugin:reloaded` | `id`, `name`, `meta` |
| `web:plugin:source` | `id`, `name`, `sourceUrl`, `meta` |
| `web:plugin:toggle` | `id`, `name`, `enabled` |
| `web:plugin:removed` | `id` |

### Bot (`bot:*`)

| Event | Payload chính |
|---|---|
| `bot:ready` | `botId`, `username`, `at` |
| `bot:message` | `id`, `authorId`, `channelId`, `guildId`, `content`, `isBot` |
| `bot:interaction` | `id`, `command`, `userId`, `channelId`, `guildId` |
| `bot:user:connected` | `discordId`, `webUserId`, `username`, `newBalance`, `mergedWebBalance` |
| `bot:user:token` | `discordId`, `webUserId`, `username`, `needsRename` |
| `bot:user:autolinked` | `discordId`, `webUserId`, `username` |
| `bot:link:start` | `userId`, `provider`, `providerName`, `reward`, `dailyMax`, `sid`, `targetUrl`, `finalUrl` |
| `bot:link:redeemed` | `sid`, `userKey`, `provider`, `providerName`, `reward`, `newBalance`, `weeklyCount`, `period` |
| `bot:daily:claim` | `userId`, `reward`, `newBalance`, `date` |
| `bot:device:vmos-free` | `userId`, `linkCount`, `date` |
| `bot:profile:theme` | `userId`, `webUserId`, `theme` |
| `bot:profile:username` | `userId`, `webUserId`, `username` |
| `bot:shop:purchase` | `userId`, `itemId`, `itemName`, `quantity`, `total`, `remaining`, `newBalance` |
| `bot:giftcode` | `userId`, `code`, `amount`, `newBalance` |
| `bot:transfer` | `from`, `to`, `amount`, `fee`, `received`, `newBalance` |
| `bot:admin:background` | `url`, `by` |
| `bot:device:reg:panel` | `userId` |
| `bot:device:reg` | `service`, `userId`, `cost` |
| `bot:plugin:command` | `pluginId`, `pluginName`, `commandName`, `userId` |
| `bot:plugin:executed` | `pluginId`, `pluginName`, `commandName`, `userId` |
| `bot:exchange` | `userId`, `from` (`coin`/`acoin`), `to` (`acoin`/`coin`), `amount`, `rate`, `acoinGain`/`coinGain`, `coinDelta`, `newCoin`, `newAcoin` |
| `bot:seller:request` | `userId`, `ok`, `status` |
| `bot:seller:trust` | `adminId`, `targetId`, `ok`, `status`, `seller` |
| `bot:appeal:decision` | `adminId`, `type` (`review`/`complaint`), `id`, `approve`, `note`, `decidedVia` (`marketplace`/`db`/`kv`), `updatedInDb` |
| `bot:weekly:payout` | `source` (`startup`/`auto`), `result` |
| `bot:weekly:payout:error` | `source`, `error` |

Không có event nào nhận raw `interaction`, `req` hoặc token/cookie trong payload — cố tình để tránh lộ secret ra plugin/log.

---

## 6. Giới hạn & bảo mật

- Script tối đa **200KB**; tải về trong **15s**; phần chạy đồng bộ trong `vm` có timeout **5s**.
- `register(api)` là async và chạy ngoài timeout 5s; đừng đặt logic nặng vô hạn ở đây.
- Gọi plugin chéo timeout **10s**.
- Không có memory limit riêng; plugin chạy chung process/host. `vm` chỉ để hạn chế, **không phải hàng rào bảo mật tuyệt đối**.
- `fetch` trong sandbox không bị whitelist domain; plugin có thể gọi HTTP ngoài. Chỉ cài plugin từ nguồn tin cậy.
- Route plugin là **public** nếu không tự kiểm tra `req.webUser` / `api.bot.isAdmin`.
- Chỉ admin mới được cài/sửa/xoá plugin qua API `requireAdmin`.
- Token Discord và PAT GitHub không được đưa vào event payload và không nên ghi log.

---

## 7. API quản trị (tham khảo)

| Method | Endpoint | Mô tả |
|---|---|---|
| `GET` | `/api/admin/plugins` | Danh sách plugin + runtime meta. |
| `POST` | `/api/admin/plugins` | `{ name, url }` — tải, lưu Gist, load ngay. |
| `POST` | `/api/admin/plugins/:id/reload` | Load lại từ Gist. |
| `POST` | `/api/admin/plugins/:id/source` | `{ url }` — cập nhật Gist rồi load. |
| `PATCH` | `/api/admin/plugins/:id` | `{ enabled: true|false }`. |
| `DELETE` | `/api/admin/plugins/:id` | Gỡ load, xoá Gist và DB row. |
