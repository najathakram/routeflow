// m3-driver.jsx — Driver app (Tom): full dark mode, one flow, huge buttons

function D3App() {
  const { store } = useM3();
  const stops = store.orders.filter(o => ['routed', 'delivered'].includes(o.status));
  const st = store.route.status;
  return (
    <>
      {st === 'draft' && <D3Waiting/>}
      {st === 'sent' && <D3Start stops={stops}/>}
      {st === 'running' && <D3Run stops={stops}/>}
      {st === 'done' && <D3Done stops={stops}/>}
    </>
  );
}

function D3Scr({ children, pad = '70px 18px 40px' }) {
  return (
    <div className="m3-scroll" style={{
      position: 'absolute', inset: 0, overflowY: 'auto',
      background: `linear-gradient(175deg, ${M3.canvas} 0%, #0A1424 100%)`,
      padding: pad, boxSizing: 'border-box', fontFamily: M3.body,
    }}>{children}</div>
  );
}

function D3Card({ children, pad = 18, style, anim, onClick }) {
  return (
    <div className={onClick ? 'm3-press' : ''} onClick={onClick} style={{
      background: 'rgba(255,255,255,0.055)', borderRadius: M3RAD, padding: pad,
      border: '1px solid rgba(255,255,255,0.1)',
      animation: anim ? 'm3-rise 380ms both' : 'none',
      ...style,
    }}>{children}</div>
  );
}

function D3Hdr({ sub, title, right }) {
  return (
    <M3Row style={{ justifyContent: 'space-between', marginBottom: 18, padding: '0 4px' }}>
      <div>
        <div style={{ fontFamily: M3.body, fontSize: 13.5, fontWeight: 600, color: M3.wsub }}>{sub}</div>
        <div style={{ fontFamily: M3.disp, fontSize: 27, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em', marginTop: 2 }}>{title}</div>
      </div>
      {right}
    </M3Row>
  );
}

function D3Stat({ n, label }) {
  return (
    <div style={{ flex: 1, background: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, padding: '13px 10px', textAlign: 'center' }}>
      <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 23, color: '#fff', letterSpacing: '-0.02em' }}>{n}</div>
      <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 11.5, color: M3.wsub, marginTop: 3 }}>{label}</div>
    </div>
  );
}

// Waiting
function D3Waiting() {
  return (
    <D3Scr>
      <D3Hdr sub="Friday, Jul 4" title="Hi Tom"/>
      <D3Card anim pad={22}>
        <M3Empty dark icon="truck" title="No run yet" sub="Sam is still building the route"/>
      </D3Card>
      <div style={{ textAlign: 'center', fontFamily: M3.body, fontSize: 12.5, fontWeight: 600, color: M3.wfaint, marginTop: 16 }}>
        Tip: switch to Wholesaler and send the route
      </div>
    </D3Scr>
  );
}

// Start
function D3Start({ stops }) {
  const { store, dispatch } = useM3();
  const cust = (id) => store.customers.find(c => c.id === id);
  const items = stops.reduce((s, o) => s + o.items.reduce((x, it) => x + it.qty, 0), 0);
  return (
    <D3Scr>
      <D3Hdr sub="Friday, Jul 4" title="Your run" right={<M3Pill dark label="Ready" tone="green"/>}/>
      <M3Row gap={10} style={{ marginBottom: 14 }}>
        <D3Stat n={stops.length} label="stops"/>
        <D3Stat n={items} label="items"/>
        <D3Stat n="14" label="km"/>
      </M3Row>
      <D3Card anim pad={16} style={{ marginBottom: 16 }}>
        {stops.map((o, i) => (
          <M3Row key={o.id} style={{ padding: '9px 2px', borderBottom: i < stops.length - 1 ? '1px solid rgba(255,255,255,0.07)' : 'none' }}>
            <div style={{ width: 30, height: 30, borderRadius: 15, background: 'rgba(143,186,251,0.16)', color: '#8FBAFB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: M3.disp, fontWeight: 700, fontSize: 13.5, flexShrink: 0 }}>{i + 1}</div>
            <div style={{ flex: 1, fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: '#fff' }}>{cust(o.custId).name}</div>
            <span style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 12, color: M3.wfaint }}>{cust(o.custId).addr}</span>
          </M3Row>
        ))}
      </D3Card>
      <M3Btn label="Start run" icon="truck" tone="green" h={64} fs={18} onClick={() => dispatch({ type: 'START_RUN' })}/>
    </D3Scr>
  );
}

