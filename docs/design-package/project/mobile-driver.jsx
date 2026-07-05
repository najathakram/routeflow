// mobile-driver.jsx — Driver app (Tom): one flow, zero clutter

function DrApp() {
  const { store } = useStore();
  const stops = store.orders.filter(o => ['routed', 'delivered'].includes(o.status));
  const status = store.route.status; // draft | sent | running | done

  return (
    <>
      {status === 'draft' && <DrWaiting/>}
      {status === 'sent' && <DrStart stops={stops}/>}
      {status === 'running' && <DrRun stops={stops}/>}
      {status === 'done' && <DrDone stops={stops}/>}
    </>
  );
}

function DrHdr({ sub, title }) {
  return <Hdr sub={sub} title={title}/>;
}

// ── Waiting: no route yet ──
function DrWaiting() {
  return (
    <Scr pad="74px 16px 40px">
      <DrHdr sub="Friday, Jul 4" title="Hi Tom"/>
      <Card pad={20}>
        <EmptyState icon="truck" title="No run yet" sub="Sam is still building today's route"/>
      </Card>
      <div style={{ textAlign: 'center', fontFamily: RFM.font, fontSize: 13, fontWeight: 600, color: RFM.faint, marginTop: 16 }}>
        Tip: switch to Wholesaler and send the route
      </div>
    </Scr>
  );
}

// ── Start screen ──
function DrStart({ stops }) {
  const { store, dispatch } = useStore();
  const cust = (id) => store.customers.find(c => c.id === id);
  const items = stops.reduce((s, o) => s + o.items.reduce((x, it) => x + it.qty, 0), 0);
  return (
    <Scr pad="74px 16px 40px">
      <DrHdr sub="Friday, Jul 4" title="Your run"/>
      <Card pad={20} anim style={{ marginBottom: 14 }}>
        <Row gap={10} style={{ marginBottom: 16 }}>
          <StatChip n={stops.length} label="stops"/>
          <StatChip n={items} label="items"/>
          <StatChip n="14" label="km"/>
        </Row>
        <div style={{ borderTop: '1px solid ' + RFM.line, paddingTop: 14 }}>
          {stops.map((o, i) => (
            <Row key={o.id} style={{ padding: '8px 0' }}>
              <div style={{ width: 30, height: 30, borderRadius: 15, background: ACC_SOFT, color: 'var(--rfm-acc, #2563EB)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: RFM.font, fontWeight: 800, fontSize: 13.5 }}>{i + 1}</div>
              <div style={{ flex: 1, fontFamily: RFM.font, fontWeight: 700, fontSize: 14.5, color: RFM.ink }}>{cust(o.custId).name}</div>
              <div style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 12.5, color: RFM.faint }}>{cust(o.custId).addr}</div>
            </Row>
          ))}
        </div>
      </Card>
      <BigBtn label="Start run" icon="truck" tone="green" style={{ height: 66 }} onClick={() => dispatch({ type: 'START_RUN' })}/>
    </Scr>
  );
}

function StatChip({ n, label }) {
  return (
    <div style={{ flex: 1, background: '#F4F7FB', borderRadius: 16, padding: '12px 10px', textAlign: 'center' }}>
      <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 24, color: RFM.ink, letterSpacing: '-0.02em' }}>{n}</div>
      <div style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 12, color: RFM.sub }}>{label}</div>
    </div>
  );
}

