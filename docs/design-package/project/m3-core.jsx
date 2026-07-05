// m3-core.jsx — RouteFlow Mobile v2: tokens, icons, primitives, store
// Visual language: navy canvas heroes, Space Grotesk display, glass dock,
// pill buttons, gradient product tiles. Short labels only.

const M3 = {
  ink: '#0B1524',
  canvas: '#0F1B2D',
  canvasMid: '#152238',
  canvasLight: '#1A2D4A',
  paper: '#F5F6F8',
  card: '#FFFFFF',
  border: '#E8ECF2',
  sub: 'rgba(11,21,36,0.6)',
  faint: 'rgba(11,21,36,0.36)',
  wsub: 'rgba(255,255,255,0.66)',
  wfaint: 'rgba(255,255,255,0.4)',
  green: '#17A34A',
  greenSoft: '#E5F6EC',
  amber: '#D97D0D',
  amberSoft: '#FCF2E2',
  red: '#DC3B3B',
  redSoft: '#FCEBEB',
  disp: "'Space Grotesk', 'Inter', sans-serif",
  body: "'Inter', -apple-system, sans-serif",
};
const M3ACC = 'var(--m3-acc, #2563EB)';
const M3ACC2 = 'var(--m3-acc2, #3B82F6)';
const M3ACCSOFT = 'var(--m3-acc-soft, #E9F0FE)';
const M3GRAD = `linear-gradient(135deg, var(--m3-acc, #2563EB), var(--m3-acc2, #3B82F6))`;
const M3RAD = 'var(--m3-rad, 26px)';

