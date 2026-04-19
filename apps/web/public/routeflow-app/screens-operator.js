// screens-operator.js — operator (warehouse) screens

function operatorTabs(active = 'dash') {
  const t = (id, label, svg) => `
    <div class="tab ${active === id ? 'active' : ''}">
      <div class="tab-icon">${svg}</div>
      <div class="tab-label">${label}</div>
    </div>`;
  return `<div class="tabbar">
    ${t('dash', 'Home', '<svg viewBox="0 0 24 24" fill="none"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1v-9z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>')}
    ${t('dispatch', 'Dispatch', '<svg viewBox="0 0 24 24" fill="none"><path d="M3 17h2l1-4h12l1 4h2M5 13l1.5-5a2 2 0 012-1.5h7a2 2 0 012 1.5L19 13M7 17v2M17 17v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>')}
    ${t('fleet', 'Fleet', '<svg viewBox="0 0 24 24" fill="none"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 4v16M15 6v16" stroke="currentColor" stroke-width="1.8"/></svg>')}
    ${t('warehouse', 'Warehouse', '<svg viewBox="0 0 24 24" fill="none"><path d="M3 21V9l9-5 9 5v12M9 21v-6h6v6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>')}
    ${t('more', 'More', '<svg viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>')}
  </div>`;
}

/* ══════ OP 1 — MORNING DASHBOARD ══════ */
const op_dash = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div>
        <div style="font-size:13px;color:var(--label2);letter-spacing:0.04em;text-transform:uppercase;font-weight:600">Thursday · Apr 19 · 06:42</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <div style="width:34px;height:34px;border-radius:999px;background:var(--fill3);display:flex;align-items:center;justify-content:center;position:relative">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" stroke="var(--label)" stroke-width="1.7" stroke-linecap="round"/></svg>
          <div style="position:absolute;top:4px;right:4px;width:8px;height:8px;border-radius:999px;background:var(--red);border:1.5px solid var(--bg)"></div>
        </div>
        <div style="width:34px;height:34px;border-radius:999px;background:var(--brand-gradient);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">JL</div>
      </div>
    </div>
    <div class="nav-large-title">Warehouse</div>
    <div style="font-size:15px;color:var(--label2);margin-top:2px">North Depot · 6 routes ready to roll</div>
  </div>

  <div class="content"><div class="scroll">
    <!-- Dispatch readiness -->
    <div style="padding:14px 16px 0">
      <div style="background:var(--brand-gradient);color:#fff;border-radius:20px;padding:18px;position:relative;overflow:hidden">
        <div style="font-size:12px;opacity:0.8;letter-spacing:0.1em;text-transform:uppercase;font-weight:700">Dispatch readiness</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px">
          <div style="font-size:42px;font-weight:700;letter-spacing:-1.2px;font-variant-numeric:tabular-nums">83%</div>
          <div style="font-size:14px;opacity:0.85">4 of 6 routes loaded</div>
        </div>
        <div style="height:6px;background:rgba(255,255,255,0.24);border-radius:999px;margin-top:12px;overflow:hidden">
          <div style="width:83%;height:100%;background:#fff;border-radius:999px"></div>
        </div>
        <div style="display:flex;gap:6px;margin-top:14px">
          <div style="background:#fff;color:var(--brand-ink);padding:8px 12px;border-radius:10px;font-size:13px;font-weight:600">Release all</div>
          <div style="background:rgba(255,255,255,0.2);color:#fff;padding:8px 12px;border-radius:10px;font-size:13px;font-weight:600">Run sheet</div>
        </div>
      </div>
    </div>

    <!-- KPIs -->
    <div class="kpi-grid" style="margin-top:14px">
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--brand-wash);color:var(--brand)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M3 17h2l1-4h12l1 4h2M7 17v2M17 17v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
        <div class="kpi-value">6 / 7</div>
        <div class="kpi-label">Drivers checked in</div>
        <div class="kpi-delta neutral">Rita — no show</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--green-wash);color:var(--green-ink)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M20 7L9 18l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
        <div class="kpi-value">74</div>
        <div class="kpi-label">Stops scheduled</div>
        <div class="kpi-delta up">↑ 12 vs yesterday</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--orange-wash);color:var(--orange-ink)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5l3 2M12 22a10 10 0 110-20 10 10 0 010 20z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
        <div class="kpi-value">7</div>
        <div class="kpi-label">Short-picks</div>
        <div class="kpi-delta down">3 need substitution</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--purple-wash);color:var(--purple-ink)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M3 7l9 5 9-5M3 7l9-4 9 4M3 7v10l9 5M21 7v10l-9 5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>
        <div class="kpi-value">$28.4k</div>
        <div class="kpi-label">Out for delivery</div>
        <div class="kpi-delta neutral">148 invoices</div>
      </div>
    </div>

    <!-- Routes list -->
    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Routes today</span><span class="section-inline-link">All</span></div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px">
      ${[
        {n:'Route 07', who:'Marcus R.', stops:'12 stops · 148 km', pct:100, status:'Rolled', color:'var(--green)'},
        {n:'Route 03', who:'Ana P.', stops:'9 stops · 92 km', pct:100, status:'Rolled', color:'var(--green)'},
        {n:'Route 11', who:'Dmitri K.', stops:'14 stops · 176 km', pct:74, status:'Loading', color:'var(--brand)'},
        {n:'Route 05', who:'Samira H.', stops:'11 stops · 112 km', pct:42, status:'Picking', color:'var(--orange)'},
        {n:'Route 02', who:'— unassigned', stops:'8 stops · 86 km', pct:0, status:'No driver', color:'var(--red)'},
      ].map(r=>`
        <div style="background:var(--bg-elev);border-radius:14px;padding:12px 14px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:10px;background:${r.color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">${r.n.split(' ')[1]}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:15px;font-weight:600;color:var(--label);letter-spacing:-0.2px">${r.n} · ${r.who}</div>
              <div style="font-size:12px;color:var(--label2);margin-top:1px">${r.stops}</div>
            </div>
            <span class="pill pill-${r.status==='Rolled'?'green':r.status==='No driver'?'red':r.status==='Loading'?'brand':'orange'}"><span class="pill-dot"></span>${r.status}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
            <div class="progress-track" style="flex:1"><div class="progress-fill" style="width:${r.pct}%;background:${r.color}"></div></div>
            <div style="font-size:12px;color:var(--label2);min-width:34px;text-align:right;font-variant-numeric:tabular-nums">${r.pct}%</div>
          </div>
        </div>`).join('')}
    </div>
    <div style="height:20px"></div>
  </div></div>

  ${operatorTabs('dash')}
