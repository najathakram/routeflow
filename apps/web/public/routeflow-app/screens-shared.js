// screens-shared.js — auth, role picker, messaging

/* ══════ SH 1 — SIGN IN ══════ */
const sh_login = `
<div class="screen white" style="background:var(--bg-elev)">
  ${statusbar()}
  <div style="flex:1;display:flex;flex-direction:column;padding:48px 28px 20px">
    <!-- Brand mark -->
    <div style="width:72px;height:72px;border-radius:22px;background:var(--brand-gradient);display:flex;align-items:center;justify-content:center;box-shadow:0 12px 32px rgba(11,110,107,0.35)">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
        <path d="M4 17L12 13L20 17M4 17L12 21L20 17M4 17V9L12 5L20 9V17M12 13V5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div style="font-size:34px;font-weight:700;letter-spacing:-1.2px;color:var(--label);margin-top:20px">Welcome back</div>
    <div style="font-size:17px;color:var(--label2);margin-top:6px;letter-spacing:-0.2px">Sign in to RouteFlow · North Depot</div>

    <div style="margin-top:32px;display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px">Email</div>
        <div style="background:var(--fill3);border-radius:12px;padding:14px 14px;font-size:17px;color:var(--label);display:flex;align-items:center;gap:10px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 6h16v12H4zM4 6l8 7 8-7" stroke="var(--label2)" stroke-width="1.8" stroke-linejoin="round"/></svg>
          jordan.m@northdepot.co
        </div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px">Password</div>
        <div style="background:var(--fill3);border-radius:12px;padding:14px 14px;font-size:17px;color:var(--label);display:flex;align-items:center;gap:10px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="11" rx="2" stroke="var(--label2)" stroke-width="1.8"/><path d="M8 10V7a4 4 0 018 0v3" stroke="var(--label2)" stroke-width="1.8"/></svg>
          <span style="letter-spacing:4px;color:var(--label)">••••••••</span>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 2px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:20px;height:20px;border-radius:6px;background:var(--brand);display:flex;align-items:center;justify-content:center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>
          </div>
          <span style="font-size:14px;color:var(--label)">Remember me</span>
        </div>
        <span style="font-size:14px;color:var(--brand);font-weight:500">Forgot?</span>
      </div>
    </div>

    <div style="margin-top:24px"><div class="btn-primary">Sign in</div></div>

    <div style="display:flex;align-items:center;gap:12px;margin:22px 0">
      <div style="flex:1;height:0.5px;background:var(--separator)"></div>
      <span style="font-size:12px;color:var(--label2);letter-spacing:0.06em;text-transform:uppercase">or</span>
      <div style="flex:1;height:0.5px;background:var(--separator)"></div>
    </div>

    <div style="background:#fff;color:#3c4043;padding:14px;border-radius:12px;font-size:16px;font-weight:500;display:flex;align-items:center;justify-content:center;gap:10px;border:1px solid #dadce0;box-shadow:0 1px 3px rgba(60,64,67,0.1)">
      <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      Sign in with Google
    </div>

    <div style="flex:1"></div>
    <div style="text-align:center;font-size:13px;color:var(--label2);padding-bottom:8px">New driver? <span style="color:var(--brand);font-weight:500">Get setup code</span></div>
  </div>
  <div class="home-indicator"></div>
</div>`;

