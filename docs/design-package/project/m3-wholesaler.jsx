// m3-wholesaler.jsx — Wholesaler app: Today, Orders, Route, Money, More hub

function W3App() {
  const [tab, setTab] = React.useState(() => localStorage.getItem('m3:wh:tab') || 'today');
  const { store } = useM3();
  React.useEffect(() => { localStorage.setItem('m3:wh:tab', tab); }, [tab]);
  const needs = store.orders.filter(o => o.status === 'new').length + store.returns.filter(r => r.status === 'pending').length;
  const tabs = [
    { id: 'today', icon: 'home', label: 'Today', badge: needs || null },
    { id: 'orders', icon: 'box', label: 'Orders' },
    { id: 'route', icon: 'route', label: 'Route' },
    { id: 'money', icon: 'money', label: 'Money' },
    { id: 'more', icon: 'grid', label: 'More' },
  ];
  return (
    <>
      {tab === 'today' && <W3Today goTab={setTab}/>}
      {tab === 'orders' && <W3Orders/>}
      {tab === 'route' && <W3Route/>}
      {tab === 'money' && <W3Money/>}
      {tab === 'more' && <W3More/>}
      <M3Dock tabs={tabs} active={tab} onChange={setTab}/>
    </>
  );
}

function W3HeroTop({ title, sub, right }) {
  return (
    <M3Row style={{ justifyContent: 'space-between', marginBottom: 18 }}>
      <div>
        <div style={{ fontFamily: M3.body, fontSize: 13.5, fontWeight: 600, color: M3.wsub }}>{sub}</div>
        <div style={{ fontFamily: M3.disp, fontSize: 27, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em', marginTop: 2 }}>{title}</div>
      </div>
      {right}
    </M3Row>
  );
}

// ── Today ──
function W3Today({ goTab }) {
  const { store, dispatch } = useM3();
  const [view, setView] = React.useState(null);
  const news = store.orders.filter(o => o.status === 'new');
  const rets = store.returns.filter(r => r.status === 'pending');
  const low = store.products.filter(p => p.stock <= 8);
  const cust = (id) => store.customers.find(c => c.id === id);
  const delivered = store.orders.filter(o => o.status === 'delivered');
  const todayRev = 1480 + Math.round(delivered.reduce((s, o) => s + m3Price(store.products, o.items), 0));

  return (
    <M3Scr hero={
      <M3Hero>
        <W3HeroTop sub="Friday, Jul 4" title="Morning, Sam" right={
          <M3Round icon="bell" tone="glass" onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'No new alerts' } })}/>
        }/>
        <M3Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontFamily: M3.body, fontSize: 12.5, fontWeight: 700, color: M3.wfaint, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Today so far</div>
            <M3Num v={todayRev} prefix="$" size={44} color="#fff" countKey={todayRev}/>
          </div>
          <M3Spark data={store.week} color="#8FBAFB"/>
        </M3Row>
        <M3Row gap={8} style={{ marginTop: 16 }}>
          <M3Pill dark label={news.length + ' orders in'} tone="blue"/>
          <M3Pill dark label={delivered.length + ' delivered'} tone="green"/>
          <M3Pill dark label="97% on time" tone="gray"/>
        </M3Row>
      </M3Hero>
    }>
      <M3Section label="Needs you" count={news.length + rets.length}/>
      {news.length === 0 && rets.length === 0 && (
        <M3Card anim><M3Empty icon="check" title="All caught up" sub="New orders will land here"/></M3Card>
      )}
      {news.map((o, i) => (
        <M3Card key={o.id} anim delay={i * 60} pad={14} style={{ marginBottom: 10 }}>
          <M3Row>
            <M3Avatar name={cust(o.custId).name} hue={cust(o.custId).hue} size={48}/>
            <div style={{ flex: 1, minWidth: 0 }} className="m3-press" onClick={() => setView(o)}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16, color: M3.ink }}>{cust(o.custId).name}</div>
              <div style={{ fontSize: 13, color: M3.sub, fontWeight: 600, marginTop: 2 }}>
                {o.items.reduce((s, it) => s + it.qty, 0)} items · ${m3Price(store.products, o.items).toFixed(2)}
              </div>
            </div>
            <M3Round icon="chev" tone="white" size={42} onClick={() => setView(o)}/>
            <M3Round icon="check" tone="green" size={50} onClick={() => dispatch({ type: 'APPROVE_ORDER', id: o.id })}/>
          </M3Row>
        </M3Card>
      ))}

      {rets.map(r => (
        <M3Card key={r.id} anim pad={14} style={{ marginBottom: 10 }}>
          <M3Row style={{ marginBottom: 12 }}>
            <div style={{ width: 48, height: 48, borderRadius: 18, background: M3.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {M3I('undo', { size: 23, color: M3.amber })}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15.5, color: M3.ink }}>{cust(r.custId).name}</div>
              <div style={{ fontSize: 13, color: M3.sub, fontWeight: 600, marginTop: 2 }}>{r.pname} × {r.qty}</div>
            </div>
            <M3Pill label={r.reason} tone="amber"/>
          </M3Row>
          <M3Row gap={9}>
            <M3Btn label="Decline" tone="danger" h={48} style={{ flex: 1 }} onClick={() => dispatch({ type: 'RETURN_DECISION', id: r.id, ok: false })}/>
            <M3Btn label={'Credit $' + r.amount.toFixed(2)} tone="green" h={48} style={{ flex: 1.6 }} onClick={() => dispatch({ type: 'RETURN_DECISION', id: r.id, ok: true })}/>
          </M3Row>
        </M3Card>
      ))}

      {low.length > 0 && (
        <>
          <M3Section label="Running low" count={low.length} style={{ marginTop: 20 }} right={
            <span className="m3-press" onClick={() => goTab('more')} style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 13, color: 'var(--m3-acc, #2563EB)' }}>Stock</span>
          }/>
          <div className="m3-scroll" style={{ display: 'flex', gap: 10, overflowX: 'auto', margin: '0 -16px', padding: '0 16px 4px' }}>
            {low.map(p => (
              <M3Card key={p.id} pad={12} style={{ minWidth: 168 }}>
                <M3Tile p={p} height={64} glyphSize={32} radius={16} style={{ marginBottom: 10 }}/>
                <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5, color: M3.ink, lineHeight: 1.15, minHeight: 31 }}>{p.name}</div>
                <M3Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                  <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: M3.amber }}>{p.stock} left</span>
                  <M3Btn label="+20" tone="soft" h={36} fs={13.5} style={{ padding: '0 14px' }} onClick={() => dispatch({ type: 'RESTOCK', pid: p.id })}/>
                </M3Row>
              </M3Card>
            ))}
          </div>
        </>
      )}

      {(store.route.status === 'running' || store.route.status === 'done') && <W3LiveStrip goTab={goTab}/>}

      <M3Sheet open={!!view} onClose={() => setView(null)} title={view ? cust(view.custId).name : ''}>
        {view && (
          <>
            <M3Lines items={view.items}/>
            <M3Row style={{ justifyContent: 'space-between', padding: '14px 4px 16px' }}>
              <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 14.5, color: M3.sub }}>Total</span>
              <M3Money v={m3Price(store.products, view.items)} size={24}/>
            </M3Row>
            <M3Btn label="Approve" icon="check" tone="green" onClick={() => { dispatch({ type: 'APPROVE_ORDER', id: view.id }); setView(null); }}/>
            <div style={{ height: 9 }}/>
            <M3Btn label="Decline" tone="danger" h={48} onClick={() => { dispatch({ type: 'DECLINE_ORDER', id: view.id }); setView(null); }}/>
          </>
        )}
      </M3Sheet>
    </M3Scr>
  );
}