</div>`;

/* ══════ OP 2 — DISPATCH (assign routes) ══════ */
const op_dispatch = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Home</div>
      <div class="nav-title">Assign</div>
      <div class="nav-action bold">Release</div>
    </div>
    <div class="nav-large-title">Dispatch</div>
  </div>

  <div class="content"><div class="scroll">
    <div style="padding:6px 16px 0">
      <div class="seg-control">
        <div class="seg-item active">Routes</div>
        <div class="seg-item">Drivers</div>
        <div class="seg-item">Conflicts · 2</div>
      </div>
    </div>

    <!-- Unassigned warning -->
    <div class="offline-banner" style="background:rgba(255,59,48,0.10);border-color:rgba(255,59,48,0.3);color:var(--red-ink);margin-top:14px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4M12 16v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <span>Route 02 has no driver · 8 stops · departing 08:00</span>
    </div>

    <div class="section-inline" style="padding-top:8px"><span class="section-inline-title" style="font-size:17px">Assign driver → Route 02</span></div>

    <div style="padding:0 16px 0">
      <div style="background:var(--bg-elev);border-radius:16px;overflow:hidden">
        ${[
          {name:'Jordan M.', status:'Available · checked in 06:32', badge:'Recommended', tag:'brand', dist:'Home zone: East'},
          {name:'Priya S.', status:'Available · checked in 06:40', tag:'gray', dist:'Home zone: Central'},
          {name:'Leo K.', status:'On break · ETA 20 min', tag:'gray', dist:'Home zone: East'},
          {name:'Rita A.', status:'Not checked in', tag:'red', dist:'Was on Route 02'},
        ].map((d,i)=>`
          <div style="padding:12px 14px;display:flex;align-items:center;gap:12px;${i>0?'border-top:0.5px solid var(--separator)':''}">
            <div style="width:44px;height:44px;border-radius:999px;background:linear-gradient(135deg,#${['6A9BD8','E6A55C','8BB974','D28CB5'][i]},#${['3D6FA8','B07636','598347','A15A84'][i]});color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700">${d.name.split(' ').map(n=>n[0]).join('')}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:16px;font-weight:600;color:var(--label);display:flex;align-items:center;gap:6px">${d.name} ${d.badge?`<span class="pill pill-brand" style="font-size:10px;padding:1px 6px">${d.badge}</span>`:''}</div>
              <div style="font-size:13px;color:var(--label2);margin-top:1px">${d.status}</div>
              <div style="font-size:12px;color:var(--label2);margin-top:1px">${d.dist}</div>
            </div>
            ${d.tag==='red'?'<span class="pill pill-red">Unavailable</span>':`<div style="background:var(--${d.tag==='brand'?'brand':'fill2'});color:${d.tag==='brand'?'#fff':'var(--brand)'};padding:8px 14px;border-radius:10px;font-size:14px;font-weight:600">Assign</div>`}
          </div>`).join('')}
      </div>
    </div>

    <!-- Route summary -->
    <div class="section-inline" style="padding-top:20px"><span class="section-inline-title" style="font-size:17px">Route 02 preview</span></div>
    <div style="padding:0 16px">
      <div style="background:var(--bg-elev);border-radius:16px;padding:14px">
        <div style="display:flex;gap:14px">
          <div>
            <div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Stops</div>
            <div style="font-size:20px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">8</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Value</div>
            <div style="font-size:20px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">$2,140</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">Distance</div>
            <div style="font-size:20px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">86 km</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;font-weight:600">ETA</div>
            <div style="font-size:20px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">5h 20</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">
          <span class="pill pill-gray">Van 02 · 3.5t</span>
          <span class="pill pill-gray">Chilled req.</span>
          <span class="pill pill-orange">1 fragile stop</span>
        </div>
      </div>
    </div>
    <div style="height:20px"></div>
  </div></div>

  ${operatorTabs('dispatch')}
</div>`;

