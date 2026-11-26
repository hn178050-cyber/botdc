# NIGARIA CLOUD — Discord Bot + Web Dashboard

Bot Discord bán/đăng ký tài khoản cloud kèm **web dashboard** đầy đủ: tài khoản web riêng,
shop lưu kho trên GitHub Gist, nhiệm vụ vượt link, bảng xếp hạng và trang quản trị.

**📖 Hướng dẫn đầy đủ A–Z (cài đặt, lấy DB Neon, deploy, vận hành, xử lý lỗi): [help.md](./help.md)**

## Tính năng

### Bot Discord
- `/reg` — panel chọn dịch vụ: VMOS (10 xu) và VSPhone (10 xu), kèm bản free mỗi ngày.
- `/buycloud` — mua máy cloud qua Hanami (UGPhone / VMOS / VSPhone).
- `/getlink` — nhận link nhiệm vụ: **Link4M / LayMa +50 xu** (2 lượt/ngày), **bbmkts +25 xu** (1 lượt/ngày).
- `/tasks` — xem tiến độ từng dịch vụ hôm nay (cùng dữ liệu `GET /api/tasks`).
- `/vmosfree` — lấy 1 tài khoản VMOS free mỗi ngày (cần đã vượt ≥ 1 link).
- `/vsphonefree` — lấy 1 VSPhone thường free mỗi ngày (cần đã vượt ≥ 1 link).
- `/theme`, `/username`, `/history`, `/buy`, `/leaderboard` — đồng bộ các chức năng web (giao diện, tên tài khoản, lịch sử mua/chuyển, mua shop, BXH) lên Discord.
- `/wallpaper` — (Admin) đổi ảnh nền web ngay trong Discord.
- `/shop` — xem danh sách sản phẩm, giá, logo và tồn kho.
- `/connect <token>` — liên kết tài khoản web với Discord để **cộng dồn coin** (coin web + coin Discord).
- `/token` — lấy **token cố định** của tài khoản (bằng `web_users.link_token`); dùng để đăng nhập web hoặc `/connect`.
- `/plugin ten:lenh` — gọi lệnh do plugin đăng ký.
- `/vi`, `/daily`, `/code`, `/pay`, `/star`, `/sdone`, `/adcoin`, `/gen`, `/op`, `/unop`, `/clear`.
- `/seller` — gửi yêu cầu làm seller (`request`); admin duyệt (`trust`, chỉ định `user` hoặc `id`) và xem danh sách (`list`).
- `/exchange` — đổi `coin -> ACOIN` hoặc `ACOIN -> coin` theo tỷ giá hiện hành (mặc định **5 coin = 1 ACOIN**).
- `/acoin` — xem số dư ACOIN và tỷ giá quy đổi.
- `/shops` — tìm kiếm shop trên marketplace (lọc theo `recommended` / `newest` / `oldest` / `cheapest` / `priciest` / `topRated` / `bestSelling`).
- `/appeal` — (Admin) chấp nhận hoặc từ chối review/khiếu nại theo `id`, kèm ghi chú.
- Sau khi tạo tài khoản, bot gửi kèm nút **📋 Copy acc|pass** (bấm để nhận lại đúng định dạng `tài khoản|mật_khẩu`).

