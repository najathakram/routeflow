// reel2-scenes.jsx — "Why RouteFlow" reel for wholesalers (new product launch, no usage stats)
// Vertical 1080x1920, warm human tone, no em/en dashes.

const W_NAVY = 'var(--tweak-navy, #1B3A5C)';
const W_NAVY_80 = 'rgba(27,58,92,0.82)';
const W_NAVY_60 = 'rgba(27,58,92,0.6)';
const W_BRAND = 'var(--tweak-brand, #2563EB)';
const W_BRAND_LIGHT = 'var(--tweak-brand-light, #EFF6FF)';
const W_BRAND_DARK = 'var(--tweak-brand-dark, #1D4ED8)';
const W_CREAM = '#FAFBFD';
const W_SUCCESS = '#16A34A';
const W_SUCCESS_BG = '#F0FDF4';
const W_AMBER = '#D97706';
const W_BORDER = '#E2E8F0';

const W_FONT = "'Inter', -apple-system, 'SF Pro Display', sans-serif";
const W_MONO = "'JetBrains Mono', ui-monospace, monospace";

// ── Logo (route path + 3 nodes) ──
function WLogoMark({ size = 80, color = W_BRAND }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <path d="M16 20 Q 40 20 40 40 Q 40 60 64 60" stroke={color} strokeWidth="4" strokeLinecap="round" fill="none"/>
      <circle cx="16" cy="20" r="7" fill={color}/>
      <circle cx="40" cy="40" r="5" fill={color} opacity="0.7"/>
      <circle cx="64" cy="60" r="7" fill={color}/>
    </svg>
  );
}

function WLogotype({ size = 56, color = W_NAVY, mark = W_BRAND }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.28 }}>
      <WLogoMark size={size * 1.05} color={mark} />
      <div style={{ fontFamily: W_FONT, fontWeight: 700, fontSize: size, color, letterSpacing: '-0.03em', lineHeight: 1 }}>
        RouteFlow
      </div>
    </div>
  );
}

