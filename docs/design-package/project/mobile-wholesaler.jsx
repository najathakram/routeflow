// mobile-wholesaler.jsx — Wholesaler (operator) app: Today, Route, Money, Stock, People

function WhApp() {
  const [tab, setTab] = React.useState(() => localStorage.getItem('rfm:wh:tab') || 'today');
  const { store } = useStore();
  React.useEffect(() => { localStorage.setItem('rfm:wh:tab', tab); }, [tab]);

  const newCount = store.orders.filter(o => o.status === 'new').length + store.returns.filter(r => r.status === 'pending').length;
  const tabs = [
    { id: 'today', icon: 'home', label: 'Today', badge: newCount || null },
    { id: 'route', icon: 'route', label: 'Route' },
    { id: 'money', icon: 'money', label: 'Money' },
    { id: 'stock', icon: 'stock', label: 'Stock' },
    { id: 'people', icon: 'people', label: 'People' },
  ];
  return (
    <>
      {tab === 'today' && <WhToday/>}
      {tab === 'route' && <WhRoute/>}
      {tab === 'money' && <WhMoney/>}
      {tab === 'stock' && <WhStock/>}
      {tab === 'people' && <WhPeople/>}
      <TabBar tabs={tabs} active={tab} onChange={setTab}/>
    </>
  );
}

// ── Today ──
function WhToday() {
  const { store, dispatch } = useStore();
  const [view, setView] = React.useState(null); // order for detail sheet
  const news = store.orders.filter(o => o.status === 'new');
  const toDeliver = store.orders.filter(o => ['approved', 'routed'].includes(o.status));
  const owed = store.invoices.filter(i => i.status !== 'paid').reduce((s, i) => s + i.amount, 0);
  const rets = store.returns.filter(r => r.status === 'pending');
  const cust = (id) => store.customers.find(c => c.id === id);

  return (
    <Scr>
      <Hdr sub="Friday, Jul 4" title="Morning, Sam" right={
        <RoundBtn icon="bell" size={46} onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'No new alerts' } })}/>
      }/>

      {/* Big three numbers */}
      <Row gap={10} style={{ marginBottom: 22 }}>
        <StatTile n={news.length} label="New" tone="amber"/>
        <StatTile n={toDeliver.length} label="To deliver" tone="blue"/>
        <StatTile n={'$' + Math.round(owed).toLocaleString()} label="Owed" tone="navy" small/>
      </Row>

      <SectionLabel label="New orders" count={news.length}/>
      {news.length === 0 && <Card anim><EmptyState icon="check" title="All caught up" sub="New orders land here"/></Card>}
      {news.map((o, i) => (
        <Card key={o.id} anim style={{ marginBottom: 12, animationDelay: i * 60 + 'ms' }} pad={16}>
          <Row>
            <Avatar name={cust(o.custId).name} hue={cust(o.custId).hue}/>
            <div style={{ flex: 1, minWidth: 0 }} onClick={() => setView(o)}>
              <div style={{ fontWeight: 800, fontSize: 16.5, color: RFM.ink }}>{cust(o.custId).name}</div>
              <div style={{ fontSize: 13.5, color: RFM.sub, fontWeight: 600, marginTop: 2 }}>
                {o.items.reduce((s, it) => s + it.qty, 0)} items · <Money v={priceOf(store.products, o.items)} size={13.5} weight={800}/>
              </div>
            </div>
            <RoundBtn icon="chev" tone="soft" size={44} onClick={() => setView(o)}/>
            <RoundBtn icon="check" tone="green" size={52} onClick={() => dispatch({ type: 'APPROVE_ORDER', id: o.id })}/>
          </Row>
        </Card>
      ))}

      {rets.length > 0 && <SectionLabel label="Returns" count={rets.length} style={{ marginTop: 22 }}/>}
      {rets.map(r => (
        <Card key={r.id} anim pad={16} style={{ marginBottom: 12 }}>
          <Row style={{ marginBottom: 12 }}>
            <div style={{ width: 46, height: 46, borderRadius: 16, background: RFM.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {I('undo', { size: 22, color: RFM.amber })}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: RFM.ink }}>{cust(r.custId).name}</div>
              <div style={{ fontSize: 13.5, color: RFM.sub, fontWeight: 600, marginTop: 2 }}>{r.pname} × {r.qty}</div>
            </div>
            <Pill label={r.reason} tone="amber"/>
          </Row>
          <Row gap={10}>
            <BigBtn label="Decline" tone="red" style={{ flex: 1, height: 50 }} onClick={() => dispatch({ type: 'RETURN_DECISION', id: r.id, ok: false })}/>
            <BigBtn label={'Credit $' + r.amount.toFixed(2)} tone="green" style={{ flex: 2, height: 50 }} onClick={() => dispatch({ type: 'RETURN_DECISION', id: r.id, ok: true })}/>
          </Row>
        </Card>
      ))}

      {/* Order detail sheet */}
      <Sheet open={!!view} onClose={() => setView(null)} title={view ? cust(view.custId).name : ''}>
        {view && (
          <>
            <ItemLines items={view.items}/>
            <Row style={{ justifyContent: 'space-between', padding: '14px 4px 16px' }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: RFM.sub }}>Total</span>
              <Money v={priceOf(store.products, view.items)} size={24}/>
            </Row>
            <BigBtn label="Approve" icon="check" tone="green" onClick={() => { dispatch({ type: 'APPROVE_ORDER', id: view.id }); setView(null); }}/>
            <div style={{ height: 10 }}/>
            <BigBtn label="Decline" tone="red" style={{ height: 50 }} onClick={() => { dispatch({ type: 'DECLINE_ORDER', id: view.id }); setView(null); }}/>
          </>
        )}
      </Sheet>
    </Scr>
  );
}

