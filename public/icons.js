/* NIGARIA CLOUD icons — inline SVG, stroke-based, currentColor only.
 * Contract API: window.icons = { icon(name, size = 20), names: [...] }
 * No ES module. All icons use viewBox 0 0 24 24, stroke currentColor, width 1.8.
 */
(function () {
  'use strict';

  const PATHS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5"/>',
    shop: '<path d="M4 9h16l-1.2 10.2a1.8 1.8 0 0 1-1.8 1.6H7a1.8 1.8 0 0 1-1.8-1.6L4 9Z"/><path d="M4 9 5.6 4.8A1.5 1.5 0 0 1 7 3.8h10a1.5 1.5 0 0 1 1.4 1L20 9"/><path d="M9 13h6"/>',
    device: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    tasks: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m3.5 6 1.4 1.4L7.4 4.8"/><path d="m3.5 12 1.4 1.4 1.5-1.6"/><path d="m3.5 18 1.4 1.4 1.5-1.6"/>',
    status: '<path d="M3 12h3l2-6 4 12 3-8 2 4h4"/>',
    leaderboard: '<path d="M5 20V10"/><path d="M12 20V4"/><path d="M19 20v-7"/><path d="m9 6 3-2 3 2"/><path d="M3 20h18"/>',
    transfer: '<path d="M4 8h15"/><path d="m15 4 4 4-4 4"/><path d="M20 16H5"/><path d="m9 12-4 4 4 4"/>',
    gift: '<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M3 13h18"/><path d="M12 9v11"/><path d="M12 9S9.5 4 7 5.2 8.5 9 12 9Z"/><path d="M12 9s2.5-5 5-3.8S15.5 9 12 9Z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.1h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>',
    orders: '<path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5"/><path d="M8 12h8"/><path d="M8 16h6"/>',
    seller: '<path d="M4 9h16l-1 11H5L4 9Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/><path d="M9.5 14h5"/>',
    store: '<path d="M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9"/><path d="M3 6h18l-1 4H4L3 6Z"/><path d="M9 20v-6h6v6"/>',
    chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    chat: '<path d="M20 12a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.3-.7L4 20l1.2-4.3a7.5 7.5 0 1 1 14.8-3.7Z"/><path d="M9 11.5h.01"/><path d="M12.5 11.5h.01"/><path d="M16 11.5h.01"/>',
    language: '<path d="M4 5h9"/><path d="M8.5 3v2"/><path d="M11 5c0 4-2.5 7.5-6 9"/><path d="M6 9c1 2.3 3 4.3 5.5 5.5"/><path d="m13 20 4.5-10 4.5 10"/><path d="M14.7 16.5h5.6"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    youtube: '<path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4a2.6 2.6 0 0 0-1.8 1.8A27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8Z" fill="currentColor" stroke="none"/><path d="m10 15.2 5-3.2-5-3.2v6.4Z" fill="var(--panel-2, #0b1220)" stroke="none"/>',
    discord: '<path d="M19.6 5.4A16 16 0 0 0 15.7 4l-.5 1a13 13 0 0 0-4.4 0l-.5-1A16 16 0 0 0 6.4 5.4C3.7 9.3 3 13.1 3.4 16.9a16 16 0 0 0 4.8 2.4l1-1.7a10 10 0 0 1-1.6-.8l.4-.3a11.5 11.5 0 0 0 9.9 0l.4.3a10 10 0 0 1-1.6.8l1 1.7a16 16 0 0 0 4.8-2.4c.5-4.4-.8-8.2-3.3-11.5ZM9.3 14.8c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm5.4 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" fill="currentColor" stroke="none"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/>',
    'star-filled': '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" fill="currentColor" stroke="none"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11"/><path d="M9 9.5c.7-.8 1.8-1.2 3-1.2 1.7 0 3 .7 3 1.8 0 2.4-6 1.2-6 3.7 0 1.1 1.3 1.9 3 1.9 1.2 0 2.3-.4 3-1.2"/>',
    acoin: '<path d="M12 2.8 20 7v10l-8 4.2L4 17V7l8-4.2Z"/><path d="m4 7 8 4.5L20 7"/><path d="M12 11.5v9.7"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    filter: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    reply: '<path d="M9 8 4 12l5 4"/><path d="M4.5 12H14a6 6 0 0 1 6 6v1"/>',
    replyAll: '<path d="M7 8 3 12l4 4"/><path d="M12 8 8 12l4 4"/><path d="M8.5 12H15a6 6 0 0 1 6 6v1"/>',
    appeal: '<path d="M14 4h6v6"/><path d="m20 4-8 8"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
    warning: '<path d="M12 3.5 21.5 20H2.5L12 3.5Z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
    complaint: '<path d="M12 3.5 21.5 20H2.5L12 3.5Z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
    pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    refund: '<path d="M4 8h15"/><path d="m15 4 4 4-4 4"/><path d="M20 16H5"/><path d="m9 12-4 4 4 4"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4.5L20 15"/><path d="M20 20v-5h-5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
    cart: '<path d="M3 4h2.2l2.1 10.4a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><path d="M16 14h2"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    send: '<path d="m21 3-9.5 18-2.2-7.3L2 11.5 21 3Z"/><path d="m9.3 13.7 5.2-5.2"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 6-2 7-2 7h16s-2-1-2-7Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v2.5"/>',
    // aliases / extras used by legacy views
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    package: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6"/><path d="M9 12h6"/>',
    plugin: '<path d="M9 3v4"/><path d="M15 3v4"/><path d="M7 7h10v5a5 5 0 0 1-10 0V7Z"/><path d="M12 17v4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-2 4 4"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    exchange: '<path d="M4 8h15"/><path d="m15 4 4 4-4 4"/><path d="M20 16H5"/><path d="m9 12-4 4 4 4"/>',
    cookie: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1"/><circle cx="12" cy="14.5" r="1"/><circle cx="15.5" cy="9.5" r="1"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7L11 6.8"/><path d="M14 10.5a4 4 0 0 0-5.7 0L6 12.8a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.4 4 5.5 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.5-4-9s1.4-6.6 4-9Z"/>',
    cloud: '<path d="M7.5 18.5H6a4 4 0 0 1-.5-8A6 6 0 0 1 17.4 9.2 3.8 3.8 0 0 1 18 18.5h-.5"/><path d="M9.5 18.5h5"/>',
    back: '<path d="M10 6 4 12l6 6"/><path d="M4.5 12H20"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-left': '<path d="m15 5-7 7 7 7"/>',
    'chevron-right': '<path d="m9 5 7 7-7 7"/>',
    'arrow-up': '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
    'arrow-down': '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    'dot-online': '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="10" opacity=".25" fill="currentColor" stroke="none"/>',
    'dot-offline': '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="10" opacity=".25" fill="currentColor" stroke="none"/>',
    // aliases referenced by legacy views
    admin: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/><path d="m18 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 19a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15 19a5 5 0 0 1 6-4.6"/>',
    crown: '<path d="M3 7l4.2 3L12 4l4.8 6L21 7l-2 11H5L3 7Z"/><path d="M5 20h14"/>',
  };

  const NAMES = [
    'home', 'shop', 'device', 'tasks', 'status', 'leaderboard', 'transfer', 'gift',
    'settings', 'profile', 'logout', 'orders', 'seller', 'chat', 'language', 'menu',
    'close', 'youtube', 'discord', 'star', 'coin', 'acoin', 'search', 'filter', 'check',
    'plus', 'reply', 'appeal', 'warning', 'refresh', 'copy', 'eye', 'cart', 'wallet',
    'calendar', 'arrowUp', 'arrowDown', 'chevron', 'send', 'bell', 'lock', 'user',
    'store', 'chart', 'pending', 'refund', 'complaint', 'replyAll', 'trash', 'crown',
  ];

  function icon(name, size = 20) {
    const key = String(name || 'info');
    const body = PATHS[key] || PATHS.info;
    const s = Number(size) || 20;
    return '<svg class="ico-svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + '</svg>';
  }

  window.icons = { icon, names: NAMES };
  // backwards-compatible aliases for code written during integration
  window.icon = icon;
  window.NIGARIA_ICONS = PATHS;
})();