function W3LiveStrip({ goTab }) {
  const { store } = useM3();
  const stops = store.orders.filter(o => ['routed', 'delivered'].includes(o.status));
  const done = stops.filter(o => o.status === 'delivered').length;
  const finished = store.route.status === 'done';
  return (
    <>
      <M3Section label="On the road" style={{ marginTop: 20 }}/>
      <M3Card anim pad={16} onClick={() => goTab('route')} style={{ background: finished ? M3.greenSoft : '#fff' }}>
        <M3Row>
          <div style={{ width: 46, height: 46, borderRadius: 18, background: finished ? M3.green : M3GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {M3I(finished ? 'check' : 'truck', { size: 23, color: '#fff' })}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15.5, color: M3.ink }}>
              {finished ? 'Run finished' : store.route.driver + ' is driving'}
            </div>
            <div style={{ height: 7, borderRadius: 4, background: 'rgba(11,21,36,0.08)', marginTop: 8, overflow: 'hidden' }}>
              <div style={{ width: (done / stops.length * 100) + '%', height: '100%', borderRadius: 4, background: finished ? M3.green : M3GRAD, transition: 'width 500ms ease' }}/>
            </div>
          </div>
          <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: M3.sub }}>{done}/{stops.length}</span>
        </M3Row>
      </M3Card>
    </>
  );
}