function StatTile({ n, label, tone, small }) {
  const bg = { amber: RFM.amberSoft, blue: ACC_SOFT, navy: RFM.navy }[tone];
  const fg = { amber: RFM.amber, blue: 'var(--rfm-acc, #2563EB)', navy: '#fff' }[tone];
  return (
    <div style={{ flex: 1, background: bg, borderRadius: RAD, padding: '16px 14px' }}>
      <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: small ? 23 : 30, color: fg, letterSpacing: '-0.03em', lineHeight: 1 }}>{n}</div>
      <div style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 12.5, color: tone === 'navy' ? 'rgba(255,255,255,0.72)' : RFM.sub, marginTop: 6 }}>{label}</div>
    </div>
  );
}

function SectionLabel({ label, count, style }) {
  return (
    <Row gap={8} style={{ padding: '0 4px', marginBottom: 12, ...style }}>
      <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 17, color: RFM.ink, letterSpacing: '-0.01em' }}>{label}</div>
      {count > 0 && <div style={{
        minWidth: 24, height: 24, borderRadius: 12, background: ACC_SOFT, color: 'var(--rfm-acc, #2563EB)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: RFM.font, fontWeight: 800, fontSize: 13, padding: '0 7px',
      }}>{count}</div>}
    </Row>
  );
}

