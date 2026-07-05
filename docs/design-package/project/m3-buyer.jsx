// m3-buyer.jsx — Buyer app (Maya at Harbor Cafe): Home, Shop, Orders, Money
// Multi-seller portal. Shop: storefront -> product page -> basket -> checkout.

function B3App() {
  const [tab, setTab] = React.useState(() => localStorage.getItem('m3:by:tab') || 'home');
  const { store } = useM3();
  React.useEffect(() => { localStorage.setItem('m3:by:tab', tab); }, [tab]);
  const cartN = Object.values(store.cart).reduce((s, q) => s + q, 0);
  const tabs = [
    { id: 'home', icon: 'home', label: 'Home' },
    { id: 'shop', icon: 'bag', label: 'Shop', badge: cartN || null },
    { id: 'orders', icon: 'box', label: 'Orders' },
    { id: 'money', icon: 'money', label: 'Money' },
  ];
  return (
    <>
      {tab === 'home' && <B3Home goShop={() => setTab('shop')}/>}
      {tab === 'shop' && <B3Shop/>}
      {tab === 'orders' && <B3Orders/>}
      {tab === 'money' && <B3Money/>}
      <M3Dock tabs={tabs} active={tab} onChange={setTab}/>
    </>
  );
}

function b3Step(status) { return { new: 0, approved: 1, routed: 2, delivered: 3 }[status] ?? 0; }

function useB3Order() {
  const { store } = useM3();
  const mine = store.orders.filter(o => o.custId === 'c1' && o.status !== 'declined');
  return { active: mine.find(o => o.status !== 'delivered'), mine };
}

// Seller switcher chip (multi-seller portal, like buyer/portal/[seller])
function B3Seller() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <div className="m3-press" onClick={() => setOpen(true)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '8px 13px', borderRadius: 999,
        background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.18)',
      }}>
        <div style={{ width: 20, height: 20, borderRadius: 8, background: M3GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {M3I('building', { size: 12, color: '#fff', sw: 2.6 })}
        </div>
        <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13, color: '#fff' }}>Fresh Fields</span>
        {M3I('switch', { size: 13, color: 'rgba(255,255,255,0.6)' })}
      </div>
      <M3Sheet open={open} onClose={() => setOpen(false)} title="Your suppliers">
        {[
          { name: 'Fresh Fields Wholesale', sub: 'Harbor Cafe account', on: true, status: 'Active', tone: 'green', hue: 212 },
          { name: 'Metro Beverage Co', sub: 'Waiting for their ok', on: false, status: 'Pending', tone: 'amber', hue: 26 },
        ].map((s, i) => (
          <div key={i} className="m3-press" onClick={() => setOpen(false)} style={{
            display: 'flex', alignItems: 'center', gap: 13,
            padding: '14px 14px', marginBottom: 9, borderRadius: 20,
            background: s.on ? M3ACCSOFT : M3.paper,
            border: '2px solid ' + (s.on ? 'var(--m3-acc, #2563EB)' : 'transparent'),
          }}>
            <M3Avatar name={s.name} hue={s.hue} size={44}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: M3.ink }}>{s.name}</div>
              <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>{s.sub}</div>
            </div>
            <M3Pill label={s.status} tone={s.tone}/>
          </div>
        ))}
        <div style={{ fontFamily: M3.body, textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: M3.faint, marginTop: 6 }}>
          One login, all your suppliers
        </div>
      </M3Sheet>
    </>
  );
}

