// mobile-core.jsx — RouteFlow Mobile: tokens, icons, shared UI kit, store
// Friendly navy/blue. Big targets. Short labels. No long texts.

// ── Palette (accent comes from tweaks via CSS vars) ──
const RFM = {
  navy: '#16324F',
  ink: '#0F2137',
  sub: 'rgba(22,50,79,0.62)',
  faint: 'rgba(22,50,79,0.38)',
  bg: '#F3F5F8',
  card: '#FFFFFF',
  line: '#E3E9F2',
  green: '#189A4A',
  greenSoft: '#E7F7EE',
  amber: '#D97706',
  amberSoft: '#FDF3E3',
  red: '#D93636',
  redSoft: '#FDEEEE',
  font: "'Inter', -apple-system, sans-serif",
};
const ACC = 'var(--rfm-acc, #2563EB)';
const ACC_SOFT = 'var(--rfm-acc-soft, #EAF1FE)';
const RAD = 'var(--rfm-rad, 22px)';

// ── Icons: consistent 2.2 stroke, friendly rounded ──
function Ic({ d, size = 26, color = 'currentColor', fill = 'none', sw = 2.2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d={d} stroke={color} strokeWidth={sw} fill={fill} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
const PATHS = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1v-9.5Z',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4V8Zm8 4 8-4M12 12 4 8m8 4v8',
  route: 'M6 19a2.5 2.5 0 1 0 0-5c4 0 3-8 7-8a2.5 2.5 0 1 1 0 5c-4 0-3 8-7 8Z',
  money: 'M3 7h18v10H3V7Zm9 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6 10h.01M18 14h.01',
  stock: 'M4 14h7v7H4v-7Zm9 0h7v7h-7v-7Zm-4.5-10h7v7h-7V4Z',
  people: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 1a2.5 2.5 0 1 0 0-5M2.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5M15 15.5c2.6.2 4.5 2 4.5 4.5',
  truck: 'M2 6h11v10H2V6Zm11 3h4l3 3v4h-7M6 19a1.8 1.8 0 1 0 0-3.6A1.8 1.8 0 0 0 6 19Zm11 0a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6Z',
  check: 'M4.5 12.5 10 18 19.5 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  chev: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  bell: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Zm4.5 9a1.7 1.7 0 0 0 3 0',
  pen: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z',
  repeat: 'M4 9a6 6 0 0 1 10.5-4M20 15a6 6 0 0 1-10.5 4M17 3l3 2-3 2M7 21l-3-2 3-2',
  alert: 'M12 5 2.5 20h19L12 5Zm0 6v3.5m0 3v.01',
  doc: 'M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6M9 16h6',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  card: 'M3 6h18v12H3V6Zm0 4h18',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3.5 2',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  bag: 'M6 8h12l1.5 13h-15L6 8Zm3 0a3 3 0 0 1 6 0',
  send: 'M21 3 3 10.5l7 3 3 7L21 3Zm-11 7.5L21 3',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z',
  phone: 'M5 4h4l1.5 4.5L8 10a12 12 0 0 0 6 6l1.5-2.5L20 15v4a1.5 1.5 0 0 1-1.7 1.5C10 19.6 4.4 14 3.5 5.7A1.5 1.5 0 0 1 5 4Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-4.8-4.8',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 12h8l1-12M10 11v5m4-5v5',
  undo: 'M8 5 3 9.5 8 14M3 9.5h11a6 6 0 0 1 0 12h-3',
};
function I(name, props = {}) { return <Ic d={PATHS[name]} {...props}/>; }

// ── Product glyphs (line icons in soft tiles) ──
const GLYPHS = {
  milk: 'M9 3h6v3l1.5 3V21h-9V9L9 6V3Zm-1.5 9h9',
  beans: 'M7.5 14a4.5 6 0 1 0 0-.01M7.5 8c1 1.8 1 6.2 0 8M16.5 16a4.5 6 20 1 0-.01 0M16 10c.8 1.9.9 4.5.3 6.5',
  cups: 'M6 4h12l-1.5 16h-9L6 4Zm.5 5h11',
  syrup: 'M10 3h4v3l2 2v13H8V8l2-2V3Zm-2 9h8',
  butter: 'M4 10h16v7H4v-7Zm3-3h10v3H7V7Z',
  flour: 'M8 4h8l2 5c0 2-1 3-2 3v6a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-6c-1 0-2-1-2-3l2-5Zm-2 5h12',
  bread: 'M4 12a4 4 0 0 1 4-4h8a4 4 0 0 1 2 7.5V19H6v-3.5A4 4 0 0 1 4 12Z',
  clean: 'M9 3h6v4h3l-2 14H8L6 7h3V3Zm1 8v6m4-6v6',
};
function Glyph({ name, size = 30, color = ACC }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d={GLYPHS[name]} stroke={color} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ── Base CSS (press states, scrollbars) ──
const rfmCss = `
  .rfm-press { transition: transform 120ms ease, box-shadow 120ms ease; cursor: pointer; user-select: none; -webkit-user-select: none; }
  .rfm-press:active { transform: scale(0.965); }
  .rfm-scroll { scrollbar-width: none; }
  .rfm-scroll::-webkit-scrollbar { display: none; }
  @keyframes rfm-pop { 0% { transform: scale(0.3); opacity: 0; } 60% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
  @keyframes rfm-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes rfm-up { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes rfm-dot { 0% { transform: translate(0,0) scale(1); opacity: 1; } 100% { transform: translate(var(--dx), var(--dy)) scale(0.4); opacity: 0; } }
  @keyframes rfm-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes rfm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
`;

// ── Store ──
const seedProducts = [
  { id: 'p1', name: 'Oat Milk 12 pack', glyph: 'milk', price: 38.4, stock: 42, cat: 'Dairy', hue: 210, rating: 4.8, pop: 320, unit: '12 x 1L', bullets: ['Pack of 12 x 1L', 'Comes in the chilled van', 'Keeps 30 days unopened'] },
  { id: 'p2', name: 'Espresso Beans 1kg', glyph: 'beans', price: 24.0, stock: 6, cat: 'Coffee', hue: 45, rating: 4.9, pop: 410, unit: '1 kg bag', bullets: ['Medium dark roast', 'Roasted this week', 'Whole beans'] },
  { id: 'p3', name: 'Paper Cups 500', glyph: 'cups', price: 18.2, stock: 120, cat: 'Packaging', hue: 160, rating: 4.6, pop: 180, unit: '500 cups', bullets: ['12 oz double wall', 'Fits standard lids', 'Compostable'] },
  { id: 'p4', name: 'Sugar Syrup', glyph: 'syrup', price: 12.9, stock: 4, cat: 'Coffee', hue: 285, rating: 4.7, pop: 95, unit: '750 ml', bullets: ['Pump included', 'No artificial color', 'Keeps 6 months'] },
  { id: 'p5', name: 'Butter 5kg', glyph: 'butter', price: 42.0, stock: 18, cat: 'Dairy', hue: 60, rating: 4.8, pop: 150, unit: '5 kg block', bullets: ['Unsalted', 'Comes chilled', 'Local dairy'] },
  { id: 'p6', name: 'Flour 10kg', glyph: 'flour', price: 16.5, stock: 26, cat: 'Pantry', hue: 270, rating: 4.7, pop: 210, unit: '10 kg sack', bullets: ['Strong bakers flour', 'Protein 12.5%', 'Milled monthly'] },
  { id: 'p7', name: 'Sourdough Mix', glyph: 'bread', price: 21.0, stock: 30, cat: 'Pantry', hue: 25, rating: 4.5, pop: 60, unit: '2 kg mix', bullets: ['Starter included', 'Just add water', 'Makes 8 loaves'] },
  { id: 'p8', name: 'Cleaner 5L', glyph: 'clean', price: 14.0, stock: 12, cat: 'Pantry', hue: 195, rating: 4.4, pop: 75, unit: '5 L jug', bullets: ['Food safe', 'Unscented', 'Dilute 1:20'] },
];

const seedCustomers = [
  { id: 'c1', name: 'Harbor Cafe', addr: '12 Quay St', owed: 284.5, last: 'Today', hue: 210 },
  { id: 'c2', name: 'Bluestone Grocery', addr: '48 Mill Rd', owed: 0, last: 'Yesterday', hue: 160 },
  { id: 'c3', name: 'Nordic Deli', addr: '221 Pine Ave', owed: 612.0, last: '2 days ago', hue: 260 },
  { id: 'c4', name: 'Station Street Bar', addr: '7 Elm Ln', owed: 421.8, last: 'Monday', hue: 20 },
  { id: 'c5', name: 'Maple and Oak', addr: '83 Cedar Dr', owed: 0, last: 'Last week', hue: 100 },
];

let rfmSeq = 100;
const oid = () => 'o' + (++rfmSeq);

const seedOrders = [
  { id: 'o1', custId: 'c2', items: [{ pid: 'p1', qty: 8 }, { pid: 'p5', qty: 4 }, { pid: 'p6', qty: 6 }], status: 'new', time: '7:12' },
  { id: 'o2', custId: 'c4', items: [{ pid: 'p2', qty: 6 }, { pid: 'p4', qty: 8 }], status: 'new', time: '7:40' },
  { id: 'o3', custId: 'c3', items: [{ pid: 'p1', qty: 4 }, { pid: 'p3', qty: 2 }], status: 'approved', time: '6:55' },
  { id: 'o4', custId: 'c5', items: [{ pid: 'p6', qty: 4 }, { pid: 'p7', qty: 3 }], status: 'approved', time: '6:30' },
  { id: 'o5', custId: 'c1', items: [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 4 }, { pid: 'p3', qty: 2 }], status: 'approved', time: '6:20' },
];

const seedInvoices = [
  { id: 'INV 1042', custId: 'c1', amount: 284.5, status: 'due', due: 'in 3 days' },
  { id: 'INV 1038', custId: 'c3', amount: 612.0, status: 'due', due: 'in 9 days' },
  { id: 'INV 1035', custId: 'c4', amount: 421.8, status: 'overdue', due: '2 days late' },
  { id: 'INV 1031', custId: 'c2', amount: 198.2, status: 'paid', due: '' },
  { id: 'INV 1027', custId: 'c5', amount: 342.6, status: 'paid', due: '' },
];

const initialStore = {
  products: seedProducts,
  customers: seedCustomers,
  orders: seedOrders,
  invoices: seedInvoices,
  returns: [
    { id: 'r1', custId: 'c1', pname: 'Oat Milk 12 pack', qty: 2, reason: 'Damaged', amount: 12.8, status: 'pending' },
  ],
  route: { driver: null, status: 'draft' }, // draft | sent | running | done
  runIdx: 0,          // driver current stop index
  runPhase: 'go',     // go | checklist
  cart: {},           // pid -> qty (retailer)
  credits: 0,         // retailer credit from approved returns
  history: [
    { id: 'h1', date: 'Tue, Jun 30', total: 412.8, items: [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 4 }, { pid: 'p3', qty: 2 }, { pid: 'p4', qty: 3 }] },
    { id: 'h2', date: 'Tue, Jun 23', total: 298.5, items: [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 3 }] },
    { id: 'h3', date: 'Tue, Jun 16', total: 184.2, items: [{ pid: 'p1', qty: 4 }, { pid: 'p3', qty: 2 }] },
  ],
  standing: true,
  toast: null,
};

