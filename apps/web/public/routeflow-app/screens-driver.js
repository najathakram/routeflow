// ──────────────────────────────────────────────────────
//  screens-driver.js
//  Renders all driver-side screens into #driver-phones
// ──────────────────────────────────────────────────────

/* small helper — builds a phone slot */
function phone(label, sublabel, bodyHTML, opts = {}) {
  return `
    <div class="phone-slot">
      <div class="phone-label"><b>${label}</b>${sublabel ? ' · ' + sublabel : ''}</div>
      <div class="phone">
        <div class="dynamic-island"></div>
        ${bodyHTML}
      </div>
    </div>`;
}

/* status bar inner icons */
const SB_ICONS = `<svg width="17" height="12" viewBox="0 0 17 12" fill="none"><rect x="0" y="3" width="3" height="9" rx="0.8" fill="currentColor"/><rect x="4.5" y="2" width="3" height="10" rx="0.8" fill="currentColor"/><rect x="9" y="0.5" width="3" height="11.5" rx="0.8" fill="currentColor"/><rect x="13.5" y="0" width="3" height="12" rx="0.8" fill="currentColor" opacity="0.35"/></svg><svg width="16" height="12" viewBox="0 0 16 12" fill="none"><path d="M8 2.5C5.5 2.5 3.3 3.5 1.8 5.2L0 3.4C2 1.3 4.8 0 8 0s6 1.3 8 3.4L14.2 5.2C12.7 3.5 10.5 2.5 8 2.5z" fill="currentColor"/><path d="M8 6c-1.6 0-3 .7-4 1.7L2.4 6.1C3.8 4.8 5.8 4 8 4s4.2.8 5.6 2.1L12 7.7C11 6.7 9.6 6 8 6z" fill="currentColor"/><circle cx="8" cy="10" r="2" fill="currentColor"/></svg><svg width="25" height="12" viewBox="0 0 25 12" fill="none"><rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="currentColor" stroke-opacity="0.4"/><rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor"/><path d="M23 4v4a2 2 0 000-4z" fill="currentColor" fill-opacity="0.5"/></svg>`;

const statusbar = (light = false) => `
  <div class="statusbar" style="${light ? 'color:#fff' : ''}">
    <span class="sb-time" ${light ? 'style="color:#fff"' : ''}>9:41</span>
    <div class="sb-icons" ${light ? 'style="color:#fff"' : ''}>${SB_ICONS}</div>
  </div>`;

/* tab bar for driver */
function driverTabs(active = 'route') {
  const t = (id, label, svg) => `
    <div class="tab ${active === id ? 'active' : ''}">
      <div class="tab-icon">${svg}</div>
      <div class="tab-label">${label}</div>
    </div>`;
  return `<div class="tabbar">
    ${t('route', 'Route', '<svg viewBox="0 0 24 24" fill="none"><path d="M5 6a3 3 0 106 0 3 3 0 00-6 0zM13 18a3 3 0 106 0 3 3 0 00-6 0zM8 9v2a4 4 0 004 4h2a4 4 0 014 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>')}
    ${t('map', 'Map', '<svg viewBox="0 0 24 24" fill="none"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 4v16M15 6v16" stroke="currentColor" stroke-width="1.8"/></svg>')}
    ${t('orders', 'Orders', '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M8 3v4M16 3v4M4 11h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>')}
    ${t('cash', 'Cash', '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="7" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="13" r="2.5" stroke="currentColor" stroke-width="1.8"/></svg>')}
    ${t('more', 'More', '<svg viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>')}
  </div>`;
}