// ── Icon set (2.2 stroke, rounded) ──
function M3Ic({ d, size = 24, color = 'currentColor', sw = 2.2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d={d} stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
const M3P = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1v-9.5Z',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4V8Zm8 4 8-4M12 12 4 8m8 4v8',
  route: 'M6 19a2.5 2.5 0 1 0 0-5c4 0 3-8 7-8a2.5 2.5 0 1 1 0 5c-4 0-3 8-7 8Z',
  money: 'M3 7h18v10H3V7Zm9 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6 10h.01M18 14h.01',
  grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
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
  repeat: 'M4 9a6 6 0 0 1 10.5-4M20 15a6 6 0 0 1-10.5 4M17 3l3 2-3 2M7 21l-3-2 3-2',
  alert: 'M12 5 2.5 20h19L12 5Zm0 6v3.5m0 3v.01',
  doc: 'M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6M9 16h6',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  card: 'M3 6h18v12H3V6Zm0 4h18',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  bag: 'M6 8h12l1.5 13h-15L6 8Zm3 0a3 3 0 0 1 6 0',
  send: 'M21 3 3 10.5l7 3 3 7L21 3Zm-11 7.5L21 3',
  phone: 'M5 4h4l1.5 4.5L8 10a12 12 0 0 0 6 6l1.5-2.5L20 15v4a1.5 1.5 0 0 1-1.7 1.5C10 19.6 4.4 14 3.5 5.7A1.5 1.5 0 0 1 5 4Z',
  undo: 'M8 5 3 9.5 8 14M3 9.5h11a6 6 0 0 1 0 12h-3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-4.8-4.8',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 12h8l1-12M10 11v5m4-5v5',
  heart: 'M12 20s-7.5-4.6-9.3-9.3C1.5 7.5 3.6 4.5 6.8 4.5c2 0 3.7 1.2 5.2 3.2 1.5-2 3.2-3.2 5.2-3.2 3.2 0 5.3 3 4.1 6.2C19.5 15.4 12 20 12 20Z',
  chart: 'M4 20V10m5.5 10V4M15 20v-7m5.5 7V8',
  building: 'M4 21V5l8-2v18M12 21h8v-11l-8-2M7 8h.01M7 12h.01M7 16h.01M16 13h.01M16 17h.01',
  pin: 'M12 21s-6.5-5.4-6.5-10.5a6.5 6.5 0 1 1 13 0C18.5 15.6 12 21 12 21Zm0-8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3.5 2',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z',
  switch: 'M7 8h13M17 4l3 4-3 4M17 16H4m3-4-3 4 3 4',
};
function M3I(name, props = {}) { return <M3Ic d={M3P[name]} {...props}/>; }

// ── Product glyphs ──
const M3GLYPHS = {
  milk: 'M9 3h6v3l1.5 3V21h-9V9L9 6V3Zm-1.5 9h9',
  beans: 'M7.5 14a4.5 6 0 1 0 0-.01M7.5 8c1 1.8 1 6.2 0 8M16.5 16a4.5 6 20 1 0-.01 0M16 10c.8 1.9.9 4.5.3 6.5',
  cups: 'M6 4h12l-1.5 16h-9L6 4Zm.5 5h11',
  syrup: 'M10 3h4v3l2 2v13H8V8l2-2V3Zm-2 9h8',
  butter: 'M4 10h16v7H4v-7Zm3-3h10v3H7V7Z',
  flour: 'M8 4h8l2 5c0 2-1 3-2 3v6a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-6c-1 0-2-1-2-3l2-5Zm-2 5h12',
  bread: 'M4 12a4 4 0 0 1 4-4h8a4 4 0 0 1 2 7.5V19H6v-3.5A4 4 0 0 1 4 12Z',
  clean: 'M9 3h6v4h3l-2 14H8L6 7h3V3Zm1 8v6m4-6v6',
};
function M3Glyph({ name, size = 30, color = M3ACC, sw = 1.9 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d={M3GLYPHS[name]} stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ── CSS ──
const m3Css = `
  .m3-press { transition: transform 140ms cubic-bezier(0.3,1.4,0.5,1); cursor: pointer; user-select: none; -webkit-user-select: none; }
  .m3-press:active { transform: scale(0.955); }
  .m3-scroll { scrollbar-width: none; }
  .m3-scroll::-webkit-scrollbar { display: none; }
  @keyframes m3-pop { 0% { transform: scale(0.35); opacity: 0; } 62% { transform: scale(1.1); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
  @keyframes m3-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes m3-up { from { transform: translateY(34px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes m3-rise { from { transform: translateY(14px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes m3-dot { 0% { transform: translate(0,0) scale(1); opacity: 1; } 100% { transform: translate(var(--dx), var(--dy)) scale(0.35); opacity: 0; } }
  @keyframes m3-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
  @keyframes m3-shimmer { 0% { transform: translateX(-70%); } 100% { transform: translateX(180%); } }
  @keyframes m3-ping { 0% { transform: scale(0.55); opacity: 0.6; } 100% { transform: scale(1.9); opacity: 0; } }
  @keyframes m3-bounce { 0% { transform: scale(1); } 35% { transform: scale(1.45); } 70% { transform: scale(0.88); } 100% { transform: scale(1); } }
  @keyframes m3-shine { 0% { transform: translateX(-140%) skewX(-18deg); } 100% { transform: translateX(340%) skewX(-18deg); } }
  @media (prefers-reduced-motion: reduce) { .m3-fx { animation: none !important; } }
`;

// ── Store (same world, richer data) ──
const m3Products = [
  { id: 'p1', name: 'Oat Milk 12 pack', glyph: 'milk', price: 38.4, stock: 42, cat: 'Dairy', hue: 212, rating: 4.8, pop: 320, unit: '12 x 1L', bullets: ['Pack of 12 x 1L', 'Comes in the chilled van', 'Keeps 30 days unopened'] },
  { id: 'p2', name: 'Espresso Beans 1kg', glyph: 'beans', price: 24.0, stock: 6, cat: 'Coffee', hue: 42, rating: 4.9, pop: 410, unit: '1 kg bag', bullets: ['Medium dark roast', 'Roasted this week', 'Whole beans'] },
  { id: 'p3', name: 'Paper Cups 500', glyph: 'cups', price: 18.2, stock: 120, cat: 'Packaging', hue: 158, rating: 4.6, pop: 180, unit: '500 cups', bullets: ['12 oz double wall', 'Fits standard lids', 'Compostable'] },
  { id: 'p4', name: 'Sugar Syrup', glyph: 'syrup', price: 12.9, stock: 4, cat: 'Coffee', hue: 286, rating: 4.7, pop: 95, unit: '750 ml', bullets: ['Pump included', 'No artificial color', 'Keeps 6 months'] },
  { id: 'p5', name: 'Butter 5kg', glyph: 'butter', price: 42.0, stock: 18, cat: 'Dairy', hue: 62, rating: 4.8, pop: 150, unit: '5 kg block', bullets: ['Unsalted', 'Comes chilled', 'Local dairy'] },
  { id: 'p6', name: 'Flour 10kg', glyph: 'flour', price: 16.5, stock: 26, cat: 'Pantry', hue: 268, rating: 4.7, pop: 210, unit: '10 kg sack', bullets: ['Strong bakers flour', 'Protein 12.5%', 'Milled monthly'] },
  { id: 'p7', name: 'Sourdough Mix', glyph: 'bread', price: 21.0, stock: 30, cat: 'Pantry', hue: 26, rating: 4.5, pop: 60, unit: '2 kg mix', bullets: ['Starter included', 'Just add water', 'Makes 8 loaves'] },
  { id: 'p8', name: 'Cleaner 5L', glyph: 'clean', price: 14.0, stock: 12, cat: 'Pantry', hue: 196, rating: 4.4, pop: 75, unit: '5 L jug', bullets: ['Food safe', 'Unscented', 'Dilute 1:20'] },
];

const m3Customers = [
  { id: 'c1', name: 'Harbor Cafe', addr: '12 Quay St', owed: 284.5, last: 'Today', hue: 212 },
  { id: 'c2', name: 'Bluestone Grocery', addr: '48 Mill Rd', owed: 0, last: 'Yesterday', hue: 158 },
  { id: 'c3', name: 'Nordic Deli', addr: '221 Pine Ave', owed: 612.0, last: '2 days ago', hue: 262 },
  { id: 'c4', name: 'Station Street Bar', addr: '7 Elm Ln', owed: 421.8, last: 'Monday', hue: 22 },
  { id: 'c5', name: 'Maple and Oak', addr: '83 Cedar Dr', owed: 0, last: 'Last week', hue: 96 },
];

let m3Seq = 100;
const m3oid = () => 'o' + (++m3Seq);

const m3Orders = [
  { id: 'o1', custId: 'c2', items: [{ pid: 'p1', qty: 8 }, { pid: 'p5', qty: 4 }, { pid: 'p6', qty: 6 }], status: 'new', time: '7:12' },
  { id: 'o2', custId: 'c4', items: [{ pid: 'p2', qty: 6 }, { pid: 'p4', qty: 8 }], status: 'new', time: '7:40' },
  { id: 'o3', custId: 'c3', items: [{ pid: 'p1', qty: 4 }, { pid: 'p3', qty: 2 }], status: 'approved', time: '6:55' },
  { id: 'o4', custId: 'c5', items: [{ pid: 'p6', qty: 4 }, { pid: 'p7', qty: 3 }], status: 'approved', time: '6:30' },
  { id: 'o5', custId: 'c1', items: [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 4 }, { pid: 'p3', qty: 2 }], status: 'approved', time: '6:20' },
];

const m3Invoices = [
  { id: 'INV 1042', custId: 'c1', amount: 284.5, status: 'due', due: 'in 3 days' },
  { id: 'INV 1038', custId: 'c3', amount: 612.0, status: 'due', due: 'in 9 days' },
  { id: 'INV 1035', custId: 'c4', amount: 421.8, status: 'overdue', due: '2 days late' },
  { id: 'INV 1031', custId: 'c2', amount: 198.2, status: 'paid', due: '' },
  { id: 'INV 1027', custId: 'c5', amount: 342.6, status: 'paid', due: '' },
];

const m3Initial = {
  products: m3Products,
  customers: m3Customers,
  orders: m3Orders,
  invoices: m3Invoices,
  returns: [
    { id: 'r1', custId: 'c1', pname: 'Oat Milk 12 pack', qty: 2, reason: 'Damaged', amount: 12.8, status: 'pending' },
  ],
  route: { driver: null, status: 'draft' },
  runPhase: 'go',
  cart: {},
  favorites: ['p1', 'p2'],
  credits: 0,
  history: [
    { id: 'h1', date: 'Tue, Jun 30', total: 412.8, items: [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 4 }, { pid: 'p3', qty: 2 }, { pid: 'p4', qty: 3 }] },
    { id: 'h2', date: 'Tue, Jun 23', total: 298.5, items: [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 3 }] },
    { id: 'h3', date: 'Tue, Jun 16', total: 184.2, items: [{ pid: 'p1', qty: 4 }, { pid: 'p3', qty: 2 }] },
  ],
  standing: true,
  week: [1840, 2210, 1620, 2480, 2960, 1180, 2140], // Mon..Sun revenue
  toast: null,
};