const REGULARS = [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 4 }, { pid: 'p3', qty: 2 }];

function priceOf(products, items) {
  return items.reduce((s, it) => {
    const p = products.find(p => p.id === it.pid);
    return s + (p ? p.price * it.qty : 0);
  }, 0);
}

function rfmReducer(s, a) {
  const findCust = (id) => s.customers.find(c => c.id === id);
  switch (a.type) {
    case 'TOAST': return { ...s, toast: a.toast };
    case 'APPROVE_ORDER':
      return { ...s, orders: s.orders.map(o => o.id === a.id ? { ...o, status: 'approved' } : o), toast: { kind: 'ok', msg: 'Order approved' } };
    case 'DECLINE_ORDER':
      return { ...s, orders: s.orders.map(o => o.id === a.id ? { ...o, status: 'declined' } : o), toast: { kind: 'ok', msg: 'Order declined' } };
    case 'SET_DRIVER':
      return { ...s, route: { ...s.route, driver: a.name } };
    case 'SEND_ROUTE': {
      return {
        ...s,
        route: { ...s.route, status: 'sent' },
        orders: s.orders.map(o => o.status === 'approved' ? { ...o, status: 'routed' } : o),
        toast: { kind: 'ok', msg: 'Route sent to ' + s.route.driver },
      };
    }
    case 'MARK_PAID': {
      const inv = s.invoices.find(i => i.id === a.id);
      return {
        ...s,
        invoices: s.invoices.map(i => i.id === a.id ? { ...i, status: 'paid', due: '' } : i),
        customers: s.customers.map(c => inv && c.id === inv.custId ? { ...c, owed: Math.max(0, +(c.owed - inv.amount).toFixed(2)) } : c),
        toast: { kind: 'ok', msg: 'Marked paid' },
      };
    }
    case 'ADJUST_STOCK':
      return { ...s, products: s.products.map(p => p.id === a.pid ? { ...p, stock: Math.max(0, p.stock + a.delta) } : p) };
    case 'RESTOCK':
      return { ...s, products: s.products.map(p => p.id === a.pid ? { ...p, stock: p.stock + 20 } : p), toast: { kind: 'ok', msg: '20 added' } };
    case 'RETURN_DECISION': {
      const r = s.returns.find(r => r.id === a.id);
      const ok = a.ok;
      return {
        ...s,
        returns: s.returns.map(x => x.id === a.id ? { ...x, status: ok ? 'approved' : 'declined' } : x),
        credits: ok && r && r.custId === 'c1' ? +(s.credits + r.amount).toFixed(2) : s.credits,
        toast: { kind: 'ok', msg: ok ? 'Credit sent' : 'Return declined' },
      };
    }
    case 'CART_SET': {
      const cart = { ...s.cart };
      if (a.qty <= 0) delete cart[a.pid]; else cart[a.pid] = a.qty;
      return { ...s, cart };
    }
    case 'SEND_CART': {
      const items = Object.entries(s.cart).map(([pid, qty]) => ({ pid, qty }));
      if (!items.length) return s;
      return {
        ...s,
        cart: {},
        orders: [{ id: oid(), custId: 'c1', items, status: 'new', time: 'now' }, ...s.orders],
        toast: { kind: 'big', msg: 'Order sent' },
      };
    }
    case 'REORDER': {
      return {
        ...s,
        orders: [{ id: oid(), custId: 'c1', items: a.items, status: 'new', time: 'now' }, ...s.orders],
        toast: { kind: 'big', msg: 'Order sent' },
      };
    }
    case 'REPORT_PROBLEM': {
      const p = s.products.find(p => p.id === a.pid);
      return {
        ...s,
        returns: [{ id: 'r' + (++rfmSeq), custId: 'c1', pname: p ? p.name : '', qty: a.qty, reason: a.reason, amount: p ? +(p.price * a.qty / (a.reason === 'Missing' ? 1 : 1)).toFixed(2) : 0, status: 'pending' }, ...s.returns],
        toast: { kind: 'big', msg: 'Sent. We are on it' },
      };
    }
    case 'TOGGLE_STANDING':
      return { ...s, standing: !s.standing, toast: { kind: 'ok', msg: s.standing ? 'Tuesdays paused' : 'Tuesdays back on' } };
    case 'START_RUN':
      return { ...s, route: { ...s.route, status: 'running' }, runIdx: 0, runPhase: 'go', toast: { kind: 'ok', msg: 'Run started' } };
    case 'ARRIVE':
      return { ...s, runPhase: 'checklist' };
    case 'COMPLETE_STOP': {
      const pending = s.orders.filter(o => o.status === 'routed');
      const cur = pending[0];
      if (!cur) return s;
      const total = priceOf(s.products, cur.items);
      const cust = findCust(cur.custId);
      const isLast = pending.length === 1;
      return {
        ...s,
        orders: s.orders.map(o => o.id === cur.id ? { ...o, status: 'delivered' } : o),
        invoices: [{ id: 'INV ' + (1043 + (rfmSeq % 50)), custId: cur.custId, amount: +total.toFixed(2), status: 'due', due: 'in 14 days' }, ...s.invoices],
        customers: s.customers.map(c => c.id === cur.custId ? { ...c, owed: +(c.owed + total).toFixed(2), last: 'Today' } : c),
        route: { ...s.route, status: isLast ? 'done' : 'running' },
        runIdx: s.runIdx + 1,
        runPhase: 'go',
        toast: { kind: 'big', msg: cust ? cust.name + ' done' : 'Stop done' },
      };
    }
    case 'RESET_DAY':
      rfmSeq = 100;
      return JSON.parse(JSON.stringify(initialStore));
    default: return s;
  }
}

