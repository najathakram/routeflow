// mobile-retailer.jsx — Shop owner app (Maya at Harbor Cafe): Home, Shop, Orders, Money
// Shop = full store flow: browse grid, product page, basket, checkout.

function RtApp() {
  const [tab, setTab] = React.useState(() => localStorage.getItem('rfm:rt:tab') || 'home');
  const { store } = useStore();
  React.useEffect(() => { localStorage.setItem('rfm:rt:tab', tab); }, [tab]);
  const cartN = Object.values(store.cart).reduce((s, q) => s + q, 0);
  const tabs = [
    { id: 'home', icon: 'home', label: 'Home' },
    { id: 'shop', icon: 'bag', label: 'Shop', badge: cartN || null },
    { id: 'orders', icon: 'box', label: 'Orders' },
    { id: 'money', icon: 'money', label: 'Money' },
  ];
  return (
    <>
      {tab === 'home' && <RtHome goShop={() => setTab('shop')}/>}
      {tab === 'shop' && <RtShop/>}
      {tab === 'orders' && <RtOrders/>}
      {tab === 'money' && <RtMoney/>}
      <TabBar tabs={tabs} active={tab} onChange={setTab}/>
    </>
  );
}

function useMyOrder() {
  const { store } = useStore();
  const mine = store.orders.filter(o => o.custId === 'c1' && o.status !== 'declined');
  const active = mine.find(o => o.status !== 'delivered');
  return { active, mine };
}

function trackStep(status) {
  return { new: 0, approved: 1, routed: 2, delivered: 3 }[status] ?? 0;
}

