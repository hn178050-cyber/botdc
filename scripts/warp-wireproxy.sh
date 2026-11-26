#!/usr/bin/env bash
# WARP userspace (không cần TUN/NET_ADMIN): wgcf -> wireproxy -> SOCKS5.
# Dùng trên VPS/Máy chạy liên tục, rồi dán socks5h://host:port vào API_PROXY (dùng cho Hanami).
set -euo pipefail

PROFILE="${WGCF_PROFILE:-wgcf-profile.conf}"
CONF="${WIREPROXY_CONF:-wireproxy.conf}"
PORT="${WARP_SOCKS_PORT:-1080}"
BIND="${WARP_SOCKS_BIND:-127.0.0.1}:${PORT}"

command -v wgcf >/dev/null 2>&1 || { echo "Cần wgcf: https://github.com/ViRb3/wgcf/releases" >&2; exit 1; }
command -v wireproxy >/dev/null 2>&1 || { echo "Cần wireproxy: https://github.com/pufferffish/wireproxy/releases" >&2; exit 1; }

if [ ! -f "$PROFILE" ]; then
    echo "Chưa có $PROFILE -> đang đăng ký WARP..."
    wgcf register --accept-tos
    wgcf generate
fi

AUTH_LINES=""
if [ -n "${WARP_SOCKS_USER:-}" ]; then
    AUTH_LINES="Username = ${WARP_SOCKS_USER}"
    if [ -n "${WARP_SOCKS_PASS:-}" ]; then
        AUTH_LINES="${AUTH_LINES}"$'\n'"Password = ${WARP_SOCKS_PASS}"
    fi
fi

{
    cat "$PROFILE"
    printf '\n\n[Socks5]\nBindAddress = %s\n' "$BIND"
    [ -n "$AUTH_LINES" ] && printf '%s\n' "$AUTH_LINES"
} > "$CONF"

echo "✅ WARP SOCKS5 đang lắng tại ${BIND}"
echo "   Dán vào bot: socks5h://<user:pass@>IP_VPS:${PORT}"
exec wireproxy -c "$CONF"