// ── SCENE 1 — "Sound familiar?" hook (0.0 to 5.0s) ──
function W_SceneHook() {
  const { localTime } = useSprite();
  const lines = [
    { t: 'A customer calls. You grab a pen.', y: 520, start: 0.2 },
    { t: 'Another texts. You write it down.', y: 760, start: 1.2 },
    { t: 'The driver rings. Where was that delivery?', y: 1000, start: 2.2 },
    { t: 'And you still have to invoice them all.', y: 1240, start: 3.2 },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#FAF8F3', overflow: 'hidden' }}>
      {/* Notebook lines */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
        {Array.from({ length: 24 }).map((_, i) => (
          <line key={i} x1="60" x2="1020" y1={180 + i * 72} y2={180 + i * 72} stroke="#C9B99A" strokeWidth="1"/>
        ))}
        <line x1="140" x2="140" y1="0" y2="1920" stroke="#D4816A" strokeWidth="2" opacity="0.5"/>
      </svg>

      {/* Intro line */}
      <div style={{
        position: 'absolute', top: 200, left: 80, right: 80,
        fontFamily: W_FONT, fontSize: 48, fontWeight: 500,
        color: W_NAVY_80, letterSpacing: '-0.01em',
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        If you run a wholesale round,
      </div>
      <div style={{
        position: 'absolute', top: 280, left: 80, right: 80,
        fontFamily: W_FONT, fontSize: 88, fontWeight: 800,
        color: W_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
        opacity: clamp((localTime - 0.2) / 0.5, 0, 1),
      }}>
        this might sound<br/>familiar.
      </div>

      {lines.map((l, i) => {
        const show = clamp((localTime - l.start) / 0.5, 0, 1);
        return (
          <div key={i} style={{
            position: 'absolute', left: 160, top: l.y, right: 80,
            fontFamily: "'Caveat', 'Inter', cursive", // fallback ok
            fontSize: 56, fontWeight: 500,
            color: '#3A2E1F', letterSpacing: '-0.005em',
            opacity: show,
            transform: `translateX(${(1 - show) * -20}px) rotate(${-1 + i * 0.7}deg)`,
            fontStyle: 'italic',
          }}>
            {l.t}
          </div>
        );
      })}

      {/* Breath mark at bottom */}
      <div style={{
        position: 'absolute', bottom: 120, left: 0, right: 0, textAlign: 'center',
        fontFamily: W_FONT, fontSize: 36, fontWeight: 500,
        color: W_NAVY_80,
        opacity: clamp((localTime - 4.0) / 0.6, 0, 1),
      }}>
        There is a calmer way.
      </div>
    </div>
  );
}

// ── SCENE 2 — Meet RouteFlow (5.0 to 10.0s) ──
function W_SceneMeet() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, #fff 0%, ${W_BRAND_LIGHT} 100%)`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Route sketch behind */}
      <svg width="1080" height="400" viewBox="0 0 1080 400" style={{ position: 'absolute', top: 260, opacity: 0.7 }}>
        <path
          d="M 80 300 Q 260 80 500 200 T 1000 140"
          stroke={W_BRAND} strokeWidth="5" fill="none" strokeLinecap="round"
          strokeDasharray="2000"
          strokeDashoffset={2000 - Math.min(2000, localTime * 600)}
        />
        {[[80, 300], [500, 200], [1000, 140]].map(([cx, cy], i) => {
          const a = clamp((localTime - 0.5 - i * 0.2) / 0.3, 0, 1);
          return <circle key={i} cx={cx} cy={cy} r={16 * a} fill={W_BRAND} opacity={a}/>;
        })}
      </svg>

      <div style={{
        opacity: clamp((localTime - 1.0) / 0.5, 0, 1),
        transform: `scale(${0.9 + 0.1 * Easing.easeOutBack(clamp((localTime - 1.0) / 0.6, 0, 1))})`,
        marginBottom: 40, marginTop: -100,
      }}>
        <WLogotype size={120} color={W_NAVY} mark={W_BRAND} />
      </div>

      <div style={{
        fontFamily: W_MONO, fontSize: 22, letterSpacing: '0.22em',
        color: W_BRAND, fontWeight: 700, marginTop: 260,
        opacity: clamp((localTime - 2.0) / 0.5, 0, 1),
      }}>
        BUILT FOR WHOLESALERS
      </div>

      <div style={{
        fontFamily: W_FONT, fontSize: 80, fontWeight: 800,
        color: W_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
        marginTop: 28, textAlign: 'center',
        opacity: clamp((localTime - 2.5) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 2.5) / 0.5, 0, 1)) * 20}px)`,
      }}>
        One place for<br/>every round<br/>you run.
      </div>

      <div style={{
        fontFamily: W_FONT, fontSize: 32, fontWeight: 400, lineHeight: 1.35,
        color: W_NAVY_80, marginTop: 44, textAlign: 'center', maxWidth: 900,
        opacity: clamp((localTime - 3.6) / 0.5, 0, 1),
      }}>
        Orders, routes, drivers, invoices.<br/>
        All talking to each other. Finally.
      </div>
    </div>
  );
}

// ── SCENE 3 — Your customers order themselves (10.0 to 16.0s) ──
function W_SceneCustomer() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', overflow: 'hidden' }}>
      {/* Phone in hand */}
      <div style={{
        position: 'absolute', top: 120, left: '50%',
        transform: `translateX(-50%) rotate(-3deg)`,
        opacity: clamp(localTime / 0.5, 0, 1),
      }}>
        <PortalPhone localTime={localTime} />
      </div>

      <div style={{
        position: 'absolute', bottom: 340, left: 80, right: 80,
        opacity: clamp((localTime - 0.8) / 0.5, 0, 1),
      }}>
        <div style={{
          fontFamily: W_MONO, fontSize: 20, letterSpacing: '0.22em',
          color: W_BRAND, fontWeight: 700,
        }}>FOR YOUR CUSTOMERS</div>
        <div style={{
          fontFamily: W_FONT, fontSize: 72, fontWeight: 800,
          color: W_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
          marginTop: 16,
        }}>
          They order<br/>when they want.
        </div>
      </div>

      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        fontFamily: W_FONT, fontSize: 32, fontWeight: 400, lineHeight: 1.4,
        color: W_NAVY_80,
        opacity: clamp((localTime - 2.6) / 0.5, 0, 1),
      }}>
        No more 6am phone calls.<br/>
        No more scribbled notes.<br/>
        Every order lands in your dashboard, ready to go.
      </div>
    </div>
  );
}

function PortalPhone({ localTime }) {
  return (
    <div style={{
      width: 460, height: 920,
      background: '#111', borderRadius: 58, padding: 14,
      boxShadow: '0 40px 100px rgba(27,58,92,0.3)',
    }}>
      <div style={{
        width: '100%', height: '100%', background: W_CREAM,
        borderRadius: 46, overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
          width: 140, height: 34, background: '#111', borderRadius: 17,
        }}/>
        <div style={{ padding: '80px 28px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WLogoMark size={36} color={W_BRAND}/>
            <div style={{ fontFamily: W_FONT, fontWeight: 700, fontSize: 24, color: W_NAVY }}>Harbor Cafe</div>
          </div>
          <div style={{ fontFamily: W_FONT, fontSize: 32, fontWeight: 800, color: W_NAVY, marginTop: 24, letterSpacing: '-0.02em' }}>
            Place an order
          </div>
          <div style={{ fontFamily: W_FONT, fontSize: 16, color: W_NAVY_80, marginTop: 6 }}>
            Delivery tomorrow by 11am
          </div>
        </div>

        {/* Quick-add items */}
        <div style={{ padding: '0 20px' }}>
          {[
            { n: 'Oat Milk 12x1L', p: '$38.40', q: 6 },
            { n: 'Espresso Beans 1kg', p: '$24.00', q: 4 },
            { n: 'Paper Cups 500pk', p: '$18.20', q: 2 },
            { n: 'Brown Sugar Syrup', p: '$12.90', q: 3 },
          ].map((it, i) => {
            const show = clamp((localTime - 1.2 - i * 0.3) / 0.3, 0, 1);
            const added = localTime > 1.2 + i * 0.3 + 0.3;
            return (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '14px 16px', marginBottom: 10,
                background: added ? W_SUCCESS_BG : '#fff',
                border: `1.5px solid ${added ? '#BBF7D0' : W_BORDER}`,
                borderRadius: 14,
                opacity: show, transform: `translateY(${(1 - show) * 10}px)`,
              }}>
                <div>
                  <div style={{ fontFamily: W_FONT, fontSize: 16, fontWeight: 700, color: W_NAVY }}>{it.n}</div>
                  <div style={{ fontFamily: W_MONO, fontSize: 12, color: W_NAVY_80, marginTop: 2 }}>{it.p} each</div>
                </div>
                <div style={{
                  padding: '6px 12px',
                  background: added ? W_SUCCESS : W_BRAND_LIGHT,
                  color: added ? '#fff' : W_BRAND,
                  borderRadius: 10, fontFamily: W_MONO, fontWeight: 700, fontSize: 14,
                }}>
                  {added ? `✓ ${it.q}` : '+ Add'}
                </div>
              </div>
            );
          })}
        </div>

        {/* Total bar */}
        <div style={{
          position: 'absolute', left: 20, right: 20, bottom: 40,
          padding: '18px 22px',
          background: W_NAVY, borderRadius: 16,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          opacity: clamp((localTime - 2.7) / 0.5, 0, 1),
        }}>
          <div>
            <div style={{ fontFamily: W_FONT, fontSize: 12, color: 'rgba(255,255,255,0.7)', letterSpacing: '0.08em' }}>TOTAL</div>
            <div style={{ fontFamily: W_FONT, fontSize: 28, fontWeight: 800, color: '#fff' }}>$412.80</div>
          </div>
          <div style={{
            padding: '12px 20px', background: W_BRAND, color: '#fff',
            borderRadius: 10, fontFamily: W_FONT, fontWeight: 700, fontSize: 16,
          }}>Send order →</div>
        </div>
      </div>
    </div>
  );
}

// ── SCENE 4 — The map plans itself (16.0 to 22.0s) ──
function W_SceneRoute() {
  const { localTime } = useSprite();
  const t1 = clamp((localTime - 1.2) / 1.0, 0, 1);
  const t2 = clamp((localTime - 2.8) / 1.0, 0, 1);
  const stops = [
    [140, 520], [300, 380], [480, 460], [640, 360], [800, 500], [940, 400], [860, 620], [640, 660], [420, 660]
  ];
  const optOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, ${W_NAVY} 0%, #0F2544 100%)`,
      overflow: 'hidden',
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.08 }}>
        <defs>
          <pattern id="routeGridW" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#routeGridW)"/>
      </svg>

      <div style={{
        position: 'absolute', top: 140, left: 80, right: 80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div style={{ fontFamily: W_MONO, fontSize: 20, letterSpacing: '0.22em', color: '#7DB6FF', fontWeight: 700 }}>
          FOR YOUR OFFICE
        </div>
        <div style={{
          fontFamily: W_FONT, fontSize: 76, fontWeight: 800,
          color: '#fff', letterSpacing: '-0.03em', lineHeight: 1.02, marginTop: 18,
        }}>
          The route plans<br/>itself.
        </div>
      </div>

      {/* Map area */}
      <div style={{
        position: 'absolute', left: 60, right: 60, top: 500,
        height: 780,
        background: 'rgba(255,255,255,0.05)', borderRadius: 24,
        border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden',
      }}>
        <svg width="100%" height="100%" viewBox="0 0 1000 780">
          {/* roads */}
          <path d="M 0 200 Q 400 180 700 260 T 1000 240" stroke="rgba(255,255,255,0.15)" strokeWidth="4" fill="none"/>
          <path d="M 0 520 Q 500 560 1000 490" stroke="rgba(255,255,255,0.15)" strokeWidth="4" fill="none"/>
          <path d="M 300 0 L 280 780" stroke="rgba(255,255,255,0.12)" strokeWidth="3" fill="none"/>
          <path d="M 720 0 L 740 780" stroke="rgba(255,255,255,0.12)" strokeWidth="3" fill="none"/>

          {/* Optimized path */}
          <path
            d={`M ${optOrder.map(i => stops[i].join(' ')).join(' L ')}`}
            stroke={W_BRAND} strokeWidth="6" fill="none"
            strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray="3000"
            strokeDashoffset={(1 - t2) * 3000}
            opacity={t2}
          />
          {/* Unoptimized messy preview */}
          <path
            d="M 140 520 L 640 360 L 300 380 L 800 500 L 480 460 L 940 400 L 420 660 L 860 620 L 640 660"
            stroke="#F87171" strokeWidth="4" fill="none" strokeDasharray="12 8"
            strokeLinecap="round"
            strokeDashoffset={(1 - t1) * 3000}
            opacity={t1 * (1 - t2)}
          />

          {/* Stops */}
          {stops.map(([cx, cy], i) => {
            const appear = clamp((localTime - 0.4 - i * 0.06) / 0.3, 0, 1);
            const num = optOrder.indexOf(i) + 1;
            return (
              <g key={i} transform={`translate(${cx},${cy}) scale(${appear})`} opacity={appear}>
                <circle r="22" fill={t2 > 0.5 ? W_BRAND : '#fff'} stroke={t2 > 0.5 ? '#fff' : '#CBD5E1'} strokeWidth="3"/>
                <text y="6" textAnchor="middle" fontFamily={W_MONO} fontWeight="700" fontSize="16" fill={t2 > 0.5 ? '#fff' : W_NAVY}>
                  {t2 > 0.5 ? num : i + 1}
                </text>
              </g>
            );
          })}

          {/* Depot */}
          <g transform="translate(60, 100)">
            <rect x="-22" y="-22" width="44" height="44" rx="8" fill="#fff"/>
            <text y="7" textAnchor="middle" fontFamily={W_MONO} fontWeight="800" fontSize="18" fill={W_NAVY}>W</text>
          </g>
        </svg>

        {/* Label */}
        <div style={{
          position: 'absolute', top: 18, left: 22,
          padding: '10px 16px', borderRadius: 10,
          background: t2 > 0.5 ? W_BRAND : 'rgba(248,113,113,0.2)',
          color: '#fff', fontFamily: W_MONO, fontSize: 14, fontWeight: 700, letterSpacing: '0.18em',
        }}>
          {t2 > 0.5 ? 'OPTIMIZED' : 'BEFORE'}
        </div>
      </div>

      <div style={{
        position: 'absolute', bottom: 80, left: 80, right: 80,
        fontFamily: W_FONT, fontSize: 30, color: 'rgba(255,255,255,0.85)',
        opacity: clamp((localTime - 3.8) / 0.5, 0, 1),
        lineHeight: 1.35,
      }}>
        Nine stops. Shortest path. One tap.
      </div>
    </div>
  );
}