// ── Orders ──
function W3Orders() {
  const { store, dispatch } = useM3();
  const [seg, setSeg] = React.useState('new');
  const [view, setView] = React.useState(null);
  const cust = (id) => store.customers.find(c => c.id === id);
  const segs = [
    { id: 'new', label: 'New', match: ['new'] },
    { id: 'ready', label: 'Ready', match: ['approved'] },
    { id: 'driving', label: 'Driving', match: ['routed'] },
    { id: 'done', label: 'Done', match: ['delivered'] },
  ];
  const active = segs.find(s => s.id === seg);
  const list = store.orders.filter(o => active.match.includes(o.status));

  return (
    <M3Scr hero={
      <M3Hero pad="68px 20px 20px">
        <W3HeroTop sub={store.orders.filter(o => o.status !== 'declined').length + ' today'} title="Orders"/>
        <M3Row gap={7}>
          {segs.map(s => {
            const on = s.id === seg;
            const n = store.orders.filter(o => s.match.includes(o.status)).length;
            return (
              <div key={s.id} className="m3-press" onClick={() => setSeg(s.id)} style={{
                flex: 1, padding: '10px 4px', borderRadius: 999, textAlign: 'center',
                background: on ? '#fff' : 'rgba(255,255,255,0.09)',
                border: '1px solid ' + (on ? '#fff' : 'rgba(255,255,255,0.14)'),
                fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5,
                color: on ? M3.ink : M3.wsub,
                transition: 'background 200ms',
              }}>
                {s.label}{n ? ' ' + n : ''}
              </div>
            );
          })}
        </M3Row>
      </M3Hero>
    }>
      {list.length === 0 && <M3Card anim><M3Empty icon="box" title="Nothing here" sub="Orders move as you work them"/></M3Card>}
      {list.map((o, i) => (
        <M3Card key={o.id} anim delay={i * 50} pad={14} onClick={() => setView(o)} style={{ marginBottom: 10 }}>
          <M3Row>
            <M3Avatar name={cust(o.custId).name} hue={cust(o.custId).hue} size={46}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15.5, color: M3.ink }}>{cust(o.custId).name}</div>
              <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600, marginTop: 2 }}>{o.items.reduce((s, it) => s + it.qty, 0)} items · {o.time}</div>
            </div>
            <M3Money v={m3Price(store.products, o.items)} size={16}/>
            {M3I('chev', { size: 17, color: M3.faint })}
          </M3Row>
        </M3Card>
      ))}

      <M3Sheet open={!!view} onClose={() => setView(null)} title={view ? cust(view.custId).name : ''}>
        {view && (
          <>
            <M3Row gap={8} style={{ marginBottom: 12 }}>
              <M3Pill label={{ new: 'New', approved: 'Ready', routed: 'Driving', delivered: 'Done' }[view.status] || view.status} tone={{ new: 'blue', approved: 'amber', routed: 'blue', delivered: 'green' }[view.status] || 'gray'}/>
              <M3Pill label={'at ' + view.time} tone="gray"/>
            </M3Row>
            <M3Lines items={view.items}/>
            <M3Row style={{ justifyContent: 'space-between', padding: '14px 4px 16px' }}>
              <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 14.5, color: M3.sub }}>Total</span>
              <M3Money v={m3Price(store.products, view.items)} size={24}/>
            </M3Row>
            {view.status === 'new' && (
              <>
                <M3Btn label="Approve" icon="check" tone="green" onClick={() => { dispatch({ type: 'APPROVE_ORDER', id: view.id }); setView(null); }}/>
                <div style={{ height: 9 }}/>
                <M3Btn label="Decline" tone="danger" h={48} onClick={() => { dispatch({ type: 'DECLINE_ORDER', id: view.id }); setView(null); }}/>
              </>
            )}
          </>
        )}
      </M3Sheet>
    </M3Scr>
  );
}