/* ══════ OP 3 — PICK & LOAD VERIFICATION ══════ */
const op_pick = `
<div class="screen white">
  ${statusbar()}
  <div class="navbar white">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Dispatch</div>
      <div class="nav-title">Route 05 — Load</div>
      <div class="nav-action">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="2" height="14" fill="currentColor"/><rect x="7" y="5" width="1" height="14" fill="currentColor"/><rect x="10" y="5" width="3" height="14" fill="currentColor"/><rect x="15" y="5" width="1" height="14" fill="currentColor"/><rect x="18" y="5" width="3" height="14" fill="currentColor"/></svg>
      </div>
    </div>
  </div>

  <div class="content"><div class="scroll">
    <!-- Progress -->
    <div style="padding:14px 16px;background:var(--bg-elev);border-bottom:0.5px solid var(--separator)">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <div>
          <div style="font-size:28px;font-weight:700;color:var(--label);letter-spacing:-0.6px;font-variant-numeric:tabular-nums">47 <span style="color:var(--label2);font-weight:500">/ 112</span></div>
          <div style="font-size:13px;color:var(--label2)">items loaded · 42%</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:12px;color:var(--label2);letter-spacing:0.04em;text-transform:uppercase;font-weight:600">ETA load</div>
          <div style="font-size:22px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">07:28</div>
        </div>
      </div>
      <div class="progress-track" style="margin-top:12px;height:6px"><div class="progress-fill brand" style="width:42%"></div></div>
    </div>

    <!-- Scan hero -->
    <div style="padding:14px 16px 0">
      <div style="background:var(--brand-gradient);color:#fff;border-radius:18px;padding:18px;display:flex;align-items:center;gap:14px">
        <div style="width:56px;height:56px;border-radius:16px;background:rgba(255,255,255,0.18);display:flex;align-items:center;justify-content:center">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="2" height="14" fill="#fff"/><rect x="7" y="5" width="1" height="14" fill="#fff"/><rect x="10" y="5" width="3" height="14" fill="#fff"/><rect x="15" y="5" width="1" height="14" fill="#fff"/><rect x="18" y="5" width="3" height="14" fill="#fff"/></svg>
        </div>
        <div style="flex:1">
          <div style="font-size:12px;opacity:0.8;letter-spacing:0.08em;text-transform:uppercase;font-weight:700">Next to pick</div>
          <div style="font-size:18px;font-weight:700;letter-spacing:-0.3px;margin-top:2px">Butter (500g)</div>
          <div style="font-size:13px;opacity:0.85">Aisle B3 · Bin 14 · needs ×12</div>
        </div>
      </div>
    </div>

    <!-- Status chips -->
    <div class="filter-scroll">
      <div class="filter-chip fc-active">Route 05 · 112</div>
      <div class="filter-chip fc-inactive">Short · 3</div>
      <div class="filter-chip fc-inactive">Fragile · 2</div>
      <div class="filter-chip fc-inactive">Chilled · 18</div>
    </div>

    <!-- Pick rows -->
    <div style="padding:14px 16px 0;display:flex;flex-direction:column;gap:8px">
      ${[
        {name:'Sourdough Loaf', bin:'A1·07', need:24, got:24, status:'done'},
        {name:'Raw milk (2L)', bin:'C2·03 · chilled', need:18, got:18, status:'done'},
        {name:'Butter (500g)', bin:'B3·14', need:12, got:7, status:'active'},
        {name:'Croissants (6pk)', bin:'A2·11', need:18, got:0, status:'pending'},
        {name:'Pain au chocolat', bin:'A2·12', need:6, got:0, status:'short', note:'Only 4 in stock'},
      ].map(p=>{
        const statusColor = p.status==='done'?'var(--green)':p.status==='active'?'var(--brand)':p.status==='short'?'var(--orange)':'var(--gray4)';
        const bg = p.status==='done'?'var(--green-wash)':p.status==='active'?'var(--brand-wash)':p.status==='short'?'var(--orange-wash)':'var(--fill3)';
        return `<div style="background:var(--bg-elev);border:1px solid ${p.status==='active'?'var(--brand)':'var(--separator)'};border-radius:14px;padding:12px 14px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:32px;height:32px;border-radius:10px;background:${bg};color:${statusColor};display:flex;align-items:center;justify-content:center">
              ${p.status==='done'?'<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>':p.status==='short'?'<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 8v4M12 16v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/></svg>':'<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/></svg>'}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:15px;font-weight:600;color:var(--label);letter-spacing:-0.2px">${p.name}</div>
              <div style="font-size:12px;color:var(--label2);margin-top:1px">${p.bin}${p.note?' · '+p.note:''}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:16px;font-weight:700;color:var(--label);font-variant-numeric:tabular-nums">${p.got}<span style="color:var(--label2);font-weight:500"> / ${p.need}</span></div>
              <div style="font-size:11px;color:${statusColor};font-weight:600;margin-top:1px">${p.status==='done'?'Loaded':p.status==='active'?'Scanning':p.status==='short'?'Short 2':'Pending'}</div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="height:16px"></div>
  </div></div>

  <div style="padding:10px 16px 16px;background:var(--bg-elev);border-top:0.5px solid var(--separator);flex-shrink:0">
    <div class="btn-row">
      <div class="btn-secondary btn-small" style="padding:12px">Flag short</div>
      <div class="btn-primary btn-small" style="padding:12px">Scan next</div>
    </div>
  </div>