// ── SCENE 5 — The van (22.0 to 28.5s) ──
function W_SceneVan() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: W_CREAM, overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', top: 140, left: 80, right: 80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div style={{ fontFamily: W_MONO, fontSize: 20, letterSpacing: '0.22em', color: W_BRAND, fontWeight: 700 }}>
          FOR YOUR DRIVERS
        </div>
        <div style={{
          fontFamily: W_FONT, fontSize: 74, fontWeight: 800,
          color: W_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02, marginTop: 18,
        }}>
          Tap. Scan. Sign.<br/>That is it.
        </div>
      </div>

      {/* Three mini phone states */}
      <div style={{
        position: 'absolute', left: 40, right: 40, top: 500,
        display: 'flex', gap: 20, justifyContent: 'center',
      }}>
        <MiniPhone delay={0.5} title="Stops" variant="stops"/>
        <MiniPhone delay={1.2} title="Scan" variant="scan"/>
        <MiniPhone delay={1.9} title="Sign" variant="sign"/>
      </div>

      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        fontFamily: W_FONT, fontSize: 30, color: W_NAVY_80, lineHeight: 1.4,
        opacity: clamp((localTime - 3.2) / 0.5, 0, 1),
      }}>
        Proof of delivery captured on the spot.<br/>
        No more arguments about what was dropped off.
      </div>
    </div>
  );
}