// ── Route ──
function W3Route() {
  const { store, dispatch } = useM3();
  const stops = store.orders.filter(o => ['approved', 'routed', 'delivered'].includes(o.status));
  const cust = (id) => store.customers.find(c => c.id === id);
  const drivers = [{ name: 'Tom', hue: 212 }, { name: 'Sara', hue: 330 }];
  const sent = store.route.status !== 'draft';
  const done = stops.filter(o => o.status === 'delivered').length;

  return (
    <M3Scr hero={
      <M3Hero pad="68px 20px 22px">
        <W3HeroTop sub={sent ? 'With ' + store.route.driver : stops.length + ' stops ready'} title="Today's route" right={
          sent ? <M3Pill dark label={store.route.status === 'done' ? 'Done' : 'Live'} tone={store.route.status === 'done' ? 'green' : 'amber'}/> : null
        }/>
        <W3RoutePath n={stops.length} done={done} running={sent && store.route.status !== 'sent'}/>
        <M3Row gap={8} style={{ marginTop: 14 }}>
          <M3Pill dark label={stops.length + ' stops'} tone="blue"/>
          <M3Pill dark label="14 km" tone="gray"/>
          <M3Pill dark label="est 2h 10m" tone="gray"/>
        </M3Row>
      </M3Hero>
    }>
      {!sent && stops.length > 0 && (
        <>
          <M3Section label="Who drives?"/>
          <M3Row gap={10} style={{ marginBottom: 14 }}>
            {drivers.map(d => {
              const on = store.route.driver === d.name;
              return (
                <div key={d.name} className="m3-press" onClick={() => dispatch({ type: 'SET_DRIVER', name: d.name })} style={{
                  flex: 1, background: '#fff', borderRadius: M3RAD,
                  border: '2px solid ' + (on ? 'var(--m3-acc, #2563EB)' : M3.border),
                  boxShadow: on ? '0 8px 22px rgba(37,99,235,0.18)' : '0 2px 10px rgba(11,21,36,0.04)',
                  padding: '14px 14px', display: 'flex', alignItems: 'center', gap: 12,
                  transition: 'border 160ms, box-shadow 160ms',
                }}>
                  <M3Avatar name={d.name} hue={d.hue} size={44}/>
                  <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16.5, color: M3.ink }}>{d.name}</div>
                  {on && <div style={{ marginLeft: 'auto', width: 26, height: 26, borderRadius: 13, background: M3GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{M3I('check', { size: 14, color: '#fff', sw: 3 })}</div>}
                </div>
              );
            })}
          </M3Row>
          <M3Btn label={store.route.driver ? 'Send to ' + store.route.driver : 'Pick a driver'} icon="send" disabled={!store.route.driver} onClick={() => dispatch({ type: 'SEND_ROUTE' })} style={{ marginBottom: 20 }}/>
        </>
      )}

      <M3Section label="Stops" style={{ marginTop: sent ? 0 : 4 }}/>
      {stops.length === 0 && <M3Card anim><M3Empty icon="route" title="No stops yet" sub="Approve orders on Today first"/></M3Card>}
      {stops.map((o, i) => {
        const c = cust(o.custId);
        const isDone = o.status === 'delivered';
        return (
          <M3Card key={o.id} pad={13} anim delay={i * 45} style={{ marginBottom: 9, opacity: isDone ? 0.62 : 1 }}>
            <M3Row>
              <div style={{
                width: 36, height: 36, borderRadius: 18, flexShrink: 0,
                background: isDone ? M3.green : M3ACCSOFT,
                color: isDone ? '#fff' : 'var(--m3-acc, #2563EB)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5,
              }}>{isDone ? M3I('check', { size: 16, color: '#fff', sw: 3 }) : i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: M3.ink }}>{c.name}</div>
                <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>{c.addr}</div>
              </div>
              <span style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 13, color: M3.faint }}>{o.items.reduce((s, it) => s + it.qty, 0)} it.</span>
            </M3Row>
          </M3Card>
        );
      })}
    </M3Scr>
  );
}

function W3RoutePath({ n, done, running }) {
  const pts = [[10, 52], [66, 18], [130, 44], [196, 14], [258, 40], [318, 16]].slice(0, Math.max(2, Math.min(6, n + 1)));
  const path = 'M ' + pts.map(p => p.join(' ')).join(' L ');
  const frac = n > 0 ? done / n : 0;
  return (
    <svg width="100%" height="64" viewBox="0 0 330 64">
      <path d={path} stroke="rgba(255,255,255,0.16)" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      {running
        ? <path d={path} stroke="#6EE7A0" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="420" strokeDashoffset={420 - 420 * Math.max(0.05, frac)} style={{ transition: 'stroke-dashoffset 600ms ease' }}/>
        : <path d={path} stroke="#8FBAFB" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 10"/>}
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={i === 0 ? 7.5 : 6}
          fill={i === 0 ? '#fff' : i <= done && running ? '#6EE7A0' : M3.canvasLight}
          stroke={i === 0 ? '#fff' : i <= done && running ? '#6EE7A0' : '#8FBAFB'} strokeWidth="2.5"/>
      ))}
    </svg>
  );
}

