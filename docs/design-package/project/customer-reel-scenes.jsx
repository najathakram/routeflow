// customer-reel-scenes.jsx — RouteFlow customer-perspective reel
// Vertical 1080x1920. Warm, conversational. No em/en dashes.

const C_NAVY = '#1B3A5C';
const C_NAVY_80 = 'rgba(27,58,92,0.82)';
const C_NAVY_60 = 'rgba(27,58,92,0.6)';
const C_BRAND = '#2563EB';
const C_BRAND_LIGHT = '#EFF6FF';
const C_CREAM = '#FAFBFD';
const C_WARM = '#FAF6EE';
const C_SUCCESS = '#16A34A';
const C_SUCCESS_BG = '#F0FDF4';
const C_AMBER = '#D97706';
const C_BORDER = '#E2E8F0';
const C_FONT = "'Inter', -apple-system, sans-serif";
const C_MONO = "'JetBrains Mono', ui-monospace, monospace";

function CLogo({ size = 80, color = C_BRAND }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <path d="M16 20 Q 40 20 40 40 Q 40 60 64 60" stroke={color} strokeWidth="4" strokeLinecap="round" fill="none"/>
      <circle cx="16" cy="20" r="7" fill={color}/>
      <circle cx="40" cy="40" r="5" fill={color} opacity="0.7"/>
      <circle cx="64" cy="60" r="7" fill={color}/>
    </svg>
  );
}
function CLogotype({ size = 60, color = C_NAVY, mark = C_BRAND }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.28 }}>
      <CLogo size={size * 1.05} color={mark}/>
      <div style={{ fontFamily: C_FONT, fontWeight: 700, fontSize: size, color, letterSpacing: '-0.03em', lineHeight: 1 }}>RouteFlow</div>
    </div>
  );
}

// ── Phone frame ──
function PhoneFrame({ children, tilt = 0, scale = 1 }) {
  return (
    <div style={{
      width: 460, height: 940, background: '#111',
      borderRadius: 60, padding: 14,
      boxShadow: '0 40px 100px rgba(27,58,92,0.3)',
      transform: `rotate(${tilt}deg) scale(${scale})`,
      transformOrigin: 'center',
    }}>
      <div style={{
        width: '100%', height: '100%', background: C_CREAM,
        borderRadius: 48, overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
          width: 140, height: 34, background: '#111', borderRadius: 17, zIndex: 2,
        }}/>
        {children}
      </div>
    </div>
  );
}

// ── SCENE 1 — Hook (0 to 4.8s) ──
function C_SceneHook() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: C_WARM, overflow: 'hidden' }}>
      {/* Empty milk carton, falling pen */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.15 }}>
        {Array.from({ length: 22 }).map((_, i) => (
          <line key={i} x1="60" x2="1020" y1={220 + i * 70} y2={220 + i * 70} stroke="#C9B99A" strokeWidth="1"/>
        ))}
      </svg>

      <div style={{
        position: 'absolute', top: 240, left: 80, right: 80,
        fontFamily: C_FONT, fontSize: 46, fontWeight: 500,
        color: C_NAVY_80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        It is 5:42am.
      </div>

      <div style={{
        position: 'absolute', top: 320, left: 80, right: 80,
        fontFamily: C_FONT, fontSize: 92, fontWeight: 800,
        color: C_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
        opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
      }}>
        You are out of<br/>oat milk.<br/>Again.
      </div>

      {/* Frustration steps */}
      {[
        { t: 'Call your supplier. Voicemail.', y: 860, r: -1.5 },
        { t: 'Text the sales rep. Read. No reply.', y: 1080, r: 0.8 },
        { t: 'Email? You cannot remember the SKUs.', y: 1300, r: -0.6 },
        { t: 'Guess the quantity. Hope it arrives.', y: 1520, r: 1.2 },
      ].map((l, i) => {
        const show = clamp((localTime - 1.2 - i * 0.5) / 0.4, 0, 1);
        return (
          <div key={i} style={{
            position: 'absolute', left: 140, top: l.y, right: 100,
            fontFamily: "'Caveat', 'Inter', cursive",
            fontSize: 52, fontWeight: 500,
            color: '#3A2E1F', letterSpacing: '-0.005em',
            fontStyle: 'italic',
            opacity: show,
            transform: `translateX(${(1 - show) * -20}px) rotate(${l.r}deg)`,
          }}>
            {l.t}
          </div>
        );
      })}

      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80, textAlign: 'center',
        fontFamily: C_FONT, fontSize: 34, fontWeight: 600,
        color: C_NAVY,
        opacity: clamp((localTime - 3.6) / 0.5, 0, 1),
      }}>
        Ordering stock should not feel like this.
      </div>
    </div>
  );
}