const M3_REGULARS = [{ pid: 'p1', qty: 6 }, { pid: 'p2', qty: 4 }, { pid: 'p3', qty: 2 }];

function m3Price(products, items) {
  return items.reduce((s, it) => {
    const p = products.find(p => p.id === it.pid);
    return s + (p ? p.price * it.qty : 0);
  }, 0);
}

function m3Reducer(s, a) {
  switch (a.type) {
    case 'TOAST': return { ...s, toast: a.toast };
    case 'APPROVE_ORDER':
      return { ...s, orders: s.orders.map(o => o.id === a.id ? { ...o, status: 'approved' } : o), toast: { kind: 'ok', msg: 'Approved' } };
    case 'DECLINE_ORDER':
      return { ...s, orders: s.orders.map(o => o.id === a.id ? { ...o, status: 'declined' } : o), toast: { kind: 'ok', msg: 'Declined' } };
    case 'SET_DRIVER':
      return { ...s, route: { ...s.route, driver: a.name } };
    case 'SEND_ROUTE':
      return {
        ...s,
        route: { ...s.route, status: 'sent' },
        orders: s.orders.map(o => o.status === 'approved' ? { ...o, status: 'routed' } : o),
        toast: { kind: 'big', msg: 'Sent to ' + s.route.driver },
      };
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
      return {
        ...s,
        returns: s.returns.map(x => x.id === a.id ? { ...x, status: a.ok ? 'approved' : 'declined' } : x),
        credits: a.ok && r && r.custId === 'c1' ? +(s.credits + r.amount).toFixed(2) : s.credits,
        toast: { kind: 'ok', msg: a.ok ? 'Credit sent' : 'Return declined' },
      };
    }
    case 'CART_SET': {
      const cart = { ...s.cart };
      if (a.qty <= 0) delete cart[a.pid]; else cart[a.pid] = a.qty;
      return { ...s, cart };
    }
    case 'TOGGLE_FAV': {
      const has = s.favorites.includes(a.pid);
      return {
        ...s,
        favorites: has ? s.favorites.filter(x => x !== a.pid) : [...s.favorites, a.pid],
        toast: { kind: 'ok', msg: has ? 'Removed from favorites' : 'Saved to favorites' },
      };
    }
    case 'SEND_CART': {
      const items = Object.entries(s.cart).map(([pid, qty]) => ({ pid, qty }));
      if (!items.length) return s;
      return {
        ...s,
        cart: {},
        orders: [{ id: m3oid(), custId: 'c1', items, status: 'new', time: 'now' }, ...s.orders],
        toast: { kind: 'big', msg: 'Order placed' },
      };
    }
    case 'REORDER':
      return {
        ...s,
        orders: [{ id: m3oid(), custId: 'c1', items: a.items, status: 'new', time: 'now' }, ...s.orders],
        toast: { kind: 'big', msg: 'Order placed' },
      };
    case 'REPORT_PROBLEM': {
      const p = s.products.find(p => p.id === a.pid);
      return {
        ...s,
        returns: [{ id: 'r' + (++m3Seq), custId: 'c1', pname: p ? p.name : '', qty: a.qty, reason: a.reason, amount: p ? +(p.price * a.qty).toFixed(2) : 0, status: 'pending' }, ...s.returns],
        toast: { kind: 'big', msg: 'Sent. We are on it' },
      };
    }
    case 'TOGGLE_STANDING':
      return { ...s, standing: !s.standing, toast: { kind: 'ok', msg: s.standing ? 'Tuesdays paused' : 'Tuesdays back on' } };
    case 'START_RUN':
      return { ...s, route: { ...s.route, status: 'running' }, runPhase: 'go', toast: { kind: 'ok', msg: 'Run started' } };
    case 'ARRIVE':
      return { ...s, runPhase: 'checklist' };
    case 'COMPLETE_STOP': {
      const pending = s.orders.filter(o => o.status === 'routed');
      const cur = pending[0];
      if (!cur) return s;
      const total = m3Price(s.products, cur.items);
      const cust = s.customers.find(c => c.id === cur.custId);
      const isLast = pending.length === 1;
      return {
        ...s,
        orders: s.orders.map(o => o.id === cur.id ? { ...o, status: 'delivered' } : o),
        invoices: [{ id: 'INV ' + (1043 + (m3Seq++ % 50)), custId: cur.custId, amount: +total.toFixed(2), status: 'due', due: 'in 14 days' }, ...s.invoices],
        customers: s.customers.map(c => c.id === cur.custId ? { ...c, owed: +(c.owed + total).toFixed(2), last: 'Today' } : c),
        route: { ...s.route, status: isLast ? 'done' : 'running' },
        runPhase: 'go',
        toast: { kind: 'big', msg: cust ? cust.name + ' done' : 'Stop done' },
      };
    }
    case 'RESET_DAY':
      m3Seq = 100;
      return JSON.parse(JSON.stringify(m3Initial));
    default: return s;
  }
}