// ── Home ──
function B3Home({ goShop }) {
  const { store, dispatch } = useM3();
  const { active } = useB3Order();
  const [problem, setProblem] = React.useState(false);
  const regs = M3_REGULARS.map(r => store.products.find(p => p.id === r.pid));

  return (
    <M3Scr hero={
      <M3Hero>
        <M3Row style={{ justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: M3.body, fontSize: 13.5, fontWeight: 600, color: M3.wsub }}>Harbor Cafe</div>
            <div style={{ fontFamily: M3.disp, fontSize: 27, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em', marginTop: 2 }}>Hi Maya</div>
          </div>
          <B3Seller/>
        </M3Row>

        {/* Delivery status inside hero */}
        {active ? (
          <div style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 22, padding: 16 }}>
            <M3Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: '#fff' }}>Your delivery</span>
              {active.status === 'routed'
                ? <M3Pill dark label={store.route.status === 'running' ? 'On the way' : 'Loading van'} tone="green"/>
                : <M3Pill dark label={active.status === 'new' ? 'Sent' : 'Packing'} tone={active.status === 'new' ? 'blue' : 'amber'}/>}
            </M3Row>
            <B3TrackBar current={active.status === 'routed' && store.route.status === 'running' ? 2 : b3Step(active.status)}/>
            {active.status === 'routed' && store.route.status === 'running' && (
              <M3Row gap={8} style={{ marginTop: 12 }}>
                {M3I('truck', { size: 18, color: '#6EE7A0' })}
                <span style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 13, color: '#6EE7A0' }}>Tom is 2 stops away</span>
              </M3Row>
            )}
          </div>
        ) : (
          <div style={{ background: 'rgba(23,163,74,0.14)', border: '1px solid rgba(23,163,74,0.3)', borderRadius: 22, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 16, background: M3.green, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('check', { size: 21, color: '#fff', sw: 3 })}
            </div>
            <div>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: '#fff' }}>All delivered</div>
              <div style={{ fontFamily: M3.body, fontSize: 12.5, fontWeight: 600, color: M3.wsub }}>Nothing on the way</div>
            </div>
          </div>
        )}
      </M3Hero>
    }>
      {/* One tap reorder */}
      <div className="m3-press" onClick={() => dispatch({ type: 'REORDER', items: M3_REGULARS })} style={{
        background: M3GRAD, borderRadius: M3RAD, padding: 18,
        boxShadow: '0 14px 32px rgba(37,99,235,0.32)',
        position: 'relative', overflow: 'hidden', marginBottom: 12,
      }}>
        <div style={{ position: 'absolute', width: 150, height: 150, borderRadius: 75, background: 'rgba(255,255,255,0.1)', right: -46, top: -56 }}/>
        <M3Row style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 18.5, color: '#fff', letterSpacing: '-0.01em' }}>Order my usual</div>
            <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 3 }}>
              One tap · ${m3Price(store.products, M3_REGULARS).toFixed(2)}
            </div>
            <M3Row gap={6} style={{ marginTop: 12 }}>
              {regs.map(p => p && (
                <div key={p.id} style={{ width: 36, height: 36, borderRadius: 13, background: 'rgba(255,255,255,0.94)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <M3Glyph name={p.glyph} size={21} color={`oklch(40% 0.12 ${p.hue})`}/>
                </div>
              ))}
            </M3Row>
          </div>
          <div style={{ width: 52, height: 52, borderRadius: 26, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }}>
            {M3I('bolt', { size: 26, color: '#fff' })}
          </div>
        </M3Row>
      </div>

      {/* Standing order + quick actions */}
      <M3Row gap={12} style={{ marginBottom: 12 }}>
        <M3Card pad={15} onClick={() => dispatch({ type: 'TOGGLE_STANDING' })} style={{ flex: 1 }}>
          <M3Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ width: 40, height: 40, borderRadius: 15, background: store.standing ? M3.greenSoft : M3.paper, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('repeat', { size: 20, color: store.standing ? M3.green : M3.faint })}
            </div>
            <div style={{
              width: 42, height: 26, borderRadius: 14, padding: 3, boxSizing: 'border-box',
              background: store.standing ? M3.green : '#D8DFE9', transition: 'background 200ms',
            }}>
              <div style={{ width: 20, height: 20, borderRadius: 10, background: '#fff', transform: `translateX(${store.standing ? 16 : 0}px)`, transition: 'transform 200ms', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}/>
            </div>
          </M3Row>
          <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.ink }}>Every Tuesday</div>
          <div style={{ fontSize: 12, color: M3.sub, fontWeight: 600 }}>{store.standing ? 'Usual order runs itself' : 'Paused'}</div>
        </M3Card>
        <M3Card pad={15} onClick={() => setProblem(true)} style={{ flex: 1 }}>
          <div style={{ width: 40, height: 40, borderRadius: 15, background: M3.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
            {M3I('alert', { size: 20, color: M3.amber })}
          </div>
          <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.ink }}>Something wrong?</div>
          <div style={{ fontSize: 12, color: M3.sub, fontWeight: 600 }}>Fixed in 3 taps</div>
        </M3Card>
      </M3Row>

      {/* Favorites rail */}
      <M3Section label="Your favorites" right={
        <span className="m3-press" onClick={goShop} style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 13, color: 'var(--m3-acc, #2563EB)' }}>Shop all</span>
      }/>
      <div className="m3-scroll" style={{ display: 'flex', gap: 10, overflowX: 'auto', margin: '0 -16px', padding: '0 16px 4px' }}>
        {store.favorites.map(pid => {
          const p = store.products.find(x => x.id === pid);
          if (!p) return null;
          const q = store.cart[pid] || 0;
          return (
            <M3Card key={pid} pad={11} style={{ minWidth: 150 }}>
              <M3Tile p={p} height={72} glyphSize={34} radius={15} style={{ marginBottom: 9 }}/>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13, color: M3.ink, lineHeight: 1.15, minHeight: 30 }}>{p.name}</div>
              <M3Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                <M3Money v={p.price} size={14}/>
                <M3Round icon={q ? 'check' : 'plus'} tone={q ? 'green' : 'grad'} size={34} onClick={() => dispatch({ type: 'CART_SET', pid, qty: q + 1 })}/>
              </M3Row>
            </M3Card>
          );
        })}
      </div>

      <B3Problem open={problem} onClose={() => setProblem(false)}/>
    </M3Scr>
  );
}

function B3TrackBar({ current }) {
  const labels = ['Sent', 'Packing', 'Driving', 'Here'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {labels.map((l, i) => {
        const done = i < current, on = i === current;
        return (
          <div key={i} style={{ flex: 1 }}>
            <div style={{
              height: 6, borderRadius: 3,
              background: done || on ? M3.green : 'rgba(255,255,255,0.14)',
              animation: on ? 'm3-pulse 1.6s infinite' : 'none',
            }}/>
            <div style={{ fontFamily: M3.body, fontSize: 10.5, fontWeight: on ? 800 : 600, color: on ? '#6EE7A0' : M3.wfaint, marginTop: 6, textAlign: 'center' }}>{l}</div>
          </div>
        );
      })}
    </div>
  );
}