// ── SCENE 2 — Meet the customer portal (4.8 to 10.0s) ──
function C_SceneMeet() {
  const { localTime } = useSprite();
  const reveal = clamp((localTime - 0.6) / 0.7, 0, 1);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, #fff 0%, ${C_BRAND_LIGHT} 100%)`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ marginTop: -120, opacity: clamp(localTime / 0.4, 0, 1), transform: `scale(${0.9 + 0.1 * Easing.easeOutBack(clamp(localTime / 0.6, 0, 1))})` }}>
        <CLogotype size={110} color={C_NAVY} mark={C_BRAND}/>
      </div>

      <div style={{
        fontFamily: C_MONO, fontSize: 22, letterSpacing: '0.22em',
        color: C_BRAND, fontWeight: 700, marginTop: 60,
        opacity: clamp((localTime - 1.2) / 0.5, 0, 1),
      }}>
        FOR YOUR CAFE. YOUR SHOP. YOUR BAR.
      </div>

      <div style={{
        fontFamily: C_FONT, fontSize: 86, fontWeight: 800,
        color: C_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02,
        marginTop: 28, textAlign: 'center',
        opacity: reveal, transform: `translateY(${(1 - reveal) * 24}px)`,
      }}>
        Order from your<br/>wholesaler like<br/>you order dinner.
      </div>

      <div style={{
        fontFamily: C_FONT, fontSize: 32, fontWeight: 400, lineHeight: 1.35,
        color: C_NAVY_80, marginTop: 44, textAlign: 'center', maxWidth: 900,
        opacity: clamp((localTime - 2.8) / 0.5, 0, 1),
      }}>
        RouteFlow gives you a login.<br/>
        Your supplier sends you the link.
      </div>

      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80, textAlign: 'center',
        fontFamily: C_FONT, fontSize: 26, color: C_NAVY_60,
        opacity: clamp((localTime - 3.8) / 0.5, 0, 1),
      }}>
        Free for you. Always.
      </div>
    </div>
  );
}