// ── Product tile: gradient panel + glyph, feels like a product shot ──
function TileImg({ p, size = '100%', height = 108, glyphSize = 44, radius = 18, float }) {
  return (
    <div style={{
      width: size, height, borderRadius: radius, position: 'relative', overflow: 'hidden',
      background: `linear-gradient(155deg, oklch(97% 0.02 ${p.hue}) 0%, oklch(91% 0.06 ${p.hue}) 100%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        position: 'absolute', width: height * 1.1, height: height * 1.1, borderRadius: '50%',
        background: `oklch(88% 0.08 ${p.hue} / 0.5)`, right: -height * 0.35, top: -height * 0.35,
      }}/>
      <div style={{ position: 'relative', filter: float ? 'drop-shadow(0 10px 14px rgba(22,50,79,0.18))' : 'none' }}>
        <Glyph name={p.glyph} size={glyphSize} color={`oklch(42% 0.11 ${p.hue})`}/>
      </div>
    </div>
  );
}

function Stars({ rating, size = 12 }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1.5 }}>
      {[0, 1, 2, 3, 4].map(i => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24">
          <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5Z"
            fill={i < Math.round(rating) ? '#F5A623' : '#DDE4EC'}/>
        </svg>
      ))}
    </span>
  );
}

// ── Home ──
function RtHome({ goShop }) {
  const { store, dispatch } = useStore();
  const { active } = useMyOrder();
  const [problem, setProblem] = React.useState(false);
  const regularProducts = REGULARS.map(r => store.products.find(p => p.id === r.pid));

  return (
    <Scr>
      <Hdr sub="Harbor Cafe" title="Hi Maya" right={
        <div className="rfm-press" onClick={() => dispatch({ type: 'TOGGLE_STANDING' })} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '9px 13px', borderRadius: 99,
          background: store.standing ? RFM.greenSoft : '#E9EDF4',
        }}>
          {I('repeat', { size: 16, color: store.standing ? RFM.green : RFM.faint })}
          <span style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 12.5, color: store.standing ? RFM.green : RFM.faint }}>
            Tuesdays {store.standing ? 'ON' : 'OFF'}
          </span>
        </div>
      }/>

      {active ? (
        <Card pad={18} anim style={{ marginBottom: 14 }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 16.5, color: RFM.ink }}>Your delivery</div>
            {active.status === 'routed'
              ? <Pill label={store.route.status === 'running' ? 'On the way' : 'Loading van'} tone="green"/>
              : <Pill label={active.status === 'new' ? 'Sent' : 'Packing'} tone={active.status === 'new' ? 'blue' : 'amber'}/>}
          </Row>
          <Steps labels={['Sent', 'Packing', 'Driving', 'Here']} current={active.status === 'routed' && store.route.status === 'running' ? 2 : trackStep(active.status)}/>
          {active.status === 'routed' && store.route.status === 'running' && (
            <div style={{
              marginTop: 14, padding: '11px 14px', borderRadius: 14, background: RFM.greenSoft,
              display: 'flex', alignItems: 'center', gap: 10,
              fontFamily: RFM.font, fontWeight: 800, fontSize: 14, color: RFM.green,
            }}>
              {I('truck', { size: 20, color: RFM.green })} Tom is 2 stops away
            </div>
          )}
        </Card>
      ) : (
        <Card pad={18} anim style={{ marginBottom: 14, background: RFM.greenSoft }}>
          <Row>
            <div style={{ width: 46, height: 46, borderRadius: 18, background: RFM.green, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {I('check', { size: 24, color: '#fff', sw: 3 })}
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16, color: RFM.ink }}>All delivered</div>
              <div style={{ fontSize: 13.5, color: RFM.sub, fontWeight: 600 }}>Nothing on the way</div>
            </div>
          </Row>
        </Card>
      )}

      {/* One tap reorder */}
      <div className="rfm-press" onClick={() => dispatch({ type: 'REORDER', items: REGULARS })} style={{
        background: `linear-gradient(135deg, var(--rfm-acc, #2563EB), var(--rfm-acc-dark, #1D4ED8))`,
        borderRadius: RAD, padding: 20, marginBottom: 14,
        boxShadow: '0 16px 34px rgba(37,99,235,0.32)',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', width: 160, height: 160, borderRadius: 80, background: 'rgba(255,255,255,0.08)', right: -50, top: -60 }}/>
        <Row style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 19, color: '#fff', letterSpacing: '-0.01em' }}>Order my usual</div>
            <div style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 13.5, color: 'rgba(255,255,255,0.82)', marginTop: 4 }}>
              One tap · <Money v={priceOf(store.products, REGULARS)} size={13.5} color="#fff"/>
            </div>
            <Row gap={6} style={{ marginTop: 12 }}>
              {regularProducts.map(p => p && (
                <div key={p.id} style={{ width: 38, height: 38, borderRadius: 13, background: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Glyph name={p.glyph} size={22} color={`oklch(42% 0.11 ${p.hue})`}/>
                </div>
              ))}
            </Row>
          </div>
          <div style={{ width: 54, height: 54, borderRadius: 20, background: 'rgba(255,255,255,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }}>
            {I('bolt', { size: 27, color: '#fff' })}
          </div>
        </Row>
      </div>

      <Row gap={12}>
        <Card pad={16} onClick={goShop} style={{ flex: 1 }}>
          <div style={{ width: 44, height: 44, borderRadius: 16, background: ACC_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
            {I('bag', { size: 23, color: 'var(--rfm-acc, #2563EB)' })}
          </div>
          <div style={{ fontWeight: 800, fontSize: 15, color: RFM.ink }}>Browse</div>
          <div style={{ fontSize: 12.5, color: RFM.sub, fontWeight: 600 }}>Full catalog</div>
        </Card>
        <Card pad={16} onClick={() => setProblem(true)} style={{ flex: 1 }}>
          <div style={{ width: 44, height: 44, borderRadius: 16, background: RFM.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
            {I('alert', { size: 23, color: RFM.amber })}
          </div>
          <div style={{ fontWeight: 800, fontSize: 15, color: RFM.ink }}>Something wrong?</div>
          <div style={{ fontSize: 12.5, color: RFM.sub, fontWeight: 600 }}>2 taps to fix it</div>
        </Card>
      </Row>

      <ProblemFlow open={problem} onClose={() => setProblem(false)}/>
    </Scr>
  );
}

// ── Problem flow ──
function ProblemFlow({ open, onClose }) {
  const { store, dispatch } = useStore();
  const [pick, setPick] = React.useState(null);
  const last = store.history[0];
  React.useEffect(() => { if (!open) setPick(null); }, [open]);

  return (
    <Sheet open={open} onClose={onClose} title={pick ? 'What happened?' : 'Which item?'}>
      {!pick && (
        <>
          <div style={{ fontFamily: RFM.font, fontSize: 13.5, fontWeight: 600, color: RFM.sub, marginBottom: 12 }}>From {last.date}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {last.items.map(it => {
              const p = store.products.find(p => p.id === it.pid);
              return (
                <div key={it.pid} className="rfm-press" onClick={() => setPick(it)} style={{
                  background: '#F4F7FB', borderRadius: 18, padding: 12, textAlign: 'center',
                }}>
                  <TileImg p={p} height={76} glyphSize={34} radius={14}/>
                  <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 13.5, color: RFM.ink, lineHeight: 1.2, marginTop: 10 }}>{p.name}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {pick && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { r: 'Damaged', icon: 'alert', tone: RFM.amberSoft, fg: RFM.amber },
            { r: 'Missing', icon: 'x', tone: RFM.redSoft, fg: RFM.red },
            { r: 'Wrong item', icon: 'undo', tone: ACC_SOFT, fg: 'var(--rfm-acc, #2563EB)' },
          ].map(o => (
            <div key={o.r} className="rfm-press" onClick={() => { dispatch({ type: 'REPORT_PROBLEM', pid: pick.pid, qty: 1, reason: o.r === 'Wrong item' ? 'Wrong' : o.r }); onClose(); }} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              background: '#F4F7FB', borderRadius: 18, padding: '16px 18px',
            }}>
              <div style={{ width: 46, height: 46, borderRadius: 16, background: o.tone, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {I(o.icon, { size: 22, color: o.fg })}
              </div>
              <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 17, color: RFM.ink }}>{o.r}</div>
              <div style={{ marginLeft: 'auto' }}>{I('chev', { size: 18, color: RFM.faint })}</div>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

// ══════════════ SHOP: store front → product page → basket → checkout ══════════════
function RtShop() {
  const { store } = useStore();
  const [page, setPage] = React.useState({ name: 'front' }); // front | pdp | cart | checkout
  const cartItems = Object.entries(store.cart).map(([pid, qty]) => ({ pid, qty }));
  const cartN = cartItems.reduce((s, it) => s + it.qty, 0);

  const go = (name, extra) => setPage({ name, ...extra });

  return (
    <>
      {page.name === 'front' && <ShopFront go={go} cartN={cartN}/>}
      {page.name === 'pdp' && <ShopPDP pid={page.pid} go={go} cartN={cartN}/>}
      {page.name === 'cart' && <ShopCart go={go}/>}
      {page.name === 'checkout' && <ShopCheckout go={go}/>}
    </>
  );
}

// Small round cart button with badge
function CartBtn({ cartN, onClick }) {
  return (
    <div className="rfm-press" onClick={onClick} style={{ position: 'relative' }}>
      <div style={{ width: 46, height: 46, borderRadius: 17, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(22,50,79,0.1)' }}>
        {I('bag', { size: 22, color: RFM.ink })}
      </div>
      {cartN > 0 && (
        <div style={{
          position: 'absolute', top: -5, right: -5, minWidth: 20, height: 20, borderRadius: 10,
          background: 'var(--rfm-acc, #2563EB)', color: '#fff',
          fontFamily: RFM.font, fontWeight: 800, fontSize: 11.5,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px',
          boxShadow: '0 3px 8px rgba(37,99,235,0.4)',
        }}>{cartN}</div>
      )}
    </div>
  );
}

// ── Store front: search + deals + chips + grid ──
function ShopFront({ go, cartN }) {
  const { store, dispatch } = useStore();
  const [q, setQ] = React.useState('');
  const [cat, setCat] = React.useState('All');
  const cats = ['All', 'Dairy', 'Coffee', 'Packaging', 'Pantry'];
  const list = store.products.filter(p =>
    (cat === 'All' || p.cat === cat) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase()))
  );
  const deals = [
    { pid: 'p2', tag: '10% off this week', hue: 45 },
    { pid: 'p7', tag: 'New in', hue: 25 },
  ];

  return (
    <Scr pad={'70px 16px ' + (cartN ? 196 : 130) + 'px'}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 14, padding: '0 2px' }}>
        <div style={{ fontFamily: RFM.font, fontSize: 29, fontWeight: 800, color: RFM.ink, letterSpacing: '-0.03em' }}>Shop</div>
        <CartBtn cartN={cartN} onClick={() => go('cart')}/>
      </Row>

      {/* Search */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: '#fff', borderRadius: 18, padding: '0 16px', height: 50,
        boxShadow: '0 4px 14px rgba(22,50,79,0.07)', marginBottom: 16,
      }}>
        {I('search', { size: 20, color: RFM.faint })}
        <input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalog"
          style={{ border: 'none', outline: 'none', flex: 1, fontFamily: RFM.font, fontWeight: 600, fontSize: 15.5, color: RFM.ink, background: 'transparent' }}
        />
        {q && <div className="rfm-press" onClick={() => setQ('')}>{I('x', { size: 16, color: RFM.faint })}</div>}
      </div>

      {/* Deals rail */}
      {!q && cat === 'All' && (
        <div className="rfm-scroll" style={{ display: 'flex', gap: 12, overflowX: 'auto', margin: '0 -16px 16px', padding: '0 16px' }}>
          {deals.map(d => {
            const p = store.products.find(p => p.id === d.pid);
            return (
              <div key={d.pid} className="rfm-press" onClick={() => go('pdp', { pid: d.pid })} style={{
                minWidth: 250, borderRadius: RAD, overflow: 'hidden', position: 'relative',
                background: `linear-gradient(140deg, oklch(96% 0.03 ${d.hue}), oklch(88% 0.08 ${d.hue}))`,
                padding: 18, display: 'flex', gap: 14, alignItems: 'center',
              }}>
                <div style={{ filter: 'drop-shadow(0 8px 12px rgba(22,50,79,0.16))' }}>
                  <Glyph name={p.glyph} size={52} color={`oklch(40% 0.11 ${d.hue})`}/>
                </div>
                <div>
                  <div style={{
                    display: 'inline-block', padding: '4px 10px', borderRadius: 99, marginBottom: 7,
                    background: 'rgba(255,255,255,0.85)', color: `oklch(40% 0.13 ${d.hue})`,
                    fontFamily: RFM.font, fontWeight: 800, fontSize: 11.5,
                  }}>{d.tag}</div>
                  <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 16.5, color: RFM.ink, lineHeight: 1.15 }}>{p.name}</div>
                  <Money v={p.price} size={14} weight={800} color={RFM.sub}/>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Category chips */}
      <div className="rfm-scroll" style={{ display: 'flex', gap: 8, overflowX: 'auto', margin: '0 -16px 16px', padding: '0 16px' }}>
        {cats.map(c => {
          const on = c === cat;
          return (
            <div key={c} className="rfm-press" onClick={() => setCat(c)} style={{
              padding: '10px 18px', borderRadius: 99, whiteSpace: 'nowrap',
              background: on ? RFM.ink : '#fff',
              color: on ? '#fff' : RFM.sub,
              fontFamily: RFM.font, fontWeight: 800, fontSize: 13.5,
              boxShadow: on ? '0 6px 16px rgba(22,50,79,0.25)' : '0 2px 8px rgba(22,50,79,0.06)',
            }}>{c}</div>
          );
        })}
      </div>

      {/* Product grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {list.map((p, i) => <GridCard key={p.id} p={p} i={i} go={go}/>)}
      </div>
      {list.length === 0 && <Card><EmptyState icon="search" title="Nothing found" sub="Try another word"/></Card>}

      <StickyCartBar go={go}/>
    </Scr>
  );
}

function GridCard({ p, i, go }) {
  const { store, dispatch } = useStore();
  const q = store.cart[p.id] || 0;
  return (
    <div style={{
      background: '#fff', borderRadius: RAD, padding: 10, position: 'relative',
      boxShadow: '0 1px 2px rgba(22,50,79,0.04), 0 10px 28px rgba(22,50,79,0.07)',
      animation: 'rfm-up 340ms both', animationDelay: (i % 8) * 40 + 'ms',
    }}>
      <div className="rfm-press" onClick={() => go('pdp', { pid: p.id })}>
        <TileImg p={p} height={110} glyphSize={46} radius={`calc(${RAD} - 8px)`} float/>
        <div style={{ padding: '10px 6px 4px' }}>
          <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 14, color: RFM.ink, lineHeight: 1.2, minHeight: 34 }}>{p.name}</div>
          <Row gap={5} style={{ marginTop: 3 }}>
            <Stars rating={p.rating}/>
            <span style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 11, color: RFM.faint }}>{p.pop}</span>
          </Row>
          <Row style={{ justifyContent: 'space-between', marginTop: 7 }}>
            <div>
              <Money v={p.price} size={16.5}/>
              <div style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 10.5, color: RFM.faint }}>{p.unit}</div>
            </div>
          </Row>
        </div>
      </div>
      {/* Quick add */}
      <div style={{ position: 'absolute', right: 10, bottom: 12 }}>
        {q === 0 ? (
          <div className="rfm-press" onClick={() => dispatch({ type: 'CART_SET', pid: p.id, qty: 1 })} style={{
            width: 40, height: 40, borderRadius: 15, background: 'var(--rfm-acc, #2563EB)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 6px 14px rgba(37,99,235,0.35)',
          }}>{I('plus', { size: 19, color: '#fff', sw: 2.6 })}</div>
        ) : (
          <Row gap={0} style={{ background: ACC_SOFT, borderRadius: 13, overflow: 'hidden' }}>
            <div className="rfm-press" onClick={() => dispatch({ type: 'CART_SET', pid: p.id, qty: q - 1 })} style={{ width: 32, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {I('minus', { size: 15, color: 'var(--rfm-acc, #2563EB)' })}
            </div>
            <div style={{ width: 22, textAlign: 'center', fontFamily: RFM.font, fontWeight: 800, fontSize: 14.5, color: RFM.ink }}>{q}</div>
            <div className="rfm-press" onClick={() => dispatch({ type: 'CART_SET', pid: p.id, qty: q + 1 })} style={{ width: 32, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {I('plus', { size: 15, color: 'var(--rfm-acc, #2563EB)' })}
            </div>
          </Row>
        )}
      </div>
    </div>
  );
}

function StickyCartBar({ go }) {
  const { store } = useStore();
  const cartItems = Object.entries(store.cart).map(([pid, qty]) => ({ pid, qty }));
  const n = cartItems.reduce((s, it) => s + it.qty, 0);
  if (!n) return null;
  return (
    <div className="rfm-press" onClick={() => go('cart')} style={{
      position: 'absolute', left: 14, right: 14, bottom: 96, zIndex: 55,
      background: RFM.ink, borderRadius: 22, padding: '15px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      boxShadow: '0 14px 34px rgba(22,50,79,0.4)',
      animation: 'rfm-up 280ms both',
    }}>
      <Row gap={10}>
        <div style={{ minWidth: 28, height: 28, borderRadius: 14, background: 'var(--rfm-acc, #2563EB)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: RFM.font, fontWeight: 800, fontSize: 13.5, padding: '0 8px' }}>{n}</div>
        <span style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 16, color: '#fff' }}>Go to basket</span>
      </Row>
      <Row gap={6}>
        <Money v={priceOf(store.products, cartItems)} size={17} color="#fff"/>
        {I('chev', { size: 17, color: 'rgba(255,255,255,0.6)' })}
      </Row>
    </div>
  );
}

// ── Product page ──
function ShopPDP({ pid, go, cartN }) {
  const { store, dispatch } = useStore();
  const p = store.products.find(x => x.id === pid);
  const [qty, setQty] = React.useState(1);
  const [slide, setSlide] = React.useState(0);
  const inCart = store.cart[pid] || 0;
  if (!p) return null;
  const pair = store.products.find(x => x.cat === p.cat && x.id !== p.id) || store.products.find(x => x.id !== p.id);

  const views = [
    { scale: 1, rot: 0 }, { scale: 1.35, rot: -8 }, { scale: 0.85, rot: 6 },
  ];

  return (
    <Scr pad="70px 16px 178px">
      {/* Top bar */}
      <Row style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <RoundBtn icon="back" size={46} onClick={() => go('front')}/>
        <CartBtn cartN={cartN} onClick={() => go('cart')}/>
      </Row>

      {/* Gallery */}
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <div style={{
          height: 260, borderRadius: RAD, overflow: 'hidden', position: 'relative',
          background: `linear-gradient(155deg, oklch(97% 0.02 ${p.hue}) 0%, oklch(90% 0.07 ${p.hue}) 100%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ position: 'absolute', width: 300, height: 300, borderRadius: '50%', background: `oklch(87% 0.09 ${p.hue} / 0.45)`, right: -90, top: -110 }}/>
          <div style={{ position: 'absolute', width: 180, height: 180, borderRadius: '50%', background: `oklch(93% 0.05 ${p.hue} / 0.7)`, left: -50, bottom: -70 }}/>
          <div style={{
            transform: `scale(${views[slide].scale}) rotate(${views[slide].rot}deg)`,
            transition: 'transform 380ms cubic-bezier(0.2,0.9,0.3,1)',
            filter: 'drop-shadow(0 18px 22px rgba(22,50,79,0.22))',
          }}>
            <Glyph name={p.glyph} size={130} color={`oklch(40% 0.12 ${p.hue})`}/>
          </div>
          {p.stock <= 8 && (
            <div style={{ position: 'absolute', top: 14, left: 14, padding: '6px 12px', borderRadius: 99, background: '#fff', fontFamily: RFM.font, fontWeight: 800, fontSize: 12, color: RFM.amber }}>
              Only {p.stock} left
            </div>
          )}
        </div>
        <Row gap={6} style={{ justifyContent: 'center', marginTop: 12 }}>
          {views.map((_, i) => (
            <div key={i} className="rfm-press" onClick={() => setSlide(i)} style={{
              width: i === slide ? 24 : 8, height: 8, borderRadius: 5,
              background: i === slide ? RFM.ink : '#C9D4E2', transition: 'all 250ms',
            }}/>
          ))}
        </Row>
      </div>

      {/* Info */}
      <div style={{ padding: '0 4px' }}>
        <Row gap={8} style={{ marginBottom: 8 }}>
          <Pill label={p.cat} tone="blue"/>
          {p.pop > 200 && <Pill label="Popular" tone="amber"/>}
        </Row>
        <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 24, color: RFM.ink, letterSpacing: '-0.02em', lineHeight: 1.12 }}>{p.name}</div>
        <Row gap={7} style={{ marginTop: 7 }}>
          <Stars rating={p.rating} size={15}/>
          <span style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 13.5, color: RFM.ink }}>{p.rating}</span>
          <span style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 13, color: RFM.faint }}>{p.pop} shops order this</span>
        </Row>

        <Row style={{ justifyContent: 'space-between', marginTop: 14, alignItems: 'flex-end' }}>
          <div>
            <Money v={p.price} size={32}/>
            <div style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 12.5, color: RFM.faint }}>{p.unit}</div>
          </div>
          <Stepper value={qty} onChange={(v) => setQty(Math.max(1, v))} min={1}/>
        </Row>

        {/* Delivery promise */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 11, marginTop: 16,
          padding: '13px 15px', borderRadius: 16, background: RFM.greenSoft,
        }}>
          {I('truck', { size: 21, color: RFM.green })}
          <div>
            <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 14, color: RFM.green }}>Free delivery tomorrow, 7am</div>
            <div style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 12, color: RFM.sub }}>{p.stock > 8 ? 'In stock at the depot' : 'Low stock, order soon'}</div>
          </div>
        </div>

        {/* Short facts */}
        <div style={{ marginTop: 16 }}>
          {p.bullets.map((b, i) => (
            <Row key={i} gap={9} style={{ padding: '7px 2px' }}>
              <div style={{ width: 20, height: 20, borderRadius: 10, background: ACC_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {I('check', { size: 11, color: 'var(--rfm-acc, #2563EB)', sw: 3.2 })}
              </div>
              <span style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 14, color: RFM.sub }}>{b}</span>
            </Row>
          ))}
        </div>

        {/* Goes well with */}
        {pair && (
          <>
            <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 16, color: RFM.ink, margin: '18px 0 10px' }}>Goes well with</div>
            <Card pad={12} onClick={() => { go('pdp', { pid: pair.id }); setQty(1); setSlide(0); }}>
              <Row>
                <TileImg p={pair} size={58} height={58} glyphSize={30} radius={16}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 14.5, color: RFM.ink }}>{pair.name}</div>
                  <Money v={pair.price} size={14} weight={700} color={RFM.sub}/>
                </div>
                <RoundBtn icon="plus" tone="acc" size={40} onClick={(e) => { e.stopPropagation(); dispatch({ type: 'CART_SET', pid: pair.id, qty: (store.cart[pair.id] || 0) + 1 }); }}/>
              </Row>
            </Card>
          </>
        )}
      </div>

      {/* Sticky buy bar */}
      <div style={{
        position: 'absolute', left: 14, right: 14, bottom: 96, zIndex: 55,
        background: '#fff', borderRadius: 24, padding: 12,
        display: 'flex', gap: 10,
        boxShadow: '0 -2px 10px rgba(22,50,79,0.05), 0 16px 40px rgba(22,50,79,0.22)',
      }}>
        <BigBtn label={inCart ? 'In basket · ' + inCart : 'Add to basket'} tone="ghost" style={{ flex: 1, height: 54 }}
          onClick={() => dispatch({ type: 'CART_SET', pid, qty: inCart + qty })}/>
        <BigBtn label="Order now" style={{ flex: 1, height: 54 }}
          onClick={() => { dispatch({ type: 'CART_SET', pid, qty: inCart + qty }); go('checkout'); }}/>
      </div>
    </Scr>
  );
}

// ── Basket ──
function ShopCart({ go }) {
  const { store, dispatch } = useStore();
  const items = Object.entries(store.cart).map(([pid, qty]) => ({ pid, qty }));
  const total = priceOf(store.products, items);

  return (
    <Scr pad="70px 16px 178px">
      <Row gap={12} style={{ marginBottom: 16 }}>
        <RoundBtn icon="back" size={46} onClick={() => go('front')}/>
        <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 26, color: RFM.ink, letterSpacing: '-0.02em' }}>Basket</div>
        <div style={{ marginLeft: 'auto', fontFamily: RFM.font, fontWeight: 700, fontSize: 14, color: RFM.faint }}>
          {items.reduce((s, it) => s + it.qty, 0)} items
        </div>
      </Row>

      {items.length === 0 && (
        <Card pad={20}>
          <EmptyState icon="bag" title="Basket is empty" sub="Add something from the shop"/>
          <BigBtn label="Browse the shop" tone="ghost" onClick={() => go('front')}/>
        </Card>
      )}

      {items.map((it, i) => {
        const p = store.products.find(p => p.id === it.pid);
        return (
          <Card key={it.pid} pad={12} anim style={{ marginBottom: 10, animationDelay: i * 50 + 'ms' }}>
            <Row>
              <div className="rfm-press" onClick={() => go('pdp', { pid: it.pid })}>
                <TileImg p={p} size={64} height={64} glyphSize={32} radius={16}/>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14.5, color: RFM.ink, lineHeight: 1.15 }}>{p.name}</div>
                <Money v={p.price * it.qty} size={15.5}/>
                <div style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 11, color: RFM.faint }}>{p.unit}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 }}>
                <div className="rfm-press" onClick={() => dispatch({ type: 'CART_SET', pid: it.pid, qty: 0 })} style={{ padding: 4 }}>
                  {I('trash', { size: 17, color: RFM.faint })}
                </div>
                <Row gap={0} style={{ background: ACC_SOFT, borderRadius: 12, overflow: 'hidden' }}>
                  <div className="rfm-press" onClick={() => dispatch({ type: 'CART_SET', pid: it.pid, qty: it.qty - 1 })} style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {I('minus', { size: 15, color: 'var(--rfm-acc, #2563EB)' })}
                  </div>
                  <div style={{ width: 26, textAlign: 'center', fontFamily: RFM.font, fontWeight: 800, fontSize: 14.5, color: RFM.ink }}>{it.qty}</div>
                  <div className="rfm-press" onClick={() => dispatch({ type: 'CART_SET', pid: it.pid, qty: it.qty + 1 })} style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {I('plus', { size: 15, color: 'var(--rfm-acc, #2563EB)' })}
                  </div>
                </Row>
              </div>
            </Row>
          </Card>
        );
      })}

      {items.length > 0 && (
        <div style={{
          position: 'absolute', left: 14, right: 14, bottom: 96, zIndex: 55,
          background: '#fff', borderRadius: 24, padding: '14px 16px 12px',
          boxShadow: '0 -2px 10px rgba(22,50,79,0.05), 0 16px 40px rgba(22,50,79,0.22)',
        }}>
          <Row style={{ justifyContent: 'space-between', padding: '0 6px 10px' }}>
            <span style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 14.5, color: RFM.sub }}>Subtotal</span>
            <Money v={total} size={20}/>
          </Row>
          <BigBtn label="Checkout" icon="chev" style={{ height: 54 }} onClick={() => go('checkout')}/>
        </div>
      )}
    </Scr>
  );
}

// ── Checkout ──
function ShopCheckout({ go }) {
  const { store, dispatch } = useStore();
  const [slot, setSlot] = React.useState(0);
  const items = Object.entries(store.cart).map(([pid, qty]) => ({ pid, qty }));
  const total = priceOf(store.products, items);
  const slots = ['Tomorrow 7am', 'Tomorrow 2pm', 'Tue 7am'];

  if (items.length === 0) {
    return (
      <Scr pad="70px 16px 130px">
        <Row gap={12} style={{ marginBottom: 16 }}>
          <RoundBtn icon="back" size={46} onClick={() => go('front')}/>
          <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 26, color: RFM.ink }}>Checkout</div>
        </Row>
        <Card pad={20}><EmptyState icon="check" title="Order placed" sub="Track it on Home"/></Card>
      </Scr>
    );
  }

  return (
    <Scr pad="70px 16px 178px">
      <Row gap={12} style={{ marginBottom: 16 }}>
        <RoundBtn icon="back" size={46} onClick={() => go('cart')}/>
        <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 26, color: RFM.ink, letterSpacing: '-0.02em' }}>Checkout</div>
      </Row>

      {/* Deliver to */}
      <Card pad={16} style={{ marginBottom: 12 }}>
        <Row>
          <div style={{ width: 44, height: 44, borderRadius: 16, background: ACC_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {I('map', { size: 22, color: 'var(--rfm-acc, #2563EB)' })}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: RFM.ink }}>Harbor Cafe</div>
            <div style={{ fontSize: 13, color: RFM.sub, fontWeight: 600 }}>12 Quay St, back door</div>
          </div>
          <Pill label="Saved" tone="green"/>
        </Row>
      </Card>

      {/* Slot */}
      <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 15.5, color: RFM.ink, margin: '4px 4px 10px' }}>When?</div>
      <Row gap={8} style={{ marginBottom: 12 }}>
        {slots.map((s, i) => {
          const on = slot === i;
          return (
            <div key={i} className="rfm-press" onClick={() => setSlot(i)} style={{
              flex: 1, padding: '13px 8px', borderRadius: 16, textAlign: 'center',
              background: on ? RFM.ink : '#fff',
              color: on ? '#fff' : RFM.sub,
              fontFamily: RFM.font, fontWeight: 800, fontSize: 12.5,
              boxShadow: on ? '0 8px 20px rgba(22,50,79,0.28)' : '0 2px 8px rgba(22,50,79,0.06)',
            }}>{s}</div>
          );
        })}
      </Row>

      {/* Pay */}
      <Card pad={16} style={{ marginBottom: 12 }}>
        <Row>
          <div style={{ width: 44, height: 44, borderRadius: 16, background: RFM.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {I('card', { size: 22, color: RFM.amber })}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: RFM.ink }}>On account</div>
            <div style={{ fontSize: 13, color: RFM.sub, fontWeight: 600 }}>Invoiced after delivery</div>
          </div>
          {I('check', { size: 20, color: RFM.green, sw: 3 })}
        </Row>
      </Card>

      {/* Summary */}
      <Card pad={16}>
        {items.map(it => {
          const p = store.products.find(p => p.id === it.pid);
          return (
            <Row key={it.pid} style={{ justifyContent: 'space-between', padding: '5px 2px' }}>
              <span style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 13.5, color: RFM.sub }}>{p.name} × {it.qty}</span>
              <Money v={p.price * it.qty} size={13.5} weight={700}/>
            </Row>
          );
        })}
        <Row style={{ justifyContent: 'space-between', padding: '5px 2px' }}>
          <span style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 13.5, color: RFM.sub }}>Delivery</span>
          <span style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 13.5, color: RFM.green }}>Free</span>
        </Row>
        <div style={{ borderTop: '1px solid ' + RFM.line, marginTop: 8, paddingTop: 10 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <span style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 16, color: RFM.ink }}>Total</span>
            <Money v={total} size={22}/>
          </Row>
        </div>
      </Card>

      {/* Place order */}
      <div style={{
        position: 'absolute', left: 14, right: 14, bottom: 96, zIndex: 55,
        background: '#fff', borderRadius: 24, padding: 12,
        boxShadow: '0 -2px 10px rgba(22,50,79,0.05), 0 16px 40px rgba(22,50,79,0.22)',
      }}>
        <BigBtn label={'Place order · $' + total.toFixed(2)} icon="check" tone="green" style={{ height: 56 }}
          onClick={() => { dispatch({ type: 'SEND_CART' }); go('front'); }}/>
      </div>
    </Scr>
  );
}

// ── Orders ──
function RtOrders() {
  const { store, dispatch } = useStore();
  const { active } = useMyOrder();
  const [view, setView] = React.useState(null);

  return (
    <Scr>
      <Hdr title="Orders"/>
      {active && (
        <Card pad={18} anim style={{ marginBottom: 18 }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: RFM.ink }}>On its way</div>
            <Money v={priceOf(store.products, active.items)} size={16}/>
          </Row>
          <Steps labels={['Sent', 'Packing', 'Driving', 'Here']} current={active.status === 'routed' && store.route.status === 'running' ? 2 : trackStep(active.status)}/>
        </Card>
      )}

      <SectionLabel label="Past orders"/>
      {store.history.map((h, i) => (
        <Card key={h.id} pad={15} anim onClick={() => setView(h)} style={{ marginBottom: 10, animationDelay: i * 50 + 'ms' }}>
          <Row>
            <div style={{ width: 44, height: 44, borderRadius: 16, background: RFM.greenSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {I('check', { size: 20, color: RFM.green, sw: 3 })}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: RFM.ink }}>{h.date}</div>
              <div style={{ fontSize: 13, color: RFM.sub, fontWeight: 600 }}>{h.items.reduce((s, it) => s + it.qty, 0)} items</div>
            </div>
            <Money v={h.total} size={16}/>
            {I('chev', { size: 18, color: RFM.faint })}
          </Row>
        </Card>
      ))}

      <Sheet open={!!view} onClose={() => setView(null)} title={view ? view.date : ''}>
        {view && (
          <>
            <ItemLines items={view.items}/>
            <div style={{ height: 16 }}/>
            <BigBtn label="Order this again" icon="repeat" onClick={() => { dispatch({ type: 'REORDER', items: view.items }); setView(null); }}/>
          </>
        )}
      </Sheet>
    </Scr>
  );
}

// ── Money ──
function RtMoney() {
  const { store, dispatch } = useStore();
  const [view, setView] = React.useState(null);
  const mine = store.invoices.filter(i => i.custId === 'c1');
  const open = mine.filter(i => i.status !== 'paid');
  const owe = open.reduce((s, i) => s + i.amount, 0);

  return (
    <Scr>
      <Hdr title="Money"/>
      <div style={{ background: RFM.navy, borderRadius: RAD, padding: '22px 20px', marginBottom: 14, boxShadow: '0 14px 34px rgba(22,50,79,0.28)' }}>
        <div style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 13.5, color: 'rgba(255,255,255,0.65)' }}>You owe</div>
        <div style={{ marginTop: 6 }}><Money v={Math.max(0, owe - store.credits)} size={40} color="#fff"/></div>
        {store.credits > 0 && (
          <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 99, background: 'rgba(24,154,74,0.25)' }}>
            {I('check', { size: 14, color: '#7EE2A8', sw: 3 })}
            <span style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 13, color: '#7EE2A8' }}>${store.credits.toFixed(2)} credit applied</span>
          </div>
        )}
      </div>

      <SectionLabel label="Invoices"/>
      {mine.map((inv, i) => (
        <Card key={inv.id} pad={15} anim onClick={() => setView(inv)} style={{ marginBottom: 10, animationDelay: i * 50 + 'ms' }}>
          <Row>
            <div style={{ width: 44, height: 44, borderRadius: 16, background: inv.status === 'paid' ? RFM.greenSoft : RFM.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {I('doc', { size: 21, color: inv.status === 'paid' ? RFM.green : RFM.amber })}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: RFM.ink }}>{inv.id}</div>
              <div style={{ fontSize: 13, color: RFM.sub, fontWeight: 600 }}>{inv.status === 'paid' ? 'Paid' : 'Due ' + inv.due}</div>
            </div>
            <Money v={inv.amount} size={16}/>
            {I('chev', { size: 18, color: RFM.faint })}
          </Row>
        </Card>
      ))}

      <Sheet open={!!view} onClose={() => setView(null)} title={view ? view.id : ''}>
        {view && (
          <>
            <Row style={{ justifyContent: 'space-between', padding: '4px 4px 16px' }}>
              <Pill label={view.status === 'paid' ? 'Paid' : 'Due ' + view.due} tone={view.status === 'paid' ? 'green' : 'amber'}/>
              <Money v={view.amount} size={26}/>
            </Row>
            <BigBtn label="Download PDF" icon="doc" tone="ghost" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'PDF saved' } }); setView(null); }}/>
            <div style={{ height: 10 }}/>
            <BigBtn label="Get my statement" icon="send" tone="ghost" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Emailed to you' } }); setView(null); }}/>
          </>
        )}
      </Sheet>
    </Scr>
  );
}

Object.assign(window, { RtApp });