// ── Active run ──
function DrRun({ stops }) {
  const { store, dispatch } = useStore();
  const cust = (id) => store.customers.find(c => c.id === id);
  const pending = stops.filter(o => o.status === 'routed');
  const cur = pending[0];
  const doneN = stops.length - pending.length;
  const [checked, setChecked] = React.useState({});
  const [sig, setSig] = React.useState([]);
  const drawing = React.useRef(false);
  const svgRef = React.useRef(null);

  React.useEffect(() => { setChecked({}); setSig([]); }, [cur ? cur.id : '']);
  if (!cur) return null;

  const allChecked = cur.items.every((_, i) => checked[i]);
  const phase = store.runPhase;

  const pt = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return [Math.round(t.clientX - r.left), Math.round(t.clientY - r.top)];
  };

  return (
    <Scr pad="74px 16px 40px">
      {/* Progress header */}
      <Row style={{ justifyContent: 'space-between', marginBottom: 14, padding: '0 4px' }}>
        <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 24, color: RFM.ink, letterSpacing: '-0.02em' }}>
          Stop {doneN + 1} of {stops.length}
        </div>
        <Row gap={5}>
          {stops.map((o, i) => (
            <div key={i} style={{
              width: i === doneN ? 22 : 9, height: 9, borderRadius: 5,
              background: i < doneN ? RFM.green : i === doneN ? 'var(--rfm-acc, #2563EB)' : '#D5DEEA',
              transition: 'all 300ms',
            }}/>
          ))}
        </Row>
      </Row>

      {phase === 'go' && (
        <>
          <Card pad={20} anim style={{ marginBottom: 14 }}>
            <Row style={{ marginBottom: 14 }}>
              <Avatar name={cust(cur.custId).name} hue={cust(cur.custId).hue} size={54}/>
              <div>
                <div style={{ fontWeight: 800, fontSize: 20, color: RFM.ink, letterSpacing: '-0.01em' }}>{cust(cur.custId).name}</div>
                <div style={{ fontSize: 14.5, color: RFM.sub, fontWeight: 700, marginTop: 2 }}>{cust(cur.custId).addr}</div>
              </div>
            </Row>
            <MiniMapCard/>
            <Row gap={10} style={{ marginTop: 14 }}>
              <BigBtn label="Navigate" icon="map" tone="ghost" style={{ flex: 1, height: 54 }} onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Opening maps' } })}/>
              <BigBtn label="Call" icon="phone" tone="ghost" style={{ flex: 1, height: 54 }} onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Calling...' } })}/>
            </Row>
          </Card>
          <BigBtn label="I have arrived" icon="check" tone="green" style={{ height: 66 }} onClick={() => dispatch({ type: 'ARRIVE' })}/>
          {pending.length > 1 && (
            <div style={{ textAlign: 'center', fontFamily: RFM.font, fontSize: 13.5, fontWeight: 700, color: RFM.faint, marginTop: 16 }}>
              Next: {cust(pending[1].custId).name}
            </div>
          )}
        </>
      )}

      {phase === 'checklist' && (
        <>
          <Card pad={18} anim style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 16.5, color: RFM.ink, marginBottom: 12 }}>Hand over</div>
            {cur.items.map((it, i) => {
              const p = store.products.find(p => p.id === it.pid);
              const on = !!checked[i];
              return (
                <div key={i} className="rfm-press" onClick={() => setChecked({ ...checked, [i]: !on })} style={{
                  display: 'flex', alignItems: 'center', gap: 13,
                  padding: '13px 12px', marginBottom: 8, borderRadius: 16,
                  background: on ? RFM.greenSoft : '#F4F7FB',
                  border: '2px solid ' + (on ? RFM.green : 'transparent'),
                  transition: 'all 150ms',
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 16, flexShrink: 0,
                    background: on ? RFM.green : '#fff',
                    border: on ? 'none' : '2.5px solid #C9D4E2',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{on && I('check', { size: 17, color: '#fff', sw: 3.5 })}</div>
                  <Glyph name={p.glyph} size={26} color={on ? RFM.green : 'var(--rfm-acc, #2563EB)'}/>
                  <div style={{ flex: 1, fontFamily: RFM.font, fontWeight: 800, fontSize: 15, color: RFM.ink }}>{p.name}</div>
                  <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 15, color: RFM.sub }}>× {it.qty}</div>
                </div>
              );
            })}
          </Card>

          {allChecked && (
            <Card pad={16} anim style={{ marginBottom: 14 }}>
              <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 16, color: RFM.ink }}>Sign here</div>
                {sig.length > 0 && <div className="rfm-press" onClick={() => setSig([])} style={{ fontFamily: RFM.font, fontWeight: 700, fontSize: 13.5, color: 'var(--rfm-acc, #2563EB)' }}>Clear</div>}
              </Row>
              <svg
                ref={svgRef}
                width="100%" height="130"
                style={{ background: '#F4F7FB', borderRadius: 14, touchAction: 'none', display: 'block' }}
                onPointerDown={(e) => {
                  try { svgRef.current.setPointerCapture(e.pointerId); } catch {}
                  const p = pt(e);
                  setSig(s => [...s, [p]]);
                  drawing.current = true;
                }}
                onPointerMove={(e) => {
                  if (!drawing.current) return;
                  const p = pt(e);
                  setSig(s => {
                    if (!s.length) return s;
                    const n = s.slice();
                    n[n.length - 1] = [...n[n.length - 1], p];
                    return n;
                  });
                }}
                onPointerUp={() => { drawing.current = false; }}
                onPointerCancel={() => { drawing.current = false; }}
              >
                {sig.length === 0 && (
                  <text x="50%" y="50%" textAnchor="middle" fill="#B9C5D6" fontFamily={RFM.font} fontSize="14" fontWeight="700">draw with your finger</text>
                )}
                {sig.map((stroke, i) => (
                  <polyline key={i} points={stroke.map(p => p.join(',')).join(' ')} fill="none" stroke={RFM.ink} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
                ))}
              </svg>
            </Card>
          )}

          <BigBtn label="Done, next stop" icon="check" tone="green" style={{ height: 66 }} disabled={!allChecked || sig.length === 0} onClick={() => dispatch({ type: 'COMPLETE_STOP' })}/>
          {!allChecked && (
            <div style={{ textAlign: 'center', fontFamily: RFM.font, fontSize: 13.5, fontWeight: 700, color: RFM.faint, marginTop: 14 }}>
              Tap each item as you hand it over
            </div>
          )}
        </>
      )}
    </Scr>
  );
}