// ── SCENE 3 — Browse + reorder in two taps (10.0 to 17.0s) ──
function C_SceneReorder() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', top: 120, left: 80, right: 80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div style={{ fontFamily: C_MONO, fontSize: 20, letterSpacing: '0.22em', color: C_BRAND, fontWeight: 700 }}>
          01 &nbsp;ORDER
        </div>
        <div style={{
          fontFamily: C_FONT, fontSize: 78, fontWeight: 800,
          color: C_NAVY, letterSpacing: '-0.03em', lineHeight: 1.0, marginTop: 14,
        }}>
          Reorder your<br/>regulars in<br/>two taps.
        </div>
      </div>

      <div style={{
        position: 'absolute', top: 660, left: '50%', transform: 'translateX(-50%)',
        opacity: clamp((localTime - 0.4) / 0.4, 0, 1),
      }}>
        <PhoneFrame>
          <div style={{ padding: '76px 24px 24px' }}>
            <div style={{ fontFamily: C_FONT, fontSize: 14, color: C_NAVY_60 }}>Harbor Cafe</div>
            <div style={{ fontFamily: C_FONT, fontSize: 30, fontWeight: 800, color: C_NAVY, marginTop: 4, letterSpacing: '-0.02em' }}>Your regulars</div>
            <div style={{ fontFamily: C_FONT, fontSize: 14, color: C_NAVY_80, marginTop: 4 }}>Tap + to add. We remember quantities.</div>
          </div>

          <div style={{ padding: '0 20px' }}>
            {[
              { n: 'Oat Milk 12x1L', p: '$38.40', q: 6, last: 'Last order: 2 weeks ago' },
              { n: 'Espresso Beans 1kg', p: '$24.00', q: 4, last: 'Last order: 9 days ago' },
              { n: 'Paper Cups 500pk', p: '$18.20', q: 2, last: 'Last order: 3 weeks ago' },
              { n: 'Brown Sugar Syrup', p: '$12.90', q: 3, last: 'Last order: 1 month ago' },
            ].map((it, i) => {
              const appear = clamp((localTime - 1.0 - i * 0.3) / 0.3, 0, 1);
              const added = localTime > 1.0 + i * 0.3 + 0.5;
              return (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '14px 16px', marginBottom: 10,
                  background: added ? C_SUCCESS_BG : '#fff',
                  border: `1.5px solid ${added ? '#BBF7D0' : C_BORDER}`,
                  borderRadius: 14,
                  opacity: appear, transform: `translateY(${(1 - appear) * 10}px)`,
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: C_FONT, fontSize: 16, fontWeight: 700, color: C_NAVY }}>{it.n}</div>
                    <div style={{ fontFamily: C_FONT, fontSize: 11, color: C_NAVY_60, marginTop: 2 }}>{it.last}</div>
                  </div>
                  <div style={{
                    padding: '8px 12px',
                    background: added ? C_SUCCESS : C_BRAND_LIGHT,
                    color: added ? '#fff' : C_BRAND,
                    borderRadius: 10, fontFamily: C_MONO, fontWeight: 700, fontSize: 14,
                    flexShrink: 0, marginLeft: 12,
                  }}>
                    {added ? `✓ ${it.q}` : '+ Add'}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{
            position: 'absolute', left: 20, right: 20, bottom: 40,
            padding: '16px 20px', background: C_NAVY, borderRadius: 16,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            opacity: clamp((localTime - 3.0) / 0.5, 0, 1),
          }}>
            <div>
              <div style={{ fontFamily: C_FONT, fontSize: 11, color: 'rgba(255,255,255,0.7)', letterSpacing: '0.1em' }}>TOTAL</div>
              <div style={{ fontFamily: C_FONT, fontSize: 26, fontWeight: 800, color: '#fff' }}>$412.80</div>
            </div>
            <div style={{
              padding: '10px 18px', background: C_BRAND, color: '#fff',
              borderRadius: 10, fontFamily: C_FONT, fontWeight: 700, fontSize: 15,
            }}>Place order →</div>
          </div>
        </PhoneFrame>
      </div>

      <div style={{
        position: 'absolute', bottom: 80, left: 80, right: 80, textAlign: 'center',
        fontFamily: C_FONT, fontSize: 26, color: C_NAVY_80, lineHeight: 1.4,
        opacity: clamp((localTime - 4.2) / 0.5, 0, 1),
      }}>
        24/7. On your phone. While the espresso brews.
      </div>
    </div>
  );
}