function ItemLines({ items }) {
  const { store } = useStore();
  return (
    <div>
      {items.map((it, i) => {
        const p = store.products.find(p => p.id === it.pid);
        if (!p) return null;
        return (
          <Row key={i} style={{ padding: '10px 4px', borderBottom: '1px solid ' + RFM.line }}>
            <div style={{ width: 42, height: 42, borderRadius: 14, background: ACC_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Glyph name={p.glyph} size={24}/>
            </div>
            <div style={{ flex: 1, fontWeight: 700, fontSize: 15, color: RFM.ink }}>{p.name}</div>
            <div style={{ fontWeight: 800, fontSize: 15, color: RFM.sub }}>× {it.qty}</div>
          </Row>
        );
      })}
    </div>
  );
}

// ── Route ──
function WhRoute() {
  const { store, dispatch } = useStore();
  const stops = store.orders.filter(o => ['approved', 'routed', 'delivered'].includes(o.status));
  const cust = (id) => store.customers.find(c => c.id === id);
  const drivers = [{ name: 'Tom', hue: 210 }, { name: 'Sara', hue: 330 }];
  const sent = store.route.status !== 'draft';
  const doneCount = stops.filter(o => o.status === 'delivered').length;

  return (
    <Scr>
      <Hdr sub={sent ? 'Sent to ' + store.route.driver : stops.length + ' stops ready'} title="Today's route"/>

      {/* Route strip */}
      <Card pad={18} style={{ marginBottom: 16 }}>
        <MiniRouteMap n={stops.length} done={doneCount} running={store.route.status === 'running' || store.route.status === 'done'}/>
        <Row style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <Pill label={stops.length + ' stops'} tone="blue"/>
          <Pill label="14 km" tone="gray"/>
          <Pill label="est 2h 10m" tone="gray"/>
        </Row>
      </Card>

      {!sent && stops.length > 0 && (
        <>
          <SectionLabel label="Who drives?"/>
          <Row gap={10} style={{ marginBottom: 16 }}>
            {drivers.map(d => {
              const on = store.route.driver === d.name;
              return (
                <div key={d.name} className="rfm-press" onClick={() => dispatch({ type: 'SET_DRIVER', name: d.name })} style={{
                  flex: 1, background: on ? ACC_SOFT : '#fff', borderRadius: RAD,
                  border: '2.5px solid ' + (on ? 'var(--rfm-acc, #2563EB)' : 'transparent'),
                  padding: '14px 12px', display: 'flex', alignItems: 'center', gap: 12,
                  boxShadow: '0 4px 14px rgba(22,50,79,0.05)',
                }}>
                  <Avatar name={d.name} hue={d.hue} size={44}/>
                  <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 17, color: RFM.ink }}>{d.name}</div>
                  {on && <div style={{ marginLeft: 'auto' }}>{I('check', { size: 20, color: 'var(--rfm-acc, #2563EB)', sw: 3 })}</div>}
                </div>
              );
            })}
          </Row>
          <BigBtn label={store.route.driver ? 'Send to ' + store.route.driver : 'Pick a driver'} icon="send" disabled={!store.route.driver} onClick={() => dispatch({ type: 'SEND_ROUTE' })} style={{ marginBottom: 20 }}/>
        </>
      )}

      {sent && (
        <Card pad={16} style={{ marginBottom: 16, background: store.route.status === 'done' ? RFM.greenSoft : '#fff' }}>
          <Row>
            <Avatar name={store.route.driver || 'T'} hue={store.route.driver === 'Sara' ? 330 : 210} size={44}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: RFM.ink }}>
                {store.route.status === 'done' ? 'Run finished' : store.route.status === 'running' ? store.route.driver + ' is driving' : 'Waiting for ' + store.route.driver}
              </div>
              <div style={{ fontSize: 13.5, color: RFM.sub, fontWeight: 600, marginTop: 2 }}>{doneCount} of {stops.length} delivered</div>
            </div>
            {store.route.status === 'done' ? <Pill label="Done" tone="green"/> : <Pill label="Live" tone={store.route.status === 'running' ? 'green' : 'amber'}/>}
          </Row>
        </Card>
      )}

      <SectionLabel label="Stops"/>
      {stops.length === 0 && <Card><EmptyState icon="route" title="No stops yet" sub="Approve orders on Today"/></Card>}
      {stops.map((o, i) => {
        const c = cust(o.custId);
        const done = o.status === 'delivered';
        return (
          <Card key={o.id} pad={14} anim style={{ marginBottom: 10, animationDelay: i * 50 + 'ms', opacity: done ? 0.65 : 1 }}>
            <Row>
              <div style={{
                width: 36, height: 36, borderRadius: 18, flexShrink: 0,
                background: done ? RFM.green : ACC_SOFT,
                color: done ? '#fff' : 'var(--rfm-acc, #2563EB)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: RFM.font, fontWeight: 800, fontSize: 15,
              }}>{done ? I('check', { size: 17, color: '#fff', sw: 3 }) : i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 15.5, color: RFM.ink }}>{c.name}</div>
                <div style={{ fontSize: 13, color: RFM.sub, fontWeight: 600 }}>{c.addr}</div>
              </div>
              <div style={{ fontWeight: 800, fontSize: 14, color: RFM.sub }}>{o.items.reduce((s, it) => s + it.qty, 0)} it.</div>
            </Row>
          </Card>
        );
      })}
    </Scr>
  );
}