</div>`;

/* ══════ OP 4 — LIVE FLEET MAP ══════ */
const op_fleet = `
<div class="screen tinted">
  <div style="position:absolute;inset:0;z-index:0;background:linear-gradient(180deg,#C9DDE3 0%,#DCE7E9 45%,#E8EDE6 100%)">
    <svg width="393" height="852" viewBox="0 0 393 852" style="position:absolute;inset:0" preserveAspectRatio="none">
      <path d="M-20 180 Q 100 200 200 240 T 420 280" stroke="#fff" stroke-width="14" fill="none"/>
      <path d="M80 -20 Q 120 200 170 420 T 260 820" stroke="#fff" stroke-width="12" fill="none"/>
      <path d="M320 -20 Q 280 200 240 420 T 200 820" stroke="#fff" stroke-width="10" fill="none"/>
      <path d="M-20 500 Q 120 470 240 510 T 420 540" stroke="#fff" stroke-width="12" fill="none"/>
      <path d="M-20 680 Q 150 650 300 690 T 500 710" stroke="#fff" stroke-width="10" fill="none"/>
      <rect x="40" y="360" width="80" height="50" rx="10" fill="#B9D7B1" opacity="0.7"/>
      <rect x="260" y="420" width="110" height="80" rx="14" fill="#B9D7B1" opacity="0.7"/>
      <path d="M-20 820 Q 100 780 200 810 T 420 790 L 420 900 L -20 900 Z" fill="#A9C8D2" opacity="0.8"/>
    </svg>
    <!-- trails -->
    <svg width="393" height="852" style="position:absolute;inset:0" preserveAspectRatio="none">
      <path d="M110 300 Q 140 380 200 440 T 300 620" stroke="#0B6E6B" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.8"/>
      <path d="M260 210 Q 240 320 220 450 T 180 700" stroke="#5856D6" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.8"/>
      <path d="M60 480 Q 120 500 200 530 T 340 590" stroke="#FF9500" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.8"/>
    </svg>
    <!-- van pins -->
    ${[
      {x:210, y:460, label:'R07', color:'#0B6E6B', state:'on time'},
      {x:195, y:620, label:'R11', color:'#5856D6', state:'on time'},
      {x:330, y:560, label:'R05', color:'#FF9500', state:'late'},
      {x:130, y:280, label:'R03', color:'#34C759', state:'home'},
    ].map(v=>`
      <div style="position:absolute;left:${v.x}px;top:${v.y}px;transform:translate(-50%,-50%)">
        <div style="background:${v.color};color:#fff;padding:6px 10px;border-radius:10px;font-size:12px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,0.25);display:flex;align-items:center;gap:5px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M3 17h2l1-4h12l1 4h2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>
          ${v.label}
        </div>
      </div>`).join('')}
    <!-- depot -->
    <div style="position:absolute;left:56px;top:160px">
      <div style="width:36px;height:36px;background:#000;color:#fff;border-radius:999px;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,0.3)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 21V9l9-5 9 5v12" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>
      </div>
    </div>
  </div>

  ${statusbar(true)}

  <!-- Top search -->
  <div style="position:absolute;top:56px;left:16px;right:16px;z-index:60">
    <div style="background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-radius:14px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 6px 20px rgba(0,0,0,0.15)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#636366" stroke-width="1.8"/><path d="M21 21l-4.3-4.3" stroke="#636366" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span style="flex:1;font-size:15px;color:#636366">Search driver, route, customer…</span>
      <span class="pill pill-green" style="font-size:11px;padding:3px 8px"><span class="pill-dot"></span>4 live</span>
    </div>
  </div>

  <!-- Legend chips -->
  <div style="position:absolute;top:112px;left:16px;display:flex;gap:6px;z-index:60;flex-wrap:wrap;max-width:340px">
    <div style="background:rgba(255,255,255,0.94);padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;color:#000;display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;background:#0B6E6B;border-radius:999px"></span>On time · 3</div>
    <div style="background:rgba(255,255,255,0.94);padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;color:#000;display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;background:#FF9500;border-radius:999px"></span>Late · 1</div>
    <div style="background:rgba(255,255,255,0.94);padding:5px 10px;border-radius:999px;font-size:11px;font-weight:600;color:#000;display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;background:#34C759;border-radius:999px"></span>Home · 1</div>
  </div>

  <!-- Bottom sheet — driver list -->
  <div style="position:absolute;left:0;right:0;bottom:82px;z-index:60">
    <div style="background:rgba(255,255,255,0.98);backdrop-filter:blur(20px);margin:0 10px;border-radius:22px 22px 10px 10px;padding:12px 0 16px;box-shadow:0 -6px 24px rgba(0,0,0,0.18);max-height:340px;overflow:hidden">
      <div style="width:36px;height:4px;background:#D1D1D6;border-radius:999px;margin:0 auto 10px"></div>
      <div style="padding:0 16px 10px;display:flex;justify-content:space-between;align-items:baseline">
        <div style="font-size:17px;font-weight:700;color:#000;letter-spacing:-0.3px">Live drivers</div>
        <div style="font-size:13px;color:var(--brand);font-weight:500">Message all</div>
      </div>
      ${[
        {name:'Marcus R.', route:'R07', progress:'5 / 12 stops · on time', color:'#0B6E6B', init:'MR'},
        {name:'Samira H.', route:'R05', progress:'3 / 11 stops · +18m late', color:'#FF9500', init:'SH'},
        {name:'Dmitri K.', route:'R11', progress:'2 / 14 stops · on time', color:'#5856D6', init:'DK'},
      ].map((d,i)=>`
        <div style="padding:10px 16px;display:flex;align-items:center;gap:12px;${i>0?'border-top:0.5px solid rgba(60,60,67,0.12)':''}">
          <div style="width:38px;height:38px;border-radius:999px;background:${d.color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">${d.init}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:600;color:#000">${d.name} <span style="color:#636366;font-weight:500;font-size:13px">· ${d.route}</span></div>
            <div style="font-size:12px;color:#636366;margin-top:1px">${d.progress}</div>
          </div>
          <div style="width:34px;height:34px;background:rgba(11,110,107,0.12);color:#0B6E6B;border-radius:10px;display:flex;align-items:center;justify-content:center">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.8"/></svg>
          </div>
        </div>`).join('')}
    </div>
  </div>

  ${operatorTabs('fleet')}