// ── Money ──
function W3Money() {
  const { store, dispatch } = useM3();
  const [view, setView] = React.useState(null);
  const unpaid = store.invoices.filter(i => i.status !== 'paid');
  const paid = store.invoices.filter(i => i.status === 'paid');
  const owed = unpaid.reduce((s, i) => s + i.amount, 0);
  const overdue = unpaid.filter(i => i.status === 'overdue');
  const cust = (id) => store.customers.find(c => c.id === id);

  return (
    <M3Scr hero={
      <M3Hero>
        <W3HeroTop sub={unpaid.length + ' open invoices'} title="Money"/>
        <div style={{ fontFamily: M3.body, fontSize: 12.5, fontWeight: 700, color: M3.wfaint, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Owed to you</div>
        <M3Num v={owed} prefix="$" size={44} color="#fff" decimals={0} countKey={owed}/>
        <M3Row gap={10} style={{ marginTop: 16 }}>
          <div style={{ flex: 1, background: 'rgba(220,59,59,0.16)', border: '1px solid rgba(220,59,59,0.3)', borderRadius: 18, padding: '12px 14px' }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 21, color: '#F19A9A' }}>{overdue.length}</div>
            <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12, color: M3.wsub }}>overdue</div>
          </div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 18, padding: '12px 14px' }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 21, color: '#fff' }}>{unpaid.length - overdue.length}</div>
            <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12, color: M3.wsub }}>due soon</div>
          </div>
          <div style={{ flex: 1, background: 'rgba(23,163,74,0.16)', border: '1px solid rgba(23,163,74,0.3)', borderRadius: 18, padding: '12px 14px' }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 21, color: '#6EE7A0' }}>${Math.round(paid.reduce((s, i) => s + i.amount, 0)).toLocaleString()}</div>
            <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12, color: M3.wsub }}>paid in</div>
          </div>
        </M3Row>
      </M3Hero>
    }>
      <M3Section label="Waiting on" count={unpaid.length}/>
      {unpaid.map((inv, i) => (
        <M3Card key={inv.id} pad={14} anim delay={i * 50} onClick={() => setView(inv)} style={{ marginBottom: 10 }}>
          <M3Row>
            <M3Avatar name={cust(inv.custId).name} hue={cust(inv.custId).hue} size={44}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: M3.ink }}>{cust(inv.custId).name}</div>
              <div style={{ fontSize: 12.5, color: inv.status === 'overdue' ? M3.red : M3.sub, fontWeight: 700 }}>{inv.due}</div>
            </div>
            <M3Money v={inv.amount} size={17}/>
            {M3I('chev', { size: 17, color: M3.faint })}
          </M3Row>
        </M3Card>
      ))}

      <M3Section label="Paid" style={{ marginTop: 18 }}/>
      {paid.map(inv => (
        <M3Card key={inv.id} pad={13} style={{ marginBottom: 8, opacity: 0.68 }}>
          <M3Row>
            <div style={{ width: 34, height: 34, borderRadius: 17, background: M3.greenSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {M3I('check', { size: 15, color: M3.green, sw: 3 })}
            </div>
            <div style={{ flex: 1, fontFamily: M3.body, fontWeight: 600, fontSize: 14, color: M3.ink }}>{cust(inv.custId).name}</div>
            <M3Money v={inv.amount} size={14} weight={600}/>
          </M3Row>
        </M3Card>
      ))}

      <M3Sheet open={!!view} onClose={() => setView(null)} title={view ? view.id : ''}>
        {view && (
          <>
            <M3Row style={{ marginBottom: 14 }}>
              <M3Avatar name={cust(view.custId).name} hue={cust(view.custId).hue}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16.5, color: M3.ink }}>{cust(view.custId).name}</div>
                <div style={{ fontSize: 13, color: view.status === 'overdue' ? M3.red : M3.sub, fontWeight: 700 }}>{view.status === 'overdue' ? 'Late · ' + view.due : 'Due ' + view.due}</div>
              </div>
              <M3Money v={view.amount} size={23}/>
            </M3Row>
            <M3Btn label="Mark paid" icon="check" tone="green" onClick={() => { dispatch({ type: 'MARK_PAID', id: view.id }); setView(null); }}/>
            <div style={{ height: 9 }}/>
            <M3Btn label="Send a nudge" icon="bell" tone="soft" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Reminder sent' } }); setView(null); }}/>
          </>
        )}
      </M3Sheet>
    </M3Scr>
  );
}