const M3Store = React.createContext(null);
function useM3() { return React.useContext(M3Store); }
const M3Overlay = React.createContext(null);

// ── Primitives ──
function M3Num({ v, size = 34, color = M3.ink, prefix = '', suffix = '', decimals = 0, countKey }) {
  // count-up on mount / key change
  const [disp, setDisp] = React.useState(v);
  const fromRef = React.useRef(0);
  React.useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    const dur = 700;
    let raf;
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      setDisp(from + (v - from) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    fromRef.current = v;
    return () => cancelAnimationFrame(raf);
  }, [v, countKey]);
  return (
    <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: size, color, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
      {prefix}{disp.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}
    </span>
  );
}

function M3Money({ v, size = 22, color = M3.ink, weight = 700 }) {
  const [d, c] = v.toFixed(2).split('.');
  return (
    <span style={{ fontFamily: M3.disp, fontWeight: weight, fontSize: size, color, letterSpacing: '-0.02em' }}>
      ${Number(d).toLocaleString()}<span style={{ fontSize: size * 0.66, opacity: 0.5 }}>.{c}</span>
    </span>
  );
}

function M3Avatar({ name, hue = 212, size = 46, dark }) {
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('');
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.38, flexShrink: 0,
      background: dark ? `oklch(35% 0.09 ${hue})` : `oklch(92% 0.05 ${hue})`,
      color: dark ? `oklch(85% 0.07 ${hue})` : `oklch(42% 0.13 ${hue})`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: M3.disp, fontWeight: 700, fontSize: size * 0.36,
    }}>{initials}</div>
  );
}

function M3Row({ children, gap = 12, style }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap, ...style }}>{children}</div>;
}

function M3Card({ children, onClick, style, pad = 18, anim, delay = 0 }) {
  return (
    <div className={onClick ? 'm3-press' : ''} onClick={onClick} style={{
      background: M3.card, borderRadius: M3RAD, padding: pad,
      border: '1px solid ' + M3.border,
      boxShadow: '0 2px 10px rgba(11,21,36,0.04)',
      animation: anim ? `m3-rise 380ms cubic-bezier(0.2,0.9,0.3,1) ${delay}ms both` : 'none',
      ...style,
    }}>{children}</div>
  );
}