// ── SCENE 4 — Track your delivery (17.0 to 23.5s) ──
function C_SceneTrack() {
  const { localTime } = useSprite();
  const progress = clamp((localTime - 0.6) / 3.5, 0, 1);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, ${C_NAVY} 0%, #0F2544 100%)`,
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', top: 120, left: 80, right: 80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div style={{ fontFamily: C_MONO, fontSize: 20, letterSpacing: '0.22em', color: '#7DB6FF', fontWeight: 700 }}>
          02 &nbsp;TRACK
        </div>
        <div style={{
          fontFamily: C_FONT, fontSize: 78, fontWeight: 800,
          color: '#fff', letterSpacing: '-0.03em', lineHeight: 1.0, marginTop: 14,
        }}>
          Know where<br/>your order is.<br/>Right now.
        </div>
      </div>

      {/* Map-style tracker */}
      <div style={{
        position: 'absolute', left: 60, right: 60, top: 620,
        height: 560,
        background: 'rgba(255,255,255,0.05)', borderRadius: 24,
        border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden',
      }}>
        <svg width="100%" height="100%" viewBox="0 0 1000 560">
          <path d="M 0 180 Q 400 140 700 240 T 1000 210" stroke="rgba(255,255,255,0.15)" strokeWidth="4" fill="none"/>
          <path d="M 0 420 Q 500 460 1000 380" stroke="rgba(255,255,255,0.15)" strokeWidth="4" fill="none"/>

          {/* Dashed full path */}
          <path d="M 100 460 Q 300 280 500 340 T 900 140"
            stroke="rgba(125,182,255,0.4)" strokeWidth="5" fill="none" strokeDasharray="10 10"/>
          {/* Completed portion */}
          <path d="M 100 460 Q 300 280 500 340 T 900 140"
            stroke="#7DB6FF" strokeWidth="6" fill="none"
            strokeDasharray="1400" strokeDashoffset={(1 - progress) * 1400}/>

          {/* Depot */}
          <g transform="translate(100, 460)">
            <circle r="22" fill="#fff"/>
            <text y="6" textAnchor="middle" fontFamily={C_MONO} fontWeight="800" fontSize="14" fill={C_NAVY}>W</text>
          </g>
          {/* Your cafe */}
          <g transform="translate(900, 140)">
            <circle r="26" fill={C_BRAND} stroke="#fff" strokeWidth="3"/>
            <text y="6" textAnchor="middle" fontFamily={C_MONO} fontWeight="800" fontSize="14" fill="#fff">YOU</text>
          </g>
          {/* Van on path */}
          {(() => {
            // Approximate position along bezier
            const t = progress;
            const x = 100 + (900 - 100) * t;
            const y = 460 - Math.sin(t * Math.PI) * 280;
            return (
              <g transform={`translate(${x}, ${y})`}>
                <rect x="-28" y="-18" width="56" height="36" rx="6" fill="#FCD34D" stroke={C_NAVY} strokeWidth="2"/>
                <rect x="-20" y="-12" width="20" height="14" rx="2" fill="#fff"/>
                <circle cx="-16" cy="20" r="5" fill="#111"/>
                <circle cx="16" cy="20" r="5" fill="#111"/>
              </g>
            );
          })()}
        </svg>

        <div style={{
          position: 'absolute', top: 16, left: 20,
          padding: '10px 14px', borderRadius: 10,
          background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)',
          fontFamily: C_MONO, fontSize: 13, color: '#fff', letterSpacing: '0.14em', fontWeight: 700,
        }}>
          ORD 1042 · ON THE WAY
        </div>

        <div style={{
          position: 'absolute', bottom: 18, left: 20, right: 20,
          padding: '16px 20px', borderRadius: 14,
          background: 'rgba(255,255,255,0.95)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontFamily: C_FONT, fontSize: 13, color: C_NAVY_60, letterSpacing: '0.08em' }}>ARRIVING</div>
            <div style={{ fontFamily: C_FONT, fontSize: 24, fontWeight: 800, color: C_NAVY, marginTop: 2 }}>
              In {Math.max(1, Math.round((1 - progress) * 18))} minutes
            </div>
          </div>
          <div style={{
            padding: '10px 14px', background: C_BRAND_LIGHT, color: C_BRAND,
            borderRadius: 10, fontFamily: C_FONT, fontWeight: 700, fontSize: 14,
          }}>2 stops away</div>
        </div>
      </div>

      <div style={{
        position: 'absolute', bottom: 80, left: 80, right: 80, textAlign: 'center',
        fontFamily: C_FONT, fontSize: 26, color: 'rgba(255,255,255,0.8)',
        opacity: clamp((localTime - 4.4) / 0.5, 0, 1),
      }}>
        No more "are you close?" texts.
      </div>
    </div>
  );
}