// ── More hub ──
function W3More() {
  const [page, setPage] = React.useState('hub'); // hub | stock | people | insights | drivers
  if (page === 'stock') return <W3Stock back={() => setPage('hub')}/>;
  if (page === 'people') return <W3People back={() => setPage('hub')}/>;
  if (page === 'insights') return <W3Insights back={() => setPage('hub')}/>;
  if (page === 'drivers') return <W3Drivers back={() => setPage('hub')}/>;
  return <W3Hub go={setPage}/>;
}

function W3Hub({ go }) {
  const { store, dispatch } = useM3();
  const low = store.products.filter(p => p.stock <= 8).length;
  const tiles = [
    { id: 'stock', icon: 'stock', label: 'Stock', sub: store.products.length + ' products', badge: low || null, hue: 212 },
    { id: 'people', icon: 'people', label: 'People', sub: store.customers.length + ' customers', hue: 158 },
    { id: 'insights', icon: 'chart', label: 'Insights', sub: 'This week', hue: 262 },
    { id: 'drivers', icon: 'truck', label: 'Drivers', sub: 'Tom and Sara', hue: 26 },
  ];
  return (
    <M3Scr hero={
      <M3Hero pad="68px 20px 22px">
        <W3HeroTop sub="Fresh Fields Wholesale" title="Everything else"/>
      </M3Hero>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {tiles.map((t, i) => (
          <M3Card key={t.id} anim delay={i * 60} pad={18} onClick={() => go(t.id)} style={{ position: 'relative' }}>
            {t.badge && (
              <div style={{
                position: 'absolute', top: 14, right: 14, minWidth: 22, height: 22, borderRadius: 11,
                background: M3.red, color: '#fff', fontFamily: M3.body, fontWeight: 800, fontSize: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 6px',
              }}>{t.badge}</div>
            )}
            <div style={{
              width: 52, height: 52, borderRadius: 19, marginBottom: 14,
              background: `linear-gradient(150deg, oklch(95% 0.04 ${t.hue}), oklch(87% 0.09 ${t.hue}))`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{M3I(t.icon, { size: 26, color: `oklch(38% 0.12 ${t.hue})` })}</div>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 17, color: M3.ink }}>{t.label}</div>
            <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12.5, color: M3.sub, marginTop: 3 }}>{t.sub}</div>
          </M3Card>
        ))}
      </div>
      <div style={{ height: 14 }}/>
      <M3Btn label="Reset the demo day" icon="repeat" tone="line" h={50} onClick={() => dispatch({ type: 'RESET_DAY' })}/>
    </M3Scr>
  );
}

function W3SubHero({ title, sub, back }) {
  return (
    <M3Hero pad="64px 20px 20px">
      <M3Row gap={13}>
        <M3Round icon="back" tone="glass" size={44} onClick={back}/>
        <div>
          <div style={{ fontFamily: M3.body, fontSize: 12.5, fontWeight: 600, color: M3.wsub }}>{sub}</div>
          <div style={{ fontFamily: M3.disp, fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>{title}</div>
        </div>
      </M3Row>
    </M3Hero>
  );
}

// Stock
function W3Stock({ back }) {
  const { store, dispatch } = useM3();
  const [view, setView] = React.useState(null);
  const low = store.products.filter(p => p.stock <= 8);
  const viewP = view ? store.products.find(p => p.id === view) : null;

  return (
    <M3Scr hero={<W3SubHero title="Stock" sub={low.length ? low.length + ' running low' : 'All healthy'} back={back}/>}>
      {low.length > 0 && (
        <>
          <M3Section label="Running low" count={low.length}/>
          {low.map(p => (
            <M3Card key={p.id} pad={13} anim style={{ marginBottom: 10 }}>
              <M3Row>
                <M3Tile p={p} height={52} glyphSize={28} radius={17} style={{ width: 52, flexShrink: 0 }}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15, color: M3.ink }}>{p.name}</div>
                  <div style={{ fontSize: 12.5, color: M3.amber, fontWeight: 800 }}>{p.stock} left</div>
                </div>
                <M3Btn label="+20" tone="grad" h={42} fs={14} style={{ padding: '0 18px' }} onClick={() => dispatch({ type: 'RESTOCK', pid: p.id })}/>
              </M3Row>
            </M3Card>
          ))}
        </>
      )}
      <M3Section label="Everything" style={{ marginTop: low.length ? 18 : 0 }}/>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {store.products.map((p, i) => (
          <M3Card key={p.id} pad={11} anim delay={i * 40} onClick={() => setView(p.id)}>
            <M3Tile p={p} height={92} glyphSize={40} radius={17}/>
            <div style={{ padding: '10px 5px 3px' }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5, color: M3.ink, lineHeight: 1.2, minHeight: 32 }}>{p.name}</div>
              <M3Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 17, color: p.stock <= 8 ? M3.amber : M3.ink }}>{p.stock}</span>
                <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 11.5, color: M3.faint }}>in stock</span>
              </M3Row>
            </div>
          </M3Card>
        ))}
      </div>

      <M3Sheet open={!!viewP} onClose={() => setView(null)} title={viewP ? viewP.name : ''}>
        {viewP && (
          <>
            <M3Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <M3Tile p={viewP} height={60} glyphSize={32} radius={19} style={{ width: 60 }}/>
              <div style={{ textAlign: 'right' }}>
                <M3Money v={viewP.price} size={21}/>
                <div style={{ fontSize: 12, fontWeight: 600, color: M3.faint }}>{viewP.unit}</div>
              </div>
            </M3Row>
            <M3Row style={{ justifyContent: 'space-between', padding: '12px 4px 14px' }}>
              <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16, color: M3.ink }}>In stock</span>
              <M3Stepper value={viewP.stock} onChange={(v) => dispatch({ type: 'ADJUST_STOCK', pid: viewP.id, delta: v - viewP.stock })}/>
            </M3Row>
            {viewP.stock <= 8 && <M3Btn label="Add 20 more" icon="plus" onClick={() => dispatch({ type: 'RESTOCK', pid: viewP.id })}/>}
          </>
        )}
      </M3Sheet>
    </M3Scr>
  );
}