// Problem flow: item -> reason -> sent
function B3Problem({ open, onClose }) {
  const { store, dispatch } = useM3();
  const [pick, setPick] = React.useState(null);
  const last = store.history[0];
  React.useEffect(() => { if (!open) setPick(null); }, [open]);
  return (
    <M3Sheet open={open} onClose={onClose} title={pick ? 'What happened?' : 'Which item?'}>
      {!pick && (
        <>
          <div style={{ fontFamily: M3.body, fontSize: 13, fontWeight: 600, color: M3.sub, marginBottom: 12 }}>From {last.date}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {last.items.map(it => {
              const p = store.products.find(p => p.id === it.pid);
              return (
                <div key={it.pid} className="m3-press" onClick={() => setPick(it)} style={{ background: M3.paper, borderRadius: 20, padding: 11, textAlign: 'center' }}>
                  <M3Tile p={p} height={70} glyphSize={32} radius={15}/>
                  <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13, color: M3.ink, marginTop: 9, lineHeight: 1.2 }}>{p.name}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {pick && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {[
            { r: 'Damaged', icon: 'alert', bg: M3.amberSoft, fg: M3.amber },
            { r: 'Missing', icon: 'x', bg: M3.redSoft, fg: M3.red },
            { r: 'Wrong item', icon: 'undo', bg: M3ACCSOFT, fg: 'var(--m3-acc, #2563EB)' },
          ].map(o => (
            <div key={o.r} className="m3-press" onClick={() => { dispatch({ type: 'REPORT_PROBLEM', pid: pick.pid, qty: 1, reason: o.r === 'Wrong item' ? 'Wrong' : o.r }); onClose(); }} style={{
              display: 'flex', alignItems: 'center', gap: 13,
              background: M3.paper, borderRadius: 20, padding: '15px 16px',
            }}>
              <div style={{ width: 44, height: 44, borderRadius: 16, background: o.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {M3I(o.icon, { size: 21, color: o.fg })}
              </div>
              <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16.5, color: M3.ink }}>{o.r}</span>
              <div style={{ marginLeft: 'auto' }}>{M3I('chev', { size: 17, color: M3.faint })}</div>
            </div>
          ))}
        </div>
      )}
    </M3Sheet>
  );
}

// ══════════ SHOP ══════════
function B3Shop() {
  const { store } = useM3();
  const [page, setPage] = React.useState({ name: 'front' });
  const cartN = Object.values(store.cart).reduce((s, q) => s + q, 0);
  const go = (name, extra) => setPage({ name, ...extra });
  return (
    <>
      {page.name === 'front' && <B3Front go={go} cartN={cartN}/>}
      {page.name === 'pdp' && <B3PDP key={page.pid} pid={page.pid} go={go} cartN={cartN}/>}
      {page.name === 'cart' && <B3Cart go={go}/>}
      {page.name === 'checkout' && <B3Checkout go={go}/>}
    </>
  );
}

function B3Front({ go, cartN }) {
  const { store, dispatch } = useM3();
  const [q, setQ] = React.useState('');
  const [cat, setCat] = React.useState('All');
  const [favOnly, setFavOnly] = React.useState(false);
  const cats = ['All', 'Dairy', 'Coffee', 'Packaging', 'Pantry'];
  const list = store.products.filter(p =>
    (cat === 'All' || p.cat === cat) &&
    (!favOnly || store.favorites.includes(p.id)) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <M3Scr hero={
      <M3Hero pad="66px 20px 20px">
        <M3Row style={{ justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontFamily: M3.disp, fontSize: 27, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>Shop</div>
          <M3Row gap={9}>
            <M3Round icon="heart" tone={favOnly ? 'grad' : 'glass'} size={44} onClick={() => setFavOnly(!favOnly)}/>
            <M3Round icon="bag" tone="glass" size={44} badge={cartN || null} onClick={() => go('cart')}/>
          </M3Row>
        </M3Row>
        {/* Search */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 999, padding: '0 18px', height: 50,
        }}>
          {M3I('search', { size: 19, color: 'rgba(255,255,255,0.5)' })}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalog"
            style={{ border: 'none', outline: 'none', flex: 1, fontFamily: M3.body, fontWeight: 600, fontSize: 15, color: '#fff', background: 'transparent' }}/>
          {q && <div className="m3-press" onClick={() => setQ('')}>{M3I('x', { size: 15, color: 'rgba(255,255,255,0.5)' })}</div>}
        </div>
        {/* Cats */}
        <div className="m3-scroll" style={{ display: 'flex', gap: 7, overflowX: 'auto', margin: '14px -20px 0', padding: '0 20px' }}>
          {cats.map(c => {
            const on = c === cat;
            return (
              <div key={c} className="m3-press" onClick={() => setCat(c)} style={{
                padding: '9px 17px', borderRadius: 999, whiteSpace: 'nowrap',
                background: on ? '#fff' : 'rgba(255,255,255,0.09)',
                border: '1px solid ' + (on ? '#fff' : 'rgba(255,255,255,0.14)'),
                fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5,
                color: on ? M3.ink : M3.wsub,
              }}>{c}</div>
            );
          })}
        </div>
      </M3Hero>
    } bodyPad={'16px 16px ' + (cartN ? 190 : 128) + 'px'}>
      {/* Deal banner */}
      {!q && cat === 'All' && !favOnly && (
        <div className="m3-press" onClick={() => go('pdp', { pid: 'p2' })} style={{
          borderRadius: M3RAD, overflow: 'hidden', position: 'relative', marginBottom: 14,
          background: 'linear-gradient(140deg, oklch(94% 0.05 42), oklch(85% 0.1 42))',
          padding: 18, display: 'flex', gap: 16, alignItems: 'center',
        }}>
          <div style={{ position: 'absolute', top: 0, bottom: 0, width: 70, background: 'linear-gradient(105deg, transparent, rgba(255,255,255,0.5), transparent)', animation: 'm3-shimmer 2.8s infinite' }}/>
          <div style={{ filter: 'drop-shadow(0 10px 14px rgba(11,21,36,0.2))' }}>
            <M3Glyph name="beans" size={56} color="oklch(36% 0.11 42)"/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'inline-block', padding: '4px 11px', borderRadius: 999, background: M3.ink, color: '#fff', fontFamily: M3.disp, fontWeight: 700, fontSize: 11.5, marginBottom: 6 }}>10% OFF THIS WEEK</div>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 17.5, color: M3.ink }}>Espresso Beans 1kg</div>
            <div style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 13, color: 'rgba(11,21,36,0.6)' }}>$24.00 → $21.60</div>
          </div>
          {M3I('chev', { size: 20, color: 'rgba(11,21,36,0.4)' })}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {list.map((p, i) => <B3GridCard key={p.id} p={p} i={i} go={go}/>)}
      </div>
      {list.length === 0 && <M3Card><M3Empty icon="search" title="Nothing found" sub={favOnly ? 'No favorites in this filter' : 'Try another word'}/></M3Card>}

      <B3CartBar go={go}/>
    </M3Scr>
  );
}