function MiniPhone({ delay, title, variant }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  return (
    <div style={{
      width: 320, height: 650,
      background: '#111', borderRadius: 42, padding: 10,
      opacity: t, transform: `translateY(${(1 - t) * 30}px)`,
      boxShadow: '0 30px 60px rgba(27,58,92,0.2)',
    }}>
      <div style={{
        width: '100%', height: '100%',
        background: '#fff', borderRadius: 34,
        overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          width: 100, height: 26, background: '#111', borderRadius: 13,
        }}/>
        <div style={{ padding: '50px 18px 12px' }}>
          <div style={{ fontFamily: W_MONO, fontSize: 10, color: W_BRAND, letterSpacing: '0.14em', fontWeight: 700 }}>
            ROUTE R-28
          </div>
          <div style={{ fontFamily: W_FONT, fontSize: 22, fontWeight: 800, color: W_NAVY, marginTop: 4 }}>
            {title}
          </div>
        </div>

        <div style={{ padding: '0 14px' }}>
          {variant === 'stops' && <MiniStops localTime={localTime - delay}/>}
          {variant === 'scan' && <MiniScan localTime={localTime - delay}/>}
          {variant === 'sign' && <MiniSign localTime={localTime - delay}/>}
        </div>
      </div>
    </div>
  );
}