// ── SCENE 5 — One place for every invoice (23.5 to 30.0s) ──
function C_SceneInvoices() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: C_WARM, overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', top: 120, left: 80, right: 80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div style={{ fontFamily: C_MONO, fontSize: 20, letterSpacing: '0.22em', color: C_BRAND, fontWeight: 700 }}>
          03 &nbsp;INVOICES
        </div>
        <div style={{
          fontFamily: C_FONT, fontSize: 78, fontWeight: 800,
          color: C_NAVY, letterSpacing: '-0.03em', lineHeight: 1.0, marginTop: 14,
        }}>
          Every invoice.<br/>One place.<br/>Forever.
        </div>
      </div>

      {/* Stack of invoice cards fanning in */}
      <div style={{ position: 'absolute', top: 620, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{ position: 'relative', width: 860, height: 1000 }}>
          {[
            { id: 'INV 1042', date: 'Oct 12', amt: '$412.80', status: 'PAID', statusBg: '#BBF7D0', statusFg: C_SUCCESS, tilt: -4, x: 40, y: 40 },
            { id: 'INV 1031', date: 'Sep 28', amt: '$298.50', status: 'PAID', statusBg: '#BBF7D0', statusFg: C_SUCCESS, tilt: 3, x: 160, y: 160 },
            { id: 'INV 1028', date: 'Sep 14', amt: '$184.20', status: 'DUE 3d', statusBg: '#FDE68A', statusFg: C_AMBER, tilt: -2, x: 80, y: 320 },
            { id: 'INV 1022', date: 'Aug 30', amt: '$502.10', status: 'PAID', statusBg: '#BBF7D0', statusFg: C_SUCCESS, tilt: 4, x: 220, y: 480 },
            { id: 'INV 1017', date: 'Aug 16', amt: '$276.40', status: 'PAID', statusBg: '#BBF7D0', statusFg: C_SUCCESS, tilt: -3, x: 100, y: 640 },
          ].map((inv, i) => {
            const appear = clamp((localTime - 0.6 - i * 0.25) / 0.5, 0, 1);
            return (
              <div key={i} style={{
                position: 'absolute',
                left: inv.x, top: inv.y,
                width: 600, padding: '22px 28px',
                background: '#fff', borderRadius: 18,
                border: `1px solid ${C_BORDER}`,
                boxShadow: '0 20px 50px rgba(27,58,92,0.12)',
                opacity: appear,
                transform: `translateY(${(1 - appear) * 30}px) rotate(${inv.tilt * (1 - appear * 0.5)}deg)`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontFamily: C_MONO, fontSize: 13, color: C_NAVY_60, letterSpacing: '0.14em', fontWeight: 700 }}>{inv.id}</div>
                  <div style={{
                    fontFamily: C_MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.14em',
                    padding: '4px 10px', background: inv.statusBg, color: inv.statusFg, borderRadius: 6,
                  }}>{inv.status}</div>
                </div>
                <div style={{ fontFamily: C_FONT, fontSize: 18, color: C_NAVY_80, marginTop: 8 }}>{inv.date}, 2024</div>
                <div style={{ fontFamily: C_FONT, fontSize: 38, fontWeight: 800, color: C_NAVY, marginTop: 6, letterSpacing: '-0.02em' }}>{inv.amt}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{
        position: 'absolute', bottom: 80, left: 80, right: 80, textAlign: 'center',
        fontFamily: C_FONT, fontSize: 26, color: C_NAVY_80, lineHeight: 1.4,
        opacity: clamp((localTime - 4.2) / 0.5, 0, 1),
      }}>
        Statements, PDFs, tax time.<br/>No more digging through email.
      </div>
    </div>
  );
}

// ── SCENE 6 — Returns and credits (30.0 to 36.0s) ──
function C_SceneReturns() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute', top: 120, left: 80, right: 80,
        opacity: clamp(localTime / 0.4, 0, 1),
      }}>
        <div style={{ fontFamily: C_MONO, fontSize: 20, letterSpacing: '0.22em', color: C_BRAND, fontWeight: 700 }}>
          04 &nbsp;PROBLEMS SOLVED
        </div>
        <div style={{
          fontFamily: C_FONT, fontSize: 78, fontWeight: 800,
          color: C_NAVY, letterSpacing: '-0.03em', lineHeight: 1.0, marginTop: 14,
        }}>
          A carton came<br/>damaged?<br/>Three taps.
        </div>
      </div>

      <div style={{
        position: 'absolute', top: 700, left: '50%', transform: 'translateX(-50%)',
        opacity: clamp((localTime - 0.5) / 0.5, 0, 1),
      }}>
        <PhoneFrame>
          <div style={{ padding: '76px 24px 24px' }}>
            <div style={{ fontFamily: C_MONO, fontSize: 12, color: C_BRAND, letterSpacing: '0.14em', fontWeight: 700 }}>REPORT AN ISSUE</div>
            <div style={{ fontFamily: C_FONT, fontSize: 26, fontWeight: 800, color: C_NAVY, marginTop: 6, letterSpacing: '-0.02em' }}>Order 1042</div>
            <div style={{ fontFamily: C_FONT, fontSize: 14, color: C_NAVY_60, marginTop: 4 }}>Delivered this morning</div>
          </div>

          <div style={{ padding: '0 20px' }}>
            {[
              { n: 'Oat Milk 12x1L', q: 6, reason: 'Damaged', sel: true },
              { n: 'Espresso Beans 1kg', q: 4, reason: null },
              { n: 'Paper Cups 500pk', q: 2, reason: null },
              { n: 'Brown Sugar Syrup', q: 3, reason: null },
            ].map((it, i) => {
              const show = clamp((localTime - 1.0 - i * 0.2) / 0.3, 0, 1);
              const showReason = it.sel && localTime > 2.2;
              return (
                <div key={i} style={{
                  padding: '14px 16px', marginBottom: 10,
                  background: showReason ? '#FEF3C7' : '#fff',
                  border: `1.5px solid ${showReason ? '#FCD34D' : C_BORDER}`,
                  borderRadius: 14,
                  opacity: show,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontFamily: C_FONT, fontSize: 15, fontWeight: 700, color: C_NAVY }}>{it.n}</div>
                    <div style={{ fontFamily: C_MONO, fontSize: 12, color: C_NAVY_60 }}>x{it.q}</div>
                  </div>
                  {showReason && (
                    <div style={{
                      marginTop: 8,
                      padding: '6px 10px', background: '#fff',
                      border: `1px solid ${C_AMBER}`, borderRadius: 8,
                      fontFamily: C_MONO, fontSize: 11, fontWeight: 700, color: C_AMBER,
                      display: 'inline-block', letterSpacing: '0.1em',
                    }}>DAMAGED · 2 UNITS</div>
                  )}
                </div>
              );
            })}
          </div>

          {localTime > 3.4 && (
            <div style={{
              position: 'absolute', left: 20, right: 20, bottom: 40,
              padding: '14px 20px', background: C_SUCCESS, color: '#fff',
              borderRadius: 14, textAlign: 'center',
              fontFamily: C_FONT, fontWeight: 700, fontSize: 16,
              opacity: clamp((localTime - 3.4) / 0.4, 0, 1),
            }}>
              ✓ Credit applied to your account
            </div>
          )}
        </PhoneFrame>
      </div>

      <div style={{
        position: 'absolute', bottom: 80, left: 80, right: 80, textAlign: 'center',
        fontFamily: C_FONT, fontSize: 26, color: C_NAVY_80, lineHeight: 1.4,
        opacity: clamp((localTime - 4.2) / 0.5, 0, 1),
      }}>
        Credit on your next invoice. Done.
      </div>
    </div>
  );
}