function B3GridCard({ p, i, go }) {
  const { store, dispatch } = useM3();
  const q = store.cart[p.id] || 0;
  const fav = store.favorites.includes(p.id);
  return (
    <div style={{
      background: '#fff', borderRadius: M3RAD, padding: 10, position: 'relative',
      border: '1px solid ' + M3.border,
      boxShadow: '0 2px 10px rgba(11,21,36,0.04)',
      animation: `m3-rise 380ms ${(i % 8) * 45}ms both`,
    }}>
      {/* fav heart */}
      <div className="m3-press" onClick={() => dispatch({ type: 'TOGGLE_FAV', pid: p.id })} style={{
        position: 'absolute', top: 16, right: 16, zIndex: 2,
        width: 32, height: 32, borderRadius: 16,
        background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(11,21,36,0.12)',
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path d="M12 20s-7.5-4.6-9.3-9.3C1.5 7.5 3.6 4.5 6.8 4.5c2 0 3.7 1.2 5.2 3.2 1.5-2 3.2-3.2 5.2-3.2 3.2 0 5.3 3 4.1 6.2C19.5 15.4 12 20 12 20Z"
            fill={fav ? M3.red : 'none'} stroke={fav ? M3.red : 'rgba(11,21,36,0.4)'} strokeWidth="2"/>
        </svg>
      </div>
      <div className="m3-press" onClick={() => go('pdp', { pid: p.id })}>
        <M3Tile p={p} height={104} glyphSize={44} radius={18}/>
        <div style={{ padding: '10px 5px 3px' }}>
          <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5, color: M3.ink, lineHeight: 1.2, minHeight: 33 }}>{p.name}</div>
          <M3Row gap={5} style={{ marginTop: 3 }}>
            <M3Stars rating={p.rating}/>
            <span style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 10.5, color: M3.faint }}>{p.pop}</span>
          </M3Row>
          <div style={{ marginTop: 6 }}>
            <M3Money v={p.price} size={16}/>
            <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 10.5, color: M3.faint }}>{p.unit}</div>
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', right: 10, bottom: 11 }}>
        {q === 0 ? (
          <M3Round icon="plus" tone="grad" size={38} onClick={() => dispatch({ type: 'CART_SET', pid: p.id, qty: 1 })}/>
        ) : (
          <M3Row gap={0} style={{ background: M3ACCSOFT, borderRadius: 999, overflow: 'hidden' }}>
            <div className="m3-press" onClick={() => dispatch({ type: 'CART_SET', pid: p.id, qty: q - 1 })} style={{ width: 30, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('minus', { size: 14, color: 'var(--m3-acc, #2563EB)' })}
            </div>
            <span style={{ width: 20, textAlign: 'center', fontFamily: M3.disp, fontWeight: 700, fontSize: 14, color: M3.ink }}>{q}</span>
            <div className="m3-press" onClick={() => dispatch({ type: 'CART_SET', pid: p.id, qty: q + 1 })} style={{ width: 30, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('plus', { size: 14, color: 'var(--m3-acc, #2563EB)' })}
            </div>
          </M3Row>
        )}
      </div>
    </div>
  );
}

function B3CartBar({ go }) {
  const { store } = useM3();
  const items = Object.entries(store.cart).map(([pid, qty]) => ({ pid, qty }));
  const n = items.reduce((s, it) => s + it.qty, 0);
  if (!n) return null;
  return (
    <div className="m3-press" onClick={() => go('cart')} style={{
      position: 'absolute', left: 14, right: 14, bottom: 92, zIndex: 55,
      background: M3.canvas, borderRadius: 999, padding: '13px 18px',
      border: '1px solid rgba(255,255,255,0.12)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      boxShadow: '0 16px 38px rgba(11,21,36,0.45)',
      animation: 'm3-up 280ms both',
    }}>
      <M3Row gap={10}>
        <div style={{ minWidth: 28, height: 28, borderRadius: 14, background: M3GRAD, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5, padding: '0 8px' }}>{n}</div>
        <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15.5, color: '#fff' }}>Go to basket</span>
      </M3Row>
      <M3Row gap={5}>
        <M3Money v={m3Price(store.products, items)} size={16.5} color="#fff"/>
        {M3I('chev', { size: 16, color: 'rgba(255,255,255,0.55)' })}
      </M3Row>
    </div>
  );
}