// Pill button: gradient / dark / soft / line / green / danger
function M3Btn({ label, icon, onClick, tone = 'grad', disabled, h = 56, style, fs = 16.5 }) {
  const [shine, setShine] = React.useState(0);
  const fire = (e) => { setShine(s => s + 1); if (onClick) onClick(e); };
  const styles = {
    grad: { background: disabled ? '#C4CEDC' : M3GRAD, color: '#fff', boxShadow: disabled ? 'none' : '0 8px 22px rgba(37,99,235,0.32)' },
    dark: { background: disabled ? '#C4CEDC' : M3.canvas, color: '#fff', boxShadow: '0 8px 22px rgba(11,21,36,0.25)' },
    green: { background: disabled ? '#C4CEDC' : M3.green, color: '#fff', boxShadow: disabled ? 'none' : '0 8px 22px rgba(23,163,74,0.3)' },
    soft: { background: M3ACCSOFT, color: 'var(--m3-acc, #2563EB)' },
    line: { background: '#fff', color: M3.ink, border: '1.5px solid ' + M3.border },
    danger: { background: M3.redSoft, color: M3.red },
    glass: { background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', backdropFilter: 'blur(8px)' },
  }[tone];
  return (
    <div className={disabled ? '' : 'm3-press'} onClick={disabled ? undefined : fire} style={{
      height: h, borderRadius: 999, padding: '0 22px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
      fontFamily: M3.disp, fontWeight: 700, fontSize: fs, letterSpacing: '-0.01em',
      position: 'relative', overflow: 'hidden',
      ...styles, ...style,
    }}>
      {shine > 0 && (tone === 'grad' || tone === 'green' || tone === 'dark') && (
        <span key={shine} className="m3-fx" style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: '38%',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)',
          animation: 'm3-shine 550ms ease-out both', pointerEvents: 'none',
        }}/>
      )}
      {icon && M3I(icon, { size: fs * 1.25, color: styles.color })}
      {label}
    </div>
  );
}

function M3Round({ icon, onClick, tone = 'soft', size = 48, badge }) {
  const [fx, setFx] = React.useState([]);
  const fire = (e) => {
    const id = Date.now() + Math.random();
    setFx(a => [...a.slice(-2), id]);
    setTimeout(() => setFx(a => a.filter(x => x !== id)), 700);
    if (onClick) onClick(e);
  };
  const map = {
    soft: [M3ACCSOFT, 'var(--m3-acc, #2563EB)'],
    grad: [M3GRAD, '#fff'],
    dark: [M3.canvas, '#fff'],
    green: [M3.green, '#fff'],
    danger: [M3.redSoft, M3.red],
    white: ['#fff', M3.ink],
    glass: ['rgba(255,255,255,0.14)', '#fff'],
  }[tone];
  return (
    <div className="m3-press" onClick={fire} style={{
      width: size, height: size, borderRadius: size / 2, flexShrink: 0, position: 'relative',
      background: map[0], display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: tone === 'white' ? '1px solid ' + M3.border : tone === 'glass' ? '1px solid rgba(255,255,255,0.2)' : 'none',
      boxShadow: tone === 'grad' || tone === 'green' ? '0 6px 16px rgba(11,21,36,0.22)' : 'none',
    }}>
      {fx.map(id => (
        <React.Fragment key={id}>
          <span className="m3-fx" style={{
            position: 'absolute', inset: -2, borderRadius: '50%', pointerEvents: 'none',
            border: '2.5px solid ' + ((tone === 'grad' || tone === 'green' || tone === 'dark') ? 'rgba(255,255,255,0.85)' : map[1]),
            animation: 'm3-ping 480ms ease-out both',
          }}/>
          {(tone === 'grad' || tone === 'green') && [0, 1, 2, 3, 4, 5].map(i => {
            const ang = (i / 6) * Math.PI * 2 + 0.5;
            return <span key={i} className="m3-fx" style={{
              position: 'absolute', left: '50%', top: '50%', width: 5, height: 5, borderRadius: 3,
              marginLeft: -2.5, marginTop: -2.5, pointerEvents: 'none',
              background: i % 3 === 0 ? '#6EE7A0' : i % 3 === 1 ? '#8FBAFB' : '#F5B860',
              '--dx': Math.cos(ang) * size * 0.85 + 'px', '--dy': Math.sin(ang) * size * 0.85 + 'px',
              animation: 'm3-dot 560ms 40ms ease-out both',
            }}/>;
          })}
        </React.Fragment>
      ))}
      {M3I(icon, { size: size * 0.44, color: map[1] })}
      {badge ? (
        <div key={String(badge)} className="m3-fx" style={{
          position: 'absolute', top: -4, right: -4, minWidth: 19, height: 19, borderRadius: 10,
          background: M3.red, color: '#fff', fontFamily: M3.body, fontSize: 11, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px',
          border: '2px solid #fff',
          animation: 'm3-bounce 450ms cubic-bezier(0.3,1.4,0.5,1) both',
        }}>{badge}</div>
      ) : null}
    </div>
  );
}