// Active run
function D3Run({ stops }) {
  const { store, dispatch } = useM3();
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
    <D3Scr>
      {/* progress header */}
      <M3Row style={{ justifyContent: 'space-between', marginBottom: 16, padding: '0 4px' }}>
        <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 24, color: '#fff', letterSpacing: '-0.02em' }}>
          Stop {doneN + 1} of {stops.length}
        </div>
        <M3Row gap={5}>
          {stops.map((o, i) => (
            <div key={i} style={{
              width: i === doneN ? 24 : 9, height: 9, borderRadius: 5,
              background: i < doneN ? M3.green : i === doneN ? '#8FBAFB' : 'rgba(255,255,255,0.14)',
              transition: 'all 300ms',
            }}/>
          ))}
        </M3Row>
      </M3Row>

      {phase === 'go' && (
        <>
          <D3Card anim pad={20} style={{ marginBottom: 14 }}>
            <M3Row style={{ marginBottom: 14 }}>
              <M3Avatar dark name={cust(cur.custId).name} hue={cust(cur.custId).hue} size={54}/>
              <div>
                <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 21, color: '#fff', letterSpacing: '-0.01em' }}>{cust(cur.custId).name}</div>
                <div style={{ fontSize: 14, color: M3.wsub, fontWeight: 600, marginTop: 2 }}>{cust(cur.custId).addr}</div>
              </div>
            </M3Row>
            <D3Map/>
            <M3Row gap={9} style={{ marginTop: 14 }}>
              <M3Btn label="Navigate" icon="map" tone="glass" h={50} fs={14.5} style={{ flex: 1 }} onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Opening maps' } })}/>
              <M3Btn label="Call" icon="phone" tone="glass" h={50} fs={14.5} style={{ flex: 1 }} onClick={() => dispatch({ type: 'TOAST', toast: { kind: 'ok', msg: 'Calling...' } })}/>
            </M3Row>
          </D3Card>
          <M3Btn label="I have arrived" icon="check" tone="green" h={64} fs={18} onClick={() => dispatch({ type: 'ARRIVE' })}/>
          {pending.length > 1 && (
            <div style={{ textAlign: 'center', fontFamily: M3.body, fontSize: 13, fontWeight: 600, color: M3.wfaint, marginTop: 15 }}>
              Next: {cust(pending[1].custId).name}
            </div>
          )}
        </>
      )}

      {phase === 'checklist' && (
        <>
          <D3Card anim pad={16} style={{ marginBottom: 13 }}>
            <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 16, color: '#fff', marginBottom: 12 }}>Hand over</div>
            {cur.items.map((it, i) => {
              const p = store.products.find(p => p.id === it.pid);
              const on = !!checked[i];
              return (
                <div key={i} className="m3-press" onClick={() => setChecked(c => ({ ...c, [i]: !c[i] }))} style={{
                  display: 'flex', alignItems: 'center', gap: 13,
                  padding: '13px 13px', marginBottom: 8, borderRadius: 18,
                  background: on ? 'rgba(23,163,74,0.15)' : 'rgba(255,255,255,0.05)',
                  border: '1.5px solid ' + (on ? 'rgba(23,163,74,0.55)' : 'rgba(255,255,255,0.1)'),
                  transition: 'all 150ms',
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 16, flexShrink: 0,
                    background: on ? M3.green : 'transparent',
                    border: on ? 'none' : '2.5px solid rgba(255,255,255,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{on && M3I('check', { size: 16, color: '#fff', sw: 3.5 })}</div>
                  <M3Glyph name={p.glyph} size={25} color={on ? '#6EE7A0' : '#8FBAFB'}/>
                  <div style={{ flex: 1, fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: '#fff' }}>{p.name}</div>
                  <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 14.5, color: M3.wsub }}>× {it.qty}</span>
                </div>
              );
            })}
          </D3Card>

          {allChecked && (
            <D3Card anim pad={15} style={{ marginBottom: 13 }}>
              <M3Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 15.5, color: '#fff' }}>Sign here</span>
                {sig.length > 0 && <span className="m3-press" onClick={() => setSig([])} style={{ fontFamily: M3.body, fontWeight: 700, fontSize: 13, color: '#8FBAFB' }}>Clear</span>}
              </M3Row>
              <svg
                ref={svgRef}
                width="100%" height="128"
                style={{ background: 'rgba(255,255,255,0.92)', borderRadius: 16, touchAction: 'none', display: 'block' }}
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
                  <text x="50%" y="52%" textAnchor="middle" fill="#9AA7B8" fontFamily={M3.body} fontSize="13.5" fontWeight="600">draw with your finger</text>
                )}
                {sig.map((stroke, i) => (
                  <polyline key={i} points={stroke.map(p => p.join(',')).join(' ')} fill="none" stroke={M3.ink} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
                ))}
              </svg>
            </D3Card>
          )}

          <M3Btn label="Done, next stop" icon="check" tone="green" h={64} fs={18} disabled={!allChecked || sig.length === 0} onClick={() => dispatch({ type: 'COMPLETE_STOP' })}/>
          {!allChecked && (
            <div style={{ textAlign: 'center', fontFamily: M3.body, fontSize: 13, fontWeight: 600, color: M3.wfaint, marginTop: 14 }}>
              Tap each item as you hand it over
            </div>
          )}
        </>
      )}
    </D3Scr>
  );
}