// Product page
function B3PDP({ pid, go, cartN }) {
  const { store, dispatch } = useM3();
  const p = store.products.find(x => x.id === pid);
  const [qty, setQty] = React.useState(1);
  const [slide, setSlide] = React.useState(0);
  const inCart = store.cart[pid] || 0;
  if (!p) return null;
  const fav = store.favorites.includes(pid);
  const pair = store.products.find(x => x.cat === p.cat && x.id !== p.id) || store.products.find(x => x.id !== p.id);
  const views = [{ scale: 1, rot: 0 }, { scale: 1.4, rot: -8 }, { scale: 0.82, rot: 7 }];

  return (
    <M3Scr bg="#fff" hero={
      <div style={{ position: 'relative' }}>
        {/* Gallery hero */}
        <div style={{
          height: 340, position: 'relative', overflow: 'hidden',
          background: `linear-gradient(160deg, oklch(96% 0.03 ${p.hue}) 0%, oklch(87% 0.1 ${p.hue}) 100%)`,
          borderRadius: '0 0 38px 38px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ position: 'absolute', width: 320, height: 320, borderRadius: '50%', background: `oklch(82% 0.12 ${p.hue} / 0.5)`, right: -100, top: -120 }}/>
          <div style={{ position: 'absolute', width: 210, height: 210, borderRadius: '50%', background: `oklch(97% 0.02 ${p.hue} / 0.85)`, left: -60, bottom: -80 }}/>
          <div style={{
            transform: `scale(${views[slide].scale}) rotate(${views[slide].rot}deg)`,
            transition: 'transform 420ms cubic-bezier(0.2,0.9,0.3,1)',
            filter: 'drop-shadow(0 22px 26px rgba(11,21,36,0.25))',
            paddingTop: 30,
          }}>
            <M3Glyph name={p.glyph} size={150} color={`oklch(37% 0.12 ${p.hue})`}/>
          </div>
          {p.stock <= 8 && (
            <div style={{ position: 'absolute', bottom: 48, left: 20, padding: '6px 13px', borderRadius: 999, background: '#fff', fontFamily: M3.disp, fontWeight: 700, fontSize: 12.5, color: M3.amber, boxShadow: '0 4px 12px rgba(11,21,36,0.12)' }}>
              Only {p.stock} left
            </div>
          )}
          {/* dots */}
          <M3Row gap={6} style={{ position: 'absolute', bottom: 20, left: 0, right: 0, justifyContent: 'center' }}>
            {views.map((_, i) => (
              <div key={i} className="m3-press" onClick={() => setSlide(i)} style={{
                width: i === slide ? 24 : 8, height: 8, borderRadius: 5,
                background: i === slide ? M3.ink : 'rgba(11,21,36,0.25)', transition: 'all 250ms',
              }}/>
            ))}
          </M3Row>
        </div>
        {/* Floating top bar */}
        <div style={{ position: 'absolute', top: 58, left: 16, right: 16, display: 'flex', justifyContent: 'space-between' }}>
          <M3Round icon="back" tone="white" size={44} onClick={() => go('front')}/>
          <M3Row gap={9}>
            <div className="m3-press" onClick={() => dispatch({ type: 'TOGGLE_FAV', pid })} style={{
              width: 44, height: 44, borderRadius: 22, background: '#fff', border: '1px solid ' + M3.border,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path d="M12 20s-7.5-4.6-9.3-9.3C1.5 7.5 3.6 4.5 6.8 4.5c2 0 3.7 1.2 5.2 3.2 1.5-2 3.2-3.2 5.2-3.2 3.2 0 5.3 3 4.1 6.2C19.5 15.4 12 20 12 20Z"
                  fill={fav ? M3.red : 'none'} stroke={fav ? M3.red : 'rgba(11,21,36,0.45)'} strokeWidth="2"/>
              </svg>
            </div>
            <M3Round icon="bag" tone="white" size={44} badge={cartN || null} onClick={() => go('cart')}/>
          </M3Row>
        </div>
      </div>
    } bodyPad="18px 20px 186px">
      <M3Row gap={8} style={{ marginBottom: 9 }}>
        <M3Pill label={p.cat} tone="blue"/>
        {p.pop > 200 && <M3Pill label="Popular" tone="amber"/>}
        <M3Pill label={p.stock > 8 ? 'In stock' : 'Low stock'} tone={p.stock > 8 ? 'green' : 'amber'}/>
      </M3Row>
      <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 26, color: M3.ink, letterSpacing: '-0.02em', lineHeight: 1.1 }}>{p.name}</div>
      <M3Row gap={7} style={{ marginTop: 8 }}>
        <M3Stars rating={p.rating} size={15}/>
        <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5, color: M3.ink }}>{p.rating}</span>
        <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12.5, color: M3.faint }}>{p.pop} shops order this</span>
      </M3Row>

      <M3Row style={{ justifyContent: 'space-between', marginTop: 16, alignItems: 'flex-end' }}>
        <div>
          <M3Money v={p.price} size={34}/>
          <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12.5, color: M3.faint }}>{p.unit}</div>
        </div>
        <M3Stepper value={qty} onChange={(v) => setQty(Math.max(1, v))} min={1}/>
      </M3Row>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 11, marginTop: 18,
        padding: '13px 15px', borderRadius: 18, background: M3.greenSoft,
      }}>
        {M3I('truck', { size: 21, color: M3.green })}
        <div>
          <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14, color: M3.green }}>Free delivery tomorrow, 7am</div>
          <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12, color: M3.sub }}>From Fresh Fields depot</div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {p.bullets.map((b, i) => (
          <M3Row key={i} gap={9} style={{ padding: '6px 2px' }}>
            <div style={{ width: 20, height: 20, borderRadius: 10, background: M3ACCSOFT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {M3I('check', { size: 10.5, color: 'var(--m3-acc, #2563EB)', sw: 3.4 })}
            </div>
            <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 13.5, color: M3.sub }}>{b}</span>
          </M3Row>
        ))}
      </div>

      {pair && (
        <>
          <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16.5, color: M3.ink, margin: '18px 0 10px' }}>Goes well with</div>
          <M3Card pad={11} onClick={() => go('pdp', { pid: pair.id })}>
            <M3Row>
              <M3Tile p={pair} height={54} glyphSize={28} radius={16} style={{ width: 54, flexShrink: 0 }}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14, color: M3.ink }}>{pair.name}</div>
                <M3Money v={pair.price} size={13.5} weight={600} color={M3.sub}/>
              </div>
              <M3Round icon="plus" tone="grad" size={38} onClick={(e) => { e.stopPropagation(); dispatch({ type: 'CART_SET', pid: pair.id, qty: (store.cart[pair.id] || 0) + 1 }); }}/>
            </M3Row>
          </M3Card>
        </>
      )}

      {/* Sticky buy bar */}
      <div style={{
        position: 'absolute', left: 14, right: 14, bottom: 92, zIndex: 55,
        background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(14px)',
        borderRadius: 999, padding: 8, display: 'flex', gap: 8,
        border: '1px solid ' + M3.border,
        boxShadow: '0 16px 40px rgba(11,21,36,0.2)',
      }}>
        <M3Btn label={inCart ? 'In basket · ' + inCart : 'Add to basket'} tone="soft" h={50} fs={15} style={{ flex: 1 }}
          onClick={() => dispatch({ type: 'CART_SET', pid, qty: inCart + qty })}/>
        <M3Btn label="Order now" tone="grad" h={50} fs={15} style={{ flex: 1 }}
          onClick={() => { if (!inCart) dispatch({ type: 'CART_SET', pid, qty }); go('checkout'); }}/>
      </div>
    </M3Scr>
  );
}

