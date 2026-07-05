// RouteFlow Unified — tiny icon set. <i data-ic="name"></i> → inline SVG (16px, stroke).
(function () {
  var P = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    package: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
    undo: '<path d="M3 8h10a6 6 0 0 1 0 12H8"/><path d="M7 4L3 8l4 4"/>',
    truck: '<path d="M2 6h12v10H2z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
    users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c.5-3.6 3.2-5.6 6.5-5.6s6 2 6.5 5.6"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.8"/><path d="M18.5 14.6c2 .9 3 2.6 3.2 5"/>',
    warehouse: '<path d="M3 8.5L12 4l9 4.5V20H3z"/><path d="M7 20v-7h10v7"/><path d="M7 16.5h10"/>',
    dollar: '<path d="M12 2.5v19"/><path d="M17 6H9.8a3.2 3.2 0 0 0 0 6.4h4.4a3.2 3.2 0 0 1 0 6.4H6.5"/>',
    chart: '<path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-6"/><path d="M2.5 20h19"/>',
    leaf: '<path d="M11 20a7 7 0 0 1-7-7c0-5 4-9 16-9 0 12-4 16-9 16z"/><path d="M5 20c3-4 6-7 10-9"/>',
    sliders: '<path d="M5 21v-6"/><path d="M5 9V3"/><path d="M12 21v-9"/><path d="M12 6V3"/><path d="M19 21v-4"/><path d="M19 11V3"/><path d="M2 15h6"/><path d="M9 6h6"/><path d="M16 17h6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/>',
    bell: '<path d="M18 8.5a6 6 0 0 0-12 0c0 6.5-2.5 8.2-2.5 8.2h17S18 15 18 8.5z"/><path d="M10.3 20.5a2 2 0 0 0 3.4 0"/>',
    chevdown: '<path d="M6 9l6 6 6-6"/>',
    chevright: '<path d="M9 6l6 6-6 6"/>',
    chevleft: '<path d="M15 6l-6 6 6 6"/>',
    chevupdown: '<path d="M8 9.5L12 5.5l4 4"/><path d="M8 14.5l4 4 4-4"/>',
    chevup: '<path d="M6 15l6-6 6 6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    eye: '<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    alert: '<path d="M12 3.5L22 20H2z"/><path d="M12 10v4.5"/><path d="M12 17.4v.1"/>',
    barcode: '<path d="M4 5v14"/><path d="M8 5v14"/><path d="M11.5 5v14"/><path d="M16 5v14"/><path d="M20 5v14"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17"/><path d="M8 2.5V6"/><path d="M16 2.5V6"/>',
    download: '<path d="M12 3v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 19.5h16"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13.5h9l1-13.5"/><path d="M10.2 11v6"/><path d="M13.8 11v6"/>',
    swap: '<path d="M17 3.5l3.5 3.5L17 10.5"/><path d="M20.5 7H7"/><path d="M7 13.5L3.5 17 7 20.5"/><path d="M3.5 17H17"/>',
    arrowleft: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
    filetext: '<path d="M6 2.5h8l5 5V21.5H6z"/><path d="M14 2.5V8h5"/><path d="M9 13h7"/><path d="M9 17h7"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    camera: '<rect x="2.5" y="7" width="19" height="13" rx="2"/><path d="M8.5 7l1.5-2.8h4L15.5 7"/><circle cx="12" cy="13.2" r="3.4"/>',
    dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
    cart: '<circle cx="9" cy="20" r="1.6"/><circle cx="17" cy="20" r="1.6"/><path d="M3 4h2.5l2.2 11h10.8l2-8H6.2"/>',
    heart: '<path d="M12 20s-7.5-4.6-9.3-9A5.2 5.2 0 0 1 12 6.5 5.2 5.2 0 0 1 21.3 11c-1.8 4.4-9.3 9-9.3 9z"/>',
    store: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/><path d="M2.8 9h18.4"/>',
    shield: '<path d="M12 2.8l7.5 3v6.1c0 5-3.4 8-7.5 9.6-4.1-1.6-7.5-4.6-7.5-9.6V5.8z"/>',
    repeat: '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M20.5 6H8a4.5 4.5 0 0 0-4.5 4.5"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M3.5 18H16a4.5 4.5 0 0 0 4.5-4.5"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c.6-4 3.7-6.2 7.5-6.2s6.9 2.2 7.5 6.2"/>',
    mail: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M3 6.5l9 6.5 9-6.5"/>',
    printer: '<path d="M7 8V3.5h10V8"/><rect x="3" y="8" width="18" height="8.5" rx="1.5"/><path d="M7 13.5h10v7H7z"/>',
    phone: '<path d="M5 3.5h4l1.5 4.5-2.3 1.8a13 13 0 0 0 6 6l1.8-2.3 4.5 1.5v4a1.8 1.8 0 0 1-2 1.8C10.5 20 4 13.5 3.2 5.5A1.8 1.8 0 0 1 5 3.5z"/>',
    chat: '<path d="M21 12a8.5 8.5 0 0 1-12.4 7.5L3.5 21l1.5-5A8.5 8.5 0 1 1 21 12z"/>',
    pin: '<path d="M12 21.5s7-6.3 7-11.5a7 7 0 1 0-14 0c0 5.2 7 11.5 7 11.5z"/><circle cx="12" cy="10" r="2.6"/>',
    upload: '<path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4 19.5h16"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 9.5h19"/><path d="M6 15h4"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3.5V8h-4.5"/>',
    minus: '<path d="M5 12h14"/>',
    pencil: '<path d="M4 20l1-4L16.6 4.4a1.9 1.9 0 0 1 2.7 0l.3.3a1.9 1.9 0 0 1 0 2.7L8 19z"/><path d="M14.5 6.5l3 3"/>',
    send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.7"/><path d="M21 16l-5.5-5.5L5 21"/>',
    zap: '<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/>',
    live: '<path d="M12 18.5v.1"/><path d="M8.5 15a5 5 0 0 1 7 0"/><path d="M5.5 11.5a9.5 9.5 0 0 1 13 0"/>'
  };
  function swap() {
    document.querySelectorAll('i[data-ic]').forEach(function (el) {
      var name = el.getAttribute('data-ic');
      var inner = P[name]; if (!inner) return;
      var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      var sz = el.getAttribute('data-sz') || '16';
      s.setAttribute('width', sz); s.setAttribute('height', sz);
      s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', el.getAttribute('data-sw') || '1.8');
      s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
      if (el.className) s.setAttribute('class', el.className);
      s.innerHTML = inner;
      el.replaceWith(s);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', swap); else swap();
})();