### Web dashboard
- Đăng ký / đăng nhập tài khoản web riêng (mật khẩu hash bằng scrypt) hoặc đăng nhập bằng **token Discord**.
- Tên đăng nhập phải có **ít nhất 1 chữ cái**; tài khoản cũ chỉ toàn số bị ép đổi tên khi login.
- Số dư coin hiển thị ở góc trên; nút bấm trực quan cho mọi chức năng.
- **Shop**: mua hàng, xem đồ đã mua, copy tài khoản.
- **Giftcode**: nhập mã quà để nhận coin (mã tạo từ lệnh `/gen`).
- **Buy Device**: mua cloud qua Hanami (UGPhone / VMOS / VSPhone), reg tài khoản VMOS/VSPhone và nhận bản free mỗi ngày.
- **Nhiệm vụ**: lấy link vượt link, theo dõi lượt trong ngày & trong tuần. 3 dịch vụ dùng chung cấu hình `link-providers.js`: Link4M/LayMa 50 xu (2 lượt/ngày), **bbmkts 25 xu (1 lượt/ngày)**. Web và bot cùng đọc một cấu hình nên reward luôn đồng nhất.
- **Điểm danh mỗi ngày**: nút claim nhận random **1–20 xu** (cùng bucket với `/daily` Discord). Nếu đã vượt **≥ 1 link** thì mỗi ngày còn lấy được **1 tài khoản VMOS free**, không trừ xu.
- **Xếp hạng**: coin · vượt link **7 ngày** (có thưởng, reset sau mỗi kỳ) · vượt link **tổng** (không thưởng). Tên hiển thị là username, không phải ID số.
- **Chuyển tiền**: chuyển coin cho người khác (phí 5%).
- **Hồ sơ**: đổi mật khẩu, xem/copy token liên kết Discord.
- **Quản trị** (chỉ hiện với tài khoản đã liên kết Discord admin), gồm các tab:
  - **User**: danh sách người dùng, đơn hàng, lịch sử trả thưởng.
  - **Shop**: tạo sản phẩm, upload kho lên GitHub Gist, đặt giá, thêm kho, sửa/xoá.
  - **Plugin**: dán link raw script → tự lưu Gist → lưu gist_id vào DB → load chạy ngay (không deploy lại). Xem [docs/PLUGINS.md](docs/PLUGINS.md).
  - **Google**: duyệt nhiệm vụ Gmail và chỉnh link mạng xã hội.
  - **Market** và **Giao diện**: cấu hình marketplace, ảnh nền dashboard.

### Thưởng bảng xếp hạng vượt link (tự động mỗi Chủ nhật)
| Hạng | Thưởng |
|------|--------|
| Top 1 | 300 coin |
| Top 2 | 150 coin |
| Top 3 | 75 coin |
| Top 4-10 | 40 coin |

Sau khi trả thưởng, bộ đếm vượt link bắt đầu kỳ mới. Có thể chạy thủ công trong trang Quản trị.

## Marketplace, ACOIN và Seller

- **ACOIN** là đơn vị thanh toán của marketplace. Tỷ giá mặc định do KV `exchange_coin_per_acoin` quyết định: **5 coin = 1 ACOIN** (nghĩa là **10 coin = 2 ACOIN**). Dùng `/exchange` để đổi hai chiều; số dư không bao giờ xuống dưới 0 và mỗi lần đổi đều ghi event `bot:exchange`.
- Bảng giá tham khảo: **$100 = 100 ACOIN**. Lệnh `/acoin` hiển thị số dư kèm tỷ giá hiện tại.
- Seller gửi yêu cầu bằng `/seller request`, admin duyệt bằng `/seller trust`. Có thể trust trực tiếp user chưa từng gửi yêu cầu; hệ thống sẽ tạo luôn seller ở trạng thái `active`.
- Duyệt maintenance tự động lúc bot sẵn sàng và sau mỗi 24 giờ: seller **không hoạt động 30 ngày bị giáng quyền**, **180 ngày bị xoá**.
- `/shops` hiển thị tối đa 10 shop (tên, tỷ lệ đánh giá, số lượt bán). `/appeal` cho phép admin override quyết định review/khiếu nại.

## Cài đặt

```bash
npm install
cp .env.example .env   # điền các biến cần thiết
npm start
```

- Mở `http://localhost:3000` để vào dashboard.
- **Toàn bộ dữ liệu** (coin, user, shop, tasks, plugin, marketplace, ACOIN, KV…) lưu trên **Neon PostgreSQL** qua `DATABASE_URL`. Chạy `neon-schema.sql` một lần trong Neon SQL Editor trước khi start.
- Riêng **tài khoản VMOS** vẫn do edge function riêng trong `services.js` quản lý, không nằm trong Neon.
- Kho shop và script plugin lưu trên **GitHub Gist**.
- Nếu chưa có `DATABASE_URL`, app tự fallback sang file JSON `./data/local-db.json` để dev/demo.
- Đặt `DISABLE_BOT=1` nếu chỉ muốn chạy web khi dev.
- Xem [help.md](./help.md) để biết từng bước tạo Neon, lấy connection string, tạo bảng và deploy.

### GitHub Gist (kho shop)
Tạo token GitHub có quyền `gist` và điền `GITHUB_TOKEN`. Khi admin tạo sản phẩm:
1. Server tạo 1 **secret gist** chứa danh sách tài khoản (mỗi dòng 1 tài khoản).
2. Khi có người mua N tài khoản, server lấy N dòng đầu và **ghi lại gist** với phần còn lại
   (tự động xoá tài khoản đã bán), đồng thời cập nhật tồn kho.

