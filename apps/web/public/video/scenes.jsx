// scenes.jsx — RouteFlow marketing video scenes

const NAVY = '#1B3A5C';
const NAVY_80 = 'rgba(27,58,92,0.8)';
const NAVY_40 = 'rgba(27,58,92,0.4)';
const BRAND = '#2563EB';
const BRAND_LIGHT = '#EFF6FF';
const BRAND_DARK = '#1D4ED8';
const CREAM = '#F8FAFC';
const INK = '#0F1F33';
const SUCCESS = '#16A34A';
const SUCCESS_BG = '#F0FDF4';
const WARNING = '#D97706';
const BORDER = '#E2E8F0';

const FONT = "'Inter', -apple-system, 'SF Pro Display', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

// ─── Utility: animated number counter ────────────────────────────────────
function CountUp({ from = 0, to = 100, duration = 1.2, start = 0, suffix = '', prefix = '', decimals = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - start) / duration, 0, 1);
  const eased = Easing.easeOutCubic(t);
  const v = from + (to - from) * eased;
  return <>{prefix}{v.toFixed(decimals)}{suffix}</>;
}

// ─── RouteFlow Logo mark (abstract routing node — 3 dots + path) ─────────
function LogoMark({ size = 80, color = BRAND }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <path d="M16 20 Q 40 20 40 40 Q 40 60 64 60" stroke={color} strokeWidth="4" strokeLinecap="round" fill="none"/>
      <circle cx="16" cy="20" r="7" fill={color}/>
      <circle cx="40" cy="40" r="5" fill={color} opacity="0.7"/>
      <circle cx="64" cy="60" r="7" fill={color}/>
    </svg>
  );
}

function Logotype({ size = 56, color = NAVY, mark = BRAND }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.28 }}>
      <LogoMark size={size * 1.05} color={mark} />
      <div style={{
        fontFamily: FONT, fontWeight: 700, fontSize: size,
        color, letterSpacing: '-0.03em', lineHeight: 1,
      }}>
        RouteFlow
      </div>
    </div>
  );
}

// ─── SCENE 1: Hook — the chaos ──────────────────────────────────────────
function SceneChaos() {
  const { localTime, duration } = useSprite();
  // Build of papers, alerts, question marks
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#F1F2F4', overflow: 'hidden' }}>
      {/* Soft radial vignette */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,0.15) 100%)',
      }}/>

      {/* Desk clutter: scattered papers, clipboards, phone */}
      <ClutterItem delay={0.0} x={180} y={140} rot={-8} w={220} h={280} label="ORDER #1042" tint="#fff"/>
      <ClutterItem delay={0.1} x={420} y={180} rot={5} w={240} h={300} label="INVOICE" tint="#fffef0"/>
      <ClutterItem delay={0.2} x={700} y={110} rot={-3} w={260} h={320} label="ROUTE LIST" tint="#fff"/>
      <ClutterItem delay={0.3} x={1020} y={200} rot={7} w={230} h={290} label="STOCK" tint="#fff"/>
      <ClutterItem delay={0.4} x={1340} y={150} rot={-6} w={240} h={310} label="RETURNS" tint="#fffaf0"/>
      <ClutterItem delay={0.5} x={260} y={560} rot={4} w={260} h={280} label="LEDGER" tint="#fff"/>
      <ClutterItem delay={0.6} x={580} y={620} rot={-5} w={280} h={260} label="DRIVER NOTES" tint="#fffef0"/>
      <ClutterItem delay={0.7} x={920} y={600} rot={8} w={260} h={290} label="CREDIT NOTE" tint="#fff"/>
      <ClutterItem delay={0.8} x={1240} y={580} rot={-4} w={270} h={310} label="STATEMENT" tint="#fff"/>

      {/* Red alert badges */}
      <AlertPing delay={1.4} x={340} y={320} />
      <AlertPing delay={1.7} x={820} y={240} />
      <AlertPing delay={2.0} x={1180} y={360} />
      <AlertPing delay={2.3} x={680} y={720} />
      <AlertPing delay={2.6} x={1360} y={680} />

      {/* Headline overlay */}
      <HeadlineOverlay localTime={localTime} />
    </div>
  );
}

function ClutterItem({ delay, x, y, rot, w, h, label, tint }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.45, 0, 1);
  const eased = Easing.easeOutBack(t);
  const opacity = clamp(t * 2, 0, 1);
  return (
    <div style={{
      position: 'absolute', left: x, top: y,
      width: w, height: h,
      background: tint,
      border: '1px solid #d8dbe0',
      borderRadius: 4,
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      transform: `rotate(${rot}deg) scale(${0.8 + 0.2 * eased})`,
      transformOrigin: 'center',
      opacity,
      padding: 20,
      fontFamily: MONO,
      fontSize: 13,
      color: '#6b6458',
      letterSpacing: '0.08em',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 14, color: '#444' }}>{label}</div>
      {/* fake lines */}
      {[0, 1, 2, 3, 4, 5, 6].map(i => (
        <div key={i} style={{
          height: 6, marginBottom: 12,
          background: '#e5e7eb',
          width: `${60 + ((i * 13) % 40)}%`,
          borderRadius: 2,
        }}/>
      ))}
    </div>
  );
}

function AlertPing({ delay, x, y }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.4, 0, 1);
  const scale = Easing.easeOutBack(t);
  const pulse = 1 + 0.15 * Math.sin(localTime * 6);
  return (
    <div style={{
      position: 'absolute', left: x, top: y,
      width: 56, height: 56,
      borderRadius: '50%',
      background: '#DC2626',
      color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONT, fontWeight: 800, fontSize: 30,
      boxShadow: '0 4px 16px rgba(220,38,38,0.5)',
      transform: `scale(${scale * pulse})`,
      opacity: t,
    }}>!</div>
  );
}