function MiniRouteMap({ n, done, running }) {
  const pts = [[14, 56], [64, 22], [128, 48], [196, 18], [258, 44], [310, 20]].slice(0, Math.max(2, Math.min(6, n + 1)));
  const path = 'M ' + pts.map(p => p.join(' ')).join(' L ');
  const frac = n > 0 ? done / n : 0;
  return (
    <svg width="100%" height="72" viewBox="0 0 324 72">
      <path d={path} stroke="#E3E9F2" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      {running && <path d={path} stroke={RFM.green} strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray="400" strokeDashoffset={400 - 400 * Math.max(0.06, frac)} style={{ transition: 'stroke-dashoffset 600ms ease' }}/>}
      {!running && <path d={path} stroke="var(--rfm-acc, #2563EB)" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 9"/>}
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={i === 0 ? 8 : 6.5}
          fill={i === 0 ? RFM.navy : i <= done && running ? RFM.green : '#fff'}
          stroke={i === 0 ? RFM.navy : i <= done && running ? RFM.green : 'var(--rfm-acc, #2563EB)'} strokeWidth="3"/>
      ))}
    </svg>
  );
}

// ── Money ──
function WhMoney() {
  const { store, dispatch } = useStore();
  const [view, setView] = React.useState(null);
  const unpaid = store.invoices.filter(i => i.status !== 'paid');
  const paid = store.invoices.filter(i => i.status === 'paid');
  const owed = unpaid.reduce((s, i) => s + i.amount, 0);
  const cust = (id) => store.customers.find(c => c.id === id);

  return (
    <Scr>
      <Hdr title="Money"/>
      <div style={{
        background: RFM.navy, borderRadius: RAD, padding: '22px 20px', marginBottom: 20,
        boxShadow: '0 14px 34px rgba(22,50,79,0.28)',
      }}>
        <div style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 13.5, color: 'rgba(255,255,255,0.65)' }}>Owed to you</div>
        <div style={{ marginTop: 6 }}><Money v={owed} size={40} color="#fff"/></div>
        <Row gap={8} style={{ marginTop: 12 }}>
          <Pill label={unpaid.length + ' open'} tone="blue"/>
          {unpaid.some(i => i.status === 'overdue') && <Pill label={unpaid.filter(i => i.status === 'overdue').length + ' late'} tone="red"/>}
        </Row>
      </div>

      <SectionLabel label="Waiting on" count={unpaid.length}/>
      {unpaid.map((inv, i) => (
        <Card key={inv.id} pad={15} anim onClick={() => setView(inv)} style={{ marginBottom: 10, animationDelay: i * 50 + 'ms' }}>
          <Row>
            <Avatar name={cust(inv.custId).name} hue={cust(inv.custId).hue} size={44}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 15.5, color: RFM.ink }}>{cust(inv.custId).name}</div>
              <div style={{ fontSize: 13, color: inv.status === 'overdue' ? RFM.red : RFM.sub, fontWeight: 700 }}>{inv.due}</div>
            </div>
            <Money v={inv.amount} size={18}/>
            {I('chev', { size: 18, color: RFM.faint })}
          </Row>
        </Card>
      ))}

      <SectionLabel label="Paid" style={{ marginTop: 20 }}/>
      {paid.map(inv => (
        <Card key={inv.id} pad={14} style={{ marginBottom: 8, opacity: 0.72 }}>
          <Row>
            <div style={{ width: 34, height: 34, borderRadius: 17, background: RFM.greenSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {I('check', { size: 16, color: RFM.green, sw: 3 })}
            </div>
            <div style={{ flex: 1, fontWeight: 700, fontSize: 14.5, color: RFM.ink }}>{cust(inv.custId).name}</div>
            <Money v={inv.amount} size={15} weight={700}/>
          </Row>
        </Card>
      ))}

      <Sheet open={!!view} onClose={() => setView(null)} title={view ? view.id : ''}>
        {view && (
          <>
            <Row style={{ marginBottom: 14 }}>
              <Avatar name={cust(view.custId).name} hue={cust(view.custId).hue}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 17, color: RFM.ink }}>{cust(view.custId).name}</div>
                <div style={{ fontSize: 13.5, color: view.status === 'overdue' ? RFM.red : RFM.sub, fontWeight: 700 }}>{view.status === 'overdue' ? 'Late · ' + view.due : 'Due ' + view.due}</div>
              </div>
              <Money v={view.amount} size={24}/>
            </Row>
            <BigBtn label="Mark paid" icon="check" tone="green" onClick={() => { dispatch({ type: 'MARK_PAID', id: view.id }); setView(null); }}/>
            <div style={{ height: 10 }}/>
            <BigBtn label="Send a nudge" icon="bell" tone="ghost" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Reminder sent' } }); setView(null); }}/>
          </>
        )}
      </Sheet>
    </Scr>
  );
}