function MiniMapCard() {
  return (
    <svg width="100%" height="90" viewBox="0 0 330 90" style={{ background: '#F4F7FB', borderRadius: 14, display: 'block' }}>
      <path d="M 0 30 Q 90 22 170 40 T 330 34" stroke="#DDE5EF" strokeWidth="7" fill="none"/>
      <path d="M 0 66 Q 120 76 330 60" stroke="#DDE5EF" strokeWidth="5" fill="none"/>
      <path d="M 96 0 L 90 90 M 218 0 224 90" stroke="#DDE5EF" strokeWidth="4"/>
      <path d="M 30 62 Q 110 50 170 40 Q 240 30 292 36" stroke="var(--rfm-acc, #2563EB)" strokeWidth="4.5" fill="none" strokeDasharray="9 7" strokeLinecap="round"/>
      <circle cx="30" cy="62" r="9" fill="#16324F"/>
      <g transform="translate(292, 36)">
        <circle r="13" fill="var(--rfm-acc, #2563EB)"/>
        <circle r="4.5" fill="#fff"/>
      </g>
    </svg>
  );
}

// ── Done ──
function DrDone({ stops }) {
  const { dispatch } = useStore();
  return (
    <Scr pad="74px 16px 40px">
      <div style={{ textAlign: 'center', paddingTop: 60 }}>
        <div style={{
          width: 120, height: 120, borderRadius: 44, background: RFM.greenSoft,
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px',
          animation: 'rfm-pop 500ms both',
        }}>
          <div style={{ width: 76, height: 76, borderRadius: 38, background: RFM.green, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 14px 34px rgba(24,154,74,0.4)' }}>
            {I('check', { size: 40, color: '#fff', sw: 3 })}
          </div>
        </div>
        <div style={{ fontFamily: RFM.font, fontWeight: 800, fontSize: 32, color: RFM.ink, letterSpacing: '-0.03em' }}>
          {stops.length} of {stops.length} delivered
        </div>
        <div style={{ fontFamily: RFM.font, fontWeight: 600, fontSize: 16, color: RFM.sub, marginTop: 8 }}>
          Nice driving, Tom
        </div>
        <Row gap={10} style={{ marginTop: 36, justifyContent: 'center' }}>
          <StatChip n={stops.length} label="stops"/>
          <StatChip n="14" label="km"/>
          <StatChip n="2h 04" label="time"/>
        </Row>
        <div style={{ height: 30 }}/>
        <BigBtn label="Start a new day" icon="repeat" tone="ghost" onClick={() => dispatch({ type: 'RESET_DAY' })}/>
      </div>
    </Scr>
  );
}

Object.assign(window, { DrApp });