/* ═══════════════ SCREEN 1 — START OF DAY ═══════════════ */
const drv_sod = `
<div class="screen">
  ${statusbar()}
  <div class="navbar plain navbar-large">
    <div class="navbar-inline">
      <div>
        <div style="font-size:13px;color:var(--label2);letter-spacing:0.04em;text-transform:uppercase;font-weight:600">Thursday · Apr 19</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:34px;height:34px;border-radius:999px;background:var(--fill3);display:flex;align-items:center;justify-content:center">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M14 2.5v3M10 2.5v3M3.5 9h17M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" stroke="var(--label)" stroke-width="1.6" stroke-linecap="round"/></svg>
        </div>
        <div style="width:34px;height:34px;border-radius:999px;background:var(--brand-wash);display:flex;align-items:center;justify-content:center;color:var(--brand);font-weight:700;font-size:13px;letter-spacing:-0.2px">MR</div>
      </div>
    </div>
    <div class="nav-large-title">Good morning, Marcus</div>
  </div>

  <div class="content"><div class="scroll">
    <!-- Today card -->
    <div style="padding:16px 16px 0">
      <div class="card" style="background:var(--brand-gradient);color:#fff;padding:18px;border-radius:20px;position:relative;overflow:hidden">
        <svg width="220" height="140" viewBox="0 0 220 140" fill="none" style="position:absolute;right:-30px;top:-20px;opacity:0.12">
          <circle cx="110" cy="70" r="60" stroke="#fff" stroke-width="1"/>
          <circle cx="110" cy="70" r="40" stroke="#fff" stroke-width="1"/>
          <circle cx="110" cy="70" r="22" stroke="#fff" stroke-width="1"/>
        </svg>
        <div style="font-size:12px;font-weight:600;opacity:0.75;letter-spacing:0.1em;text-transform:uppercase">Route 07 — North Shore</div>
        <div style="font-size:28px;font-weight:700;margin-top:4px;letter-spacing:-0.6px">12 stops · $3,480</div>
        <div style="font-size:14px;opacity:0.85;margin-top:2px">Est. 7h 10m · 148 km</div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <div style="background:#fff;color:var(--brand-ink);border-radius:12px;padding:10px 14px;font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
            Start day
          </div>
          <div style="background:rgba(255,255,255,0.18);color:#fff;border-radius:12px;padding:10px 14px;font-size:15px;font-weight:600">View manifest</div>
        </div>
      </div>
    </div>

    <!-- Preflight checklist -->
    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Preflight</span><span class="section-inline-link">Skip</span></div>
    <div class="grouped-section">
      <div class="list-group">
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--green-wash);color:var(--green-ink)">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div style="flex:1">
            <div class="row-title">Van inspection</div>
            <div class="row-sub">Tyres · Mirrors · Fuel 78% · 142,308 km</div>
          </div>
          <span class="pill pill-green">Done</span>
        </div>
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--brand-wash);color:var(--brand)">
            <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16v10H4z" stroke="currentColor" stroke-width="1.8"/><path d="M8 11h8M8 14h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1">
            <div class="row-title">Scan pick list</div>
            <div class="row-sub">78 / 84 items loaded · 6 short</div>
          </div>
          <span class="pill pill-orange">Review</span>
        </div>
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--fill3);color:var(--gray)">
            <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M10 10l2 2 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1">
            <div class="row-title">Opening float</div>
            <div class="row-sub">$200 cash · petty</div>
          </div>
          <span class="chevron-right">›</span>
        </div>
      </div>
    </div>

    <!-- Heads up alerts -->
    <div class="section-inline" style="padding-top:4px"><span class="section-inline-title" style="font-size:17px">Heads up</span></div>
    <div class="grouped-section">
      <div class="list-group">
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--red-wash);color:var(--red)">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4M12 16v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1">
            <div class="row-title">Harbor Café — overdue $420</div>
            <div class="row-sub">Collect before delivery per dispatch</div>
          </div>
          <span class="chevron-right">›</span>
        </div>
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--yellow-wash);color:var(--yellow-ink)">
            <svg viewBox="0 0 24 24" fill="none"><path d="M3 19h18L12 4 3 19z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1">
            <div class="row-title">Road closure · King St</div>
            <div class="row-sub">Auto-rerouted stops 9–11</div>
          </div>
          <span class="chevron-right">›</span>
        </div>
      </div>
    </div>

    <div style="height:16px"></div>
  </div></div>

  ${driverTabs('route')}
</div>`;

/* ═══════════════ SCREEN 2 — TODAY'S ROUTE ═══════════════ */
const drv_route = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="pill pill-green"><span class="pill-dot"></span>On time</span>
        <span class="pill pill-gray" style="font-weight:500">Route 07</span>
      </div>
      <div class="nav-action">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
      </div>
    </div>
    <div class="nav-large-title">Today's Route</div>
  </div>

  <div class="content"><div class="scroll">
    <div style="padding:12px 16px 0">
      <div class="inline-stats">
        <div class="inline-stat"><div class="inline-stat-val">12</div><div class="inline-stat-lbl">Stops</div></div>
        <div class="inline-stat"><div class="inline-stat-val" style="color:var(--green-ink)">5</div><div class="inline-stat-lbl">Done</div></div>
        <div class="inline-stat"><div class="inline-stat-val" style="color:var(--brand)">7</div><div class="inline-stat-lbl">Left</div></div>
        <div class="inline-stat"><div class="inline-stat-val">2h10</div><div class="inline-stat-lbl">ETA home</div></div>
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
        <div class="progress-track" style="flex:1"><div class="progress-fill green" style="width:42%"></div></div>
        <div style="font-size:13px;color:var(--label2);font-variant-numeric:tabular-nums">42%</div>
      </div>
    </div>

    <!-- Next stop hero -->
    <div style="padding:14px 16px 0">
      <div style="background:var(--brand-gradient);border-radius:18px;padding:16px;color:#fff;position:relative;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="background:rgba(255,255,255,0.22);width:26px;height:26px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">6</div>
          <div style="font-size:12px;font-weight:600;opacity:0.8;letter-spacing:0.08em;text-transform:uppercase">Up next · 0.8 mi</div>
        </div>
        <div style="font-size:22px;font-weight:700;margin-top:10px;letter-spacing:-0.4px">Harbor Café</div>
        <div style="font-size:13px;opacity:0.85;margin-top:2px">42 Harbour St · 3 items · $184</div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <div style="flex:1;background:#fff;color:var(--brand-ink);border-radius:12px;padding:10px 0;font-size:15px;font-weight:600;text-align:center">Navigate</div>
          <div style="flex:1;background:rgba(255,255,255,0.18);color:#fff;border-radius:12px;padding:10px 0;font-size:15px;font-weight:600;text-align:center">Open stop</div>
          <div style="width:44px;background:rgba(255,255,255,0.18);color:#fff;border-radius:12px;padding:10px 0;font-size:14px;font-weight:600;text-align:center;display:flex;align-items:center;justify-content:center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 16.9v3a2 2 0 01-2.2 2 19 19 0 01-8.3-3 19 19 0 01-6-6A19 19 0 012.5 4.2 2 2 0 014.5 2h3a2 2 0 012 1.7 13 13 0 00.7 2.9 2 2 0 01-.5 2.1L8.4 10a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5 13 13 0 002.9.7 2 2 0 011.7 2z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </div>
        </div>
      </div>
    </div>

    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Stops</span>
      <span style="display:flex;gap:8px;align-items:center">
        <span class="section-inline-link">Reorder</span>
        <span style="color:var(--label3)">·</span>
        <span class="section-inline-link">Map</span>
      </span>
    </div>

    <!-- Stop cards -->
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px">
      ${[
        {n:1, name:'North Deli', addr:'18 North Parade · $246 collected', status:'done', pill:'Delivered', color:'var(--green)'},
        {n:2, name:'Bayside Bistro', addr:'7 Bay Rd · $312 cash', status:'done', pill:'Delivered', color:'var(--green)'},
        {n:3, name:'Atlas Catering', addr:'92 River St · $198', status:'done', pill:'Delivered', color:'var(--green)'},
        {n:4, name:'Green Market', addr:'14 Ferry Lane · Left at door', status:'done', pill:'Unattended', color:'var(--green)'},
        {n:5, name:"Luna Roastery", addr:'6 Grove St · $312', status:'done', pill:'Delivered', color:'var(--green)'},
        {n:6, name:'Harbor Café', addr:'42 Harbour St · 3 items · $184', status:'next', pill:'Up next', color:'var(--brand)'},
        {n:7, name:'Westpark Grill', addr:'15 West End Blvd · 5 items', status:'pending', pill:'', color:'var(--gray4)'},
        {n:8, name:'Central Kitchen', addr:'3 Market Sq · 4 items', status:'pending', pill:'Call ahead', color:'var(--gray4)', callout:true},
      ].map(s => `
        <div style="background:var(--bg-elev);border-radius:14px;overflow:hidden;border-left:3px solid ${s.color}">
          <div style="padding:12px 14px">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:26px;height:26px;border-radius:999px;background:${s.status==='pending'?'var(--fill3)':s.color};color:${s.status==='pending'?'var(--label)':'#fff'};font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center">${s.n}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:16px;font-weight:600;color:var(--label);letter-spacing:-0.2px">${s.name}</div>
                <div style="font-size:13px;color:var(--label2);margin-top:1px">${s.addr}</div>
              </div>
              ${s.pill ? `<span class="pill pill-${s.status==='done'?'green':s.status==='next'?'brand':'orange'}">${s.pill}</span>` : `<span class="chevron-right">›</span>`}
            </div>
          </div>
        </div>`).join('')}
    </div>

    <div style="height:16px"></div>
  </div></div>

  ${driverTabs('route')}