// Basket
function B3Cart({ go }) {
  const { store, dispatch } = useM3();
  const items = Object.entries(store.cart).map(([pid, qty]) => ({ pid, qty }));
  const total = m3Price(store.products, items);
  return (
    <M3Scr hero={
      <M3Hero pad="64px 20px 20px">
        <M3Row gap={13}>
          <M3Round icon="back" tone="glass" size={44} onClick={() => go('front')}/>
          <div>
            <div style={{ fontFamily: M3.body, fontSize: 12.5, fontWeight: 600, color: M3.wsub }}>{items.reduce((s, it) => s + it.qty, 0)} items</div>
            <div style={{ fontFamily: M3.disp, fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>Basket</div>
          </div>
        </M3Row>
      </M3Hero>
    } bodyPad="18px 16px 196px">
      {items.length === 0 && (
        <M3Card pad={20}>
          <M3Empty icon="bag" title="Basket is empty" sub="Add something from the shop"/>
          <M3Btn label="Browse the shop" tone="soft" onClick={() => go('front')}/>
        </M3Card>
      )}
      {items.map((it, i) => {
        const p = store.products.find(p => p.id === it.pid);
        return (
          <M3Card key={it.pid} pad={11} anim delay={i * 50} style={{ marginBottom: 10 }}>
            <M3Row>
              <div className="m3-press" onClick={() => go('pdp', { pid: it.pid })}>
                <M3Tile p={p} height={62} glyphSize={30} radius={17} style={{ width: 62 }}/>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14, color: M3.ink, lineHeight: 1.15 }}>{p.name}</div>
                <M3Money v={p.price * it.qty} size={15}/>
                <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 10.5, color: M3.faint }}>{p.unit}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                <div className="m3-press" onClick={() => dispatch({ type: 'CART_SET', pid: it.pid, qty: 0 })} style={{ padding: 4 }}>
                  {M3I('trash', { size: 16, color: M3.faint })}
                </div>
                <M3Row gap={0} style={{ background: M3ACCSOFT, borderRadius: 999, overflow: 'hidden' }}>
                  <div className="m3-press" onClick={() => dispatch({ type: 'CART_SET', pid: it.pid, qty: it.qty - 1 })} style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {M3I('minus', { size: 14, color: 'var(--m3-acc, #2563EB)' })}
                  </div>
                  <span style={{ width: 24, textAlign: 'center', fontFamily: M3.disp, fontWeight: 700, fontSize: 14, color: M3.ink }}>{it.qty}</span>
                  <div className="m3-press" onClick={() => dispatch({ type: 'CART_SET', pid: it.pid, qty: it.qty + 1 })} style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {M3I('plus', { size: 14, color: 'var(--m3-acc, #2563EB)' })}
                  </div>
                </M3Row>
              </div>
            </M3Row>
          </M3Card>
        );
      })}
      {items.length > 0 && (
        <div style={{
          position: 'absolute', left: 14, right: 14, bottom: 92, zIndex: 55,
          background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(14px)',
          borderRadius: 28, padding: '13px 16px 11px',
          border: '1px solid ' + M3.border,
          boxShadow: '0 16px 40px rgba(11,21,36,0.2)',
        }}>
          <M3Row style={{ justifyContent: 'space-between', padding: '0 6px 9px' }}>
            <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 14, color: M3.sub }}>Subtotal</span>
            <M3Money v={total} size={19}/>
          </M3Row>
          <M3Btn label="Checkout" icon="chev" h={50} onClick={() => go('checkout')}/>
        </div>
      )}
    </M3Scr>
  );
}