const RFMStoreCtx = React.createContext(null);
function useStore() { return React.useContext(RFMStoreCtx); }

// ── Shared UI ──
function Money({ v, size = 26, color = RFM.ink, weight = 800 }) {
  const [d, c] = v.toFixed(2).split('.');
  return (
    <span style={{ fontFamily: RFM.font, fontWeight: weight, fontSize: size, color, letterSpacing: '-0.02em' }}>
      ${Number(d).toLocaleString()}<span style={{ fontSize: size * 0.68, opacity: 0.55 }}>.{c}</span>
    </span>
  );
}

function Avatar({ name, hue = 210, size = 46 }) {
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('');
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.36, flexShrink: 0,
      background: `oklch(93% 0.04 ${hue})`, color: `oklch(45% 0.13 ${hue})`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: RFM.font, fontWeight: 800, fontSize: size * 0.36, letterSpacing: '0.01em',
    }}>{initials}</div>
  );
}

function Card({ children, onClick, style, pad = 18, anim }) {
  return (
    <div className={onClick ? 'rfm-press' : ''} onClick={onClick} style={{
      background: RFM.card, borderRadius: RAD, padding: pad,
      boxShadow: '0 1px 2px rgba(22,50,79,0.04), 0 10px 28px rgba(22,50,79,0.07)',
      animation: anim ? 'rfm-up 340ms cubic-bezier(0.2,0.9,0.3,1) both' : 'none',
      ...style,
    }}>{children}</div>
  );
}