function D3Map() {
  return (
    <svg width="100%" height="92" viewBox="0 0 330 92" style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 16, display: 'block' }}>
      <path d="M 0 30 Q 90 22 170 40 T 330 34" stroke="rgba(255,255,255,0.1)" strokeWidth="7" fill="none"/>
      <path d="M 0 68 Q 120 78 330 62" stroke="rgba(255,255,255,0.1)" strokeWidth="5" fill="none"/>
      <path d="M 96 0 L 90 92 M 218 0 224 92" stroke="rgba(255,255,255,0.08)" strokeWidth="4"/>
      <path d="M 30 64 Q 110 52 170 40 Q 240 30 292 38" stroke="#8FBAFB" strokeWidth="4.5" fill="none" strokeDasharray="9 7" strokeLinecap="round"/>
      <circle cx="30" cy="64" r="9" fill="#fff"/>
      <g transform="translate(292, 38)">
        <circle r="13" fill="#2563EB"/>
        <circle r="4.5" fill="#fff"/>
        <circle r="18" fill="none" stroke="#2563EB" strokeWidth="2" opacity="0.4">
          <animate attributeName="r" values="13;22" dur="1.6s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.5;0" dur="1.6s" repeatCount="indefinite"/>
        </circle>
      </g>
    </svg>
  );
}

// Done
function D3Done({ stops }) {
  const { dispatch } = useM3();
  return (
    <D3Scr>
      <div style={{ textAlign: 'center', paddingTop: 56 }}>
        <div style={{
          width: 124, height: 124, borderRadius: 46,
          background: 'rgba(23,163,74,0.15)', border: '1px solid rgba(23,163,74,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px',
          animation: 'm3-pop 500ms both',
        }}>
          <div style={{ width: 78, height: 78, borderRadius: 39, background: M3.green, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 16px 40px rgba(23,163,74,0.5)' }}>
            {M3I('check', { size: 42, color: '#fff', sw: 3 })}
          </div>
        </div>
        <div style={{ fontFamily: M3.disp, fontWeight: 700, fontSize: 33, color: '#fff', letterSpacing: '-0.03em' }}>
          {stops.length} of {stops.length} delivered
        </div>
        <div style={{ fontFamily: M3.body, fontWeight: 600, fontSize: 15.5, color: M3.wsub, marginTop: 8 }}>
          Nice driving, Tom
        </div>
        <M3Row gap={10} style={{ marginTop: 34 }}>
          <D3Stat n={stops.length} label="stops"/>
          <D3Stat n="14" label="km"/>
          <D3Stat n="2h 04" label="time"/>
        </M3Row>
        <div style={{ height: 28 }}/>
        <M3Btn label="Start a new day" icon="repeat" tone="glass" onClick={() => dispatch({ type: 'RESET_DAY' })}/>
      </div>
    </D3Scr>
  );
}

Object.assign(window, { D3App });