// Checkout
function B3Checkout({ go }) {
  const { store, dispatch } = useM3();
  const [slot, setSlot] = React.useState(0);
  const items = Object.entries(store.cart).map(([pid, qty]) => ({ pid, qty }));
  const total = m3Price(store.products, items);
  const slots = ['Tomorrow 7am', 'Tomorrow 2pm', 'Tue 7am'];

  if (items.length === 0) {
    return (
      <M3Scr hero={
        <M3Hero pad="64px 20px 20px">
          <M3Row gap={13}>
            <M3Round icon="back" tone="glass" size={44} onClick={() => go('front')}/>
            <div style={{ fontFamily: M3.disp, fontSize: 24, fontWeight: 700, color: '#fff' }}>Checkout</div>
          </M3Row>
        </M3Hero>
      }>
        <M3Card pad={20}><M3Empty icon="check" title="Order placed" sub="Track it on Home"/></M3Card>
      </M3Scr>
    );
  }

  return (
    <M3Scr hero={
      <M3Hero pad="64px 20px 20px">
        <M3Row gap={13}>
          <M3Round icon="back" tone="glass" size={44} onClick={() => go('cart')}/>
          <div>
            <div style={{ fontFamily: M3.body, fontSize: 12.5, fontWeight: 600, color: M3.wsub }}>Almost there</div>
            <div style={{ fontFamily: M3.disp, fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>Checkout</div>
          </div>
        </M3Row>
      </M3Hero>
    } bodyPad="18px 16px 186px">
      <M3Card pad={15} anim style={{ marginBottom: 11 }}>
        <M3Row>
          <div style={{ width: 42, height: 42, borderRadius: 16, background: M3ACCSOFT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {M3I('pin', { size: 21, color: 'var(--m3-acc, #2563EB)' })}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.ink }}>Harbor Cafe</div>
            <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>12 Quay St, back door</div>
          </div>
          <M3Pill label="Saved" tone="green"/>
        </M3Row>
      </M3Card>

      <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15.5, color: M3.ink, margin: '6px 6px 10px' }}>When?</div>
      <M3Row gap={8} style={{ marginBottom: 11 }}>
        {slots.map((s, i) => {
          const on = slot === i;
          return (
            <div key={i} className="m3-press" onClick={() => setSlot(i)} style={{
              flex: 1, padding: '13px 6px', borderRadius: 18, textAlign: 'center',
              background: on ? M3.canvas : '#fff',
              border: '1px solid ' + (on ? M3.canvas : M3.border),
              color: on ? '#fff' : M3.sub,
              fontFamily: M3.disp, fontWeight: 700, fontSize: 12.5,
              boxShadow: on ? '0 8px 20px rgba(11,21,36,0.25)' : 'none',
              transition: 'all 180ms',
            }}>{s}</div>
          );
        })}
      </M3Row>

      <M3Card pad={15} anim style={{ marginBottom: 11 }}>
        <M3Row>
          <div style={{ width: 42, height: 42, borderRadius: 16, background: M3.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {M3I('card', { size: 21, color: M3.amber })}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.ink }}>On account</div>
            <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>Invoiced after delivery</div>
          </div>
          {M3I('check', { size: 19, color: M3.green, sw: 3 })}
        </M3Row>
      </M3Card>

      <M3Card pad={15} anim>
        {items.map(it => {
          const p = store.products.find(p => p.id === it.pid);
          return (
            <M3Row key={it.pid} style={{ justifyContent: 'space-between', padding: '4px 2px' }}>
              <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 13, color: M3.sub }}>{p.name} × {it.qty}</span>
              <M3Money v={p.price * it.qty} size={13} weight={600}/>
            </M3Row>
          );
        })}
        <M3Row style={{ justifyContent: 'space-between', padding: '4px 2px' }}>
          <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 13, color: M3.sub }}>Delivery</span>
          <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13, color: M3.green }}>Free</span>
        </M3Row>
        <div style={{ borderTop: '1px solid ' + M3.border, marginTop: 8, paddingTop: 10 }}>
          <M3Row style={{ justifyContent: 'space-between' }}>
            <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16, color: M3.ink }}>Total</span>
            <M3Money v={total} size={21}/>
          </M3Row>
        </div>
      </M3Card>

      <div style={{
        position: 'absolute', left: 14, right: 14, bottom: 92, zIndex: 55,
        background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(14px)',
        borderRadius: 999, padding: 8,
        border: '1px solid ' + M3.border,
        boxShadow: '0 16px 40px rgba(11,21,36,0.2)',
      }}>
        <M3Btn label={'Place order · $' + total.toFixed(2)} icon="check" tone="green" h={52}
          onClick={() => { dispatch({ type: 'SEND_CART' }); go('front'); }}/>
      </div>
    </M3Scr>
  );
}