function BigBtn({ label, icon, onClick, tone = 'acc', disabled, style }) {
  const bg = disabled ? '#C7D2E1' : tone === 'acc' ? ACC : tone === 'green' ? RFM.green : tone === 'navy' ? RFM.navy : tone === 'ghost' ? ACC_SOFT : tone === 'red' ? RFM.redSoft : ACC;
  const fg = tone === 'ghost' ? `var(--rfm-acc, #2563EB)` : tone === 'red' ? RFM.red : '#fff';
  return (
    <div className={disabled ? '' : 'rfm-press'} onClick={disabled ? undefined : onClick} style={{
      height: 58, borderRadius: `calc(${RAD} - 4px)`,
      background: bg, color: fg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      fontFamily: RFM.font, fontWeight: 800, fontSize: 17.5, letterSpacing: '-0.01em',
      boxShadow: disabled || tone === 'ghost' || tone === 'red' ? 'none' : '0 6px 16px rgba(22,50,79,0.18)',
      ...style,
    }}>
      {icon && I(icon, { size: 22, color: fg })}{label}
    </div>
  );
}

function RoundBtn({ icon, onClick, tone = 'soft', size = 52 }) {
  const bg = tone === 'green' ? RFM.green : tone === 'red' ? RFM.redSoft : tone === 'acc' ? ACC : ACC_SOFT;
  const fg = tone === 'green' || tone === 'acc' ? '#fff' : tone === 'red' ? RFM.red : `var(--rfm-acc, #2563EB)`;
  return (
    <div className="rfm-press" onClick={onClick} style={{
      width: size, height: size, borderRadius: size / 2.6, flexShrink: 0,
      background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: tone === 'green' || tone === 'acc' ? '0 4px 12px rgba(22,50,79,0.2)' : 'none',
    }}>{I(icon, { size: size * 0.44, color: fg })}</div>
  );
}