// People
function W3People({ back }) {
  const { store, dispatch } = useM3();
  const [view, setView] = React.useState(null);
  const viewC = view ? store.customers.find(c => c.id === view) : null;
  const invsFor = (cid) => store.invoices.filter(i => i.custId === cid);

  return (
    <M3Scr hero={<W3SubHero title="People" sub={store.customers.length + ' customers'} back={back}/>}>
      {store.customers.map((c, i) => (
        <M3Card key={c.id} pad={14} anim delay={i * 50} onClick={() => setView(c.id)} style={{ marginBottom: 10 }}>
          <M3Row>
            <M3Avatar name={c.name} hue={c.hue}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15.5, color: M3.ink }}>{c.name}</div>
              <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>Ordered {c.last.toLowerCase()}</div>
            </div>
            {c.owed > 0 ? <M3Money v={c.owed} size={15.5}/> : <M3Pill label="All paid" tone="green"/>}
            {M3I('chev', { size: 17, color: M3.faint })}
          </M3Row>
        </M3Card>
      ))}

      <M3Sheet open={!!viewC} onClose={() => setView(null)} title={viewC ? viewC.name : ''}>
        {viewC && (
          <>
            <M3Row style={{ marginBottom: 14 }}>
              <M3Avatar name={viewC.name} hue={viewC.hue} size={52}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: M3.sub, fontWeight: 600 }}>{viewC.addr}</div>
                <div style={{ marginTop: 3 }}>
                  {viewC.owed > 0 ? <M3Money v={viewC.owed} size={19}/> : <M3Pill label="All paid" tone="green"/>}
                </div>
              </div>
              <M3Round icon="phone" onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Calling...' } })}/>
            </M3Row>
            {invsFor(viewC.id).slice(0, 3).map(inv => (
              <M3Row key={inv.id} style={{ padding: '9px 2px', borderBottom: '1px solid ' + M3.border }}>
                <div style={{ width: 36, height: 36, borderRadius: 13, background: inv.status === 'paid' ? M3.greenSoft : M3.amberSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {M3I('doc', { size: 17, color: inv.status === 'paid' ? M3.green : M3.amber })}
                </div>
                <div style={{ flex: 1, fontFamily: M3.body, fontWeight: 600, fontSize: 13.5, color: M3.ink }}>{inv.id}</div>
                <M3Pill label={inv.status === 'paid' ? 'Paid' : inv.status === 'overdue' ? 'Late' : 'Open'} tone={inv.status === 'paid' ? 'green' : inv.status === 'overdue' ? 'red' : 'amber'}/>
                <M3Money v={inv.amount} size={13.5} weight={600}/>
              </M3Row>
            ))}
            <div style={{ height: 14 }}/>
            <M3Btn label="Send statement" icon="doc" tone="soft" onClick={() => { dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Statement sent' } }); setView(null); }}/>
          </>
        )}
      </M3Sheet>
    </M3Scr>
  );
}