Nếu chưa có `GITHUB_TOKEN`, kho được lưu tạm trong DB (chế độ local) để test.

### Plugin (thêm logic/API không cần deploy)
Vào **Quản trị → Plugin**, nhập tên và link raw script (http/https). Server sẽ tải script (tối đa 200KB), lưu vào secret gist, rồi load trong sandbox `vm` và mount route `/plugin/<plugin-id>/...`. Reload luôn đọc từ gist.

**Ngôn ngữ plugin: JavaScript / CommonJS** — không cần build, không dependency.

Script mẫu:
```js
module.exports = function (api) {
  api.get('/hello', (req, res) => res.json({ ok: true }));
  api.command('ping', async ({ interaction }) => {
    await interaction.editReply('pong'); // /plugin <ten>:ping (đã deferReply)
  });
  api.events.on('web:daily:claim', ({ userKey, reward }) => api.log(userKey, reward));
  api.plugins.expose('greet', ({ name }) => `Xin chào ${name}!`);
};
```

📖 **Tài liệu đầy đủ (API + toàn bộ event `web:*` / `bot:*` + bảo mật):** [docs/PLUGINS.md](docs/PLUGINS.md).

Chỉ admin mới được cài/sửa plugin; sandbox chỉ để hạn chế, không phải hàng rào bảo mật tuyệt đối — hãy dùng nguồn script tin cậy.

### Liên kết admin
1. Đăng nhập web, vào **Hồ sơ**, copy token.
2. Trong Discord (tài khoản admin) gõ `/connect <token>`.
3. Mục **Quản trị** sẽ hiện trên dashboard.

Admin được xác định bởi `ADMIN_DISCORD_ID` (owner) hoặc bảng `admins` (cấp qua `/op`).

### Proxy API (tuỳ chọn, dùng cho Hanami)
IP Render đôi khi bị nhà cung cấp/Cloudflare chặn. Proxy sau đây chỉ áp dụng cho luồng mua cloud qua Hanami khi bật `HANAMI_USE_PROXY=1`.

- **Cloudflare Worker:** copy nội dung [`cloudflare-proxy-worker.js`](./cloudflare-proxy-worker.js) vào Cloudflare Dashboard → **Workers & Pages → Create Worker** → dán → Deploy. Worker chỉ forward tới `hanaminikata.com`, nên không thành open proxy. Sau đó set `API_PROXY=https://xxx.your-subdomain.workers.dev`. Nếu Worker đặt secret `PROXY_KEY`, set thêm `API_PROXY_KEY` trên Render để gửi header `x-proxy-key`.
- **SOCKS5/WARP userspace:** dùng [`scripts/warp-wireproxy.sh`](./scripts/warp-wireproxy.sh) hoặc [`scripts/render-start.sh`](./scripts/render-start.sh) rồi set `API_PROXY=socks5h://user:pass@host:1080`.

`wireproxy` là userspace, **không sửa routing table**; Discord gateway, web UI và các luồng khác vẫn đi IP gốc.

## Biến môi trường
Xem `.env.example`. Các biến quan trọng: `DISCORD_TOKEN`, `ADMIN_DISCORD_ID`,
`RENDER_DOMAIN`, `GITHUB_TOKEN`, `HANAMI_TOKEN`, `APIKEY` (edge function VMOS), `HANAMI_USE_PROXY`,
`API_PROXY` / `API_PROXY_KEY` (tuỳ chọn), `LINK4M_API_KEY`, `LAYMA_TOKEN`, `BBMKTS_API_TOKEN`
(hoặc alias `VUOTNHANH_API_TOKEN`).

## Bảo mật
- Token GitHub/Hanami chỉ nằm ở server, không bao giờ gửi xuống trình duyệt.
- Mật khẩu web hash bằng `scrypt`; session lưu dạng hash SHA-256 trong DB, cookie `HttpOnly`.
- Mọi thao tác coin/shop/admin đều kiểm tra quyền phía server.
- **Không commit file `.env`** (đã có trong `.gitignore`). Nếu token từng bị lộ, hãy thu hồi và tạo token mới.