function HeadlineOverlay({ localTime }) {
  const show1 = localTime > 3.0;
  const show2 = localTime > 4.2;
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{
        padding: '48px 80px',
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(8px)',
        borderRadius: 24,
        boxShadow: '0 24px 80px rgba(0,0,0,0.2)',
        opacity: clamp((localTime - 2.8) / 0.5, 0, 1),
        transform: `scale(${0.9 + 0.1 * clamp((localTime - 2.8) / 0.5, 0, 1)})`,
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: FONT, fontSize: 84, fontWeight: 700,
          color: NAVY, letterSpacing: '-0.03em', lineHeight: 1.05,
          opacity: show1 ? 1 : 0,
          transition: 'opacity 400ms',
        }}>
          Running a wholesale<br/>business is chaos.
        </div>
        <div style={{
          fontFamily: FONT, fontSize: 34, fontWeight: 500,
          color: NAVY_80, marginTop: 28,
          opacity: show2 ? 1 : 0,
          transform: `translateY(${show2 ? 0 : 12}px)`,
          transition: 'opacity 400ms, transform 400ms',
        }}>
          Paper. Phone calls. Spreadsheets. Missed deliveries.
        </div>
      </div>
    </div>
  );
}

// ─── SCENE 2: Logo reveal ────────────────────────────────────────────────
function SceneLogo() {
  const { localTime, duration } = useSprite();
  // Papers fly off / fade to white, then logo assembles
  const bgT = clamp(localTime / 0.6, 0, 1);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, #fff ${bgT * 100}%, #F1F2F4 ${bgT * 100}%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column',
    }}>
      {/* Animated route path that draws in */}
      <svg width="1400" height="260" viewBox="0 0 1400 260" style={{ position: 'absolute', top: 150 }}>
        <defs>
          <linearGradient id="routeGrad" x1="0" x2="1">
            <stop offset="0%" stopColor={BRAND} stopOpacity="0"/>
            <stop offset="50%" stopColor={BRAND} stopOpacity="1"/>
            <stop offset="100%" stopColor={BRAND} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <path
          d="M 40 180 Q 200 40 380 140 T 720 130 T 1060 160 T 1360 80"
          stroke={BRAND}
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
          strokeDasharray="2000"
          strokeDashoffset={2000 - Math.min(2000, localTime * 800)}
          opacity={clamp(localTime / 0.4, 0, 1)}
        />
        {/* Pin dots along the path */}
        {[[40,180], [380,140], [720,130], [1060,160], [1360,80]].map(([cx, cy], i) => {
          const appear = clamp((localTime - 0.4 - i * 0.15) / 0.3, 0, 1);
          return (
            <circle key={i} cx={cx} cy={cy} r={14 * appear} fill={BRAND} opacity={appear} />
          );
        })}
      </svg>

      {/* Logo scales in with slight bounce */}
      <div style={{
        opacity: clamp((localTime - 1.2) / 0.5, 0, 1),
        transform: `scale(${0.85 + 0.15 * Easing.easeOutBack(clamp((localTime - 1.2) / 0.6, 0, 1))})`,
        marginBottom: 40,
      }}>
        <Logotype size={140} color={NAVY} mark={BRAND} />
      </div>

      {/* Tagline */}
      <div style={{
        fontFamily: FONT, fontSize: 44, fontWeight: 500,
        color: NAVY_80, letterSpacing: '-0.01em',
        marginTop: 260,
        opacity: clamp((localTime - 2.2) / 0.6, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 2.2) / 0.6, 0, 1)) * 20}px)`,
        textAlign: 'center',
      }}>
        Delivery operations,<br/>
        <span style={{ color: BRAND, fontWeight: 700 }}>simplified.</span>
      </div>
    </div>
  );
}

// ─── SCENE 3: The pitch — one platform ──────────────────────────────────
function ScenePitch() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: '#fff',
      padding: '80px 100px',
    }}>
      <div style={{
        fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em',
        color: BRAND, fontWeight: 600, textTransform: 'uppercase',
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>Built for</div>
      <div style={{
        fontFamily: FONT, fontSize: 96, fontWeight: 700,
        color: NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
        marginTop: 24,
        opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 0.3) / 0.5, 0, 1)) * 20}px)`,
      }}>
        Wholesalers & Jobbers
      </div>
      <div style={{
        fontFamily: FONT, fontSize: 36, fontWeight: 400, lineHeight: 1.4,
        color: NAVY_80, marginTop: 40, maxWidth: 1400,
        opacity: clamp((localTime - 0.9) / 0.5, 0, 1),
      }}>
        One platform that connects your orders, routes, drivers, invoices,
        and customers. From the warehouse to the doorstep.
      </div>

      {/* Three pillars */}
      <div style={{
        position: 'absolute', left: 100, right: 100, bottom: 120,
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 32,
      }}>
        {[
          { t: 'OPERATOR', label: 'Dashboard', sub: 'Dispatch • Orders • Invoicing' },
          { t: 'DRIVER', label: 'Mobile App', sub: 'Route runs • POD • Scanning' },
          { t: 'CUSTOMER', label: 'Self-Service Portal', sub: 'Orders • Invoices • Returns' },
        ].map((p, i) => {
          const show = clamp((localTime - 1.6 - i * 0.18) / 0.5, 0, 1);
          return (
            <div key={i} style={{
              padding: 40,
              background: CREAM,
              border: `1px solid ${BORDER}`,
              borderRadius: 20,
              opacity: show,
              transform: `translateY(${(1 - show) * 20}px)`,
            }}>
              <div style={{
                fontFamily: MONO, fontSize: 14, letterSpacing: '0.18em',
                color: BRAND, fontWeight: 600,
              }}>{p.t}</div>
              <div style={{
                fontFamily: FONT, fontSize: 44, fontWeight: 700,
                color: NAVY, marginTop: 14, letterSpacing: '-0.02em',
              }}>{p.label}</div>
              <div style={{
                fontFamily: FONT, fontSize: 22, color: NAVY_80, marginTop: 10,
              }}>{p.sub}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SCENE 4: Operator dashboard ────────────────────────────────────────
function SceneOperator() {
  const { localTime, duration } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(135deg, ${NAVY} 0%, #0F2544 100%)`,
      overflow: 'hidden',
    }}>
      {/* Grid lines */}
      <BackgroundGrid />

      {/* Left: copy */}
      <div style={{
        position: 'absolute', left: 100, top: 140, width: 720,
      }}>
        <div style={{
          fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em',
          color: '#7DB6FF', fontWeight: 600, textTransform: 'uppercase',
          opacity: clamp(localTime / 0.3, 0, 1),
        }}>01: In the office</div>
        <div style={{
          fontFamily: FONT, fontSize: 80, fontWeight: 700,
          color: '#fff', letterSpacing: '-0.03em', lineHeight: 1.02,
          marginTop: 24,
          opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
          transform: `translateY(${(1 - clamp((localTime - 0.3) / 0.5, 0, 1)) * 20}px)`,
        }}>
          Orders in.<br/>Routes out.<br/>Invoices done.
        </div>

        <div style={{ marginTop: 60 }}>
          {[
            'Multi-stop route builder with ORS optimization',
            'Auto-invoice the moment a delivery is signed',
            'Recurring orders & weekly standing templates',
            'Returns, credit notes, and customer ledger built right in',
          ].map((f, i) => {
            const show = clamp((localTime - 1.0 - i * 0.3) / 0.4, 0, 1);
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 18,
                fontFamily: FONT, fontSize: 28, fontWeight: 500,
                color: 'rgba(255,255,255,0.92)',
                marginBottom: 22,
                opacity: show,
                transform: `translateX(${(1 - show) * -16}px)`,
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: BRAND, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7l3 3 5-6" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                {f}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: mocked operator app */}
      <OperatorMock localTime={localTime} />
    </div>
  );
}

function BackgroundGrid() {
  return (
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.08 }}>
      <defs>
        <pattern id="bgGrid" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#bgGrid)"/>
    </svg>
  );
}

function OperatorMock({ localTime }) {
  const show = clamp((localTime - 0.5) / 0.6, 0, 1);
  return (
    <div style={{
      position: 'absolute', right: 60, top: 100,
      width: 980, height: 820,
      background: '#fff',
      borderRadius: 20,
      boxShadow: '0 40px 100px rgba(0,0,0,0.45)',
      overflow: 'hidden',
      opacity: show,
      transform: `translateY(${(1 - show) * 24}px) rotate(${(1 - show) * -1.5}deg)`,
      transformOrigin: 'center',
    }}>
      {/* Browser chrome */}
      <div style={{
        height: 44, background: '#F1F5F9',
        borderBottom: `1px solid ${BORDER}`,
        display: 'flex', alignItems: 'center', padding: '0 16px', gap: 8,
      }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#FF5F57' }}/>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#FEBC2E' }}/>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#28C840' }}/>
        <div style={{
          flex: 1, marginLeft: 24, height: 26, borderRadius: 6,
          background: '#fff', border: `1px solid ${BORDER}`,
          display: 'flex', alignItems: 'center', padding: '0 12px',
          fontFamily: MONO, fontSize: 12, color: '#64748B',
        }}>app.routeflow.io/dispatch</div>
      </div>

      {/* App body */}
      <div style={{ display: 'flex', height: 776 }}>
        {/* Sidebar */}
        <div style={{
          width: 220, background: NAVY, padding: '24px 14px', color: '#fff',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', marginBottom: 30 }}>
            <LogoMark size={28} color="#fff" />
            <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 18 }}>RouteFlow</div>
          </div>
          {[
            { label: 'Dashboard', active: false },
            { label: 'Orders', active: true, count: 12 },
            { label: 'Routes', active: false },
            { label: 'Customers', active: false },
            { label: 'Inventory', active: false },
            { label: 'Invoices', active: false },
            { label: 'Returns', active: false },
            { label: 'Reports', active: false },
          ].map((item, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 12px', marginBottom: 4, borderRadius: 8,
              background: item.active ? 'rgba(37,99,235,0.25)' : 'transparent',
              fontFamily: FONT, fontSize: 15, fontWeight: item.active ? 600 : 400,
              color: item.active ? '#fff' : 'rgba(255,255,255,0.75)',
            }}>
              <span>{item.label}</span>
              {item.count && (
                <span style={{
                  background: BRAND, color: '#fff',
                  fontSize: 11, padding: '2px 7px', borderRadius: 10,
                  fontWeight: 600,
                }}>{item.count}</span>
              )}
            </div>
          ))}
        </div>
        {/* Content: order rows */}
        <div style={{ flex: 1, padding: 28, background: '#F8FAFC' }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 20,
          }}>
            <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: NAVY }}>
              Orders: Today
            </div>
            <div style={{
              padding: '8px 16px', background: BRAND, color: '#fff',
              borderRadius: 10, fontFamily: FONT, fontSize: 14, fontWeight: 600,
            }}>+ New Order</div>
          </div>

          {/* Stat row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 22 }}>
            {[
              { k: 'PENDING', v: 8, c: WARNING },
              { k: 'OUT FOR DELIVERY', v: 14, c: BRAND },
              { k: 'DELIVERED', v: 32, c: SUCCESS },
              { k: 'REVENUE', v: '$8.4k', c: NAVY },
            ].map((s, i) => (
              <div key={i} style={{
                flex: 1, padding: '14px 16px',
                background: '#fff', borderRadius: 10, border: `1px solid ${BORDER}`,
              }}>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: '#64748B' }}>{s.k}</div>
                <div style={{ fontFamily: FONT, fontSize: 28, fontWeight: 700, color: s.c, marginTop: 4 }}>
                  {typeof s.v === 'number' ? <CountUp to={s.v} duration={1.2} start={0.9} /> : s.v}
                </div>
              </div>
            ))}
          </div>

          {/* Order rows */}
          {[
            { id: 'ORD-1042', cust: "Harbor Cafe", items: 12, total: '$284.50', status: 'DELIVERED', c: SUCCESS, bg: SUCCESS_BG },
            { id: 'ORD-1043', cust: "Bluestone Grocery", items: 28, total: '$612.00', status: 'OUT', c: BRAND, bg: BRAND_LIGHT },
            { id: 'ORD-1044', cust: "Nordic Deli", items: 7, total: '$148.20', status: 'OUT', c: BRAND, bg: BRAND_LIGHT },
            { id: 'ORD-1045', cust: "Station Street Bar", items: 19, total: '$421.80', status: 'PENDING', c: WARNING, bg: '#FFFBEB' },
            { id: 'ORD-1046', cust: "Maple & Oak", items: 14, total: '$276.00', status: 'PENDING', c: WARNING, bg: '#FFFBEB' },
          ].map((o, i) => {
            const appear = clamp((localTime - 1.3 - i * 0.12) / 0.4, 0, 1);
            return (
              <div key={i} style={{
                display: 'grid',
                gridTemplateColumns: '120px 1fr 80px 100px 130px',
                alignItems: 'center', gap: 16,
                padding: '14px 18px', marginBottom: 8,
                background: '#fff', borderRadius: 10, border: `1px solid ${BORDER}`,
                opacity: appear,
                transform: `translateX(${(1 - appear) * 30}px)`,
              }}>
                <div style={{ fontFamily: MONO, fontSize: 13, color: NAVY_80, fontWeight: 500 }}>{o.id}</div>
                <div style={{ fontFamily: FONT, fontSize: 16, color: NAVY, fontWeight: 600 }}>{o.cust}</div>
                <div style={{ fontFamily: FONT, fontSize: 14, color: '#64748B' }}>{o.items} items</div>
                <div style={{ fontFamily: FONT, fontSize: 16, color: NAVY, fontWeight: 600 }}>{o.total}</div>
                <div style={{
                  fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
                  padding: '5px 10px', borderRadius: 6, background: o.bg, color: o.c,
                  textAlign: 'center',
                }}>{o.status}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── SCENE 5: Route optimization animation ──────────────────────────────
function SceneRoute() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0, background: '#fff',
      padding: '80px 100px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 40,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div>
          <div style={{
            fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em',
            color: BRAND, fontWeight: 600, textTransform: 'uppercase',
          }}>02: Route optimization</div>
          <div style={{
            fontFamily: FONT, fontSize: 76, fontWeight: 700,
            color: NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
            marginTop: 20,
          }}>Stop chaining stops by hand.</div>
        </div>
      </div>

      {/* Map + animated route */}
      <MapSvg localTime={localTime} />

      {/* Right panel — stats */}
      <div style={{
        position: 'absolute', right: 100, bottom: 120, width: 420,
        padding: 32, background: NAVY, color: '#fff',
        borderRadius: 20, boxShadow: '0 24px 60px rgba(27,58,92,0.3)',
        opacity: clamp((localTime - 3.0) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 3.0) / 0.5, 0, 1)) * 20}px)`,
      }}>
        <div style={{ fontFamily: MONO, fontSize: 13, letterSpacing: '0.18em', color: '#7DB6FF' }}>
          AFTER OPTIMIZATION
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}>
          <div>
            <div style={{ fontFamily: FONT, fontSize: 52, fontWeight: 700, letterSpacing: '-0.02em' }}>
              <CountUp to={34} duration={1.0} start={3.2} suffix="%" />
            </div>
            <div style={{ fontFamily: FONT, fontSize: 16, color: 'rgba(255,255,255,0.7)' }}>fewer miles</div>
          </div>
          <div>
            <div style={{ fontFamily: FONT, fontSize: 52, fontWeight: 700, letterSpacing: '-0.02em' }}>
              <CountUp to={2.1} duration={1.0} start={3.4} suffix="h" decimals={1} />
            </div>
            <div style={{ fontFamily: FONT, fontSize: 16, color: 'rgba(255,255,255,0.7)' }}>saved per driver / day</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MapSvg({ localTime }) {
  // 10 stops. First, show them scattered. Then show messy path. Then optimized smooth path.
  const stops = [
    [120, 260], [250, 120], [420, 200], [560, 100], [700, 250],
    [840, 130], [980, 260], [1140, 150], [1260, 280], [1040, 370],
  ];
  // Messy path = original index order
  const messyPath = `M ${stops.map(s => s.join(' ')).join(' L ')}`;
  // Optimized = nearest neighbor-ish (hand tuned for visuals)
  const optOrder = [0, 1, 2, 3, 4, 5, 7, 6, 9, 8];
  const optPath = `M ${optOrder.map(i => stops[i].join(' ')).join(' L ')}`;

  const t1 = clamp((localTime - 1.0) / 0.8, 0, 1); // messy draw
  const t2 = clamp((localTime - 2.2) / 0.8, 0, 1); // fade to optimized
  const depot = [60, 180];

  return (
    <div style={{
      position: 'absolute', left: 100, top: 340,
      width: 1400, height: 480,
      background: '#F1F5F9',
      borderRadius: 20,
      overflow: 'hidden',
      border: `1px solid ${BORDER}`,
    }}>
      {/* subtle map grid */}
      <svg width="100%" height="100%" viewBox="0 0 1400 480" style={{ display: 'block' }}>
        <defs>
          <pattern id="mapGrid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#CBD5E1" strokeWidth="1" opacity="0.4"/>
          </pattern>
        </defs>
        <rect width="1400" height="480" fill="url(#mapGrid)" />
        {/* road sketches */}
        <path d="M 0 120 Q 400 100 800 140 T 1400 110" stroke="#CBD5E1" strokeWidth="3" fill="none" opacity="0.6"/>
        <path d="M 0 340 Q 500 380 1000 320 T 1400 360" stroke="#CBD5E1" strokeWidth="3" fill="none" opacity="0.6"/>
        <path d="M 300 0 L 280 480" stroke="#CBD5E1" strokeWidth="2" fill="none" opacity="0.5"/>
        <path d="M 800 0 L 820 480" stroke="#CBD5E1" strokeWidth="2" fill="none" opacity="0.5"/>
        <path d="M 1150 0 L 1170 480" stroke="#CBD5E1" strokeWidth="2" fill="none" opacity="0.5"/>

        {/* Messy red path */}
        <path d={messyPath}
          stroke="#DC2626" strokeWidth="4" fill="none"
          strokeLinecap="round" strokeLinejoin="round"
          strokeDasharray="12 8"
          strokeDashoffset={(1 - t1) * 3000}
          opacity={t1 * (1 - t2)}
        />

        {/* Optimized blue path */}
        <path d={optPath}
          stroke={BRAND} strokeWidth="5" fill="none"
          strokeLinecap="round" strokeLinejoin="round"
          strokeDasharray="3500"
          strokeDashoffset={(1 - t2) * 3500}
          opacity={t2}
        />

        {/* Depot */}
        <g transform={`translate(${depot[0]}, ${depot[1]})`}>
          <rect x="-18" y="-18" width="36" height="36" rx="6" fill={NAVY} />
          <text x="0" y="5" textAnchor="middle" fontFamily={MONO} fontSize="14" fill="#fff" fontWeight="700">W</text>
        </g>

        {/* Stops as pins */}
        {stops.map(([cx, cy], i) => {
          const appear = clamp((localTime - 0.2 - i * 0.05) / 0.3, 0, 1);
          const optIdx = optOrder.indexOf(i) + 1;
          return (
            <g key={i} transform={`translate(${cx}, ${cy}) scale(${appear})`} opacity={appear}>
              <circle r="20" fill={t2 > 0.5 ? BRAND : '#fff'} stroke={t2 > 0.5 ? BRAND_DARK : '#64748B'} strokeWidth="3"/>
              <text y="5" textAnchor="middle" fontFamily={MONO} fontWeight="700" fontSize="14" fill={t2 > 0.5 ? '#fff' : NAVY}>
                {t2 > 0.5 ? optIdx : i + 1}
              </text>
            </g>
          );
        })}

        {/* Moving truck on optimized path */}
        {t2 > 0.3 && (
          <TruckOnPath progress={clamp((localTime - 2.8) / 2.0, 0, 1)} />
        )}
      </svg>

      {/* Before/After label */}
      <div style={{
        position: 'absolute', top: 16, left: 20,
        fontFamily: MONO, fontSize: 13, letterSpacing: '0.18em', fontWeight: 700,
        padding: '8px 14px', borderRadius: 8,
        background: t2 > 0.5 ? BRAND_LIGHT : '#FEE2E2',
        color: t2 > 0.5 ? BRAND_DARK : '#DC2626',
      }}>
        {t2 > 0.5 ? 'OPTIMIZED' : 'MANUAL ROUTING'}
      </div>
    </div>
  );
}

function TruckOnPath({ progress }) {
  // Approximate along the optimized path with sample positions
  const samples = [
    [120, 260], [250, 120], [420, 200], [560, 100], [700, 250],
    [840, 130], [1140, 150], [980, 260], [1040, 370], [1260, 280],
  ];
  const seg = progress * (samples.length - 1);
  const i = Math.floor(seg);
  const f = seg - i;
  const a = samples[Math.min(i, samples.length - 1)];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  const x = a[0] + (b[0] - a[0]) * f;
  const y = a[1] + (b[1] - a[1]) * f;
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect x="-22" y="-14" width="44" height="28" rx="4" fill={NAVY}/>
      <rect x="-22" y="-14" width="18" height="28" rx="3" fill="#7DB6FF"/>
      <circle cx="-12" cy="14" r="5" fill="#222"/>
      <circle cx="12" cy="14" r="5" fill="#222"/>
    </g>
  );
}

// ─── SCENE 6: Driver app ────────────────────────────────────────────────
function SceneDriver() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: '#F8FAFC',
      padding: '80px 100px',
    }}>
      <div style={{ opacity: clamp(localTime / 0.4, 0, 1) }}>
        <div style={{
          fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em',
          color: BRAND, fontWeight: 600, textTransform: 'uppercase',
        }}>03: In the van</div>
        <div style={{
          fontFamily: FONT, fontSize: 76, fontWeight: 700,
          color: NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
          marginTop: 20, maxWidth: 1100,
        }}>Your drivers get a<br/>purpose-built co-pilot.</div>
      </div>

      {/* Three phones showing driver flow */}
      <div style={{
        position: 'absolute', left: 100, bottom: 80,
        display: 'flex', gap: 60, alignItems: 'flex-end',
      }}>
        <PhoneMock delay={0.5} title="Today's run" variant="stops" />
        <PhoneMock delay={1.0} title="Scan & verify" variant="scan" />
        <PhoneMock delay={1.5} title="Signature POD" variant="sign" />
      </div>

      {/* Right column — benefits */}
      <div style={{
        position: 'absolute', right: 100, top: 320, width: 420,
      }}>
        {[
          { n: '01', t: 'Stop-by-stop routing', s: 'Turn-by-turn guidance to the next customer' },
          { n: '02', t: 'Barcode scanning', s: 'Confirm every item leaves the van' },
          { n: '03', t: 'Proof of delivery', s: 'Signature capture + damage reporting' },
          { n: '04', t: 'Offline-ready', s: 'Keeps working when the signal drops' },
        ].map((b, i) => {
          const show = clamp((localTime - 2.0 - i * 0.25) / 0.4, 0, 1);
          return (
            <div key={i} style={{
              padding: '20px 0', borderBottom: `1px solid ${BORDER}`,
              opacity: show, transform: `translateX(${(1 - show) * -16}px)`,
            }}>
              <div style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
                <div style={{ fontFamily: MONO, fontSize: 14, color: BRAND, fontWeight: 700 }}>{b.n}</div>
                <div>
                  <div style={{ fontFamily: FONT, fontSize: 26, fontWeight: 700, color: NAVY, letterSpacing: '-0.01em' }}>{b.t}</div>
                  <div style={{ fontFamily: FONT, fontSize: 18, color: NAVY_80, marginTop: 4 }}>{b.s}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PhoneMock({ delay, title, variant }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.6, 0, 1);
  const eased = Easing.easeOutCubic(t);
  return (
    <div style={{
      width: 300, height: 620,
      background: '#111',
      borderRadius: 38,
      padding: 10,
      boxShadow: '0 30px 80px rgba(0,0,0,0.3)',
      opacity: eased,
      transform: `translateY(${(1 - eased) * 30}px)`,
    }}>
      <div style={{
        width: '100%', height: '100%',
        background: CREAM,
        borderRadius: 30,
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* Notch */}
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          width: 100, height: 26, background: '#111', borderRadius: 13,
          zIndex: 10,
        }}/>
        {/* Status bar */}
        <div style={{
          padding: '14px 26px 6px', display: 'flex', justifyContent: 'space-between',
          fontFamily: FONT, fontSize: 13, fontWeight: 700, color: NAVY,
        }}>
          <span>9:41</span>
          <span>●●●</span>
        </div>
        {/* Header */}
        <div style={{ padding: '24px 20px 12px' }}>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: BRAND, fontWeight: 700 }}>
            ROUTE R-28
          </div>
          <div style={{ fontFamily: FONT, fontSize: 22, fontWeight: 700, color: NAVY, marginTop: 4 }}>{title}</div>
        </div>
        <div style={{ padding: '0 16px' }}>
          {variant === 'stops' && <StopsList localTime={localTime - delay} />}
          {variant === 'scan' && <ScanView localTime={localTime - delay} />}
          {variant === 'sign' && <SignView localTime={localTime - delay} />}
        </div>
      </div>
    </div>
  );
}

function StopsList({ localTime }) {
  const stops = [
    { n: 1, name: 'Harbor Cafe', addr: '12 Quay St', status: 'done' },
    { n: 2, name: 'Bluestone Grocery', addr: '48 Mill Rd', status: 'done' },
    { n: 3, name: 'Nordic Deli', addr: '221 Pine Ave', status: 'active' },
    { n: 4, name: 'Station Street Bar', addr: '7 Elm Ln', status: 'up' },
    { n: 5, name: 'Maple & Oak', addr: '83 Cedar Dr', status: 'up' },
  ];
  return (
    <div>
      {stops.map((s, i) => {
        const show = clamp((localTime - 0.4 - i * 0.1) / 0.3, 0, 1);
        const isActive = s.status === 'active';
        const done = s.status === 'done';
        return (
          <div key={i} style={{
            display: 'flex', gap: 12, alignItems: 'center',
            padding: '12px 10px', marginBottom: 6,
            background: isActive ? BRAND_LIGHT : '#fff',
            border: `1px solid ${isActive ? BRAND : BORDER}`,
            borderRadius: 10,
            opacity: show,
            transform: `translateX(${(1 - show) * -10}px)`,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: done ? SUCCESS : isActive ? BRAND : '#fff',
              border: `2px solid ${done ? SUCCESS : isActive ? BRAND : BORDER}`,
              color: done || isActive ? '#fff' : NAVY,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: MONO, fontWeight: 700, fontSize: 12,
              flexShrink: 0,
            }}>
              {done ? '✓' : s.n}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 14, color: NAVY }}>{s.name}</div>
              <div style={{ fontFamily: FONT, fontSize: 11, color: NAVY_80 }}>{s.addr}</div>
            </div>
            {isActive && (
              <div style={{
                padding: '4px 8px', background: BRAND, color: '#fff',
                fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                borderRadius: 5,
              }}>NEXT</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ScanView({ localTime }) {
  const scanT = clamp((localTime - 0.6) / 1.4, 0, 1);
  const y = 120 + Math.sin(localTime * 4) * 60;
  return (
    <div>
      {/* Camera viewfinder */}
      <div style={{
        position: 'relative', height: 260, background: '#0a0a0a',
        borderRadius: 14, overflow: 'hidden',
        marginTop: 8,
      }}>
        {/* Fake barcode */}
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 180, height: 80, background: '#fff',
          display: 'flex', padding: 10,
        }}>
          {Array.from({ length: 22 }).map((_, i) => (
            <div key={i} style={{
              flex: 1, marginRight: 1, background: i % 3 === 0 ? '#fff' : '#000',
              width: (i * 7) % 5 + 1,
            }}/>
          ))}
        </div>
        {/* Scan line */}
        <div style={{
          position: 'absolute', left: 20, right: 20,
          top: y, height: 2, background: BRAND,
          boxShadow: `0 0 12px ${BRAND}`,
        }}/>
        {/* Corner guides */}
        {[[20,20,'tl'], [20,20,'tr'], [20,20,'bl'], [20,20,'br']].map((c, i) => {
          const pos = ['top:20px;left:20px', 'top:20px;right:20px', 'bottom:20px;left:20px', 'bottom:20px;right:20px'][i].split(';').reduce((a, s) => { const [k, v] = s.split(':'); a[k] = v; return a; }, {});
          return <div key={i} style={{ position: 'absolute', ...pos, width: 20, height: 20, border: `2px solid ${BRAND}`, borderColor: [
            `${BRAND} transparent transparent ${BRAND}`,
            `${BRAND} ${BRAND} transparent transparent`,
            `transparent transparent ${BRAND} ${BRAND}`,
            `transparent ${BRAND} ${BRAND} transparent`,
          ][i] }}/>;
        })}
      </div>
      {/* Items confirmed */}
      <div style={{ marginTop: 14 }}>
        {[
          { sku: 'WHL-0341', n: 'Oat Milk 12×1L', q: 6 },
          { sku: 'WHL-0118', n: 'Espresso Beans 1kg', q: 4 },
          { sku: 'WHL-0672', n: 'Paper Cups 500', q: 2 },
        ].map((it, i) => {
          const show = clamp((localTime - 1.2 - i * 0.35) / 0.3, 0, 1);
          return (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 10px', background: SUCCESS_BG,
              border: `1px solid #BBF7D0`, borderRadius: 8,
              marginBottom: 6,
              opacity: show, transform: `translateX(${(1 - show) * -10}px)`,
            }}>
              <div>
                <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 11, color: NAVY }}>{it.n}</div>
                <div style={{ fontFamily: MONO, fontSize: 9, color: '#64748B' }}>{it.sku}</div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: SUCCESS }}>✓ {it.q}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SignView({ localTime }) {
  return (
    <div>
      <div style={{
        padding: '16px 14px', background: '#fff',
        border: `1px solid ${BORDER}`, borderRadius: 10, marginTop: 4,
      }}>
        <div style={{ fontFamily: MONO, fontSize: 10, color: '#64748B', letterSpacing: '0.1em' }}>
          CUSTOMER · ORD-1042
        </div>
        <div style={{ fontFamily: FONT, fontSize: 16, fontWeight: 700, color: NAVY, marginTop: 4 }}>
          Nordic Deli
        </div>
        <div style={{ fontFamily: FONT, fontSize: 12, color: NAVY_80, marginTop: 2 }}>
          12 items · $284.50
        </div>
      </div>
      {/* Signature pad */}
      <div style={{
        height: 180, background: '#fff', border: `1px dashed ${BORDER}`,
        borderRadius: 10, marginTop: 14, position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: 8, left: 12,
          fontFamily: MONO, fontSize: 10, color: '#94A3B8', letterSpacing: '0.1em',
        }}>SIGN HERE</div>
        <svg width="100%" height="100%" viewBox="0 0 260 180" style={{ position: 'absolute', inset: 0 }}>
          <path
            d="M 30 120 Q 50 60 80 100 T 130 90 Q 160 80 180 110 T 230 100"
            stroke={NAVY} strokeWidth="3" fill="none" strokeLinecap="round"
            strokeDasharray="500"
            strokeDashoffset={clamp(500 - localTime * 200, 0, 500)}
          />
        </svg>
      </div>
      {/* Confirm button */}
      <div style={{
        marginTop: 14, padding: '14px', background: SUCCESS,
        color: '#fff', borderRadius: 10, textAlign: 'center',
        fontFamily: FONT, fontWeight: 700, fontSize: 15,
        boxShadow: `0 6px 16px rgba(22,163,74,0.3)`,
      }}>Confirm Delivery →</div>
    </div>
  );
}