/* ══════ SH 2 — ROLE PICKER ══════ */
const sh_role = `
<div class="screen">
  ${statusbar()}
  <div style="padding:24px 20px 0">
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:40px;height:40px;border-radius:999px;background:var(--brand-gradient);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">JL</div>
      <div>
        <div style="font-size:17px;font-weight:600;color:var(--label);letter-spacing:-0.2px">Jordan Lee</div>
        <div style="font-size:13px;color:var(--label2)">North Depot · Operator+Driver</div>
      </div>
    </div>
    <div style="font-size:30px;font-weight:700;letter-spacing:-0.8px;color:var(--label);margin-top:24px">How are you<br/>working today?</div>
    <div style="font-size:15px;color:var(--label2);margin-top:6px">You can switch anytime from the side menu.</div>
  </div>

  <div class="content"><div class="scroll">
    <div style="padding:24px 16px 0;display:flex;flex-direction:column;gap:12px">

      <div style="background:var(--brand-gradient);color:#fff;border-radius:20px;padding:20px;position:relative;overflow:hidden">
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="width:52px;height:52px;border-radius:14px;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 17h2l1-4h12l1 4h2M5 13l1.5-5a2 2 0 012-1.5h7a2 2 0 012 1.5L19 13M7 17v2M17 17v2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1">
            <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;opacity:0.85">Recommended</div>
            <div style="font-size:22px;font-weight:700;letter-spacing:-0.4px;margin-top:2px">Driver</div>
            <div style="font-size:14px;opacity:0.9;margin-top:4px;line-height:1.4">Route 07 is loaded & ready · 12 stops · depart 08:00</div>
          </div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
        <div style="display:flex;gap:16px;margin-top:14px;padding-left:66px">
          <div><div style="font-size:11px;opacity:0.75;letter-spacing:0.06em;text-transform:uppercase">Stops</div><div style="font-size:18px;font-weight:700;font-variant-numeric:tabular-nums">12</div></div>
          <div><div style="font-size:11px;opacity:0.75;letter-spacing:0.06em;text-transform:uppercase">Value</div><div style="font-size:18px;font-weight:700;font-variant-numeric:tabular-nums">$3.2k</div></div>
          <div><div style="font-size:11px;opacity:0.75;letter-spacing:0.06em;text-transform:uppercase">Distance</div><div style="font-size:18px;font-weight:700;font-variant-numeric:tabular-nums">148 km</div></div>
        </div>
      </div>

      <div style="background:var(--bg-elev);border-radius:20px;padding:20px;border:0.5px solid var(--separator)">
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="width:52px;height:52px;border-radius:14px;background:var(--purple-wash);color:var(--purple-ink);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 21V9l9-5 9 5v12M9 21v-6h6v6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </div>
          <div style="flex:1">
            <div style="font-size:22px;font-weight:700;letter-spacing:-0.4px;color:var(--label)">Operator</div>
            <div style="font-size:14px;color:var(--label2);margin-top:4px;line-height:1.4">Warehouse dispatch, live fleet & exceptions</div>
          </div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="var(--label3)" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;padding-left:66px;flex-wrap:wrap">
          <span class="pill pill-orange"><span class="pill-dot"></span>2 urgent</span>
          <span class="pill pill-gray">6 routes active</span>
        </div>
      </div>

      <div style="background:var(--bg-elev);border-radius:20px;padding:20px;border:0.5px solid var(--separator);opacity:0.88">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="width:52px;height:52px;border-radius:14px;background:var(--fill3);color:var(--label2);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 6v6l4 2M12 22a10 10 0 110-20 10 10 0 010 20z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </div>
          <div style="flex:1">
            <div style="font-size:17px;font-weight:600;color:var(--label);letter-spacing:-0.2px">Yesterday's recap</div>
            <div style="font-size:13px;color:var(--label2);margin-top:2px">9 deliveries · $1,486 collected · on-time 100%</div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="var(--label3)" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
      </div>
    </div>

    <!-- Status -->
    <div style="padding:24px 16px 0">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--green-wash);border-radius:12px">
        <div style="width:8px;height:8px;border-radius:999px;background:var(--green)"></div>
        <span style="font-size:13px;color:var(--green-ink);font-weight:500">All systems operational · last sync 07:38</span>
      </div>
    </div>
    <div style="height:24px"></div>
  </div></div>

  <div class="home-indicator"></div>
</div>`;

