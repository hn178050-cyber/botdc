#!/usr/bin/env bash
# Chạy WARP userspace (wireproxy) ngay trong Render — KHÔNG cần VPS, KHÔNG cần TUN/NET_ADMIN.
# wireproxy chỉ mở 1 SOCKS5 cục bộ; nó KHÔNG sửa routing table của máy.
# => Chỉ các request có agent SOCKS5 (Hanami khi bật HANAMI_USE_PROXY=1) đi qua WARP.
#    Discord/Web UI và các luồng khác không bị ảnh hưởng.
#
# Setup trên Render:
#   Build Command: npm install
#   Start Command: bash scripts/render-start.sh
#   Env:
#     RENDER_WARP=1
#     WGCF_PROFILE_B64=<base64 của wgcf-profile.conf>   # khuyến nghị
#     (tuỳ chọn) WGCF_AUTO_REGISTER=1 nếu muốn tự đăng ký lúc start
set -euo pipefail

BIN_DIR="${BIN_DIR:-$PWD/bin}"
PROFILE="${WGCF_PROFILE:-$PWD/wgcf-profile.conf}"
CONF="${WIREPROXY_CONF:-$PWD/wireproxy.conf}"
PORT="${WARP_SOCKS_PORT:-1080}"
SOCKS_URL="socks5h://127.0.0.1:${PORT}"
ORIGINAL_API_PROXY="${API_PROXY:-}"

WIREPROXY_VER="v1.1.3"
WGCF_VER="v2.3.1"

if [[ "${RENDER_WARP:-0}" != "1" ]]; then
    echo "[warp] RENDER_WARP không bật -> chạy bot với proxy hiện tại (nếu có)."
    exec node server.js
fi

case "$(uname -m)" in
    x86_64|amd64) WIRE_ARCH="amd64"; WGCF_ARCH="amd64" ;;
    aarch64|arm64) WIRE_ARCH="arm64"; WGCF_ARCH="arm64" ;;
    *) echo "[warp] Kiến trúc CPU không hỗ trợ: $(uname -m)" >&2; exec node server.js ;;
esac

ensure_bin() {
    mkdir -p "$BIN_DIR"
    if [[ ! -x "$BIN_DIR/wireproxy" ]]; then
        echo "[warp] Đang tải wireproxy..."
        curl -fsSL --retry 3 --max-time 120 \
            "https://github.com/pufferffish/wireproxy/releases/download/${WIREPROXY_VER}/wireproxy_linux_${WIRE_ARCH}.tar.gz" \
            -o /tmp/wireproxy.tgz
        tar -xzf /tmp/wireproxy.tgz -C "$BIN_DIR" wireproxy
        chmod +x "$BIN_DIR/wireproxy"
    fi
    if [[ "${WGCF_AUTO_REGISTER:-0}" == "1" && ! -x "$BIN_DIR/wgcf" ]]; then
        echo "[warp] Đang tải wgcf..."
        curl -fsSL --retry 3 --max-time 120 \
            "https://github.com/ViRb3/wgcf/releases/download/${WGCF_VER}/wgcf_${WGCF_VER}_linux_${WGCF_ARCH}" \
            -o "$BIN_DIR/wgcf"
        chmod +x "$BIN_DIR/wgcf"
    fi
}
ensure_bin

# 1) Tạo profile: ưu tiên secret, fallback tự đăng ký (khuyến nghị dùng secret).
if [[ -n "${WGCF_PROFILE_B64:-}" ]]; then
    printf '%s' "$WGCF_PROFILE_B64" | base64 -d > "$PROFILE"
    echo "[warp] Đã giải nén WARP profile từ secret."
elif [[ ! -f "$PROFILE" && "${WGCF_AUTO_REGISTER:-0}" == "1" ]]; then
    echo "[warp] Chưa có profile -> tự đăng ký WARP..."
    (cd "$BIN_DIR" && ./wgcf register --accept-tos && ./wgcf generate)
    cp "$BIN_DIR/wgcf-profile.conf" "$PROFILE"
fi

if [[ ! -f "$PROFILE" ]]; then
    echo "[warp] Không có WARP profile -> bỏ qua WARP, dùng chain cũ (worker/direct)."
    exec node server.js
fi

# 2) Ghép cấu hình: nguyên [Interface] + [Peer] + [Socks5] cục bộ.
{
    cat "$PROFILE"
    printf '\n\n[Socks5]\nBindAddress = 127.0.0.1:%s\n' "$PORT"
    if [[ -n "${WARP_SOCKS_USER:-}" ]]; then
        printf 'Username = %s\n' "$WARP_SOCKS_USER"
        [[ -n "${WARP_SOCKS_PASS:-}" ]] && printf 'Password = %s\n' "$WARP_SOCKS_PASS"
    fi
} > "$CONF"
chmod 600 "$CONF"

# 3) Chạy wireproxy, tự restart nếu tunnel rớt.
(
    while true; do
        "$BIN_DIR/wireproxy" -c "$CONF" || true
        sleep 2
    done
) &
WARP_LOOP_PID=$!

# 4) Health check QUA SOCKS5. Nếu WireGuard không handshake được (Render chặn UDP)
#    thì không set proxy -> bot tự fallback như cũ, không bao giờ treo app.
if node - "$SOCKS_URL" <<'NODE'
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');
const proxy = process.argv[2];

(async () => {
    for (let i = 0; i < 12; i++) {
        try {
            const res = await fetch('https://hanaminikata.com/', {
                agent: new SocksProxyAgent(proxy),
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            });
            await res.text();
            if (res.ok) {
                console.error('[warp] Tunnel WARP OK qua ' + proxy);
                process.exit(0);
            }
        } catch (e) { /* thử lại */ }
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.error('[warp] Tunnel không handshake được (Render có thể chặn UDP) -> fallback.');
    process.exit(1);
})();
NODE
then
    export API_PROXY="$SOCKS_URL"
    echo "[warp] Hanami sẽ đi qua WARP (khi HANAMI_USE_PROXY=1)."
else
    kill "$WARP_LOOP_PID" 2>/dev/null || true
    pkill -x wireproxy 2>/dev/null || true
    # Trả lại proxy cũ (vd Worker) thay vì xoá sạch — nếu không Worker sẽ bị mất.
    if [[ -n "$ORIGINAL_API_PROXY" ]]; then
        export API_PROXY="$ORIGINAL_API_PROXY"
        echo "[warp] Fallback về proxy có sẵn: ${ORIGINAL_API_PROXY%%\?*}"
    else
        unset API_PROXY
        echo "[warp] Giữ chain mặc định."
    fi
fi

exec node server.js