// ─── SCENE 7: Customer portal ────────────────────────────────────────────
function SceneCustomer() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, ${BRAND_LIGHT} 0%, #fff 100%)`,
      padding: '80px 100px',
    }}>
      <div style={{ opacity: clamp(localTime / 0.4, 0, 1) }}>
        <div style={{
          fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em',
          color: BRAND, fontWeight: 600, textTransform: 'uppercase',
        }}>04: For your customers</div>
        <div style={{
          fontFamily: FONT, fontSize: 76, fontWeight: 700,
          color: NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
          marginTop: 20, maxWidth: 1200,
        }}>Your customers serve themselves.<br/>
          <span style={{ color: NAVY_80, fontWeight: 500 }}>You field fewer calls.</span>
        </div>
      </div>

      {/* Customer portal mock + benefit cards */}
      <CustomerPortalMock localTime={localTime} />

      <div style={{
        position: 'absolute', right: 100, top: 380, width: 480,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        {[
          'Place new orders 24/7 from phone or web',
          'View live delivery status + full order history',
          'Download invoices & statements on demand',
          'Submit returns and track credits automatically',
          'Set standing orders. Weekly pallets, no calls needed.',
        ].map((f, i) => {
          const show = clamp((localTime - 1.4 - i * 0.22) / 0.4, 0, 1);
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 16,
              padding: '16px 20px', background: '#fff',
              border: `1px solid ${BORDER}`, borderRadius: 14,
              boxShadow: '0 4px 16px rgba(27,58,92,0.06)',
              opacity: show,
              transform: `translateX(${(1 - show) * 20}px)`,
            }}>
              <div style={{
                width: 34, height: 34, borderRadius: 10,
                background: BRAND_LIGHT, color: BRAND,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: MONO, fontWeight: 700, fontSize: 13,
                flexShrink: 0,
              }}>{String(i + 1).padStart(2, '0')}</div>
              <div style={{ fontFamily: FONT, fontSize: 20, color: NAVY, fontWeight: 500 }}>{f}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CustomerPortalMock({ localTime }) {
  const show = clamp((localTime - 0.5) / 0.6, 0, 1);
  return (
    <div style={{
      position: 'absolute', left: 100, bottom: 80,
      width: 640, height: 480,
      background: '#fff', borderRadius: 20,
      boxShadow: '0 30px 80px rgba(27,58,92,0.2)',
      overflow: 'hidden',
      opacity: show, transform: `translateY(${(1 - show) * 24}px)`,
    }}>
      {/* Header */}
      <div style={{
        padding: '20px 28px', borderBottom: `1px solid ${BORDER}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <LogoMark size={30} color={BRAND} />
          <div style={{ fontFamily: FONT, fontWeight: 700, color: NAVY, fontSize: 18 }}>Harbor Cafe</div>
        </div>
        <div style={{
          padding: '8px 16px', background: BRAND, color: '#fff',
          borderRadius: 10, fontFamily: FONT, fontSize: 13, fontWeight: 600,
        }}>+ Place Order</div>
      </div>
      {/* Hero stats */}
      <div style={{ padding: '24px 28px', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
        {[
          { k: 'Next delivery', v: 'Today · 2:30pm', c: BRAND },
          { k: 'Open balance', v: '$1,248', c: NAVY },
          { k: 'This month', v: '14 orders', c: SUCCESS },
        ].map((s, i) => (
          <div key={i} style={{
            padding: '14px 16px', background: CREAM,
            border: `1px solid ${BORDER}`, borderRadius: 12,
          }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: '#64748B' }}>{s.k.toUpperCase()}</div>
            <div style={{ fontFamily: FONT, fontSize: 20, fontWeight: 700, color: s.c, marginTop: 4 }}>{s.v}</div>
          </div>
        ))}
      </div>
      {/* Recent orders */}
      <div style={{ padding: '8px 28px' }}>
        <div style={{ fontFamily: FONT, fontSize: 14, fontWeight: 700, color: NAVY_80, marginBottom: 10, letterSpacing: '0.02em' }}>
          RECENT ORDERS
        </div>
        {[
          { id: 'ORD-1042', d: 'Apr 14', t: '$284.50', s: 'Delivered', c: SUCCESS },
          { id: 'ORD-1039', d: 'Apr 11', t: '$312.20', s: 'Delivered', c: SUCCESS },
          { id: 'ORD-1036', d: 'Apr 08', t: '$198.70', s: 'Delivered', c: SUCCESS },
          { id: 'ORD-1031', d: 'Apr 04', t: '$421.80', s: 'Delivered', c: SUCCESS },
        ].map((o, i) => {
          const show = clamp((localTime - 1.2 - i * 0.15) / 0.3, 0, 1);
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '90px 70px 1fr 90px',
              padding: '11px 0', borderBottom: `1px solid ${BORDER}`,
              alignItems: 'center', gap: 14,
              fontFamily: FONT, fontSize: 14,
              opacity: show, transform: `translateX(${(1 - show) * -10}px)`,
            }}>
              <span style={{ fontFamily: MONO, fontSize: 12, color: NAVY_80 }}>{o.id}</span>
              <span style={{ color: NAVY_80 }}>{o.d}</span>
              <span style={{ fontWeight: 700, color: NAVY }}>{o.t}</span>
              <span style={{
                fontFamily: MONO, fontSize: 10, color: o.c, fontWeight: 700,
                letterSpacing: '0.1em', textAlign: 'right',
              }}>{o.s.toUpperCase()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SCENE 8: Value / metrics ────────────────────────────────────────────
function SceneValue() {
  const { localTime } = useSprite();
  const metrics = [
    { v: 34, suffix: '%', label: 'less time planning routes', delay: 0.4 },
    { v: 3.2, suffix: 'x', label: 'faster invoicing cycle', delay: 0.7, decimals: 1 },
    { v: 97, suffix: '%', label: 'on-time delivery rate', delay: 1.0 },
    { v: 12, suffix: ' days', label: 'shorter days-to-paid', delay: 1.3 },
  ];
  return (
    <div style={{
      position: 'absolute', inset: 0, background: NAVY,
      padding: '100px 100px',
      color: '#fff', overflow: 'hidden',
    }}>
      <BackgroundGrid />
      <div style={{
        fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em',
        color: '#7DB6FF', fontWeight: 600, textTransform: 'uppercase',
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>Measurable results</div>
      <div style={{
        fontFamily: FONT, fontSize: 96, fontWeight: 700,
        color: '#fff', letterSpacing: '-0.03em', lineHeight: 1.02,
        marginTop: 24,
        opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
      }}>What operators see<br/>after 90 days.</div>

      <div style={{
        position: 'absolute', left: 100, right: 100, bottom: 140,
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24,
      }}>
        {metrics.map((m, i) => {
          const show = clamp((localTime - m.delay) / 0.4, 0, 1);
          return (
            <div key={i} style={{
              borderTop: `2px solid ${BRAND}`,
              paddingTop: 24,
              opacity: show,
              transform: `translateY(${(1 - show) * 20}px)`,
            }}>
              <div style={{
                fontFamily: FONT, fontSize: 120, fontWeight: 700,
                letterSpacing: '-0.04em', lineHeight: 1,
                color: '#fff',
              }}>
                <CountUp to={m.v} duration={1.0} start={m.delay + 0.1} suffix={m.suffix} decimals={m.decimals || 0} />
              </div>
              <div style={{
                fontFamily: FONT, fontSize: 22, fontWeight: 400,
                color: 'rgba(255,255,255,0.75)', marginTop: 12,
                lineHeight: 1.3, maxWidth: 260,
              }}>{m.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SCENE 9: All features grid ──────────────────────────────────────────
function SceneFeatures() {
  const { localTime } = useSprite();
  const features = [
    'Multi-stop route optimization',
    'Auto-invoicing on delivery',
    'Barcode scanning & POD',
    'Recurring & standing orders',
    'Customer self-service portal',
    'Returns & credit notes',
    'Inventory & supplier tracking',
    'Customer ledger & statements',
    'Driver mobile app (iOS + Android)',
    'Finance dashboard & reports',
    'Estimates → invoice conversion',
    'Multi-tenant, role-based access',
  ];
  return (
    <div style={{
      position: 'absolute', inset: 0, background: '#fff',
      padding: '80px 100px',
    }}>
      <div style={{
        fontFamily: MONO, fontSize: 18, letterSpacing: '0.2em',
        color: BRAND, fontWeight: 600, textTransform: 'uppercase',
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>Everything in one place</div>
      <div style={{
        fontFamily: FONT, fontSize: 84, fontWeight: 700,
        color: NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
        marginTop: 20,
        opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
      }}>No more duct-taped tools.</div>

      <div style={{
        marginTop: 80,
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20,
      }}>
        {features.map((f, i) => {
          const show = clamp((localTime - 0.9 - i * 0.09) / 0.4, 0, 1);
          return (
            <div key={i} style={{
              padding: '28px 28px',
              background: CREAM,
              border: `1px solid ${BORDER}`,
              borderRadius: 16,
              display: 'flex', alignItems: 'center', gap: 18,
              opacity: show,
              transform: `translateY(${(1 - show) * 16}px)`,
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: BRAND, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <svg width="18" height="18" viewBox="0 0 14 14"><path d="M3 7l3 3 5-6" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div style={{
                fontFamily: FONT, fontSize: 22, fontWeight: 600,
                color: NAVY, letterSpacing: '-0.01em',
              }}>{f}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SCENE 10: CTA ───────────────────────────────────────────────────────
function SceneCTA() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(135deg, ${NAVY} 0%, ${BRAND_DARK} 100%)`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      color: '#fff',
      overflow: 'hidden',
    }}>
      <BackgroundGrid />
      {/* Logo */}
      <div style={{
        opacity: clamp(localTime / 0.4, 0, 1),
        transform: `scale(${0.9 + 0.1 * clamp(localTime / 0.4, 0, 1)})`,
      }}>
        <Logotype size={120} color="#fff" mark="#fff" />
      </div>
      {/* Headline */}
      <div style={{
        fontFamily: FONT, fontSize: 72, fontWeight: 700,
        letterSpacing: '-0.03em', marginTop: 60, textAlign: 'center',
        maxWidth: 1400, lineHeight: 1.05,
        opacity: clamp((localTime - 0.5) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 0.5) / 0.5, 0, 1)) * 20}px)`,
      }}>
        Run your rounds like<br/>the best in the business.
      </div>
      <div style={{
        fontFamily: FONT, fontSize: 32, fontWeight: 400,
        color: 'rgba(255,255,255,0.75)', marginTop: 28, textAlign: 'center',
        opacity: clamp((localTime - 1.0) / 0.5, 0, 1),
      }}>
        14-day trial. No card. Migrate your data in a day.
      </div>
      {/* CTA button */}
      <div style={{
        display: 'flex', gap: 20, marginTop: 60,
        opacity: clamp((localTime - 1.4) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 1.4) / 0.5, 0, 1)) * 20}px)`,
      }}>
        <div style={{
          padding: '22px 44px', background: '#fff', color: NAVY,
          borderRadius: 14, fontFamily: FONT, fontSize: 26, fontWeight: 700,
          letterSpacing: '-0.01em',
          boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
        }}>Start free trial →</div>
        <div style={{
          padding: '22px 44px', background: 'transparent', color: '#fff',
          border: '2px solid rgba(255,255,255,0.4)',
          borderRadius: 14, fontFamily: FONT, fontSize: 26, fontWeight: 600,
        }}>Book a demo</div>
      </div>
      {/* URL */}
      <div style={{
        position: 'absolute', bottom: 60,
        fontFamily: MONO, fontSize: 20, letterSpacing: '0.2em',
        color: 'rgba(255,255,255,0.7)', fontWeight: 500,
        opacity: clamp((localTime - 1.8) / 0.5, 0, 1),
      }}>
        ROUTEFLOW.IO
      </div>
    </div>
  );
}

Object.assign(window, {
  NAVY, BRAND, CREAM, INK, FONT, MONO, CountUp, LogoMark, Logotype,
  SceneChaos, SceneLogo, ScenePitch, SceneOperator, SceneRoute,
  SceneDriver, SceneCustomer, SceneValue, SceneFeatures, SceneCTA,
});