function MiniStops({ localTime }) {
  const stops = [
    { n: 1, name: 'Harbor Cafe', addr: '12 Quay St', done: true },
    { n: 2, name: 'Bluestone Grocer', addr: '48 Mill Rd', done: true },
    { n: 3, name: 'Nordic Deli', addr: '221 Pine Ave', active: true },
    { n: 4, name: 'Station Street Bar', addr: '7 Elm Ln' },
    { n: 5, name: 'Maple & Oak', addr: '83 Cedar Dr' },
  ];
  return (
    <div>
      {stops.map((s, i) => {
        const show = clamp((localTime - 0.6 - i * 0.1) / 0.3, 0, 1);
        return (
          <div key={i} style={{
            display: 'flex', gap: 10, padding: '10px 10px', alignItems: 'center',
            marginBottom: 6,
            background: s.active ? W_BRAND_LIGHT : '#fff',
            border: `1.5px solid ${s.active ? W_BRAND : W_BORDER}`,
            borderRadius: 10,
            opacity: show,
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: '50%',
              background: s.done ? W_SUCCESS : s.active ? W_BRAND : '#fff',
              border: `2px solid ${s.done ? W_SUCCESS : s.active ? W_BRAND : W_BORDER}`,
              color: s.done || s.active ? '#fff' : W_NAVY,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: W_MONO, fontWeight: 700, fontSize: 12,
              flexShrink: 0,
            }}>{s.done ? '✓' : s.n}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: W_FONT, fontSize: 14, fontWeight: 700, color: W_NAVY }}>{s.name}</div>
              <div style={{ fontFamily: W_FONT, fontSize: 11, color: W_NAVY_80 }}>{s.addr}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MiniScan({ localTime }) {
  const y = 130 + Math.sin(localTime * 5) * 40;
  return (
    <div>
      <div style={{ position: 'relative', height: 260, background: '#0a0a0a', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)', background: '#fff',
          width: 200, height: 90, padding: 10, display: 'flex',
        }}>
          {Array.from({ length: 22 }).map((_, i) => (
            <div key={i} style={{ flex: 1, marginRight: 1, background: i % 3 === 0 ? '#fff' : '#000' }}/>
          ))}
        </div>
        <div style={{ position: 'absolute', left: 20, right: 20, top: y, height: 2, background: W_BRAND, boxShadow: `0 0 14px ${W_BRAND}` }}/>
      </div>
      <div style={{ marginTop: 12 }}>
        {[{ n: 'Oat Milk 12x1L', q: 6 }, { n: 'Espresso Beans', q: 4 }, { n: 'Paper Cups 500', q: 2 }].map((it, i) => {
          const show = clamp((localTime - 1.4 - i * 0.3) / 0.3, 0, 1);
          return (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', marginBottom: 6,
              background: W_SUCCESS_BG, border: '1.5px solid #BBF7D0', borderRadius: 10,
              opacity: show,
            }}>
              <div style={{ fontFamily: W_FONT, fontSize: 12, fontWeight: 700, color: W_NAVY }}>{it.n}</div>
              <div style={{ fontFamily: W_MONO, fontSize: 13, fontWeight: 700, color: W_SUCCESS }}>✓ {it.q}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniSign({ localTime }) {
  return (
    <div>
      <div style={{
        padding: '14px', background: W_CREAM, border: `1.5px solid ${W_BORDER}`,
        borderRadius: 10, marginTop: 4,
      }}>
        <div style={{ fontFamily: W_MONO, fontSize: 10, color: W_NAVY_80, letterSpacing: '0.1em' }}>ORD 1042</div>
        <div style={{ fontFamily: W_FONT, fontSize: 16, fontWeight: 700, color: W_NAVY, marginTop: 4 }}>Nordic Deli</div>
        <div style={{ fontFamily: W_FONT, fontSize: 12, color: W_NAVY_80, marginTop: 2 }}>12 items · $284.50</div>
      </div>
      <div style={{
        height: 220, background: '#fff', border: `1.5px dashed ${W_BORDER}`,
        borderRadius: 10, marginTop: 12, position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: 10, left: 14,
          fontFamily: W_MONO, fontSize: 10, color: '#94A3B8', letterSpacing: '0.1em',
        }}>SIGN HERE</div>
        <svg width="100%" height="100%" viewBox="0 0 260 220">
          <path
            d="M 30 140 Q 50 80 80 110 T 130 100 Q 160 80 180 120 T 230 110"
            stroke={W_NAVY} strokeWidth="3.5" fill="none" strokeLinecap="round"
            strokeDasharray="500"
            strokeDashoffset={clamp(500 - localTime * 160, 0, 500)}
          />
        </svg>
      </div>
      <div style={{
        marginTop: 14, padding: '14px',
        background: W_SUCCESS, color: '#fff',
        borderRadius: 10, textAlign: 'center',
        fontFamily: W_FONT, fontWeight: 700, fontSize: 15,
      }}>Confirm delivery →</div>
    </div>
  );
}

// ── SCENE 6 — Invoice sent the second it is delivered (28.5 to 34.0s) ──
function W_SceneInvoice() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', top: 140, left: 80, right: 80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div style={{ fontFamily: W_MONO, fontSize: 20, letterSpacing: '0.22em', color: W_BRAND, fontWeight: 700 }}>
          FOR YOUR BOOKS
        </div>
        <div style={{
          fontFamily: W_FONT, fontSize: 76, fontWeight: 800,
          color: W_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02, marginTop: 18,
        }}>
          Delivered at 10:42.<br/>
          Invoice at 10:42.
        </div>
      </div>

      {/* Phone -> arrow -> invoice */}
      <div style={{
        position: 'absolute', top: 580, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24,
      }}>
        <SignedReceipt delay={0.6}/>
        <FlowArrow delay={1.6}/>
        <InvoiceCard delay={2.4}/>
      </div>

      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        fontFamily: W_FONT, fontSize: 30, color: W_NAVY_80, lineHeight: 1.4,
        opacity: clamp((localTime - 3.4) / 0.5, 0, 1),
      }}>
        Auto sent to your customer.<br/>
        Auto logged against their ledger.
      </div>
    </div>
  );
}

function SignedReceipt({ delay }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  return (
    <div style={{
      width: 300, padding: 22,
      background: W_CREAM, border: `1.5px solid ${W_BORDER}`, borderRadius: 18,
      opacity: t, transform: `translateY(${(1 - t) * 16}px)`,
    }}>
      <div style={{ fontFamily: W_MONO, fontSize: 11, color: W_SUCCESS, fontWeight: 700, letterSpacing: '0.16em' }}>DELIVERED</div>
      <div style={{ fontFamily: W_FONT, fontSize: 20, fontWeight: 800, color: W_NAVY, marginTop: 6 }}>Nordic Deli</div>
      <div style={{ fontFamily: W_FONT, fontSize: 14, color: W_NAVY_80, marginTop: 2 }}>12 items · $284.50</div>
      <svg width="100%" height="50" viewBox="0 0 240 50" style={{ marginTop: 10 }}>
        <path d="M 20 35 Q 40 10 70 25 T 130 20 Q 160 12 180 30 T 220 22" stroke={W_NAVY} strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      </svg>
    </div>
  );
}

function FlowArrow({ delay }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  return (
    <div style={{ opacity: t, width: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="120" height="40" viewBox="0 0 120 40">
        <path
          d="M 5 20 L 110 20 M 100 10 L 110 20 L 100 30"
          stroke={W_BRAND} strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round"
          strokeDasharray="120"
          strokeDashoffset={(1 - t) * 120}
        />
      </svg>
    </div>
  );
}

function InvoiceCard({ delay }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  return (
    <div style={{
      width: 340, padding: 24,
      background: '#fff', border: `1.5px solid ${W_BORDER}`, borderRadius: 18,
      boxShadow: '0 24px 60px rgba(27,58,92,0.12)',
      opacity: t, transform: `translateY(${(1 - t) * 16}px)`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: W_MONO, fontSize: 11, color: W_NAVY_80, letterSpacing: '0.14em' }}>INVOICE INV 1042</div>
        <div style={{
          fontFamily: W_MONO, fontSize: 10, letterSpacing: '0.14em', fontWeight: 700,
          padding: '4px 8px', borderRadius: 6, background: W_BRAND_LIGHT, color: W_BRAND,
        }}>SENT</div>
      </div>
      <div style={{ fontFamily: W_FONT, fontSize: 20, fontWeight: 800, color: W_NAVY, marginTop: 10 }}>Nordic Deli</div>
      <div style={{ fontFamily: W_FONT, fontSize: 14, color: W_NAVY_80, marginTop: 2 }}>Due in 14 days</div>
      {[
        { n: 'Oat Milk 12x1L x6', p: '$38.40' },
        { n: 'Espresso Beans x4', p: '$96.00' },
        { n: 'Paper Cups x2', p: '$36.40' },
      ].map((l, i) => (
        <div key={i} style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '8px 0', borderBottom: `1px solid ${W_BORDER}`,
          fontFamily: W_FONT, fontSize: 13, color: W_NAVY,
        }}>
          <span>{l.n}</span><span style={{ fontFamily: W_MONO }}>{l.p}</span>
        </div>
      ))}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        marginTop: 10, paddingTop: 10,
        fontFamily: W_FONT, fontSize: 18, fontWeight: 800, color: W_NAVY,
      }}>
        <span>Total</span><span style={{ fontFamily: W_MONO }}>$284.50</span>
      </div>
    </div>
  );
}

// ── SCENE 7 — Everything you need, one login (34.0 to 41.0s) ──
function W_SceneAll() {
  const { localTime } = useSprite();
  const features = [
    'Orders from customers, 24/7',
    'Optimized routes in one click',
    'Driver app with scan + sign',
    'Auto invoicing on delivery',
    'Returns and credit notes',
    'Recurring and standing orders',
    'Inventory and suppliers',
    'Customer ledgers and statements',
    'Reports that actually make sense',
  ];
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, ${W_BRAND_LIGHT} 0%, #fff 100%)`,
      padding: '140px 80px 80px',
    }}>
      <div style={{ opacity: clamp(localTime / 0.4, 0, 1) }}>
        <div style={{ fontFamily: W_MONO, fontSize: 20, letterSpacing: '0.22em', color: W_BRAND, fontWeight: 700 }}>
          ONE LOGIN
        </div>
        <div style={{
          fontFamily: W_FONT, fontSize: 80, fontWeight: 800,
          color: W_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02, marginTop: 18,
        }}>
          All of it.<br/>
          Nothing duct taped.
        </div>
      </div>

      <div style={{ marginTop: 60, display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
        {features.map((f, i) => {
          const show = clamp((localTime - 0.7 - i * 0.18) / 0.4, 0, 1);
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 20,
              padding: '22px 26px', background: '#fff',
              border: `1.5px solid ${W_BORDER}`, borderRadius: 16,
              boxShadow: '0 4px 16px rgba(27,58,92,0.06)',
              opacity: show, transform: `translateX(${(1 - show) * -20}px)`,
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 12, background: W_BRAND,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <svg width="22" height="22" viewBox="0 0 14 14"><path d="M3 7l3 3 5-6" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div style={{ fontFamily: W_FONT, fontSize: 28, fontWeight: 700, color: W_NAVY, letterSpacing: '-0.01em' }}>
                {f}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── SCENE 8 — A promise (new product, no usage stats) (41.0 to 47.0s) ──
function W_ScenePromise() {
  const { localTime } = useSprite();
  const promises = [
    { big: 'No credit card', small: 'to start your trial' },
    { big: 'We move your data', small: 'customers, products, prices' },
    { big: 'Ready in a day', small: 'not a quarter' },
    { big: 'A real person picks up', small: 'when you call support' },
  ];
  return (
    <div style={{
      position: 'absolute', inset: 0, background: W_NAVY, color: '#fff',
      padding: '140px 80px 80px', overflow: 'hidden',
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.08 }}>
        <defs>
          <pattern id="promiseGridW" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#promiseGridW)"/>
      </svg>

      <div style={{
        fontFamily: W_MONO, fontSize: 20, letterSpacing: '0.22em', color: '#7DB6FF', fontWeight: 700,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        OUR PROMISE TO YOU
      </div>
      <div style={{
        fontFamily: W_FONT, fontSize: 76, fontWeight: 800,
        color: '#fff', letterSpacing: '-0.03em', lineHeight: 1.02, marginTop: 18,
        opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
      }}>
        Switching is<br/>supposed to be easy.
      </div>

      <div style={{
        marginTop: 70, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28,
      }}>
        {promises.map((p, i) => {
          const show = clamp((localTime - 1.0 - i * 0.3) / 0.5, 0, 1);
          return (
            <div key={i} style={{
              padding: '28px 24px',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 18,
              opacity: show, transform: `translateY(${(1 - show) * 16}px)`,
            }}>
              <div style={{
                fontFamily: W_FONT, fontSize: 36, fontWeight: 800,
                letterSpacing: '-0.02em', lineHeight: 1.1, color: '#fff',
              }}>{p.big}</div>
              <div style={{
                fontFamily: W_FONT, fontSize: 20, color: 'rgba(255,255,255,0.7)', marginTop: 10,
              }}>{p.small}</div>
            </div>
          );
        })}
      </div>

      <div style={{
        position: 'absolute', bottom: 100, left: 80, right: 80,
        fontFamily: W_FONT, fontSize: 32, fontWeight: 500,
        fontStyle: 'italic', color: 'rgba(255,255,255,0.9)',
        opacity: clamp((localTime - 3.6) / 0.5, 0, 1),
        lineHeight: 1.35,
      }}>
        We built RouteFlow for people<br/>who would rather be out on their round<br/>than stuck at a spreadsheet.
      </div>
    </div>
  );
}

// ── SCENE 9 — CTA (47.0 to 53.0s) ──
function W_SceneCTA() {
  const { localTime } = useSprite();
  const tweaks = (window.useTweaks && window.useTweaks()) || { ctaLine: "Want a calmer round?", ctaButton: 'Start your free trial', ctaUrl: 'www.routeflow.info' };
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(135deg, ${W_NAVY} 0%, #0F2544 100%)`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', color: '#fff',
      overflow: 'hidden',
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.07 }}>
        <defs>
          <pattern id="ctaGridW" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ctaGridW)"/>
      </svg>

      <div style={{
        opacity: clamp(localTime / 0.4, 0, 1),
        transform: `scale(${0.9 + 0.1 * clamp(localTime / 0.5, 0, 1)})`,
        marginBottom: 60,
      }}>
        <WLogotype size={100} color="#fff" mark="#fff"/>
      </div>

      <div style={{
        fontFamily: W_FONT, fontSize: 80, fontWeight: 800,
        letterSpacing: '-0.03em', lineHeight: 1.05, textAlign: 'center',
        padding: '0 60px',
        opacity: clamp((localTime - 0.5) / 0.5, 0, 1),
      }}>
        {tweaks.ctaLine || 'Want a calmer round?'}
      </div>

      <div style={{
        fontFamily: W_FONT, fontSize: 30, color: 'rgba(255,255,255,0.75)',
        marginTop: 32, textAlign: 'center', padding: '0 60px',
        opacity: clamp((localTime - 1.2) / 0.5, 0, 1),
      }}>
        Try RouteFlow. No card. No contract.
      </div>

      <div style={{
        marginTop: 70,
        padding: '26px 54px', background: '#fff', color: W_NAVY,
        borderRadius: 18, fontFamily: W_FONT, fontSize: 32, fontWeight: 800,
        letterSpacing: '-0.01em',
        boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
        opacity: clamp((localTime - 1.8) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 1.8) / 0.5, 0, 1)) * 16}px)`,
      }}>
        {tweaks.ctaButton || 'Start your free trial'} →
      </div>

      <div style={{
        position: 'absolute', bottom: 80,
        fontFamily: W_MONO, fontSize: 22, letterSpacing: '0.24em',
        color: 'rgba(255,255,255,0.7)', fontWeight: 500,
        opacity: clamp((localTime - 2.4) / 0.5, 0, 1),
      }}>
        {(tweaks.ctaUrl || 'www.routeflow.info').toUpperCase()}
      </div>
    </div>
  );
}

Object.assign(window, {
  W_SceneHook, W_SceneMeet, W_SceneCustomer, W_SceneRoute, W_SceneVan,
  W_SceneInvoice, W_SceneAll, W_ScenePromise, W_SceneCTA,
});