function M3Pill({ label, tone = 'blue', dark }) {
  const m = {
    blue: [dark ? 'rgba(96,165,250,0.18)' : M3ACCSOFT, dark ? '#8FBAFB' : 'var(--m3-acc, #2563EB)'],
    green: [dark ? 'rgba(23,163,74,0.22)' : M3.greenSoft, dark ? '#6EE7A0' : M3.green],
    amber: [dark ? 'rgba(217,125,13,0.2)' : M3.amberSoft, dark ? '#F5B860' : M3.amber],
    red: [dark ? 'rgba(220,59,59,0.2)' : M3.redSoft, dark ? '#F19A9A' : M3.red],
    gray: [dark ? 'rgba(255,255,255,0.1)' : '#EEF1F5', dark ? M3.wsub : M3.sub],
  }[tone];
  return (
    <span style={{
      padding: '5px 11px', borderRadius: 999, background: m[0], color: m[1],
      fontFamily: M3.body, fontWeight: 700, fontSize: 12, letterSpacing: '0.01em', whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// Hero zone: navy gradient block that sits behind the status bar
function M3Hero({ children, pad = '68px 20px 26px', style }) {
  return (
    <div style={{
      background: `linear-gradient(165deg, ${M3.canvas} 0%, ${M3.canvasMid} 55%, ${M3.canvasLight} 100%)`,
      borderRadius: '0 0 34px 34px',
      padding: pad, position: 'relative', overflow: 'hidden',
      ...style,
    }}>
      {/* glow orbs */}
      <div style={{ position: 'absolute', width: 240, height: 240, borderRadius: '50%', background: 'radial-gradient(circle, rgba(59,130,246,0.25), transparent 70%)', top: -80, right: -60, pointerEvents: 'none' }}/>
      <div style={{ position: 'absolute', width: 200, height: 200, borderRadius: '50%', background: 'radial-gradient(circle, rgba(37,99,235,0.16), transparent 70%)', bottom: -90, left: -50, pointerEvents: 'none' }}/>
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}

// Screen scaffold: hero + scrollable body
function M3Scr({ hero, children, bodyPad = '18px 16px 128px', bg = M3.paper }) {
  return (
    <div className="m3-scroll" style={{
      position: 'absolute', inset: 0, overflowY: 'auto',
      background: bg, fontFamily: M3.body,
    }}>
      {hero}
      <div style={{ padding: bodyPad }}>{children}</div>
    </div>
  );
}

// Glass dock nav
function M3Dock({ tabs, active, onChange }) {
  return (
    <div style={{
      position: 'absolute', left: 14, right: 14, bottom: 14, zIndex: 60,
      background: 'rgba(13,23,40,0.86)', backdropFilter: 'blur(18px) saturate(160%)',
      borderRadius: 999, padding: 7,
      border: '1px solid rgba(255,255,255,0.1)',
      display: 'flex', justifyContent: 'space-between',
      boxShadow: '0 14px 38px rgba(11,21,36,0.4)',
    }}>
      {tabs.map(t => {
        const on = t.id === active;
        return (
          <div key={t.id} className="m3-press" onClick={() => onChange(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 7, position: 'relative',
            padding: on ? '11px 16px' : '11px 13px', borderRadius: 999,
            background: on ? M3GRAD : 'transparent',
            boxShadow: on ? '0 6px 16px rgba(37,99,235,0.4)' : 'none',
            transition: 'background 220ms',
          }}>
            {t.badge ? (
              <div key={String(t.badge)} className="m3-fx" style={{
                position: 'absolute', top: 3, right: 5, minWidth: 17, height: 17, borderRadius: 9,
                background: M3.red, color: '#fff', fontSize: 10.5, fontWeight: 800, fontFamily: M3.body,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
                animation: 'm3-bounce 450ms cubic-bezier(0.3,1.4,0.5,1) both',
              }}>{t.badge}</div>
            ) : null}
            {M3I(t.icon, { size: 22, color: on ? '#fff' : 'rgba(255,255,255,0.55)', sw: on ? 2.4 : 2.1 })}
            {on && <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13, color: '#fff', whiteSpace: 'nowrap' }}>{t.label}</span>}
          </div>
        );
      })}
    </div>
  );
}

// Bottom sheet (portals to device root)
function M3Sheet({ open, onClose, children, title, dark }) {
  const overlay = React.useContext(M3Overlay);
  if (!open) return null;
  const body = (
    <div style={{ position: 'absolute', inset: 0, zIndex: 80 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(6,12,22,0.5)', backdropFilter: 'blur(2px)', animation: 'm3-fade 200ms both' }}/>
      <div className="m3-scroll" style={{
        position: 'absolute', left: 8, right: 8, bottom: 8, maxHeight: '80%',
        overflowY: 'auto',
        background: dark ? M3.canvasMid : '#fff',
        borderRadius: 30,
        border: dark ? '1px solid rgba(255,255,255,0.1)' : 'none',
        padding: '14px 18px 18px',
        animation: 'm3-up 320ms cubic-bezier(0.2,0.9,0.3,1) both',
        boxShadow: '0 -12px 44px rgba(6,12,22,0.3)',
      }}>
        <div style={{ width: 42, height: 4.5, borderRadius: 3, background: dark ? 'rgba(255,255,255,0.2)' : '#DBE2EB', margin: '0 auto 12px' }}/>
        {title && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 21, color: dark ? '#fff' : M3.ink, letterSpacing: '-0.02em' }}>{title}</div>
            <div className="m3-press" onClick={onClose} style={{ width: 34, height: 34, borderRadius: 17, background: dark ? 'rgba(255,255,255,0.1)' : '#EEF1F5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('x', { size: 15, color: dark ? '#fff' : M3.sub })}
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

// Toast + celebration
function M3Toast({ celebrate = true }) {
  const { store, dispatch } = useM3();
  const t = store.toast;
  React.useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => dispatch({ type: 'TOAST', toast: null }), t.kind === 'big' ? 1500 : 1300);
    return () => clearTimeout(h);
  }, [t]);
  if (!t) return null;
  if (t.kind === 'big' && celebrate) {
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(9,17,30,0.45)', backdropFilter: 'blur(3px)', animation: 'm3-fade 200ms both' }}/>
        <div style={{ position: 'relative', textAlign: 'center', animation: 'm3-pop 400ms cubic-bezier(0.2,0.9,0.3,1) both' }}>
          <div style={{ position: 'relative', width: 100, height: 100, margin: '0 auto' }}>
            {Array.from({ length: 10 }).map((_, i) => {
              const ang = (i / 10) * Math.PI * 2;
              return <div key={i} style={{
                position: 'absolute', left: 45, top: 45, width: 10, height: 10, borderRadius: 5,
                background: i % 3 === 0 ? '#6EE7A0' : i % 3 === 1 ? '#8FBAFB' : '#F5B860',
                '--dx': Math.cos(ang) * 80 + 'px', '--dy': Math.sin(ang) * 80 + 'px',
                animation: 'm3-dot 750ms 120ms ease-out both',
              }}/>;
            })}
            <div style={{
              width: 100, height: 100, borderRadius: 50, background: M3.green,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 18px 46px rgba(23,163,74,0.5)',
            }}>{M3I('check', { size: 50, color: '#fff', sw: 3 })}</div>
          </div>
          <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 25, color: '#fff', marginTop: 18, letterSpacing: '-0.02em', textShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>{t.msg}</div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 112, zIndex: 90, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9,
        background: 'rgba(13,23,40,0.92)', backdropFilter: 'blur(10px)',
        color: '#fff', padding: '12px 20px', borderRadius: 999,
        fontFamily: M3.body, fontWeight: 700, fontSize: 14.5,
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 12px 32px rgba(6,12,22,0.4)',
        animation: 'm3-up 260ms cubic-bezier(0.2,0.9,0.3,1) both',
      }}>
        <div style={{ width: 21, height: 21, borderRadius: 11, background: M3.green, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {M3I('check', { size: 12, color: '#fff', sw: 3.2 })}
        </div>
        {t.msg}
      </div>
    </div>
  );
}

// Product tile: rich gradient squircle
function M3Tile({ p, height = 108, glyphSize = 46, radius = 20, style }) {
  return (
    <div style={{
      height, borderRadius: radius, position: 'relative', overflow: 'hidden',
      background: `linear-gradient(150deg, oklch(96% 0.03 ${p.hue}) 0%, oklch(88% 0.09 ${p.hue}) 100%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      ...style,
    }}>
      <div style={{ position: 'absolute', width: height * 1.2, height: height * 1.2, borderRadius: '50%', background: `oklch(84% 0.11 ${p.hue} / 0.55)`, right: -height * 0.4, top: -height * 0.45 }}/>
      <div style={{ position: 'absolute', width: height * 0.8, height: height * 0.8, borderRadius: '50%', background: `oklch(97% 0.02 ${p.hue} / 0.8)`, left: -height * 0.3, bottom: -height * 0.35 }}/>
      <div style={{ position: 'relative', filter: 'drop-shadow(0 10px 12px rgba(11,21,36,0.2))' }}>
        <M3Glyph name={p.glyph} size={glyphSize} color={`oklch(38% 0.12 ${p.hue})`}/>
      </div>
    </div>
  );
}

function M3Stars({ rating, size = 12 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1.5 }}>
      {[0, 1, 2, 3, 4].map(i => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24">
          <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z"
            fill={i < Math.round(rating) ? '#F0A824' : '#DFE5EC'}/>
        </svg>
      ))}
    </span>
  );
}

// Stepper (pill)
function M3Stepper({ value, onChange, min = 0, dark }) {
  const bg = dark ? 'rgba(255,255,255,0.1)' : M3ACCSOFT;
  const fg = dark ? '#fff' : 'var(--m3-acc, #2563EB)';
  return (
    <M3Row gap={0} style={{ background: bg, borderRadius: 999, overflow: 'hidden' }}>
      <div className="m3-press" onClick={() => onChange(Math.max(min, value - 1))} style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {M3I('minus', { size: 18, color: fg })}
      </div>
      <div style={{ width: 34, textAlign: 'center', fontFamily: M3.disp, fontWeight: 700, fontSize: 18, color: dark ? '#fff' : M3.ink }}>{value}</div>
      <div className="m3-press" onClick={() => onChange(value + 1)} style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {M3I('plus', { size: 18, color: fg })}
      </div>
    </M3Row>
  );
}

// Sparkline
function M3Spark({ data, w = 120, h = 38, color = '#8FBAFB' }) {
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * (w - 6) + 3,
    h - 5 - ((v - min) / (max - min || 1)) * (h - 12),
  ]);
  const path = 'M ' + pts.map(p => p.map(n => n.toFixed(1)).join(' ')).join(' L ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path + ` L ${w - 3} ${h - 2} L 3 ${h - 2} Z`} fill={color} opacity="0.14"/>
      <path d={path} stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3.4" fill={color}/>
    </svg>
  );
}

// Progress steps (buyer tracking) — horizontal glow line
function M3Steps({ labels, current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {labels.map((l, i) => {
        const done = i < current, on = i === current;
        return (
          <React.Fragment key={i}>
            {i > 0 && <div style={{ flex: 1, height: 4, borderRadius: 2, background: i <= current ? M3.green : '#E4E9F0', marginTop: 14 }}/>}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 62 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 16,
                background: done || on ? M3.green : '#E4E9F0',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                animation: on ? 'm3-pulse 1.6s infinite' : 'none',
                boxShadow: on ? '0 5px 14px rgba(23,163,74,0.4)' : 'none',
              }}>
                {done ? M3I('check', { size: 15, color: '#fff', sw: 3.2 }) : <div style={{ width: 9, height: 9, borderRadius: 5, background: on ? '#fff' : '#B7C2D1' }}/>}
              </div>
              <div style={{ fontFamily: M3.body, fontSize: 10.5, fontWeight: on ? 800 : 600, color: on ? M3.ink : M3.faint }}>{l}</div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function M3Empty({ icon, title, sub, dark }) {
  return (
    <div style={{ textAlign: 'center', padding: '42px 20px' }}>
      <div style={{
        width: 82, height: 82, borderRadius: 30,
        background: dark ? 'rgba(255,255,255,0.08)' : M3ACCSOFT,
        display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
      }}>{M3I(icon, { size: 38, color: dark ? '#8FBAFB' : 'var(--m3-acc, #2563EB)' })}</div>
      <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 19, color: dark ? '#fff' : M3.ink }}>{title}</div>
      {sub && <div style={{ fontFamily: M3.body, fontSize: 14, fontWeight: 500, color: dark ? M3.wsub : M3.sub, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// Error boundary
class M3Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: false }; }
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    if (this.state.err) return (
      <M3Scr hero={<M3Hero><div style={{ height: 30 }}/></M3Hero>}>
        <M3Card pad={20}>
          <M3Empty icon="alert" title="Small hiccup" sub="Tap below to reload this screen"/>
          <M3Btn label="Reload" icon="repeat" onClick={() => this.setState({ err: false })}/>
        </M3Card>
      </M3Scr>
    );
    return this.props.children;
  }
}

// Section header
function M3Section({ label, count, right, style }) {
  return (
    <M3Row style={{ justifyContent: 'space-between', padding: '2px 6px', marginBottom: 12, ...style }}>
      <M3Row gap={8}>
        <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 17.5, color: M3.ink, letterSpacing: '-0.01em' }}>{label}</span>
        {count > 0 && <span style={{
          minWidth: 23, height: 23, borderRadius: 12, background: M3GRAD, color: '#fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: M3.disp, fontWeight: 700, fontSize: 12.5, padding: '0 7px',
        }}>{count}</span>}
      </M3Row>
      {right}
    </M3Row>
  );
}

// Item lines (order contents)
function M3Lines({ items, dark }) {
  const { store } = useM3();
  return (
    <div>
      {items.map((it, i) => {
        const p = store.products.find(p => p.id === it.pid);
        if (!p) return null;
        return (
          <M3Row key={i} style={{ padding: '9px 2px', borderBottom: '1px solid ' + (dark ? 'rgba(255,255,255,0.08)' : M3.border) }}>
            <M3Tile p={p} height={42} glyphSize={24} radius={14} style={{ width: 42, flexShrink: 0 }}/>
            <div style={{ flex: 1, fontFamily: M3.body, fontWeight: 600, fontSize: 14.5, color: dark ? '#fff' : M3.ink }}>{p.name}</div>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: dark ? M3.wsub : M3.sub }}>× {it.qty}</div>
          </M3Row>
        );
      })}
    </div>
  );
}

Object.assign(window, {
  M3, M3ACC, M3ACC2, M3ACCSOFT, M3GRAD, M3RAD, M3I, M3Ic, M3Glyph, m3Css,
  M3Store, useM3, M3Overlay, m3Reducer, m3Initial, m3Price, M3_REGULARS,
  M3Num, M3Money, M3Avatar, M3Row, M3Card, M3Btn, M3Round, M3Pill, M3Hero,
  M3Scr, M3Dock, M3Sheet, M3Toast, M3Tile, M3Stars, M3Stepper, M3Spark,
  M3Steps, M3Empty, M3Boundary, M3Section, M3Lines,
});