// Insights
function W3Insights({ back }) {
  const { store } = useM3();
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const max = Math.max(...store.week);
  const top = [...store.products].sort((a, b) => b.pop - a.pop).slice(0, 3);
  return (
    <M3Scr hero={<W3SubHero title="Insights" sub="This week" back={back}/>}>
      <M3Card anim pad={18} style={{ marginBottom: 12 }}>
        <M3Row style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 13, color: M3.sub }}>Revenue</div>
          <M3Pill label="+18% vs last week" tone="green"/>
        </M3Row>
        <M3Num v={store.week.reduce((a, b) => a + b, 0)} prefix="$" size={32}/>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 110, marginTop: 16 }}>
          {store.week.map((v, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: '100%', height: (v / max * 84) + 'px', borderRadius: 9,
                background: i === 4 ? M3GRAD : M3ACCSOFT,
                boxShadow: i === 4 ? '0 6px 14px rgba(37,99,235,0.3)' : 'none',
                animation: `m3-rise 500ms ${i * 60}ms both`,
              }}/>
              <span style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 11, color: i === 4 ? 'var(--m3-acc, #2563EB)' : M3.faint }}>{days[i]}</span>
            </div>
          ))}
        </div>
      </M3Card>

      <M3Row gap={12} style={{ marginBottom: 12 }}>
        <M3Card anim pad={16} style={{ flex: 1 }}>
          <M3Num v={97} suffix="%" size={27} color={M3.green}/>
          <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12.5, color: M3.sub, marginTop: 4 }}>on time</div>
        </M3Card>
        <M3Card anim pad={16} style={{ flex: 1 }}>
          <M3Num v={286} prefix="$" size={27}/>
          <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12.5, color: M3.sub, marginTop: 4 }}>avg drop</div>
        </M3Card>
        <M3Card anim pad={16} style={{ flex: 1 }}>
          <M3Num v={31} size={27}/>
          <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12.5, color: M3.sub, marginTop: 4 }}>orders</div>
        </M3Card>
      </M3Row>

      <M3Section label="Top sellers"/>
      {top.map((p, i) => (
        <M3Card key={p.id} pad={12} anim delay={i * 60} style={{ marginBottom: 9 }}>
          <M3Row>
            <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 17, color: M3.faint, width: 20 }}>{i + 1}</span>
            <M3Tile p={p} height={46} glyphSize={26} radius={15} style={{ width: 46, flexShrink: 0 }}/>
            <div style={{ flex: 1, fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.ink }}>{p.name}</div>
            <span style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 13, color: M3.sub }}>{p.pop} orders</span>
          </M3Row>
        </M3Card>
      ))}
    </M3Scr>
  );
}

// Drivers
function W3Drivers({ back }) {
  const { store } = useM3();
  const running = store.route.status === 'running' || store.route.status === 'sent';
  const drivers = [
    { name: 'Tom', hue: 212, runs: 142, rate: 98, active: running && store.route.driver === 'Tom' },
    { name: 'Sara', hue: 330, runs: 118, rate: 97, active: running && store.route.driver === 'Sara' },
  ];
  return (
    <M3Scr hero={<W3SubHero title="Drivers" sub="Your team" back={back}/>}>
      {drivers.map((d, i) => (
        <M3Card key={d.name} anim delay={i * 70} pad={16} style={{ marginBottom: 12 }}>
          <M3Row style={{ marginBottom: 14 }}>
            <M3Avatar name={d.name} hue={d.hue} size={52}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 17.5, color: M3.ink }}>{d.name}</div>
              <div style={{ fontSize: 12.5, color: M3.sub, fontWeight: 600 }}>{d.active ? 'On a run now' : 'Off the road'}</div>
            </div>
            <M3Pill label={d.active ? 'Driving' : 'Free'} tone={d.active ? 'green' : 'gray'}/>
          </M3Row>
          <M3Row gap={10}>
            <div style={{ flex: 1, background: M3.paper, borderRadius: 16, padding: '11px 12px', textAlign: 'center' }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 19, color: M3.ink }}>{d.runs}</div>
              <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 11.5, color: M3.sub }}>runs</div>
            </div>
            <div style={{ flex: 1, background: M3.paper, borderRadius: 16, padding: '11px 12px', textAlign: 'center' }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 19, color: M3.green }}>{d.rate}%</div>
              <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 11.5, color: M3.sub }}>on time</div>
            </div>
            <div style={{ flex: 1, background: M3.paper, borderRadius: 16, padding: '11px 12px', textAlign: 'center' }}>
              <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 19, color: M3.ink }}>4.9</div>
              <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 11.5, color: M3.sub }}>rating</div>
            </div>
          </M3Row>
        </M3Card>
      ))}
    </M3Scr>
  );
}

Object.assign(window, { W3App });