// ── SCENE 7 — Standing orders (36.0 to 41.0s) ──
function C_SceneStanding() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, ${C_BRAND_LIGHT} 0%, #fff 100%)`,
      overflow: 'hidden', padding: '120px 80px',
    }}>
      <div style={{ opacity: clamp(localTime / 0.4, 0, 1) }}>
        <div style={{ fontFamily: C_MONO, fontSize: 20, letterSpacing: '0.22em', color: C_BRAND, fontWeight: 700 }}>
          05 &nbsp;SET IT AND FORGET IT
        </div>
        <div style={{
          fontFamily: C_FONT, fontSize: 78, fontWeight: 800,
          color: C_NAVY, letterSpacing: '-0.03em', lineHeight: 1.0, marginTop: 14,
        }}>
          Same order,<br/>every Tuesday.
        </div>
      </div>

      {/* Calendar */}
      <div style={{
        marginTop: 60, padding: 30,
        background: '#fff', borderRadius: 24,
        border: `1px solid ${C_BORDER}`,
        boxShadow: '0 24px 60px rgba(27,58,92,0.08)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontFamily: C_FONT, fontSize: 26, fontWeight: 800, color: C_NAVY }}>October</div>
          <div style={{ fontFamily: C_MONO, fontSize: 12, color: C_BRAND, fontWeight: 700, letterSpacing: '0.14em' }}>STANDING ORDER · TUE</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 10 }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} style={{ fontFamily: C_MONO, fontSize: 14, color: C_NAVY_60, textAlign: 'center', fontWeight: 700, letterSpacing: '0.08em' }}>{d}</div>
          ))}
          {Array.from({ length: 35 }).map((_, i) => {
            const day = i - 2; // start Oct 1 on Wed
            const isTue = (i % 7) === 2;
            const valid = day >= 1 && day <= 31;
            const highlight = isTue && valid;
            const appear = clamp((localTime - 0.6 - i * 0.03) / 0.2, 0, 1);
            const pulse = highlight ? 0.85 + 0.15 * Math.sin(localTime * 3 - i * 0.4) : 1;
            return (
              <div key={i} style={{
                aspectRatio: '1', borderRadius: 12,
                background: highlight ? C_BRAND : valid ? '#fff' : 'transparent',
                border: highlight ? 'none' : valid ? `1px solid ${C_BORDER}` : 'none',
                color: highlight ? '#fff' : valid ? C_NAVY : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: C_FONT, fontSize: 20, fontWeight: highlight ? 800 : 500,
                opacity: appear * (highlight ? pulse : 1),
                boxShadow: highlight ? `0 8px 20px rgba(37,99,235,${0.25 + 0.15 * Math.sin(localTime * 3)})` : 'none',
              }}>
                {valid ? day : ''}
              </div>
            );
          })}
        </div>
        <div style={{
          marginTop: 24, padding: '14px 18px',
          background: C_BRAND_LIGHT, borderRadius: 12,
          fontFamily: C_FONT, fontSize: 18, color: C_NAVY, fontWeight: 600,
          opacity: clamp((localTime - 2.0) / 0.5, 0, 1),
        }}>
          6x Oat Milk · 4x Beans · 2x Cups · every Tuesday
        </div>
      </div>

      <div style={{
        marginTop: 50, textAlign: 'center',
        fontFamily: C_FONT, fontSize: 28, color: C_NAVY_80, lineHeight: 1.4,
        opacity: clamp((localTime - 3.0) / 0.5, 0, 1),
      }}>
        Skip a week. Pause a month.<br/>
        All from your phone.
      </div>
    </div>
  );
}