// ── Stock ──
function WhStock() {
  const { store, dispatch } = useStore();
  const [view, setView] = React.useState(null);
  const low = store.products.filter(p => p.stock <= 8);
  const viewP = view ? store.products.find(p => p.id === view) : null;

  return (
    <Scr>
      <Hdr title="Stock" right={<RoundBtn icon="plus" tone="acc" size={46} onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Ask me to add products' } })}/>}/>

      {low.length > 0 && (
        <>
          <SectionLabel label="Running low" count={low.length}/>
          {low.map(p => (
            <Card key={p.id} pad={14} anim style={{ marginBottom: 10, border: '2px solid ' + RFM.amberSoft }}>
              <Row>
                <div style={{ width: 48, height: 48, borderRadius: 16, background: RFM.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Glyph name={p.glyph} size={27} color={RFM.amber}/>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 15.5, color: RFM.ink }}>{p.name}</div>
                  <div style={{ fontSize: 13, color: RFM.amber, fontWeight: 800 }}>{p.stock} left</div>
                </div>
                <BigBtn label="+ 20" tone="acc" style={{ height: 46, width: 84 }} onClick={() => dispatch({ type: 'RESTOCK', pid: p.id })}/>
              </Row>
            </Card>
          ))}
        </>
      )}

      <SectionLabel label="Everything" style={{ marginTop: low.length ? 20 : 0 }}/>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {store.products.map((p, i) => (
          <Card key={p.id} pad={16} anim onClick={() => setView(p.id)} style={{ animationDelay: i * 40 + 'ms' }}>
            <div style={{ width: 52, height: 52, borderRadius: 18, background: ACC_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
              <Glyph name={p.glyph} size={30}/>
            </div>
            <div style={{ fontWeight: 800, fontSize: 14.5, color: RFM.ink, lineHeight: 1.2, minHeight: 35 }}>{p.name}</div>
            <Row style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 19, color: p.stock <= 8 ? RFM.amber : RFM.ink }}>{p.stock}</span>
              <span style={{ fontWeight: 700, fontSize: 12.5, color: RFM.faint }}>in stock</span>
            </Row>
          </Card>
        ))}
      </div>

      <Sheet open={!!viewP} onClose={() => setView(null)} title={viewP ? viewP.name : ''}>
        {viewP && (
          <>
            <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ width: 60, height: 60, borderRadius: 20, background: ACC_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Glyph name={viewP.glyph} size={34}/>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Money v={viewP.price} size={22}/>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: RFM.faint }}>per unit</div>
              </div>
            </Row>
            <Row style={{ justifyContent: 'space-between', padding: '14px 4px' }}>
              <span style={{ fontWeight: 800, fontSize: 16, color: RFM.ink }}>In stock</span>
              <Stepper value={viewP.stock} onChange={(v) => dispatch({ type: 'ADJUST_STOCK', pid: viewP.id, delta: v - viewP.stock })}/>
            </Row>
            {viewP.stock <= 8 && (
              <BigBtn label="Add 20 more" icon="plus" onClick={() => dispatch({ type: 'RESTOCK', pid: viewP.id })}/>
            )}
          </>
        )}
      </Sheet>
    </Scr>
  );
}