</div>`;

/* ══════ OP 5 — DRIVER DETAIL / MESSAGING ══════ */
const op_driver_detail = `
<div class="screen white">
  ${statusbar()}
  <div class="navbar white">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Fleet</div>
      <div class="nav-title">Marcus R. · R07</div>
      <div class="nav-action">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
      </div>
    </div>
  </div>

  <div class="content"><div class="scroll">
    <!-- Header -->
    <div style="background:var(--bg-elev);padding:20px 16px;text-align:center">
      <div style="width:72px;height:72px;border-radius:999px;background:var(--brand-gradient);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;margin:0 auto">MR</div>
      <div style="font-size:22px;font-weight:700;color:var(--label);margin-top:10px;letter-spacing:-0.4px">Marcus Renard</div>
      <div style="font-size:14px;color:var(--label2);margin-top:2px">Van 07 · On route · 3.8h driven today</div>
      <div style="display:flex;gap:8px;margin-top:14px;justify-content:center">
        ${[
          ['<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M22 16.9v3a2 2 0 01-2.2 2A19 19 0 013 4.2 2 2 0 015 2h3a2 2 0 012 1.7 13 13 0 00.7 2.9 2 2 0 01-.5 2.1L9 10a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5 13 13 0 002.9.7 2 2 0 011.7 2z" stroke="currentColor" stroke-width="1.6"/></svg>','Call'],
          ['<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.6"/></svg>','Message'],
          ['<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2l3 7h7l-5.5 4 2 7-6.5-4-6.5 4 2-7L2 9h7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>','Reassign'],
        ].map(([svg,label])=>`<div style="padding:9px 16px;background:var(--fill3);border-radius:12px;display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--label)">${svg}${label}</div>`).join('')}
      </div>
    </div>

    <!-- Live stats -->
    <div style="padding:14px 16px 0">
      <div class="inline-stats">
        <div class="inline-stat"><div class="inline-stat-val">5/12</div><div class="inline-stat-lbl">Stops</div></div>
        <div class="inline-stat"><div class="inline-stat-val" style="color:var(--green-ink)">$1,486</div><div class="inline-stat-lbl">Collected</div></div>
        <div class="inline-stat"><div class="inline-stat-val">64 km</div><div class="inline-stat-lbl">Driven</div></div>
      </div>
    </div>

    <!-- Thread preview -->
    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Thread</span><span class="section-inline-link">Open chat</span></div>
    <div style="padding:0 16px;display:flex;flex-direction:column;gap:8px">
      <div style="align-self:flex-start;max-width:78%;background:var(--fill3);color:var(--label);padding:10px 12px;border-radius:16px 16px 16px 4px;font-size:15px;line-height:1.35">Harbor Café is cash-only today — bring exact change if you can.</div>
      <div style="align-self:flex-start;font-size:11px;color:var(--label2);margin-left:8px">Jamie · Dispatch · 8:42</div>
      <div style="align-self:flex-end;max-width:78%;background:var(--brand);color:#fff;padding:10px 12px;border-radius:16px 16px 4px 16px;font-size:15px;line-height:1.35">Got it. Stopped at petrol for float ✓</div>
      <div style="align-self:flex-end;font-size:11px;color:var(--label2);margin-right:8px">Marcus · 8:50</div>
    </div>

    <!-- Timeline -->
    <div class="section-inline" style="padding-top:4px"><span class="section-inline-title" style="font-size:17px">Today's timeline</span></div>
    <div class="grouped-section">
      <div class="list-group">
        ${[
          {t:'09:42', title:'Delivered — Luna Roastery', sub:'$312 cash · signed', c:'var(--green)'},
          {t:'09:08', title:'Delivered — Green Market', sub:'Left at door · photo', c:'var(--green)'},
          {t:'08:45', title:'Arrived — Atlas Catering', sub:'0.3 mi ahead of ETA', c:'var(--brand)'},
          {t:'07:50', title:'Left depot', sub:'Van 07 · 84 items loaded', c:'var(--gray)'},
        ].map(e=>`
          <div class="list-row">
            <div style="width:56px;font-size:13px;color:var(--label2);font-variant-numeric:tabular-nums">${e.t}</div>
            <div style="width:8px;height:8px;background:${e.c};border-radius:999px;flex-shrink:0;margin:0 4px"></div>
            <div style="flex:1">
              <div style="font-size:15px;color:var(--label);font-weight:500">${e.title}</div>
              <div style="font-size:12px;color:var(--label2);margin-top:1px">${e.sub}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div style="height:20px"></div>
  </div></div>
</div>`;

/* ══════ OP 6 — EXCEPTIONS ══════ */
const op_exceptions = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div class="nav-back"><svg width="10" height="17" viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Home</div>
      <div class="nav-title">Needs attention</div>
      <div class="nav-action">Filter</div>
    </div>
    <div class="nav-large-title">Exceptions</div>
    <div style="font-size:15px;color:var(--label2);margin-top:2px">5 open · 2 urgent · 12 cleared today</div>
  </div>

  <div class="content"><div class="scroll">
    <div class="filter-scroll">
      <div class="filter-chip fc-active">All · 5</div>
      <div class="filter-chip fc-inactive">Urgent · 2</div>
      <div class="filter-chip fc-inactive">Returns</div>
      <div class="filter-chip fc-inactive">Payments</div>
      <div class="filter-chip fc-inactive">Routes</div>
    </div>

    <div style="padding:12px 16px 0;display:flex;flex-direction:column;gap:10px">
      ${[
        {sev:'red', title:'R05 · Samira H. — 18 min late', sub:'Traffic on Highway 1 · 3 stops affected', time:'now', actions:['Reroute','Notify customers']},
        {sev:'red', title:'R07 · Harbor Café refused delivery', sub:'Item damaged · driver needs credit authorization', time:'4m ago', actions:['Authorize $22','Dispatch']},
        {sev:'orange', title:'R11 · Short pick not resolved', sub:'3 × Pain au chocolat for Central Kitchen', time:'8m ago', actions:['Substitute']},
        {sev:'orange', title:'Van 03 · Low fuel', sub:'14% · nearest station 2.1 km', time:'12m ago', actions:['Notify Ana']},
        {sev:'yellow', title:'Standing order paused', sub:'Luna Roastery · weekly · customer request', time:'1h ago', actions:['Review']},
      ].map(e=>{
        const colors={red:['var(--red-wash)','var(--red)','var(--red-ink)'],orange:['var(--orange-wash)','var(--orange)','var(--orange-ink)'],yellow:['var(--yellow-wash)','var(--yellow)','var(--yellow-ink)']};
        const [bg,c,ink]=colors[e.sev];
        return `<div style="background:var(--bg-elev);border-radius:14px;overflow:hidden;border-left:3px solid ${c}">
          <div style="padding:12px 14px">
            <div style="display:flex;align-items:flex-start;gap:10px">
              <div style="width:30px;height:30px;border-radius:8px;background:${bg};color:${ink};display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 20h20L12 2zM12 9v4M12 17v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:15px;font-weight:600;color:var(--label);letter-spacing:-0.2px">${e.title}</div>
                <div style="font-size:13px;color:var(--label2);margin-top:2px">${e.sub}</div>
              </div>
              <div style="font-size:11px;color:var(--label2);font-variant-numeric:tabular-nums">${e.time}</div>
            </div>
            <div style="display:flex;gap:6px;margin-top:10px;padding-left:40px">
              ${e.actions.map((a,i)=>`<div style="padding:6px 12px;background:${i===0?'var(--brand)':'var(--fill3)'};color:${i===0?'#fff':'var(--label)'};border-radius:8px;font-size:13px;font-weight:600">${a}</div>`).join('')}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="height:20px"></div>
  </div></div>

  ${operatorTabs('dash')}
</div>`;

/* ══════ OP 7 — WAREHOUSE STOCK ══════ */
const op_warehouse = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div style="font-size:13px;color:var(--label2);letter-spacing:0.04em;text-transform:uppercase;font-weight:600">North Depot</div>
      <div class="nav-action">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="2" height="14" fill="currentColor"/><rect x="7" y="5" width="1" height="14" fill="currentColor"/><rect x="10" y="5" width="3" height="14" fill="currentColor"/><rect x="15" y="5" width="1" height="14" fill="currentColor"/><rect x="18" y="5" width="3" height="14" fill="currentColor"/></svg>
      </div>
    </div>
    <div class="nav-large-title">Warehouse</div>
  </div>

  <div class="content"><div class="scroll">
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span>Search SKU, name or bin…</span>
    </div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--orange-wash);color:var(--orange-ink)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18v10H3zM3 10h18" stroke="currentColor" stroke-width="1.8"/></svg>
        </div>
        <div class="kpi-value">14</div>
        <div class="kpi-label">Low stock</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--red-wash);color:var(--red-ink)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 2v20M2 12h20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
        <div class="kpi-value">3</div>
        <div class="kpi-label">Out of stock</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--brand-wash);color:var(--brand)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M20 8l-8 8-4-4M4 12l4 4M20 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
        <div class="kpi-value">1,284</div>
        <div class="kpi-label">SKUs tracked</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background:var(--purple-wash);color:var(--purple-ink)">
          <svg viewBox="0 0 24 24" fill="none"><path d="M3 7l9 5 9-5M3 7l9-4 9 4M3 7v10l9 5M21 7v10l-9 5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>
        <div class="kpi-value">6</div>
        <div class="kpi-label">Inbound POs</div>
      </div>
    </div>

    <div class="section-inline"><span class="section-inline-title" style="font-size:17px">Low-stock alerts</span><span class="section-inline-link">Reorder all</span></div>
    <div class="grouped-section">
      <div class="list-group">
        ${[
          {name:'Butter (500g)', sku:'1108', bin:'B3·14', have:24, min:48, pct:50},
          {name:'Croissants (6pk)', sku:'3302', bin:'A2·11', have:8, min:40, pct:20},
          {name:'Pain au chocolat', sku:'3308', bin:'A2·12', have:4, min:30, pct:13},
          {name:'Raw milk 2L', sku:'2201', bin:'C2·03', have:18, min:36, pct:50},
        ].map(p=>`
          <div class="list-row" style="padding:12px 16px">
            <div style="flex:1">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <div style="font-size:15px;font-weight:500;color:var(--label)">${p.name}</div>
                <div style="font-size:13px;color:var(--label);font-weight:600;font-variant-numeric:tabular-nums">${p.have} <span style="color:var(--label2);font-weight:400">/ ${p.min}</span></div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
                <div class="progress-track" style="flex:1;height:3px"><div class="progress-fill ${p.pct<=25?'orange':'brand'}" style="width:${p.pct}%"></div></div>
                <div style="font-size:12px;color:var(--label2);font-variant-numeric:tabular-nums">${p.bin}</div>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div style="height:20px"></div>
  </div></div>

  ${operatorTabs('warehouse')}
</div>`;

window.operatorPhones = [
  ['01 Morning dashboard', 'Readiness · KPIs · routes', op_dash],
  ['02 Dispatch assignment', 'Suggest · assign driver', op_dispatch],
  ['03 Pick & load', 'Scan · verify · short flags', op_pick],
  ['04 Live fleet', 'Map · trails · drivers', op_fleet],
  ['05 Driver detail', 'Live · thread · timeline', op_driver_detail],
  ['06 Exceptions queue', 'Sev-colored · quick actions', op_exceptions],
  ['07 Warehouse stock', 'Low stock · bins · reorder', op_warehouse],
];
