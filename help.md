# NIGARIA CLOUD — Hướng dẫn chi tiết A → Z

Tài liệu này hướng dẫn **toàn bộ** quy trình: tạo database Neon, lấy connection string,
tạo bảng, cấu hình bot Discord, GitHub Gist, chạy local, deploy production, dùng từng
tính năng trên web/Discord, viết plugin, sao lưu/phục hồi và xử lý lỗi.

> **Nguyên tắc dữ liệu (nhớ kỹ):**
> - **Neon PostgreSQL** chứa **toàn bộ** dữ liệu của bot/web: xu, tài khoản web, session,
>   giftcode, giới hạn ngày, admin, KV, BXH link, shop, đơn hàng, chuyển tiền, thưởng tuần,
>   plugin, seller/marketplace, ACOIN, device account, Gmail task.
> - **Tài khoản VMOS** KHÔNG lưu ở Neon. Nó do edge function riêng trong `services.js`
>   (`https://wxygtmfttyidwnhjdwdw.supabase.co/functions/v1/get-key`) quản lý.
> - **GitHub Gist** lưu kho shop và source plugin (secret gist).
> - **File JSON** `./data/local-db.json` chỉ là chế độ dự phòng khi **chưa có** `DATABASE_URL`.

---

## Mục lục

| Mục | Nội dung |
|---|---|
| [0](#0-kiến-trúc-hệ-thống) | Kiến trúc hệ thống |
| [1](#1-chuẩn-bị-trước-khi-bắt-đầu) | Chuẩn bị |
| [2](#2-tạo-database-neon-từng-bước-một) | **Tạo Neon DB — từng bước một** |
| [3](#3-chạy-schema-tạo-22-bảng) | Chạy schema, tạo 22 bảng |
| [4](#4-cài-đặt-và-chạy-local) | Cài đặt & chạy local |
| [5](#5-cấu-hình-discord-bot) | Cấu hình Discord bot |
| [6](#6-github-token-cho-gist) | GitHub token cho Gist |
| [7](#7-bảng-biến-môi-trường) | Bảng biến môi trường |
| [8](#8-deploy-production-render) | Deploy production |
| [9](#9-proxy-cloudflare-tuỳ-chọn) | Proxy Cloudflare (tuỳ chọn) |
| [10](#10-web-dashboard-a-z) | Web dashboard A–Z |
| [11](#11-slash-commands-a-z) | 28 slash command A–Z |
| [12](#12-plugin-a-z) | Plugin A–Z |
| [13](#13-dữ-liệu-nằm-ở-đâu) | Dữ liệu nằm ở đâu |
| [14](#14-sao-lưu--phục-hồi) | Sao lưu / phục hồi |
| [15](#15-xử-lý-lỗi-thường-gặp) | Xử lý lỗi |
| [16](#16-bảo-mật) | Bảo mật |
| [17](#17-faq-nhanh) | FAQ nhanh |

---

<a id="0-kiến-trúc-hệ-thống"></a>

## 0. Kiến trúc hệ thống

```
Discord ──slash command──┐
                        ├──> server.js (Node + discord.js) ──┐
Trình duyệt ──HTTP───────┘                                  │
                                                            ├──> Neon PostgreSQL  (mọi dữ liệu)
                                    web.js (Express) ───────┤      ↓ DATABASE_URL
                                                            ├──> GitHub Gist      (kho shop + plugin)
                                                            └──> services.js
                                                                   ├── VMOS edge function (tài khoản VMOS)
                                                                   ├── Hanami (mua cloud)
                                                                   └── VSPhone (reg/free)
```

Ba tiến trình/nguồn độc lập:

1. `server.js` — bot Discord + khởi tạo web.
2. `web.js` — Express server, mount tại cùng process.
3. `database.js` — lớp truy cập Neon. Khi `DATABASE_URL` rỗng, tự dùng JSON local.

---

<a id="1-chuẩn-bị-trước-khi-bắt-đầu"></a>

## 1. Chuẩn bị trước khi bắt đầu

Bạn cần có:

| Thứ | Yêu cầu | Lấy ở đâu |
|---|---|---|
| Node.js | **18 trở lên** (khuyến nghị 20 LTS) | https://nodejs.org |
| npm | đi kèm Node | — |
| Git | bất kỳ bản nào | https://git-scm.com |
| Tài khoản Neon | free tier là đủ | https://neon.tech |
| Discord app + bot token | quyền `bot` + `applications.commands` | https://discord.com/developers/applications |
| GitHub token có quyền `gist` | dùng lưu kho shop/plugin | https://github.com/settings/tokens |
| Tài khoản Render (hoặc VPS) | để deploy 24/7 | https://render.com |
| (Tuỳ chọn) Cloudflare | làm proxy cho Hanami | https://dash.cloudflare.com |

Kiểm tra Node:

```bash
node --version     # phải >= v18
npm --version
```

---

<a id="2-tạo-database-neon-từng-bước-một"></a>

## 2. Tạo database Neon — từng bước một

Đây là phần quan trọng nhất. Làm **đúng thứ tự** từng bước bên dưới.

### Bước 2.1 — Đăng ký / đăng nhập Neon

1. Mở trình duyệt, vào **https://neon.tech**.
2. Góc trên bên phải bấm **Sign Up**.
3. Chọn một cách đăng nhập:
   - **Continue with GitHub** (nhanh nhất, khuyến nghị), hoặc
   - **Continue with Google**, hoặc
   - **Sign up with Email** → nhập email → mở email xác nhận → bấm link xác nhận.
4. Nếu dùng GitHub: trang GitHub sẽ hỏi **Authorize Neon** → bấm **Authorize**.
5. Sau khi xác nhận bạn sẽ tới **Neon Console** tại `https://console.neon.tech`.

### Bước 2.2 — Tạo Project (chứa database)

1. Trong Neon Console, bấm nút **New Project** (hoặc **Create a project** nếu trang còn trống).
2. Điền các ô:
   - **Project name**: gõ `nigaria-cloud` (hoặc tên bất kỳ).
   - **Region**: chọn khu vực gần nơi deploy nhất. Nếu deploy Render ở Mỹ → chọn `US East (Ashburn)` / `us-east-1`. Nếu ở châu Á → `Asia Pacific (Singapore)`. **Chọn xong không đổi được sau này**, nên cân nhắc kỹ.
   - **PostgreSQL version**: giữ mặc định (16 hoặc 17 đều được).
   - **Compute size**: giữ `0.25 CU` (free tier).
3. Bấm **Create Project**.
4. Đợi 10–30 giây cho project khởi tạo. Bạn sẽ thấy màn hình **Dashboard** với ô **Connection string**.

> Neon free tier sẽ **tự ngủ (suspend)** sau một thời gian không có request. Lần đầu kết nối sau khi ngủ có thể chậm ~1 giây — đây là hành vi bình thường, không phải lỗi.

<a id="23-lấy-connection-string-chuỗi-kết-nối"></a>

### Bước 2.3 — Lấy connection string (chuỗi kết nối)

1. Trong Dashboard của project vừa tạo, tìm ô có nhãn **Connection string**.
2. Ở phần **Connection string**, bạn sẽ thấy các lựa chọn:
   - **Role**: chọn `neondb_owner` (role mặc định, có full quyền).
   - **Database**: chọn `neondb` (database mặc định).
   - Chuyển sang tab **Pooled connection** (khuyến nghị) thay vì **Direct connection**.
     - Pooled có cụm `-pooler` trong hostname, ví dụ `ep-xxxx-pooler.us-east-1.aws.neon.tech`.
     - Dùng Pooled để không vượt giới hạn số connection của free tier.
3. Bấm **Copy** để copy chuỗi. Nó có dạng:

```
postgresql://neondb_owner:MAT_KHAU_CUA_BAN@ep-xxxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

4. Giải thích từng phần:

| Thành phần | Ý nghĩa |
|---|---|
| `postgresql://` | Giao thức Postgres (node-postgres `pg` hiểu được) |
| `neondb_owner` | Tên role (user) |
| `MAT_KHAU_CUA_BAN` | Mật khẩu role — **coi như secret, không chia sẻ** |
| `ep-xxxx-pooler...` | Endpoint có pooler (đầu cuối kết nối) |
| `/neondb` | Tên database |
| `?sslmode=require` | **Bắt buộc** — Neon chỉ nhận kết nối TLS |
| `&channel_binding=require` | Tham số Neon thêm. `pg` thường bỏ qua được. Nếu app báo lỗi liên quan tới `channel_binding`, xoá tham số này nhưng **giữ lại `sslmode=require`**. |

5. **Quên mật khẩu?** Vào Dashboard → phần **Connection string** → bấm **Reset password** (hoặc tab **Roles** → `neondb_owner` → **Reset password**) → copy chuỗi mới.

6. Dán chuỗi vào file `.env` ở bước [4.3](#43-điền-file-env), dòng:

```env
DATABASE_URL=postgresql://neondb_owner:...@ep-...-pooler.../neondb?sslmode=require
```

> ⚠️ Không được đưa `DATABASE_URL` thật vào `help.md`, README, ảnh chụp màn hình public hay commit lên GitHub. Repo này đang **public**.

### Bước 2.4 — Kiểm tra kết nối trước khi tạo bảng

Vào Neon Console → **SQL Editor** (sidebar bên trái) → **New query** → dán:

```sql
SELECT current_database(), current_user, version();
```

Bấm **Run**. Kết quả phải hiện `neondb`, `neondb_owner` và chuỗi PostgreSQL. Nếu lỗi, quay lại bước 2.3 kiểm tra role/password.

---

<a id="3-chạy-schema-tạo-22-bảng"></a>

## 3. Chạy schema, tạo 22 bảng

### Bước 3.1 — Mở SQL Editor

1. Vẫn trong Neon Console, bấm **SQL Editor** ở sidebar.
2. Bấm **New query** (tạo tab query mới).

### Bước 3.2 — Dán nội dung file schema

1. Mở file `neon-schema.sql` trong repo này bằng editor bất kỳ.
2. Chọn toàn bộ (`Ctrl+A` / `Cmd+A`) → copy (`Ctrl+C`).
3. Dán vào ô query của Neon (`Ctrl+V`).
4. Bấm **Run** (góc trên bên phải, hoặc `Ctrl+Enter`).

### Bước 3.3 — Kiểm tra kết quả

- Phần output phải hiện thông báo kiểu `Success. 0 rows returned` / các lệnh `CREATE TABLE` thành công.
- File schema được thiết kế **idempotent** (`create table if not exists`, `add column if not exists`), nên chạy lại nhiều lần **không xoá dữ liệu**.

Nếu có lỗi, đọc thông báo đỏ: thường là do thiếu quote hoặc dán thiếu một đoạn. Copy lại từ đầu file.

### Bước 3.4 — Xác nhận 22 bảng đã tồn tại

Dán query kiểm tra:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Bạn phải thấy đủ 22 bảng:

```
acoin_balances      daily_limits        link_stats          purchases           shops
admins              device_accounts     orders              reviews             transfers
complaints          gift_codes          payouts             sellers             user_coins
gmail_tasks         plugins             sessions            web_sessions
kv                  shop_items          web_users
```

### Bước 3.5 — Kiểm tra bảng rỗng

```sql
SELECT count(*) AS so_kv FROM kv;
SELECT count(*) AS so_user FROM web_users;
```

Kết quả phải là `0` (database mới tinh).

### Bước 3.6 — (Tuỳ chọn) Cấp lại quyền nếu dùng role khác

Nếu bạn tạo role riêng thay vì `neondb_owner`, chạy:

```sql
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ten_role_cua_ban;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ten_role_cua_ban;
```

---

<a id="4-cài-đặt-và-chạy-local"></a>

## 4. Cài đặt và chạy local

### Bước 4.1 — Clone repo

```bash
git clone https://github.com/hn178050-cyber/botdc.git
cd botdc
```

### Bước 4.2 — Cài dependency

```bash
npm install
```

Lệnh này cài `express`, `discord.js`, `pg`, `ioredis`, v.v. Kiểm tra:

```bash
node -e "require('pg'); require('express'); console.log('OK')"
```

<a id="43-điền-file-env"></a>

### Bước 4.3 — Điền file `.env`

```bash
cp .env.example .env
nano .env
```

Tối thiểu để chạy web có Neon:

```env
DATABASE_URL=postgresql://neondb_owner:...@ep-...-pooler.../neondb?sslmode=require
DISABLE_BOT=1
PORT=3000
RENDER_DOMAIN=http://localhost:3000
```

`DISABLE_BOT=1` giúp chạy web mà không cần token Discord — rất tiện để test DB trước.

### Bước 4.4 — Start server

```bash
npm start
```

Log mong đợi:

```
[BOT] DISABLE_BOT=1 — bỏ qua đăng nhập Discord (chỉ chạy web).
✅ Web Server đang chạy: http://localhost:3000
[plugin] Đã load 0/0 plugin.
```

Mở `http://localhost:3000` trong trình duyệt.

### Bước 4.5 — Xác nhận app đang dùng Neon (không phải JSON)

Đăng ký một tài khoản thử trên web, rồi vào Neon SQL Editor chạy:

```sql
SELECT id, username, created_at FROM web_users ORDER BY created_at DESC LIMIT 5;
```

Nếu thấy user vừa đăng ký → **Neon đã hoạt động**. Nếu bảng vẫn rỗng nhưng web hiện user, tức là `DATABASE_URL` chưa được đọc → kiểm tra lại file `.env` và restart server.

Cách khác (dùng plugin API): `api.core.dbMode` phải trả về `'neon'`.

### Bước 4.6 — Chế độ dự phòng JSON (khi chưa có Neon)

Nếu xoá dòng `DATABASE_URL` và restart, app tự ghi `./data/local-db.json`. Đây chỉ để dev — **không dùng cho production**. File này đã nằm trong `.gitignore`.

---

<a id="5-cấu-hình-discord-bot"></a>

## 5. Cấu hình Discord bot

### Bước 5.1 — Tạo Application

1. Vào https://discord.com/developers/applications → bấm **New Application**.
2. Đặt tên, ví dụ `NIGARIA CLOUD` → bấm **Create**.

<a id="52-tạo-bot--lấy-token"></a>

### Bước 5.2 — Tạo Bot & lấy token

1. Sidebar trái → tab **Bot** → bấm **Reset Token** (nếu chưa có thì nút là **Add Bot** → sau đó **Reset Token**).
2. Xác nhận bằng mật khẩu Discord nếu được hỏi.
3. Bấm **Copy** → dán vào `.env`:

```env
DISCORD_TOKEN=token_dai_cua_ban
```

> Token này giống mật khẩu. Nếu lộ, quay lại trang Bot bấm **Reset Token** để tạo token mới.

### Bước 5.3 — Bật Intent

Cùng tab **Bot**, kéo xuống mục **Privileged Gateway Intents**, bật:

- ✅ **Presence Intent** (tuỳ, nhưng nên bật)
- ✅ **Server Members Intent**
- ✅ **Message Content Intent** (bắt buộc để bot đọc tin nhắn)

Bấm **Save Changes**.

### Bước 5.4 — Mời bot vào server

1. Sidebar → **OAuth2** → **URL Generator**.
2. **Scopes**: tick `bot` và `applications.commands`.
3. **Bot Permissions**: tick ít nhất:
   - `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`,
   - `Use External Emojis`, `Add Reactions`.
4. Copy URL sinh ra ở ô **Generated URL**, dán vào trình duyệt.
5. Chọn server → **Authorize** → xác nhận captcha.

### Bước 5.5 — Lấy ID admin

1. Trong Discord, bật **User Settings → Advanced → Developer Mode**.
2. Chuột phải vào tên user của bạn → **Copy User ID**.
3. Dán vào `.env`:

```env
ADMIN_DISCORD_ID=123456789012345678
```

Nếu có nhiều admin, cách nhau bằng dấu phẩy: `ID1,ID2,ID3`.

### Bước 5.6 — Kiểm tra slash command

Restart bot không có `DISABLE_BOT`:

```bash
# xoá hoặc comment dòng DISABLE_BOT trong .env
npm start
```

Vào server Discord, gõ `/` → phải thấy danh sách 28 lệnh (xem [mục 11](#11-slash-commands-a-z)). Slash command có thể mất tới 1 giờ để Discord register lần đầu; nếu chưa hiện, đợi rồi reload Discord (`Ctrl+R`).

---

<a id="6-github-token-cho-gist"></a>

## 6. GitHub token cho Gist

Dùng để lưu **kho shop** và **source plugin** trong secret gist.

### Bước 6.1 — Tạo token

1. Vào https://github.com/settings/tokens.
2. Bấm **Generate new token** → **Generate new token (classic)**.
3. **Note**: gõ `nigaria-cloud`.
4. **Expiration**: chọn `No expiration` hoặc 90 days (nhớ gia hạn nếu chọn có hạn).
5. Tick **duy nhất ô `gist`**.
6. Bấm **Generate token** → copy token.

### Bước 6.2 — Cấu hình

```env
GITHUB_TOKEN=ghp_...
```

### Bước 6.3 — Hành vi

- Khi admin tạo sản phẩm có kho, server tạo **1 secret gist** chứa danh sách tài khoản (mỗi dòng 1 tài khoản).
- Khi người dùng mua N tài khoản, server lấy N dòng đầu, ghi lại gist với phần còn lại và trừ tồn kho.
- Nếu **không có** `GITHUB_TOKEN`, kho được lưu tạm trong Neon (cột `stock_content` của `shop_items`) để test.

Tên file gist do app tạo: `nigaria-chat.json`, `nigaria-orders.json`, `nigaria-links.json`, `nigaria-<tên>.js`.

---

<a id="7-bảng-biến-môi-trường"></a>

## 7. Bảng biến môi trường

Copy từ `.env.example`, điền những cái bạn dùng. **Mọi thay đổi `.env` đều cần restart server.**

| Biến | Bắt buộc | Ý nghĩa / giá trị mẫu |
|---|---|---|
| `DATABASE_URL` | ✅ production | Chuỗi Neon từ [bước 2.3](#23-lấy-connection-string-chuỗi-kết-nối). Alias: `NEON_DATABASE_URL`. |
| `DISCORD_TOKEN` | ✅ nếu chạy bot | Token bot từ [bước 5.2](#52-tạo-bot--lấy-token). |
| `ADMIN_DISCORD_ID` | ✅ | ID user làm admin, cách nhau `,`. |
| `DISABLE_BOT` | không | `1` = chỉ chạy web, không login Discord. |
| `PORT` | không | Mặc định `3000`. Render tự inject `PORT`. |
| `RENDER_DOMAIN` | ✅ | Domain công khai, dùng tạo link task. Local: `http://localhost:3000`. |
| `COOKIE_SECURE` | không | `1` khi chạy sau HTTPS (cookie chỉ gửi qua HTTPS). |
| `GITHUB_TOKEN` | khuyến nghị | Token có quyền `gist`. |
| `LINK4M_API_KEY` | không | API key Link4M (+50 xu, 2 lần/ngày). |
| `LAYMA_TOKEN` | không | Token LayMa (+50 xu, 2 lần/ngày). |
| `BBMKTS_API_TOKEN` | không | Token bbmkts (+25 xu, 1 lần/ngày). Alias cũ: `VUOTNHANH_API_TOKEN`. |
| `LEADERBOARD_WEBHOOK_URL` | không | Discord webhook thông báo trả thưởng tuần + BXH. |
| `YTB_CHANNEL_URL` | không | Link kênh YouTube cho nhiệm vụ `/star`. |
| `STAR_CHANNEL_NAME` | không | Tên channel star, mặc định `star`. |
| `HANAMI_TOKEN` | không | Token mua cloud Hanami. |
| `HANAMI_USE_PROXY` | không | `1` = Hanami đi qua `API_PROXY`. |
| `API_PROXY` | không | Cloudflare Worker `https://...` hoặc `socks5h://user:pass@host:1080`. |
| `API_PROXY_KEY` | không | Giá trị secret `PROXY_KEY` của Worker. |
| `APIKEY` | không | Key gọi edge function đăng ký VMOS. |
| `VSPHONE_API_URL` / `VSPHONE_API_KEY` | không | Cấu hình reg VSPhone. |
| `EXCHANGE_COIN_PER_ACOIN` | không | Tỷ giá, mặc định 5 coin = 1 ACOIN. |
| `MARKETPLACE_DATA_DIR` | không | Thư mục lưu chat/order khi không dùng Gist, mặc định `./data`. |
| `LOCAL_DB_FILE` | không | Đường dẫn JSON fallback, mặc định `./data/local-db.json`. |
| `ADMIN_IP_WHITELIST` | không | IP được bypass rate limit, cách nhau `,`. |

---

<a id="8-deploy-production-render"></a>

## 8. Deploy production (Render)

### Bước 8.1 — Đẩy code lên GitHub

Repo này đã public tại `https://github.com/hn178050-cyber/botdc`. Nếu bạn tự fork/sửa:

```bash
git status
git add -A
git commit -m "mo ta thay doi"
git push origin main
```

### Bước 8.2 — Tạo Web Service trên Render

1. Vào https://dashboard.render.com → **New +** → **Web Service**.
2. Connect GitHub account → chọn repo `botdc` → **Connect**.
3. Điền:
   - **Name**: `nigaria-cloud`
   - **Region**: cùng region với Neon (để giảm độ trễ).
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
     - Nếu cần WARP/SOCKS5 cho Hanami: dùng `bash scripts/render-start.sh` thay vì `npm start`.
   - **Instance Type**: `Free` (đủ chạy) hoặc `Starter` nếu cần ổn định hơn.
4. Kéo xuống **Environment Variables** → bấm **Add Environment Variable** → thêm **từng biến** trong [mục 7](#7-bảng-biến-môi-trường). Quan trọng nhất: `DATABASE_URL`, `DISCORD_TOKEN`, `ADMIN_DISCORD_ID`, `RENDER_DOMAIN`, `GITHUB_TOKEN`.
   - `RENDER_DOMAIN` điền domain Render sau khi có, dạng `https://nigaria-cloud.onrender.com`.
   - `COOKIE_SECURE=1` vì Render dùng HTTPS.
5. Bấm **Create Web Service**.

### Bước 8.3 — Theo dõi deploy

- Tab **Logs** phải hiện:

```
[BOT] Đã đăng nhập: ...
✅ Web Server đang chạy: ...
```

- Nếu log báo `Neon Error: ...`, quay lại kiểm tra `DATABASE_URL` (đặc biệt là `sslmode=require` và dấu ngoặc kép/khoảng trắng khi dán).

### Bước 8.4 — Cập nhật domain

Khi Render cấp domain (`https://xxx.onrender.com`):

1. Vào service → **Environment** → sửa `RENDER_DOMAIN` thành domain đó.
2. Render tự restart. Nếu không, bấm **Manual Deploy → Deploy latest commit**.

### Bước 8.5 — Kiểm tra production

```bash
curl -fsS https://xxx.onrender.com/          # phải trả HTML
curl -fsS https://xxx.onrender.com/api/tasks # phải trả JSON (có thể báo cần login)
```

Vào Neon SQL Editor chạy lại `SELECT count(*) FROM web_users;` sau khi đăng ký thử trên production để chắc chắn dữ liệu ghi vào Neon.

---

<a id="9-proxy-cloudflare-tuỳ-chọn"></a>

## 9. Proxy Cloudflare (tuỳ chọn)

Chỉ cần khi IP Render bị Hanami/Cloudflare chặn (`HTTP 403`).

### Bước 9.1 — Tạo Worker

1. Vào https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
2. Đặt tên, ví dụ `nigaria-hanami-proxy` → **Deploy**.
3. Bấm **Edit code** → xoá hết code mặc định → dán toàn bộ nội dung `cloudflare-proxy-worker.js` → **Deploy**.
4. Worker chỉ cho phép hostname `hanaminikata.com` (không phải open proxy).

### Bước 9.2 — Đặt secret (khuyến nghị)

1. Trong Worker → tab **Settings** → **Variables** → **Add variable** → chọn type **Secret**.
2. Tên: `PROXY_KEY`, giá trị: chuỗi ngẫu nhiên của bạn → **Deploy**.

### Bước 9.3 — Cấu hình app

```env
HANAMI_USE_PROXY=1
API_PROXY=https://nigaria-hanami-proxy.<your-subdomain>.workers.dev
API_PROXY_KEY=<giá trị PROXY_KEY>
```

Restart app. Nếu dùng SOCKS5/WARP userspace thay vì Worker, xem `scripts/render-start.sh` và `scripts/warp-wireproxy.sh`.

---

<a id="10-web-dashboard-a-z"></a>

## 10. Web dashboard A–Z

### 10.1 Đăng ký / đăng nhập

1. Mở domain web → màn hình đăng nhập.
2. **Đăng ký**: nhập username (**phải có ít nhất 1 chữ cái**, 3–24 ký tự) + password (≥ 6 ký tự) → **Tạo tài khoản**.
3. **Đăng nhập** bằng username/password, hoặc bằng **token Discord** (xem [10.9](#109-hồ-sơ--token)).
4. Tài khoản cũ chỉ toàn số sẽ bị ép đổi tên lần đầu login.

### 10.2 Đồng hồ xu & điểm danh

- Số dư hiện ở góc trên. Nút **Claim** nhận random **1–20 xu** mỗi ngày (dùng chung bucket với `/daily` Discord).
- Đã vượt ≥ 1 link trong ngày → mỗi ngày lấy thêm **1 tài khoản VMOS free** hoặc **1 VSPhone free** (tuỳ cấu hình), không trừ xu.

### 10.3 Shop

- Tab **Shop**: xem sản phẩm, giá, tồn kho, logo.
- Chọn số lượng → **Mua** → tài khoản hiện trong **Tài khoản của bạn** → **Copy tất cả**.
- Admin tạo sản phẩm trong **Quản trị → Sản phẩm**: tên, giá, mô tả, logo, dán kho (mỗi dòng 1 account) → server đẩy lên Gist.

### 10.4 Mua device

- Tab **Mua Cloud**: chọn provider `VM / UG / VS`, điền dữ liệu (nếu UG thì chọn region), bấm **Mua Cloud**. Đây là luồng **Hanami**.
- Card **Reg tài khoản**: `VMOS Cloud`, `VSPhone`, `VMOS Free`, `VSPhone Free`. Phí reg 10 xu, chỉ trừ khi thành công.

### 10.5 Nhiệm vụ vượt link

- Tab **Nhiệm vụ**: 3 provider dùng chung cấu hình `link-providers.js`:
  - Link4M: +50 xu, tối đa 2 lần/ngày.
  - LayMa: +50 xu, tối đa 2 lần/ngày.
  - bbmkts: +25 xu, tối đa 1 lần/ngày.
- Bấm **Lấy link** → vượt link → hệ thống tự cộng xu. Web và Discord đọc **cùng một cấu hình** nên reward luôn khớp.

### 10.6 Giftcode

- Nhập mã tạo bởi `/gen` → nhận xu. Mã dùng 1 lần.

### 10.7 Bảng xếp hạng

3 tab:

| Tab | Tính | Thưởng |
|---|---|---|
| Coin | số dư hiện tại | không |
| Link 7 ngày | số link trong kỳ | có (top 1: 300, top 2: 150, top 3: 75, top 4–10: 40 xu) |
| Link tổng | cộng dồn mọi kỳ | không |

Kỳ link reset sau mỗi lần trả thưởng (Chủ nhật, hoặc admin bấm thủ công trong Quản trị).

### 10.8 Chuyển xu / ACOIN / Marketplace

- **Chuyển xu**: nhập tên người nhận + số lượng → phí 5%.
- **ACOIN**: đơn vị marketplace. Tỷ giá mặc định **5 coin = 1 ACOIN**. Đổi 2 chiều bằng `/exchange` hoặc trong trang Market.
- **Seller**: gửi yêu cầu bằng `/seller request` → admin duyệt `/seller trust`. Seller không active 30 ngày bị giáng quyền, 180 ngày bị xoá.
- `/shops` tìm shop (lọc `recommended`, `newest`, `oldest`, `cheapest`, `priciest`, `topRated`, `bestSelling`).

<a id="109-hồ-sơ--token"></a>

### 10.9 Hồ sơ & token

- Đổi mật khẩu (cần mật khẩu hiện tại).
- Copy **link token** — dùng để:
  - Đăng nhập web bằng token.
  - Liên kết Discord: `/connect <token>` → coin web + coin Discord **cộng dồn**.

### 10.10 Trang Quản trị

Chỉ hiện sau khi liên kết Discord với tài khoản admin. Các tab:

| Tab | Làm được |
|---|---|
| **Tổng quan** | Số liệu, thưởng tuần, nút trả thưởng, cài mức thưởng top 1–10 |
| **Người dùng** | Danh sách user, cộng/trừ/đặt xu, xử lý đơn, lịch sử thưởng |
| **Sản phẩm** | Tạo/sửa/xoá item, upload kho lên Gist, đổi giá |
| **Plugin** | Cài/sửa/reload/xoá plugin bằng link raw script |
| **Google** | Duyệt Gmail task, chỉnh link YouTube/Discord |
| **Market** | Cấu hình tỷ giá, duyệt seller/review/khiếu nại |
| **Giao diện** | Đổi ảnh nền, theme Bubble/Classic, ngôn ngữ VI/EN |

Ảnh nền mặc định: `https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQl1K8O2o7bsOUGL4ZqQVEkPiYlc5Mqd8XvTHgLND1FZA&s=10`. Có thể đổi bằng `/wallpaper` hoặc tab Giao diện; lưu trong `kv` key `admin_background_url` trên Neon.

---

<a id="11-slash-commands-a-z"></a>

## 11. Slash commands A–Z

Tất cả lệnh được đăng ký từ `server.js`. Một số lệnh có thêm option (trong ngoặc).

| Lệnh | Chức năng |
|---|---|
| `/acoin` | Xem số dư ACOIN + tỷ giá hiện tại |
| `/adcoin (sotien, nguoinhan)` | Admin cộng/trừ xu cho user |
| `/appeal (id, note)` | Admin duyệt/từ chối review, khiếu nại |
| `/buy (item_id, soluong)` | Mua sản phẩm shop |
| `/buycloud` | Panel mua cloud Hanami (UG / VM / VS) |
| `/clear (soluong)` | Xoá tin nhắn |
| `/code` | Xem/cấp giftcode |
| `/connect (token)` | Liên kết tài khoản web với Discord |
| `/daily` | Điểm danh nhận 1–20 xu |
| `/exchange (loai, soluong)` | Đổi coin ↔ ACOIN |
| `/gen (soluong, sotien)` | Admin tạo giftcode |
| `/getlink (provider)` | Lấy link nhiệm vụ (Link4M/LayMa/bbmkts) |
| `/history (loai)` | Lịch sử mua/chuyển xu |
| `/leaderboard` | Bảng xếp hạng coin/link |
| `/op (user)` | Admin cấp quyền admin |
| `/pay (nguoinhan, sotien)` | Chuyển xu (phí 5%) |
| `/plugin (ten, lenh)` | Gọi lệnh do plugin đăng ký |
| `/reg` | Panel chọn dịch vụ: VMOS/VSPhone (10 xu) + bản free |
| `/seller (hanhdong, user/id)` | `request` / `trust` / `list` seller |
| `/sdone` | Xác nhận nhiệm vụ /star |
| `/shop` | Xem shop, giá, tồn kho |
| `/shops (q, filter)` | Tìm shop marketplace |
| `/star` | Đăng ký nhiệm vụ YouTube/star |
| `/tasks` | Tiến độ vượt link hôm nay |
| `/theme (kieu)` | Đổi giao diện `bubble` / `classic` |
| `/token` | Lấy token cố định của tài khoản |
| `/unop (user)` | Admin thu hồi quyền admin |
| `/username (ten_moi)` | Đổi tên tài khoản web đã liên kết |
| `/vi` | Xem ví / số dư |
| `/vmosfree` | 1 VMOS free mỗi ngày (cần ≥1 link) |
| `/vsphonefree` | 1 VSPhone free mỗi ngày (cần ≥1 link) |
| `/wallpaper (url)` | Admin đổi ảnh nền web |

> Lưu ý: `/asynctas` và `/meows` **đã bị xoá** trong bản NIGARIA CLOUD (toàn bộ luồng meows.vn đã gỡ bỏ).

---

<a id="12-plugin-a-z"></a>

## 12. Plugin A–Z

Plugin cho phép thêm API/lệnh mà **không cần deploy lại**.

### Bước 12.1 — Viết plugin

Tạo file JS theo chuẩn CommonJS:

```js
module.exports = function (api) {
  api.get('/hello', (req, res) => res.json({ ok: true }));

  api.command('ping', async ({ interaction }) => {
    await interaction.editReply('pong'); // gọi bằng /plugin ten:ping
  });

  api.events.on('web:daily:claim', ({ userKey, reward }) => {
    api.log(userKey, reward);
  });

  api.plugins.expose('greet', ({ name }) => `Xin chào ${name}!`);
};
```

### Bước 12.2 — Host file

Upload file lên URL raw (ví dụ GitHub Gist raw: `https://gist.githubusercontent.com/.../raw/plugin.js`). Restrictions:

- Tối đa **200KB**.
- Tải trong **15 giây**.
- Phần chạy đồng bộ trong `vm` có timeout **5 giây**; cross-plugin call timeout **10 giây**.

### Bước 12.3 — Cài qua web

1. Vào **Quản trị → Plugin**.
2. Nhập **tên plugin**, dán **link raw script**.
3. Bấm **Tải & kích hoạt**.
4. Server tải script → lưu vào secret gist → lưu `gist_id` vào bảng `plugins` trên Neon → load ngay.

### Bước 12.4 — Kiểm tra

- Web: `GET /plugin/<plugin-id>/hello`.
- Discord: `/plugin <ten>:ping`.
- Reload trong tab Plugin để lấy source mới từ gist.

### Bước 12.5 — API chính

| API | Mô tả |
|---|---|
| `api.core.dbMode` | `'neon'` khi có `DATABASE_URL`, else `'local'` |
| `api.get/post(...)` | Đăng route web |
| `api.command(name, fn)` | Đăng lệnh Discord |
| `api.events.on(event, fn)` | Lắng nghe event `web:*` / `bot:*` |
| `api.plugins.expose/call` | Gọi chéo plugin |
| `api.db` | DB module đầy đủ (cẩn thận: có cả hash mật khẩu, token) |
| `api.coins` | Coin user |
| `api.services` | `regVmos`, `regVsphone`, `buyHanami`, `costs.reg` |
| `api.web.balanceKey` | Khoá số dư |
| `api.kv` | KV trên Neon |
| `api.log` | Ghi log |

Tài liệu đầy đủ: [`docs/PLUGINS.md`](./docs/PLUGINS.md).

> ⚠️ Sandbox `vm` **không phải hàng rào bảo mật tuyệt đối**. Chỉ cài plugin từ nguồn bạn tin tưởng. Route plugin mặc định public nếu bạn không tự kiểm tra quyền.

---

<a id="13-dữ-liệu-nằm-ở-đâu"></a>

## 13. Dữ liệu nằm ở đâu

### 13.1 Trên Neon (22 bảng)

| Bảng | Dùng cho |
|---|---|
| `user_coins` | Số dư coin (Discord + web) |
| `acoin_balances` | Số dư ACOIN |
| `web_users` | Tài khoản web (username, password_hash, link_token, discord_id) |
| `web_sessions` | Session cookie web |
| `sessions` | Session vượt link |
| `gift_codes` | Mã quà |
| `daily_limits` | Giới hạn link/ngày |
| `admins` | Danh sách admin |
| `kv` | Cấu hình: background, social links, tỷ giá, mức thưởng, coin_version... |
| `link_stats` | BXH link theo kỳ + tổng |
| `shop_items` | Sản phẩm shop (cả item hệ thống lẫn seller) |
| `purchases` | Lịch sử mua shop hệ thống |
| `transfers` | Lịch sử chuyển xu |
| `payouts` | Lịch sử trả thưởng tuần |
| `plugins` | Tên, nguồn, gist_id, trạng thái plugin |
| `sellers` | Seller marketplace |
| `shops` | User-shop |
| `orders` | Đơn marketplace |
| `reviews` | Review shop |
| `complaints` | Khiếu nại |
| `device_accounts` | Gán device cho user |
| `gmail_tasks` | Nhiệm vụ Gmail chờ duyệt |

### 13.2 Ngoài Neon

| Nguồn | Dữ liệu |
|---|---|
| VMOS edge function (`services.js`, URL hardcode) | Tài khoản VMOS |
| GitHub Gist (secret) | Kho shop, source plugin, chat/order history |
| JSON local `./data/local-db.json` | Chỉ khi không có `DATABASE_URL` |

**Không có cơ chế tự migrate JSON → Neon.** Khi chuyển từ dev sang production, database Neon là mới tinh — đây là hành vi cố ý để tránh ghi dữ liệu test lên production.

---

<a id="14-sao-lưu--phục-hồi"></a>

## 14. Sao lưu / phục hồi

### Bước 14.1 — Backup bằng `pg_dump`

Lấy connection string từ [bước 2.3](#23-lấy-connection-string-chuỗi-kết-nối), rồi:

```bash
pg_dump "postgresql://neondb_owner:...@ep-...-pooler.../neondb?sslmode=require" \
  > backup-$(date +%F).sql
```

Nếu máy không có `pg_dump`: cài PostgreSQL client (`sudo apt install postgresql-client`) hoặc dùng Neon SQL Editor → **Export** (tuỳ phiên bản console).

### Bước 14.2 — Phục hồi

```bash
psql "postgresql://..." -f backup-2026-11-26.sql
```

### Bước 14.3 — Backup nhanh bằng SQL Editor

```sql
COPY (SELECT * FROM user_coins) TO STDOUT WITH CSV HEADER;
```

### Bước 14.4 — Kiểm tra sau restore

```sql
SELECT 'user_coins' AS bang, count(*) FROM user_coins
UNION ALL SELECT 'web_users', count(*) FROM web_users
UNION ALL SELECT 'shop_items', count(*) FROM shop_items
UNION ALL SELECT 'orders', count(*) FROM orders;
```

---

<a id="15-xử-lý-lỗi-thường-gặp"></a>

## 15. Xử lý lỗi thường gặp

| Triệu chứng | Nguyên nhân | Cách fix |
|---|---|---|
| `Neon Error: password authentication failed` | Sai mật khẩu trong `DATABASE_URL` | Neon Console → **Reset password** → copy chuỗi mới → sửa `.env` → restart |
| `Neon Error: connection refused / timeout` | Dùng Direct thay vì Pooled, hoặc region khác | Dùng chuỗi có `-pooler`; kiểm tra `sslmode=require`; thử lại sau vài giây (Neon đang wake) |
| `relation "web_users" does not exist` | Chưa chạy schema | Làm lại [mục 3](#3-chạy-schema-tạo-22-bảng) |
| Web hiện user nhưng Neon vẫn rỗng | App đang chế độ `local` | Kiểm tra `DATABASE_URL` có được load không; `api.core.dbMode` phải là `'neon'`; restart |
| Coin không cập nhật trên web | Khác `coin_version` | Web tự reload khi nhãn đổi. Nếu vẫn không, đăng nhập lại |
| Bot không hiện slash command | Discord chưa register | Đợi tới 1 giờ, reload Discord (`Ctrl+R`), kiểm tra scope `applications.commands` |
| `403 Your account is suspended` từ GitHub | Token/account GitHub bị khoá | Dùng token account khác (`gh api user` để kiểm tra) |
| Cloudflare `HTTP 403` khi mua cloud | IP Render bị chặn | Bật [mục 9](#9-proxy-cloudflare-tuỳ-chọn): `HANAMI_USE_PROXY=1` + `API_PROXY` |
| `Gist rate limit` | Quá nhiều request GitHub | Đợi reset, hoặc bỏ `GITHUB_TOKEN` để dùng `stock_content` trên Neon |
| `Cannot POST /api/register` | Sai endpoint | Đường dúng là `/api/auth/register` |
| Lỗi sau khi sửa `.env` | Biến chỉ đọc lúc start | Restart server / Render service |
| `channel_binding` unsupported | Tham số Neon thêm | Xoá `&channel_binding=require`, giữ `?sslmode=require` |

### Kiểm tra nhanh trạng thái DB

```bash
# Xem chế độ DB qua log
grep -i "neon\|local" /var/log/dev.log

# Hoặc trong plugin/API
api.core.dbMode   # 'neon' | 'local'
```

---

<a id="16-bảo-mật"></a>

## 16. Bảo mật

1. **Không commit `.env`** — file này đã nằm trong `.gitignore`.
2. Repo đang **public**: tuyệt đối không dán `DATABASE_URL`, `DISCORD_TOKEN`, `GITHUB_TOKEN` vào file markdown/code.
3. Nếu lộ token:
   - Neon: Console → **Reset password**.
   - Discord: Developer Portal → Bot → **Reset Token**.
   - GitHub: https://github.com/settings/tokens → **Revoke** → tạo token mới.
4. Mật khẩu web hash bằng `scrypt`; session lưu dạng hash SHA-256 trong Neon; cookie `HttpOnly` (thêm `Secure` khi `COOKIE_SECURE=1`).
5. Mọi thao tác coin/shop/admin đều kiểm tra quyền phía server.
6. Chỉ cài plugin từ nguồn tin cậy — plugin chạy chung process, có thể đọc `api.db`.
7. Không đưa raw `interaction`, `req`, token hay cookie vào event payload (đã cố ý thiết kế như vậy).

---

<a id="17-faq-nhanh"></a>

## 17. FAQ nhanh

**H: Có cần chạy Supabase không?**
A: Không. Bản NIGARIA CLOUD đã xoá hoàn toàn Supabase REST (`SUPABASE_URL`/`SUPABASE_KEY`). Chỉ còn edge function VMOS (URL hardcode trong `services.js`) — đừng xoá cái đó.

**H: Có bắt buộc phải dùng Gist không?**
A: Không. Thiếu `GITHUB_TOKEN` thì kho shop lưu trong cột `stock_content` của bảng `shop_items` trên Neon.

**H: Dùng `DATABASE_URL` Direct thay vì Pooled được không?**
A: Được, nhưng free tier Neon có giới hạn connection. Khi bot + web cùng chạy, Pooled ổn định hơn.

**H: Neon tự ngủ có làm bot crash không?**
A: Không. Request đầu sau khi ngủ chậm ~1 giây, `pg` đã cấu hình `connectionTimeoutMillis: 10000`.

**H: Làm sao biết app đang ghi vào Neon?**
A: Đăng ký user thử → chạy `SELECT * FROM web_users ORDER BY created_at DESC LIMIT 1;` trong SQL Editor.

**H: Muốn đổi region Neon sau khi tạo?**
A: Không đổi được. Phải tạo project mới, chạy lại schema, rồi cập nhật `DATABASE_URL`.

**H: Background mặc định ở đâu?**
A: Hằng số `DEFAULT_BACKGROUND_URL` trong `web.js` và biến `--wallpaper` trong `public/styles.css`. Admin đổi bằng `/wallpaper` hoặc tab Giao diện — giá trị lưu trong `kv` trên Neon.

---

**Hết tài liệu.** Nếu làm đúng từ [mục 2](#2-tạo-database-neon-từng-bước-một) đến [mục 8](#8-deploy-production-render), bạn có một hệ thống chạy 24/7 với toàn bộ dữ liệu trên Neon.