/* ══════ SH 3 — MESSAGES ══════ */
const sh_messages = `
<div class="screen">
  ${statusbar()}
  <div class="navbar navbar-large">
    <div class="navbar-inline">
      <div class="nav-action">Edit</div>
      <div style="flex:1"></div>
      <div class="nav-action">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M17 3l4 4-11 11H6v-4zM14 6l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
    </div>
    <div class="nav-large-title">Messages</div>
  </div>

  <div class="content"><div class="scroll">
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      <span>Search</span>
      <div style="width:24px;height:24px;background:var(--fill3);border-radius:999px;display:flex;align-items:center;justify-content:center;margin-left:auto">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 3v10M7 8l5-5 5 5M4 17v3h16v-3" stroke="var(--label2)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
    </div>

    <div style="padding:4px 16px 0;display:flex;gap:10px;overflow-x:auto;-webkit-overflow-scrolling:touch">
      ${[
        {label:'All',n:5,active:true},
        {label:'Dispatch',n:2},
        {label:'Drivers',n:2},
        {label:'Customers',n:1},
        {label:'Broadcast',n:0},
      ].map(c=>`<div class="filter-chip ${c.active?'fc-active':'fc-inactive'}" style="white-space:nowrap">${c.label}${c.n?' · '+c.n:''}</div>`).join('')}
    </div>

    <div style="padding-top:14px">
      ${[
        {who:'Dispatch · Jamie', msg:'Harbor Café is cash-only today — bring exact change if you can.', time:'8:42', unread:true, pinned:true, color:'#0B6E6B', init:'DJ'},
        {who:'Luna Roastery', msg:'Can we add 3 × croissants to today\'s drop?', time:'8:18', unread:true, color:'#D28CB5', init:'LR'},
        {who:'Route 11 · Dmitri', msg:'Running 10 min behind on stop 4, traffic.', time:'Yesterday', unread:false, color:'#5856D6', init:'DK'},
        {who:'Broadcast · Ops', msg:'Reminder: end-of-day reconcile by 17:30.', time:'Yesterday', unread:false, color:'#8E8E93', init:'OP'},
        {who:'Green Market', msg:'Thanks — received invoice 9821.', time:'Tue', unread:false, color:'#34C759', init:'GM'},
      ].map((m,i)=>`
        <div style="padding:12px 16px;display:flex;gap:12px;align-items:flex-start;${i>0?'border-top:0.5px solid var(--separator);margin-left:62px':''}">
          ${i===0?`<div style="width:10px;display:flex;align-items:center;padding-top:18px">${m.unread?'<div style="width:10px;height:10px;border-radius:999px;background:var(--brand)"></div>':''}</div>`:`<div style="width:10px;display:flex;align-items:center;padding-top:18px;margin-left:-62px">${m.unread?'<div style="width:10px;height:10px;border-radius:999px;background:var(--brand)"></div>':''}</div>`}
          <div style="width:48px;height:48px;border-radius:999px;background:${m.color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0">${m.init}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px">
              <div style="font-size:16px;font-weight:${m.unread?'700':'600'};color:var(--label);letter-spacing:-0.2px;display:flex;align-items:center;gap:6px">
                ${m.pinned?'<svg width="10" height="10" viewBox="0 0 24 24" fill="var(--label2)"><path d="M12 2l2 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6z"/></svg>':''}${m.who}
              </div>
              <div style="font-size:13px;color:var(--label2);font-variant-numeric:tabular-nums;flex-shrink:0">${m.time}</div>
            </div>
            <div style="font-size:15px;color:${m.unread?'var(--label)':'var(--label2)'};margin-top:2px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${m.msg}</div>
          </div>
        </div>`).join('')}
    </div>
    <div style="height:20px"></div>
  </div></div>

  <div class="home-indicator"></div>
</div>`;

window.sharedPhones = [
  ['01 Sign in', 'Apple-style · brand mark', sh_login],
  ['02 Role picker', 'Multi-role switcher', sh_role],
  ['03 Messages', 'Dispatch ↔ drivers', sh_messages],
];