// ── Orders ──
function B3Orders() {
  const { store, dispatch } = useM3();
  const { active } = useB3Order();
  const [view, setView] = React.useState(null);
  return (
    <M3Scr hero={
      <M3Hero pad="68px 20px 22px">
        <div style={{ fontFamily: M3.body, fontSize: 13.5, fontWeight: 600, color: M3.wsub }}>Harbor Cafe</div>
        <div style={{ fontFamily: M3.disp, fontSize: 27, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em', marginTop: 2 }}>Orders</div>
        {active && (
          <div style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 22, padding: 16, marginTop: 16 }}>
            <M3Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: '#fff' }}>On its way</span>
              <M3Money v={m3Price(store.products, active.items)} size={15} color="#fff"/>
            </M3Row>
            <B3TrackBar current={active.status === 'routed' && store.route.status === 'running' ? 2 : b3Step(active.status)}/>
          </div>
        )}
      </M3Hero>
    }>
      <M3Section label="Past orders"/>
      {store.history.map((h, i) => (
        <M3Card key={h.id} pad={14} anim delay={i * 50} onClick={() => setView(h)} style={{ marginBottom: 10 }}>
          <M3Row>
            <div style={{ width: 42, height: 42, borderRadius: 16, background: M3.greenSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('check', { size: 19, color: M3.green, sw: 3 })}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.ink }}>{h.date}</div>
              <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>{h.items.reduce((s, it) => s + it.qty, 0)} items</div>
            </div>
            <M3Money v={h.total} size={15.5}/>
            {M3I('chev', { size: 17, color: M3.faint })}
          </M3Row>
        </M3Card>
      ))}
      <M3Sheet open={!!view} onClose={() => setView(null)} title={view ? view.date : ''}>
        {view && (
          <>
            <M3Lines items={view.items}/>
            <div style={{ height: 15 }}/>
            <M3Btn label="Order this again" icon="repeat" onClick={() => { dispatch({ type: 'REORDER', items: view.items }); setView(null); }}/>
          </>
        )}
      </M3Sheet>
    </M3Scr>
  );
}

// ── Money ──
function B3Money() {
  const { store, dispatch } = useM3();
  const [view, setView] = React.useState(null);
  const mine = store.invoices.filter(i => i.custId === 'c1');
  const owe = mine.filter(i => i.status !== 'paid').reduce((s, i) => s + i.amount, 0);
  return (
    <M3Scr hero={
      <M3Hero>
        <div style={{ fontFamily: M3.body, fontSize: 13.5, fontWeight: 600, color: M3.wsub }}>Harbor Cafe</div>
        <div style={{ fontFamily: M3.disp, fontSize: 27, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em', marginTop: 2, marginBottom: 14 }}>Money</div>
        <div style={{ fontFamily: M3.body, fontSize: 12.5, fontWeight: 700, color: M3.wfaint, letterSpacing: '0.06em', textTransform: 'uppercase' }}>You owe</div>
        <M3Num v={Math.max(0, owe - store.credits)} prefix="$" size={44} color="#fff" decimals={0} countKey={owe - store.credits}/>
        {store.credits > 0 && (
          <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 999, background: 'rgba(23,163,74,0.2)', border: '1px solid rgba(23,163,74,0.35)' }}>
            {M3I('check', { size: 13, color: '#6EE7A0', sw: 3.2 })}
            <span style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 12.5, color: '#6EE7A0' }}>${store.credits.toFixed(2)} credit applied</span>
          </div>
        )}
      </M3Hero>
    }>
      <M3Section label="Invoices"/>
      {mine.map((inv, i) => (
        <M3Card key={inv.id} pad={14} anim delay={i * 50} onClick={() => setView(inv)} style={{ marginBottom: 10 }}>
          <M3Row>
            <div style={{ width: 42, height: 42, borderRadius: 16, background: inv.status === 'paid' ? M3.greenSoft : M3.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('doc', { size: 20, color: inv.status === 'paid' ? M3.green : M3.amber })}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.ink }}>{inv.id}</div>
              <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>{inv.status === 'paid' ? 'Paid' : 'Due ' + inv.due}</div>
            </div>
            <M3Money v={inv.amount} size={15.5}/>
            {M3I('chev', { size: 17, color: M3.faint })}
          </M3Row>
        </M3Card>
      ))}
      <M3Sheet open={!!view} onClose={() => setView(null)} title={view ? view.id : ''}>
        {view && (
          <>
            <M3Row style={{ justifyContent: 'space-between', padding: '2px 4px 15px' }}>
              <M3Pill label={view.status === 'paid' ? 'Paid' : 'Due ' + view.due} tone={view.status === 'paid' ? 'green' : 'amber'}/>
              <M3Money v={view.amount} size={25}/>
            </M3Row>
            <M3Btn label="Download PDF" icon="doc" tone="soft" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'PDF saved' } }); setView(null); }}/>
            <div style={{ height: 9 }}/>
            <M3Btn label="Get my statement" icon="send" tone="line" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Emailed to you' } }); setView(null); }}/>
          </>
        )}
      </M3Sheet>
    </M3Scr>
  );
}

Object.assign(window, { B3App });