function Pill({ label, tone = 'blue' }) {
  const m = {
    blue: [ACC_SOFT, `var(--rfm-acc, #2563EB)`],
    green: [RFM.greenSoft, RFM.green],
    amber: [RFM.amberSoft, RFM.amber],
    red: [RFM.redSoft, RFM.red],
    gray: ['#EDF1F7', RFM.sub],
  }[tone];
  return (
    <span style={{
      padding: '5px 11px', borderRadius: 99, background: m[0], color: m[1],
      fontFamily: RFM.font, fontWeight: 800, fontSize: 12.5, letterSpacing: '0.01em',
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

function Hdr({ title, sub, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '0 4px', marginBottom: 16 }}>
      <div>
        {sub && <div style={{ fontFamily: RFM.font, fontSize: 14.5, fontWeight: 600, color: RFM.sub, marginBottom: 3 }}>{sub}</div>}
        <div style={{ fontFamily: RFM.font, fontSize: 29, fontWeight: 800, color: RFM.ink, letterSpacing: '-0.03em', lineHeight: 1.05 }}>{title}</div>
      </div>
      {right}
    </div>
  );
}

function Row({ children, gap = 12, style }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap, ...style }}>{children}</div>;
}

function Stepper({ value, onChange, min = 0 }) {
  return (
    <Row gap={0} style={{ background: ACC_SOFT, borderRadius: 14, overflow: 'hidden' }}>
      <div className="rfm-press" onClick={() => onChange(Math.max(min, value - 1))} style={{ width: 46, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {I('minus', { size: 20, color: `var(--rfm-acc, #2563EB)` })}
      </div>
      <div style={{ width: 40, textAlign: 'center', fontFamily: RFM.font, fontWeight: 800, fontSize: 19, color: RFM.ink }}>{value}</div>
      <div className="rfm-press" onClick={() => onChange(value + 1)} style={{ width: 46, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {I('plus', { size: 20, color: `var(--rfm-acc, #2563EB)` })}
      </div>
    </Row>
  );
}

// ── Bottom sheet (portals to device-root overlay so it ignores list scroll) ──
const RFMOverlayCtx = React.createContext(null);
function Sheet({ open, onClose, children, title }) {
  const overlay = React.useContext(RFMOverlayCtx);
  if (!open) return null;
  const body = (
    <div style={{ position: 'absolute', inset: 0, zIndex: 80 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(15,33,55,0.4)', animation: 'rfm-fade 200ms both' }}/>
      <div className="rfm-scroll" style={{
        position: 'absolute', left: 8, right: 8, bottom: 8, maxHeight: '78%',
        overflowY: 'auto',
        background: '#fff', borderRadius: `calc(${RAD} + 4px)`,
        padding: '14px 18px 18px',
        animation: 'rfm-up 300ms cubic-bezier(0.2,0.9,0.3,1) both',
        boxShadow: '0 -10px 40px rgba(15,33,55,0.2)',
      }}>
        <div style={{ width: 40, height: 4.5, borderRadius: 3, background: '#D8E0EB', margin: '0 auto 12px' }}/>
        {title && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 21, color: RFM.ink, letterSpacing: '-0.02em' }}>{title}</div>
            <div className="rfm-press" onClick={onClose} style={{ width: 34, height: 34, borderRadius: 12, background: '#EDF1F7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {I('x', { size: 16, color: RFM.sub })}
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  );
  const node = overlay && overlay.current;
  return node ? ReactDOM.createPortal(body, node) : body;
}

// ── Error boundary: one broken screen must not blank the phone ──
class RFMBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: false }; }
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    if (this.state.err) return (
      <Scr>
        <Card pad={20} style={{ marginTop: 60 }}>
          <EmptyState icon="alert" title="Small hiccup" sub="Tap below to reload this screen"/>
          <BigBtn label="Reload" icon="repeat" onClick={() => this.setState({ err: false })}/>
        </Card>
      </Scr>
    );
    return this.props.children;
  }
}

// ── Toast + celebration ──
function ToastLayer({ celebrate = true }) {
  const { store, dispatch } = useStore();
  const t = store.toast;
  React.useEffect(() => {
    if (!t) return;
    const ms = t.kind === 'big' ? 1500 : 1400;
    const h = setTimeout(() => dispatch({ type: 'TOAST', toast: null }), ms);
    return () => clearTimeout(h);
  }, [t]);
  if (!t) return null;
  if (t.kind === 'big' && celebrate) {
    const dots = Array.from({ length: 8 });
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.55)', backdropFilter: 'blur(3px)', animation: 'rfm-fade 200ms both' }}/>
        <div style={{ position: 'relative', textAlign: 'center', animation: 'rfm-pop 380ms cubic-bezier(0.2,0.9,0.3,1) both' }}>
          <div style={{ position: 'relative', width: 96, height: 96, margin: '0 auto' }}>
            {dots.map((_, i) => {
              const ang = (i / 8) * Math.PI * 2;
              return <div key={i} style={{
                position: 'absolute', left: 42, top: 42, width: 11, height: 11, borderRadius: 6,
                background: i % 2 ? RFM.green : `var(--rfm-acc, #2563EB)`,
                '--dx': Math.cos(ang) * 74 + 'px', '--dy': Math.sin(ang) * 74 + 'px',
                animation: 'rfm-dot 700ms 120ms ease-out both',
              }}/>;
            })}
            <div style={{
              width: 96, height: 96, borderRadius: 48, background: RFM.green,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 16px 40px rgba(24,154,74,0.4)',
            }}>{I('check', { size: 48, color: '#fff', sw: 3 })}</div>
          </div>
          <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 24, color: RFM.ink, marginTop: 16, letterSpacing: '-0.02em' }}>{t.msg}</div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 118, zIndex: 90, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9,
        background: RFM.ink, color: '#fff', padding: '12px 20px', borderRadius: 99,
        fontFamily: RFM.font, fontWeight: 700, fontSize: 15,
        boxShadow: '0 10px 30px rgba(15,33,55,0.35)',
        animation: 'rfm-up 260ms cubic-bezier(0.2,0.9,0.3,1) both',
      }}>
        <div style={{ width: 22, height: 22, borderRadius: 11, background: RFM.green, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {I('check', { size: 13, color: '#fff', sw: 3 })}
        </div>
        {t.msg}
      </div>
    </div>
  );
}