</div>`;

/* ═══════════════ SCREEN 3 — LIVE MAP ═══════════════ */
const drv_map = `
<div class="screen tinted">
  <!-- map backdrop -->
  <div style="position:absolute;inset:0;background:
      linear-gradient(180deg, #C9DDE3 0%, #DCE7E9 45%, #E8EDE6 100%);z-index:0">
    <!-- faux roads -->
    <svg width="393" height="852" viewBox="0 0 393 852" style="position:absolute;inset:0" preserveAspectRatio="none">
      <path d="M-20 280 Q 80 260 180 320 T 400 360" stroke="#fff" stroke-width="18" fill="none" opacity="0.9"/>
      <path d="M-20 280 Q 80 260 180 320 T 400 360" stroke="#B5C5CA" stroke-width="1" fill="none"/>
      <path d="M40 -20 Q 90 200 140 360 T 220 820" stroke="#fff" stroke-width="14" fill="none" opacity="0.9"/>
      <path d="M40 -20 Q 90 200 140 360 T 220 820" stroke="#B5C5CA" stroke-width="1" fill="none"/>
      <path d="M300 -20 Q 280 160 260 360 T 200 820" stroke="#fff" stroke-width="12" fill="none" opacity="0.9"/>
      <path d="M-20 550 Q 100 520 220 560 T 500 620" stroke="#fff" stroke-width="14" fill="none" opacity="0.9"/>
      <path d="M-20 700 Q 150 670 280 710 T 500 740" stroke="#fff" stroke-width="10" fill="none" opacity="0.9"/>
      <!-- parks -->
      <rect x="240" y="420" width="130" height="100" rx="16" fill="#B9D7B1" opacity="0.7"/>
      <rect x="20" y="420" width="100" height="60" rx="10" fill="#B9D7B1" opacity="0.7"/>
      <!-- water -->
      <path d="M-20 820 Q 100 780 200 810 T 420 790 L 420 900 L -20 900 Z" fill="#A9C8D2" opacity="0.8"/>
    </svg>

    <!-- route polyline -->
    <svg width="393" height="852" viewBox="0 0 393 852" style="position:absolute;inset:0" preserveAspectRatio="none">
      <defs>
        <filter id="mapblur"><feGaussianBlur stdDeviation="3"/></filter>
      </defs>
      <path d="M70 240 C 120 300 130 340 170 360 C 210 380 260 370 270 420 C 280 470 230 500 220 560 C 210 620 260 660 300 680" stroke="#0B6E6B" stroke-opacity="0.2" stroke-width="14" fill="none" stroke-linecap="round" filter="url(#mapblur)"/>
      <path d="M70 240 C 120 300 130 340 170 360 C 210 380 260 370 270 420 C 280 470 230 500 220 560 C 210 620 260 660 300 680" stroke="#0B6E6B" stroke-width="5" fill="none" stroke-linecap="round" stroke-dasharray="0"/>
      <!-- upcoming part dashed -->
      <path d="M270 420 C 280 470 230 500 220 560 C 210 620 260 660 300 680" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="2 7" opacity="0.9"/>
    </svg>

    <!-- pins -->
    ${[
      {x:66, y:232, n:1, done:true},
      {x:166, y:354, n:2, done:true},
      {x:268, y:412, n:3, done:true},
      {x:225, y:556, n:6, active:true},
      {x:298, y:676, n:8},
    ].map(p => {
      const bg = p.active ? '#0B6E6B' : p.done ? '#34C759' : '#fff';
      const fg = p.active || p.done ? '#fff' : '#0B6E6B';
      return `<div style="position:absolute;left:${p.x}px;top:${p.y}px;transform:translate(-50%,-100%)">
        <div style="background:${bg};color:${fg};border:${p.done||p.active?'0':'2px solid #0B6E6B'};font-weight:700;font-size:13px;width:32px;height:32px;border-radius:999px 999px 999px 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,0.2)"><span style="transform:rotate(45deg)">${p.n}</span></div>
        ${p.active?`<div style="width:64px;height:64px;border-radius:999px;background:rgba(11,110,107,0.2);position:absolute;top:-16px;left:-16px;z-index:-1;animation:pulse 2s infinite"></div>`:''}
      </div>`;
    }).join('')}

    <!-- driver (self) -->
    <div style="position:absolute;left:170px;top:420px">
      <div style="width:18px;height:18px;border-radius:999px;background:#0B6E6B;border:3px solid #fff;box-shadow:0 0 0 8px rgba(11,110,107,0.25),0 4px 12px rgba(0,0,0,0.25)"></div>
    </div>
  </div>

  ${statusbar(true)}

  <!-- floating top nav -->
  <div style="position:absolute;top:56px;left:16px;right:16px;display:flex;gap:10px;z-index:60">
    <div style="background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-radius:14px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 6px 20px rgba(0,0,0,0.12);flex:1">
      <div style="width:28px;height:28px;border-radius:999px;background:var(--brand-wash);color:var(--brand);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">6</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:#000;letter-spacing:-0.2px">Harbor Café</div>
        <div style="font-size:12px;color:#636366">0.8 mi · 4 min</div>
      </div>
      <div style="background:var(--brand);color:#fff;padding:7px 12px;border-radius:10px;font-size:13px;font-weight:600">Go</div>
    </div>
    <div style="width:44px;height:44px;background:rgba(255,255,255,0.96);border-radius:14px;display:flex;align-items:center;justify-content:center;align-self:center;box-shadow:0 6px 20px rgba(0,0,0,0.12)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h10" stroke="#000" stroke-width="1.8" stroke-linecap="round"/></svg>
    </div>
  </div>

  <!-- right controls -->
  <div style="position:absolute;right:16px;top:160px;display:flex;flex-direction:column;gap:8px;z-index:60">
    ${[
      '<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M12 2v6M12 16v6M2 12h6M16 12h6" stroke="#0B6E6B" stroke-width="2" stroke-linecap="round"/></svg>',
      '<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M5 12h14M12 5v14" stroke="#000" stroke-width="2" stroke-linecap="round"/></svg>',
      '<svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M5 12h14" stroke="#000" stroke-width="2" stroke-linecap="round"/></svg>',
    ].map(s => `<div style="width:44px;height:44px;background:rgba(255,255,255,0.96);border-radius:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,0.12)">${s}</div>`).join('')}
  </div>

  <!-- bottom sheet -->
  <div style="position:absolute;left:0;right:0;bottom:82px;z-index:60">
    <div style="background:rgba(255,255,255,0.98);backdrop-filter:blur(20px);margin:0 10px;border-radius:22px 22px 10px 10px;padding:14px 16px 18px;box-shadow:0 -6px 24px rgba(0,0,0,0.18)">
      <div style="width:36px;height:4px;background:#D1D1D6;border-radius:999px;margin:0 auto 12px"></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div>
          <div style="font-size:11px;color:#636366;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Arriving in</div>
          <div style="font-size:28px;font-weight:700;color:#000;letter-spacing:-0.8px;font-variant-numeric:tabular-nums">4 min</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:#636366;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Dist</div>
          <div style="font-size:20px;font-weight:700;color:#000">0.8 mi</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:#636366;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Stop</div>
          <div style="font-size:20px;font-weight:700;color:#000">6 of 12</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <div class="btn-primary" style="padding:13px 20px">Start navigation</div>
      </div>
    </div>
  </div>

  ${driverTabs('map')}
</div>
<style>@keyframes pulse { 0%{transform:scale(0.85);opacity:0.8} 100%{transform:scale(1.6);opacity:0} }</style>
`;

/* ═══════════════ SCREEN 4 — AT-DOOR DELIVERY ═══════════════ */
const drv_delivery = `
<div class="screen white">
  ${statusbar()}
  <div class="navbar white">
    <div class="navbar-inline">
      <div class="nav-back">
        <svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Route
      </div>
      <div class="nav-title">Stop 6 / 12</div>
      <div class="nav-action">Call</div>
    </div>
  </div>

  <div class="content"><div class="scroll">
    <!-- Customer card -->
    <div style="background:var(--bg-elev);padding:16px 16px 18px;border-bottom:0.5px solid var(--separator)">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="width:52px;height:52px;border-radius:14px;background:var(--brand-gradient);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;letter-spacing:-0.5px">HC</div>
        <div style="flex:1">
          <div style="font-size:22px;font-weight:700;color:var(--label);letter-spacing:-0.4px">Harbor Café</div>
          <div style="font-size:14px;color:var(--label2);margin-top:2px">42 Harbour St, Sydney NSW 2000</div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <span class="pill pill-brand">3 items</span>
            <span class="pill pill-orange">$184 due</span>
            <span class="pill pill-red">Overdue $420</span>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:14px">
        <div style="flex:1;padding:10px;background:var(--fill3);border-radius:10px;text-align:center;font-size:13px;font-weight:600;color:var(--label);display:flex;align-items:center;justify-content:center;gap:6px">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M22 16.9v3a2 2 0 01-2.2 2A19 19 0 013 4.2 2 2 0 015 2h3a2 2 0 012 1.7 13 13 0 00.7 2.9 2 2 0 01-.5 2.1L9 10a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5 13 13 0 002.9.7 2 2 0 011.7 2z" stroke="currentColor" stroke-width="1.6"/></svg>
          Call
        </div>
        <div style="flex:1;padding:10px;background:var(--fill3);border-radius:10px;text-align:center;font-size:13px;font-weight:600;color:var(--label);display:flex;align-items:center;justify-content:center;gap:6px">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.6"/></svg>
          Text
        </div>
        <div style="flex:1;padding:10px;background:var(--fill3);border-radius:10px;text-align:center;font-size:13px;font-weight:600;color:var(--label);display:flex;align-items:center;justify-content:center;gap:6px">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="10" r="3" stroke="currentColor" stroke-width="1.6"/></svg>
          Directions
        </div>
      </div>
    </div>

    <!-- Items -->
    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Items</span><span class="section-inline-link">+ Add on-site</span></div>
    <div class="grouped-section">
      <div class="list-group">
        ${[
          {name:'Sourdough Loaf', sku:'SKU 4021', qty:6, done:true},
          {name:'Butter (500g)', sku:'SKU 1108', qty:4, done:true},
          {name:'Croissants (6pk)', sku:'SKU 3302', qty:2, short:true},
        ].map(i => `
          <div class="list-row" style="gap:14px">
            <div style="width:26px;height:26px;border-radius:999px;border:${i.done?'0':'2px solid var(--gray3)'};background:${i.done?'var(--green)':'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
              ${i.done?'<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>':''}
            </div>
            <div style="flex:1">
              <div style="font-size:16px;color:var(--label);font-weight:500">${i.name}</div>
              <div style="font-size:12px;color:var(--label2);margin-top:1px">${i.sku}</div>
            </div>
            ${i.short?'<span class="pill pill-orange" style="font-size:11px;padding:2px 7px">Short</span>':''}
            <div style="background:var(--brand-wash);color:var(--brand);border-radius:8px;padding:4px 10px;font-size:14px;font-weight:700;font-variant-numeric:tabular-nums">×${i.qty}</div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Proof of delivery -->
    <div class="section-inline" style="padding-top:4px"><span class="section-inline-title" style="font-size:17px">Proof of delivery</span></div>
    <div style="padding:0 16px;display:flex;gap:10px">
      <div style="flex:1;height:96px;background:var(--fill3);border:1.5px dashed var(--gray3);border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--label2)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="13" r="3" stroke="currentColor" stroke-width="1.8"/></svg>
        <span style="font-size:12px;font-weight:500">Photo</span>
      </div>
      <div style="flex:1;height:96px;background:var(--fill3);border:1.5px dashed var(--gray3);border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--label2)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 20h18M6 16c3-6 7-8 12-10M6 16l2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <span style="font-size:12px;font-weight:500">Signature</span>
      </div>
      <div style="flex:1;height:96px;background:var(--fill3);border:1.5px dashed var(--gray3);border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--label2)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.8"/></svg>
        <span style="font-size:12px;font-weight:500">Note</span>
      </div>
    </div>

    <!-- Bottom sticky actions -->
    <div style="padding:20px 16px 0;display:flex;flex-direction:column;gap:8px">
      <div class="btn-row">
        <div class="btn-secondary btn-small" style="padding:12px">Attempted</div>
        <div class="btn-secondary btn-small" style="padding:12px">Partial return</div>
      </div>
      <div class="btn-green">Complete &amp; collect →</div>
    </div>
    <div style="height:20px"></div>
  </div></div>
</div>`;

/* ═══════════════ SCREEN 5 — COLLECT PAYMENT ═══════════════ */
const drv_payment = `
<div class="screen white">
  ${statusbar()}
  <div class="navbar white">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Stop</div>
      <div class="nav-title">Collect payment</div>
      <div class="nav-action">Skip</div>
    </div>
  </div>

  <div class="content"><div class="scroll">
    <div style="background:var(--bg-elev);padding:18px 16px 20px;text-align:center;border-bottom:0.5px solid var(--separator)">
      <div style="font-size:13px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Invoice #1042 · Harbor Café</div>
      <div style="font-size:52px;font-weight:700;color:var(--label);letter-spacing:-2.2px;line-height:1;margin-top:12px;font-variant-numeric:tabular-nums">
        <span style="font-size:28px;color:var(--label2);vertical-align:top;margin-right:2px;position:relative;top:8px">$</span>164<span style="font-size:28px;color:var(--gray3)">.00</span>
      </div>
      <div style="font-size:13px;color:var(--label2);margin-top:4px">Was $184 · $20 credit applied</div>
    </div>

    <!-- Method segmented -->
    <div style="padding:14px 16px 0">
      <div class="seg-control">
        <div class="seg-item active">Cash</div>
        <div class="seg-item">Card</div>
        <div class="seg-item">Cheque</div>
        <div class="seg-item">On account</div>
      </div>
    </div>

    <!-- Amount pad -->
    <div style="padding:14px 16px 0">
      <div style="background:var(--bg);border-radius:14px;padding:14px;display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:11px;color:var(--label2);letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Cash received</div>
          <div style="font-size:30px;font-weight:700;color:var(--label);letter-spacing:-0.8px;font-variant-numeric:tabular-nums;margin-top:2px">$200.00</div>
        </div>
        <div style="background:var(--green-wash);color:var(--green-ink);padding:10px 14px;border-radius:12px;text-align:right">
          <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700">Change</div>
          <div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">$36.00</div>
        </div>
      </div>
    </div>

    <!-- Quick amounts -->
    <div style="padding:12px 16px 0;display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
      ${['$50','$100','$164','$200'].map(a=>`
        <div style="background:var(--fill3);border-radius:12px;padding:12px 0;text-align:center;font-size:15px;font-weight:600;color:var(--label);font-variant-numeric:tabular-nums">${a}</div>`).join('')}
    </div>

    <!-- Numeric keypad -->
    <div style="padding:14px 16px 0">
      <div style="background:var(--bg);border-radius:14px;overflow:hidden;display:grid;grid-template-columns:repeat(3,1fr);gap:1px">
        ${['1','2','3','4','5','6','7','8','9','·','0','⌫'].map((k,i)=>`
          <div style="background:var(--bg-elev);height:56px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:500;color:var(--label);font-variant-numeric:tabular-nums">${k}</div>`).join('')}
      </div>
    </div>

    <div style="padding:14px 16px 16px">
      <div class="btn-green">Receive cash &amp; close</div>
    </div>
  </div></div>
</div>`;

/* ═══════════════ SCREEN 6 — CASH-UP / EOD ═══════════════ */
const drv_cashup = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Done</div>
      <div class="nav-title">End of day</div>
      <div class="nav-action bold">Submit</div>
    </div>
    <div class="nav-large-title">Cash up</div>
  </div>

  <div class="content"><div class="scroll">
    <!-- Reconcile hero -->
    <div style="padding:12px 16px 0">
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:13px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Expected in van</div>
            <div style="font-size:36px;font-weight:700;color:var(--label);letter-spacing:-1px;margin-top:4px;font-variant-numeric:tabular-nums">$2,184.00</div>
          </div>
          <span class="pill pill-green" style="margin-top:4px"><span class="pill-dot"></span>Matched</span>
        </div>
        <div style="height:1px;background:var(--separator);margin:14px 0"></div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
          <div><div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Cash</div><div style="font-size:18px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">$1,430</div></div>
          <div><div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Cheque</div><div style="font-size:18px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">$320</div></div>
          <div><div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Card</div><div style="font-size:18px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">$434</div></div>
        </div>
      </div>
    </div>

    <!-- Cash count accordion -->
    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Cash count</span><span style="font-size:13px;color:var(--label2)">Counted $1,430</span></div>
    <div class="grouped-section">
      <div class="list-group">
        ${[
          {d:'$100',n:10,v:'$1,000'},
          {d:'$50',n:6,v:'$300'},
          {d:'$20',n:5,v:'$100'},
          {d:'$10',n:2,v:'$20'},
          {d:'$5',n:2,v:'$10'},
          {d:'Coins',n:'—',v:'$0'},
        ].map(r=>`
          <div class="list-row" style="gap:14px">
            <div class="list-row-icon" style="background:var(--fill3);color:var(--label);font-size:13px;font-weight:700;font-variant-numeric:tabular-nums">${r.d}</div>
            <span class="row-title">${r.d} notes</span>
            <span style="font-size:15px;color:var(--label2);font-variant-numeric:tabular-nums">× ${r.n}</span>
            <span style="font-size:16px;font-weight:600;color:var(--label);min-width:56px;text-align:right;font-variant-numeric:tabular-nums">${r.v}</span>
          </div>`).join('')}
      </div>
    </div>

    <!-- Van inventory -->
    <div class="section-inline" style="padding-top:4px"><span class="section-inline-title" style="font-size:17px">Van inventory</span><span class="section-inline-link">Scan all</span></div>
    <div class="grouped-section">
      <div class="list-group">
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--green-wash);color:var(--green-ink)">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1"><div class="row-title">Loaded stock delivered</div><div class="row-sub">78 of 84 · 93%</div></div>
        </div>
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--orange-wash);color:var(--orange-ink)">
            <svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18v10H3z M3 10h18M7 14h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1"><div class="row-title">Returns &amp; undelivered</div><div class="row-sub">4 items · Sourdough ×2, Butter ×2</div></div>
          <span class="chevron-right">›</span>
        </div>
        <div class="list-row">
          <div class="list-row-icon" style="background:var(--purple-wash);color:var(--purple-ink)">
            <svg viewBox="0 0 24 24" fill="none"><path d="M9 11l3 3L22 4M22 12v6a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1"><div class="row-title">Empties &amp; crates</div><div class="row-sub">12 crates · 3 trolleys</div></div>
          <span class="chevron-right">›</span>
        </div>
      </div>
    </div>

    <div style="padding:8px 16px 20px">
      <div class="btn-primary">Submit to warehouse</div>
      <div style="font-size:12px;color:var(--label2);text-align:center;margin-top:8px">Will sync when online · Van 07 · 19:12</div>
    </div>
  </div></div>
</div>`;

/* ═══════════════ SCREEN 7 — NEW ORDER / RETURNS / CREDIT ═══════════════ */
const drv_order = `
<div class="screen white">
  ${statusbar()}
  <div class="navbar white">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Harbor Café</div>
      <div class="nav-title">New order</div>
      <div class="nav-action bold">Save</div>
    </div>
  </div>

  <div class="content"><div class="scroll">
    <div style="padding:10px 16px 0">
      <div class="seg-control">
        <div class="seg-item active">Order</div>
        <div class="seg-item">Return</div>
        <div class="seg-item">Credit note</div>
      </div>
    </div>

    <div class="search-bar" style="margin-top:14px">
      <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span>Search or scan item…</span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="2" height="14" fill="currentColor"/><rect x="7" y="5" width="1" height="14" fill="currentColor"/><rect x="10" y="5" width="3" height="14" fill="currentColor"/><rect x="15" y="5" width="1" height="14" fill="currentColor"/><rect x="18" y="5" width="3" height="14" fill="currentColor"/></svg>
    </div>

    <div class="filter-scroll">
      <div class="filter-chip fc-active">Favourites</div>
      <div class="filter-chip fc-inactive">Bakery</div>
      <div class="filter-chip fc-inactive">Dairy</div>
      <div class="filter-chip fc-inactive">Produce</div>
      <div class="filter-chip fc-inactive">Dry</div>
    </div>

    <!-- product rows with quantity steppers -->
    <div style="padding:14px 16px 0;display:flex;flex-direction:column;gap:10px">
      ${[
        {name:'Sourdough Loaf', sku:'4021', price:'$6.80', qty:6, img:'linear-gradient(135deg,#C9A27A,#8B6A44)'},
        {name:'Butter (500g)', sku:'1108', price:'$9.20', qty:4, img:'linear-gradient(135deg,#F5E29A,#D8B954)'},
        {name:'Croissants (6pk)', sku:'3302', price:'$14.00', qty:2, img:'linear-gradient(135deg,#E3BE83,#B1833F)'},
        {name:'Pain au chocolat', sku:'3308', price:'$3.50', qty:0, img:'linear-gradient(135deg,#8B5A2B,#4A2E17)'},
        {name:'Raw milk (2L)', sku:'2201', price:'$5.60', qty:0, img:'linear-gradient(135deg,#F4F4F4,#D9D9D9)'},
      ].map(p=>`
        <div style="background:var(--bg);border-radius:14px;padding:10px;display:flex;align-items:center;gap:12px">
          <div style="width:48px;height:48px;border-radius:10px;background:${p.img};position:relative;overflow:hidden"><div style="position:absolute;inset:0;background:linear-gradient(135deg,transparent 40%,rgba(255,255,255,0.22) 100%)"></div></div>
          <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:600;color:var(--label);letter-spacing:-0.2px">${p.name}</div>
            <div style="font-size:12px;color:var(--label2);margin-top:1px;font-variant-numeric:tabular-nums">SKU ${p.sku} · ${p.price}</div>
          </div>
          ${p.qty>0?`
            <div style="display:flex;align-items:center;gap:0;background:var(--bg-elev);border:0.5px solid var(--separator);border-radius:10px;padding:3px">
              <div style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:var(--brand);font-size:18px;font-weight:500">−</div>
              <div style="min-width:28px;text-align:center;font-size:16px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">${p.qty}</div>
              <div style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:var(--brand);font-size:18px;font-weight:500">+</div>
            </div>
          `:`
            <div style="width:36px;height:36px;background:var(--brand-wash);color:var(--brand);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:300">+</div>
          `}
        </div>`).join('')}
    </div>

    <div style="height:16px"></div>
  </div></div>

  <!-- sticky cart footer -->
  <div style="padding:10px 16px 16px;background:var(--bg-elev);border-top:0.5px solid var(--separator);flex-shrink:0">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div>
        <div style="font-size:12px;color:var(--label2);letter-spacing:0.04em;text-transform:uppercase;font-weight:600">12 items · PO-2041</div>
        <div style="font-size:24px;font-weight:700;color:var(--label);letter-spacing:-0.6px;font-variant-numeric:tabular-nums">$184.00</div>
      </div>
      <div style="background:var(--brand);color:#fff;border-radius:14px;padding:14px 20px;font-size:16px;font-weight:600;display:flex;align-items:center;gap:6px">
        Confirm order
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
    </div>
  </div>
</div>`;

/* ═══════════════ SCREEN 8 — STANDING ORDERS ═══════════════ */
const drv_standing = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div style="display:flex;align-items:center;gap:8px;color:var(--brand);font-size:15px;font-weight:500">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 11-9-9m9 3v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Synced 2m ago
      </div>
      <div class="nav-action">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </div>
    </div>
    <div class="nav-large-title">Standing orders</div>
  </div>

  <div class="content"><div class="scroll">
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span>Search customers…</span>
    </div>

    <div class="filter-scroll">
      <div class="filter-chip fc-active">Active · 24</div>
      <div class="filter-chip fc-inactive">Paused · 3</div>
      <div class="filter-chip fc-inactive">Daily</div>
      <div class="filter-chip fc-inactive">Weekly</div>
      <div class="filter-chip fc-inactive">Monthly</div>
    </div>

    <div style="padding:12px 16px 0;display:flex;flex-direction:column;gap:10px">
      ${[
        {name:'Harbor Café', freq:'Mon · Wed · Fri', items:'3 items · $184', next:'Apr 22', color:'#D2691E', init:'HC'},
        {name:'North Deli', freq:'Every weekday', items:'8 items · $246', next:'Apr 21', color:'#0B6E6B', init:'ND', badge:'Auto-ship'},
        {name:'Bayside Bistro', freq:'Tuesdays', items:'12 items · $420', next:'Apr 22', color:'#5856D6', init:'BB'},
        {name:'Central Kitchen', freq:'Daily', items:'6 items · $198', next:'Tomorrow', color:'#34C759', init:'CK'},
        {name:'Luna Roastery', freq:'Every Thursday', items:'4 items · $88', next:'paused', color:'#8E8E93', init:'LR', paused:true},
      ].map(s=>`
        <div style="background:var(--bg-elev);border-radius:16px;overflow:hidden">
          <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
            <div style="width:40px;height:40px;border-radius:12px;background:${s.color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700">${s.init}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:16px;font-weight:600;color:var(--label);display:flex;align-items:center;gap:6px">${s.name} ${s.badge?`<span class="pill pill-brand" style="font-size:10px;padding:1px 6px">${s.badge}</span>`:''}</div>
              <div style="font-size:13px;color:var(--label2);margin-top:1px">${s.freq}</div>
            </div>
            ${s.paused?'<span class="pill pill-gray">Paused</span>':'<span class="chevron-right">›</span>'}
          </div>
          <div style="padding:10px 16px;border-top:0.5px solid var(--separator);background:var(--bg);display:flex;align-items:center;gap:10px">
            <div style="flex:1">
              <div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Next</div>
              <div style="font-size:14px;color:var(--label);font-weight:500">${s.next}</div>
            </div>
            <div style="flex:2;text-align:right">
              <div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Order</div>
              <div style="font-size:14px;color:var(--label);font-weight:500">${s.items}</div>
            </div>
            <div style="width:34px;height:34px;background:var(--brand-wash);color:var(--brand);border-radius:10px;display:flex;align-items:center;justify-content:center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 12h18M3 6h18M3 18h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
          </div>
        </div>`).join('')}
    </div>
    <div style="height:16px"></div>
  </div></div>

  ${driverTabs('orders')}
</div>`;

/* ═══════════════ SCREEN 9 — RETURNS & CREDIT NOTES ═══════════════ */
const drv_returns = `
<div class="screen white">
  ${statusbar()}
  <div class="navbar white">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Stop</div>
      <div class="nav-title">Return &amp; credit</div>
      <div class="nav-action bold">Issue</div>
    </div>
  </div>

  <div class="content"><div class="scroll">
    <div style="background:var(--bg-elev);padding:16px;border-bottom:0.5px solid var(--separator)">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:40px;height:40px;border-radius:12px;background:var(--red-wash);color:var(--red);display:flex;align-items:center;justify-content:center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 14L3 20M3 14l6 6M14 4h4a3 3 0 013 3v4M21 8l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
        <div style="flex:1">
          <div style="font-size:18px;font-weight:700;color:var(--label)">Harbor Café</div>
          <div style="font-size:13px;color:var(--label2)">Invoice #1042 · $184 originally</div>
        </div>
      </div>
    </div>

    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Returned items</span><span class="section-inline-link">+ Add</span></div>
    <div class="grouped-section">
      <div class="list-group">
        ${[
          {name:'Sourdough Loaf', qty:2, reason:'Damaged in transit', amt:'$13.60'},
          {name:'Butter (500g)', qty:1, reason:'Wrong SKU', amt:'$9.20'},
        ].map(r=>`
          <div class="list-row" style="align-items:flex-start;padding-top:14px;padding-bottom:14px">
            <div class="list-row-icon" style="background:var(--red-wash);color:var(--red)">
              <svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M5 6l1 14a2 2 0 002 2h8a2 2 0 002-2l1-14" stroke="currentColor" stroke-width="1.7"/></svg>
            </div>
            <div style="flex:1">
              <div style="display:flex;align-items:baseline;justify-content:space-between">
                <div style="font-size:16px;font-weight:600;color:var(--label)">${r.name}</div>
                <div style="font-size:15px;font-weight:600;color:var(--label);font-variant-numeric:tabular-nums">−${r.amt}</div>
              </div>
              <div style="font-size:13px;color:var(--label2);margin-top:2px">× ${r.qty} · ${r.reason}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Reason chips -->
    <div class="section-inline" style="padding-top:4px"><span class="section-inline-title" style="font-size:17px">Add reason</span></div>
    <div style="padding:0 16px;display:flex;gap:8px;flex-wrap:wrap">
      ${['Damaged','Expired','Wrong SKU','Short-dated','Customer refused','Quality'].map(r=>`
        <div class="filter-chip fc-inactive" style="cursor:pointer">${r}</div>`).join('')}
    </div>

    <!-- Credit outcome -->
    <div style="padding:20px 16px 0">
      <div class="card" style="background:var(--brand-gradient);color:#fff;padding:16px">
        <div style="font-size:12px;opacity:0.8;letter-spacing:0.08em;text-transform:uppercase;font-weight:700">Credit note CN-0882</div>
        <div style="font-size:38px;font-weight:700;margin-top:6px;letter-spacing:-1px;font-variant-numeric:tabular-nums">−$22.80</div>
        <div style="font-size:13px;opacity:0.85;margin-top:2px">Applied to next invoice · Harbor Café</div>
      </div>
    </div>

    <div style="padding:16px;display:flex;flex-direction:column;gap:8px">
      <div class="btn-primary">Issue credit &amp; email</div>
      <div class="btn-secondary">Save as draft</div>
    </div>
  </div></div>
</div>`;

/* render all driver screens */
window.driverPhones = [
  ['01 Start of day', 'Preflight · alerts · today', drv_sod],
  ['02 Today\'s route', 'List home · next stop hero', drv_route],
  ['03 Live map', 'Map tab · floating controls', drv_map],
  ['04 At‑door delivery', 'Items · PoD · actions', drv_delivery],
  ['05 Collect payment', 'Cash · change · receipts', drv_payment],
  ['06 End of day', 'Cash-up · van inventory', drv_cashup],
  ['07 Order at customer', 'Catalog · cart · steppers', drv_order],
  ['08 Standing orders', 'Subscriptions · freq', drv_standing],
  ['09 Returns & credit', 'Reasons · credit note', drv_returns],
];