// ── People ──
function WhPeople() {
  const { store, dispatch } = useStore();
  const [view, setView] = React.useState(null);
  const viewC = view ? store.customers.find(c => c.id === view) : null;
  const invsFor = (cid) => store.invoices.filter(i => i.custId === cid);

  return (
    <Scr>
      <Hdr title="People"/>
      {store.customers.map((c, i) => (
        <Card key={c.id} pad={15} anim onClick={() => setView(c.id)} style={{ marginBottom: 10, animationDelay: i * 50 + 'ms' }}>
          <Row>
            <Avatar name={c.name} hue={c.hue}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: RFM.ink }}>{c.name}</div>
              <div style={{ fontSize: 13, color: RFM.sub, fontWeight: 600 }}>Ordered {c.last.toLowerCase()}</div>
            </div>
            {c.owed > 0 ? <Money v={c.owed} size={16}/> : <Pill label="All paid" tone="green"/>}
            {I('chev', { size: 18, color: RFM.faint })}
          </Row>
        </Card>
      ))}

      <Sheet open={!!viewC} onClose={() => setView(null)} title={viewC ? viewC.name : ''}>
        {viewC && (
          <>
            <Row style={{ marginBottom: 16 }}>
              <Avatar name={viewC.name} hue={viewC.hue} size={54}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, color: RFM.sub, fontWeight: 700 }}>{viewC.addr}</div>
                <div style={{ marginTop: 3 }}>
                  {viewC.owed > 0 ? <>owes <Money v={viewC.owed} size={19}/></> : <Pill label="All paid" tone="green"/>}
                </div>
              </div>
              <RoundBtn icon="phone" size={46} onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Calling...' } })}/>
            </Row>
            {invsFor(viewC.id).slice(0, 3).map(inv => (
              <Row key={inv.id} style={{ padding: '10px 4px', borderBottom: '1px solid ' + RFM.line }}>
                <div style={{ width: 38, height: 38, borderRadius: 13, background: inv.status === 'paid' ? RFM.greenSoft : RFM.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {I('doc', { size: 18, color: inv.status === 'paid' ? RFM.green : RFM.amber })}
                </div>
                <div style={{ flex: 1, fontWeight: 700, fontSize: 14, color: RFM.ink }}>{inv.id}</div>
                <Pill label={inv.status === 'paid' ? 'Paid' : inv.status === 'overdue' ? 'Late' : 'Open'} tone={inv.status === 'paid' ? 'green' : inv.status === 'overdue' ? 'red' : 'amber'}/>
                <Money v={inv.amount} size={14.5} weight={700}/>
              </Row>
            ))}
            <div style={{ height: 14 }}/>
            <BigBtn label="Send statement" icon="doc" tone="ghost" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Statement sent' } }); setView(null); }}/>
          </>
        )}
      </Sheet>
    </Scr>
  );
}

Object.assign(window, { WhApp });