// ── SCENE 8 — What you get (41.0 to 46.5s) ──
function C_SceneWhat() {
  const { localTime } = useSprite();
  const items = [
    { k: 'Order anytime', v: '24/7 from your phone' },
    { k: 'See your history', v: 'Every order, searchable' },
    { k: 'Live delivery tracking', v: 'Know when the van arrives' },
    { k: 'Invoices and statements', v: 'Download PDFs, any time' },
    { k: 'Report issues', v: 'Damaged, short, wrong item' },
    { k: 'Standing orders', v: 'Set once, runs forever' },
  ];
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: '#fff',
      padding: '120px 80px 80px',
    }}>
      <div style={{ opacity: clamp(localTime / 0.4, 0, 1) }}>
        <div style={{ fontFamily: C_MONO, fontSize: 20, letterSpacing: '0.22em', color: C_BRAND, fontWeight: 700 }}>
          WHAT YOU GET
        </div>
        <div style={{
          fontFamily: C_FONT, fontSize: 78, fontWeight: 800,
          color: C_NAVY, letterSpacing: '-0.03em', lineHeight: 1.02, marginTop: 14,
        }}>
          All of this.<br/>Nothing to install.
        </div>
      </div>

      <div style={{ marginTop: 60, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {items.map((f, i) => {
          const show = clamp((localTime - 0.6 - i * 0.2) / 0.4, 0, 1);
          return (
            <div key={i} style={{
              padding: '24px 22px', background: C_CREAM,
              border: `1.5px solid ${C_BORDER}`, borderRadius: 18,
              opacity: show, transform: `translateY(${(1 - show) * 16}px)`,
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 12, background: C_BRAND_LIGHT,
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14,
              }}>
                <svg width="22" height="22" viewBox="0 0 14 14"><path d="M3 7l3 3 5-6" stroke={C_BRAND} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div style={{ fontFamily: C_FONT, fontSize: 26, fontWeight: 800, color: C_NAVY, letterSpacing: '-0.01em', lineHeight: 1.15 }}>{f.k}</div>
              <div style={{ fontFamily: C_FONT, fontSize: 18, color: C_NAVY_80, marginTop: 6, lineHeight: 1.3 }}>{f.v}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── SCENE 9 — CTA (46.5 to 52.0s) ──
function C_SceneCTA() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(135deg, ${C_NAVY} 0%, #0F2544 100%)`,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', color: '#fff',
      overflow: 'hidden', padding: '0 60px',
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.07 }}>
        <defs>
          <pattern id="ctaGridC" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ctaGridC)"/>
      </svg>

      <div style={{
        opacity: clamp(localTime / 0.4, 0, 1),
        transform: `scale(${0.9 + 0.1 * clamp(localTime / 0.5, 0, 1)})`,
        marginBottom: 60,
      }}>
        <CLogotype size={100} color="#fff" mark="#fff"/>
      </div>

      <div style={{
        fontFamily: C_FONT, fontSize: 82, fontWeight: 800,
        letterSpacing: '-0.03em', lineHeight: 1.05, textAlign: 'center',
        opacity: clamp((localTime - 0.5) / 0.5, 0, 1),
      }}>
        Ask your supplier<br/>about RouteFlow.
      </div>

      <div style={{
        fontFamily: C_FONT, fontSize: 30, color: 'rgba(255,255,255,0.75)',
        marginTop: 36, textAlign: 'center', lineHeight: 1.4,
        opacity: clamp((localTime - 1.2) / 0.5, 0, 1),
      }}>
        It is free for you.<br/>
        They send you the link.<br/>
        Monday mornings just got quieter.
      </div>

      <div style={{
        marginTop: 70,
        padding: '26px 54px', background: '#fff', color: C_NAVY,
        borderRadius: 18, fontFamily: C_FONT, fontSize: 30, fontWeight: 800,
        letterSpacing: '-0.01em',
        boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
        opacity: clamp((localTime - 2.2) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 2.2) / 0.5, 0, 1)) * 16}px)`,
      }}>
        See a demo →
      </div>

      <div style={{
        position: 'absolute', bottom: 80,
        fontFamily: C_MONO, fontSize: 22, letterSpacing: '0.24em',
        color: 'rgba(255,255,255,0.7)', fontWeight: 500,
        opacity: clamp((localTime - 2.8) / 0.5, 0, 1),
      }}>
        WWW.ROUTEFLOW.INFO
      </div>
    </div>
  );
}

Object.assign(window, {
  C_SceneHook, C_SceneMeet, C_SceneReorder, C_SceneTrack,
  C_SceneInvoices, C_SceneReturns, C_SceneStanding, C_SceneWhat, C_SceneCTA,
});