// ── Tab bar ──
function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{
      position: 'absolute', left: 12, right: 12, bottom: 14, zIndex: 60,
      background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(14px)',
      borderRadius: 28, padding: '8px 6px',
      display: 'flex', justifyContent: 'space-around',
      boxShadow: '0 -2px 8px rgba(22,50,79,0.04), 0 12px 34px rgba(22,50,79,0.16)',
    }}>
      {tabs.map(t => {
        const on = t.id === active;
        return (
          <div key={t.id} className="rfm-press" onClick={() => onChange(t.id)} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '7px 13px', borderRadius: 18, minWidth: 56, position: 'relative',
            background: on ? ACC_SOFT : 'transparent',
          }}>
            {t.badge ? (
              <div style={{
                position: 'absolute', top: 2, right: 6, minWidth: 19, height: 19, borderRadius: 10,
                background: RFM.red, color: '#fff', fontSize: 11.5, fontWeight: 800, fontFamily: RFM.font,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px',
                boxShadow: '0 2px 6px rgba(217,54,54,0.4)',
              }}>{t.badge}</div>
            ) : null}
            {I(t.icon, { size: 25, color: on ? `var(--rfm-acc, #2563EB)` : RFM.faint, sw: on ? 2.5 : 2.1 })}
            <div style={{ fontFamily: RFM.font, fontSize: 11, fontWeight: on ? 800 : 600, color: on ? `var(--rfm-acc, #2563EB)` : RFM.faint }}>{t.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Screen scaffold (scrollable content + fixed tabs handled by role apps) ──
function Scr({ children, pad = '74px 16px 130px' }) {
  return (
    <div className="rfm-scroll" style={{
      position: 'absolute', inset: 0, overflowY: 'auto',
      padding: pad, boxSizing: 'border-box',
      background: RFM.bg, fontFamily: RFM.font,
    }}>{children}</div>
  );
}

// ── Progress steps (retailer tracking) ──
function Steps({ labels, current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {labels.map((l, i) => {
        const done = i < current, on = i === current;
        return (
          <React.Fragment key={i}>
            {i > 0 && <div style={{ flex: 1, height: 4, borderRadius: 2, background: i <= current ? RFM.green : '#E3E9F2', marginTop: 15 }}/>}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 62 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 17,
                background: done || on ? RFM.green : '#E3E9F2',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                animation: on ? 'rfm-pulse 1.6s infinite' : 'none',
                boxShadow: on ? '0 4px 12px rgba(24,154,74,0.35)' : 'none',
              }}>
                {done ? I('check', { size: 17, color: '#fff', sw: 3 }) : <div style={{ width: 10, height: 10, borderRadius: 5, background: on ? '#fff' : '#B9C5D6' }}/>}
              </div>
              <div style={{ fontFamily: RFM.font, fontSize: 11, fontWeight: on ? 800 : 600, color: on ? RFM.ink : RFM.faint, textAlign: 'center' }}>{l}</div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div style={{ textAlign: 'center', padding: '46px 20px' }}>
      <div style={{
        width: 84, height: 84, borderRadius: 30, background: ACC_SOFT,
        display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
      }}>{I(icon, { size: 40, color: `var(--rfm-acc, #2563EB)` })}</div>
      <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 19, color: RFM.ink }}>{title}</div>
      {sub && <div style={{ fontFamily: RFM.font, fontSize: 14.5, color: RFM.sub, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

Object.assign(window, {
  RFM, ACC, ACC_SOFT, RAD, I, Ic, Glyph, rfmCss,
  RFMStoreCtx, useStore, rfmReducer, initialStore, priceOf, REGULARS,
  Money, Avatar, Card, BigBtn, RoundBtn, Pill, Hdr, Row, Stepper, Sheet,
  ToastLayer, TabBar, Scr, Steps, EmptyState, RFMOverlayCtx, RFMBoundary,
});
