// reel-scenes.jsx — RouteFlow vertical reel for Wholesalers
// 9:16 format, warm conversational tone, no em/en dashes

const R_NAVY = 'var(--tweak-navy, #1B3A5C)';
const R_NAVY_80 = 'rgba(27,58,92,0.82)';
const R_NAVY_60 = 'rgba(27,58,92,0.6)';
const R_BRAND = 'var(--tweak-brand, #2563EB)';
const R_BRAND_LIGHT = 'var(--tweak-brand-light, #EFF6FF)';
const R_BRAND_DARK = 'var(--tweak-brand-dark, #1D4ED8)';
const R_CREAM = '#FAFBFD';
const R_SUCCESS = '#16A34A';
const R_SUCCESS_BG = '#F0FDF4';
const R_WARNING = '#D97706';
const R_WARNING_BG = '#FFFBEB';
const R_BORDER = '#E2E8F0';
const R_AMBER_BG = '#FEF3C7';

const R_FONT = "'Inter', -apple-system, 'SF Pro Display', sans-serif";
const R_MONO = "'JetBrains Mono', ui-monospace, monospace";

// Counts up a number inside a Sprite
function Counter({ from = 0, to = 100, duration = 1.0, start = 0, suffix = '', prefix = '', decimals = 0 }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - start) / duration, 0, 1);
  const v = from + (to - from) * Easing.easeOutCubic(t);
  return <>{prefix}{v.toFixed(decimals)}{suffix}</>;
}

// Subtle reusable logo mark
function Mark({ size = 40, color = R_BRAND }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
      <path d="M16 20 Q 40 20 40 40 Q 40 60 64 60" stroke={color} strokeWidth="5" strokeLinecap="round" fill="none"/>
      <circle cx="16" cy="20" r="8" fill={color}/>
      <circle cx="40" cy="40" r="5.5" fill={color} opacity="0.7"/>
      <circle cx="64" cy="60" r="8" fill={color}/>
    </svg>
  );
}

function Wordmark({ size = 48, color = R_NAVY, mark = R_BRAND }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.28 }}>
      <Mark size={size * 1.05} color={mark} />
      <div style={{
        fontFamily: R_FONT, fontWeight: 700, fontSize: size,
        color, letterSpacing: '-0.03em', lineHeight: 1,
      }}>RouteFlow</div>
    </div>
  );
}

// Reusable "phone style" frame for vertical reel scenes (the whole stage is already 9:16)
// Scenes are full-bleed inside the 1080x1920 Stage.

// ─── SCENE 1 — The hook (0.0 to 4.8s) ─────────────────────────────────
// Wholesaler juggling: phone, paper, tabs everywhere.
function ReelHook() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#F1F2F4', overflow: 'hidden' }}>
      {/* subtle grain bg */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 50% 30%, #fff 0%, #E8EBF0 70%)',
      }}/>

      {/* Scattered order papers at top */}
      <ClutterPaper delay={0.05} x={-60} y={140} rot={-12} w={360} h={220} label="ORDER 1042" />
      <ClutterPaper delay={0.15} x={260} y={80}  rot={8}   w={380} h={230} label="INVOICE"    tint="#FFFCF0"/>
      <ClutterPaper delay={0.25} x={620} y={170} rot={-6}  w={380} h={230} label="ROUTE LIST" />
      <ClutterPaper delay={0.35} x={60}  y={360} rot={5}   w={380} h={230} label="STOCK COUNT" tint="#F0FAFF"/>
      <ClutterPaper delay={0.45} x={470} y={430} rot={-9}  w={400} h={240} label="LEDGER" />

      {/* Phone with missed call */}
      <MissedCallBadge delay={1.2} x={760} y={660} />

      {/* Bottom: centered message card */}
      <div style={{
        position: 'absolute', left: 60, right: 60, top: 820,
        padding: '56px 52px',
        background: '#fff',
        borderRadius: 36,
        boxShadow: '0 30px 80px rgba(15,31,51,0.22)',
        opacity: clamp((localTime - 1.6) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 1.6) / 0.5, 0, 1)) * 32}px)`,
      }}>
        <div style={{
          fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em', fontWeight: 700,
          color: R_BRAND, textTransform: 'uppercase',
        }}>For wholesalers</div>

        <div style={{
          fontFamily: R_FONT, fontSize: 92, fontWeight: 700,
          color: R_NAVY, letterSpacing: '-0.035em', lineHeight: 1.02,
          marginTop: 28, textWrap: 'pretty',
        }}>
          Tuesday, 6am.<br/>
          You already have <span style={{ color: R_BRAND }}>14 orders</span> on scraps of paper.
        </div>

        <div style={{
          fontFamily: R_FONT, fontSize: 40, fontWeight: 500, lineHeight: 1.35,
          color: R_NAVY_80, marginTop: 36,
          opacity: clamp((localTime - 2.6) / 0.5, 0, 1),
        }}>
          Sound familiar?
        </div>
      </div>

      {/* Ringing phone icon drifting */}
      <FloatingPhone localTime={localTime} />
    </div>
  );
}

function ClutterPaper({ delay, x, y, rot, w, h, label, tint = '#fff' }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.55, 0, 1);
  const eased = Easing.easeOutBack(t);
  return (
    <div style={{
      position: 'absolute', left: x, top: y,
      width: w, height: h, background: tint,
      border: '1px solid #d8dbe0', borderRadius: 4,
      boxShadow: '0 10px 26px rgba(0,0,0,0.12)',
      transform: `rotate(${rot}deg) scale(${0.8 + 0.2 * eased})`,
      opacity: clamp(t * 2, 0, 1),
      padding: 24,
      fontFamily: R_MONO,
    }}>
      <div style={{ fontSize: 16, letterSpacing: '0.12em', color: '#6b6458', fontWeight: 700, marginBottom: 16 }}>{label}</div>
      {[0,1,2,3,4,5].map(i => (
        <div key={i} style={{
          height: 8, marginBottom: 14,
          background: '#e5e7eb', borderRadius: 2,
          width: `${55 + ((i * 11) % 40)}%`,
        }}/>
      ))}
    </div>
  );
}

function MissedCallBadge({ delay, x, y }) {
  const { localTime } = useSprite();
  const t = clamp((localTime - delay) / 0.5, 0, 1);
  const scale = Easing.easeOutBack(t);
  const pulse = 1 + 0.18 * Math.sin(localTime * 5);
  return (
    <div style={{
      position: 'absolute', left: x, top: y,
      width: 200, padding: '16px 22px',
      background: '#DC2626', color: '#fff',
      borderRadius: 18,
      fontFamily: R_FONT, fontWeight: 700,
      boxShadow: '0 12px 32px rgba(220,38,38,0.5)',
      transform: `scale(${scale * (0.96 + 0.04 * Math.sin(localTime * 6))}) rotate(-6deg)`,
      opacity: t,
    }}>
      <div style={{ fontSize: 13, letterSpacing: '0.14em', opacity: 0.85 }}>MISSED CALL</div>
      <div style={{ fontSize: 26, marginTop: 4 }}>Harbor Cafe</div>
      <div style={{ fontSize: 14, opacity: 0.8, marginTop: 2 }}>3 minutes ago</div>
    </div>
  );
}

function FloatingPhone({ localTime }) {
  const ring = localTime > 1.8 ? 1 + 0.1 * Math.sin(localTime * 20) : 1;
  return (
    <div style={{
      position: 'absolute', left: 80, top: 620,
      transform: `rotate(-18deg) scale(${ring})`,
      opacity: clamp((localTime - 0.8) / 0.5, 0, 1),
    }}>
      <svg width="160" height="160" viewBox="0 0 64 64" fill="none">
        <path d="M17 9c-2 0-4 2-4 4v4c0 16 14 30 30 30h4c2 0 4-2 4-4v-6c0-2-1-3-3-3l-8-2c-2 0-3 1-4 2l-2 3c-6-3-11-8-14-14l3-2c1-1 2-2 2-4l-2-8c0-2-1-3-3-3h-5z" fill={R_NAVY}/>
      </svg>
    </div>
  );
}

// ─── SCENE 2 — The meet (4.8 to 10.0s) ──────────────────────────────────
// "Meet RouteFlow" warm handshake moment
function ReelMeet() {
  const { localTime } = useSprite();
  const logoT = clamp((localTime - 0.3) / 0.8, 0, 1);
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, #fff 0%, ${R_BRAND_LIGHT} 100%)`,
      overflow: 'hidden',
    }}>
      {/* Flowing route line drawing in */}
      <svg width="1080" height="1920" style={{ position: 'absolute', inset: 0 }}>
        <path
          d="M 40 600 Q 300 400 540 580 T 1040 520"
          stroke={R_BRAND} strokeWidth="10" fill="none" strokeLinecap="round"
          strokeDasharray="2400"
          strokeDashoffset={Math.max(0, 2400 - localTime * 900)}
          opacity="0.9"
        />
        {[[40,600], [300,480], [540,580], [800,560], [1040,520]].map(([cx,cy],i) => {
          const a = clamp((localTime - 0.4 - i * 0.12) / 0.3, 0, 1);
          return <circle key={i} cx={cx} cy={cy} r={16*a} fill={R_BRAND} opacity={a}/>;
        })}
      </svg>

      {/* Wordmark */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 760,
        display: 'flex', justifyContent: 'center',
        opacity: logoT,
        transform: `scale(${0.9 + 0.1 * Easing.easeOutBack(logoT)})`,
      }}>
        <Wordmark size={120} color={R_NAVY} mark={R_BRAND} />
      </div>

      <div style={{
        position: 'absolute', left: 80, right: 80, top: 980,
        textAlign: 'center',
        fontFamily: R_FONT, fontSize: 52, fontWeight: 500, lineHeight: 1.3,
        color: R_NAVY_80, letterSpacing: '-0.01em',
        opacity: clamp((localTime - 1.6) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 1.6) / 0.5, 0, 1)) * 20}px)`,
      }}>
        Say hi to the team that runs your rounds with you.
      </div>

      <div style={{
        position: 'absolute', left: 80, right: 80, top: 1220,
        textAlign: 'center',
        fontFamily: R_FONT, fontSize: 72, fontWeight: 700, lineHeight: 1.1,
        color: R_NAVY, letterSpacing: '-0.02em', textWrap: 'balance',
        opacity: clamp((localTime - 2.6) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 2.6) / 0.5, 0, 1)) * 20}px)`,
      }}>
        One calm place for orders,<br/>routes, drivers and invoices.
      </div>

      {/* Signature at bottom */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 160,
        textAlign: 'center',
        fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em', fontWeight: 600,
        color: R_BRAND,
        opacity: clamp((localTime - 3.6) / 0.5, 0, 1),
      }}>
        BUILT FOR WHOLESALERS
      </div>
    </div>
  );
}

// ─── SCENE 3 — Morning orders flow in (10.0 to 16.5s) ──────────────────
// Orders appear in your dashboard, no phone calls needed.
function ReelMorning() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: R_NAVY, overflow: 'hidden' }}>
      {/* soft grid */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.08 }}>
        <defs>
          <pattern id="reelGrid1" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#reelGrid1)"/>
      </svg>

      <div style={{
        position: 'absolute', left: 60, top: 140, right: 60,
      }}>
        <div style={{
          fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em',
          color: '#7DB6FF', fontWeight: 700,
          opacity: clamp(localTime / 0.4, 0, 1),
        }}>MORNING</div>
        <div style={{
          fontFamily: R_FONT, fontSize: 96, fontWeight: 700,
          color: '#fff', letterSpacing: '-0.035em', lineHeight: 1.02,
          marginTop: 20,
          opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
          transform: `translateY(${(1 - clamp((localTime - 0.3) / 0.5, 0, 1)) * 20}px)`,
        }}>
          Your customers order themselves.
        </div>
        <div style={{
          fontFamily: R_FONT, fontSize: 36, fontWeight: 500, lineHeight: 1.35,
          color: 'rgba(255,255,255,0.78)', marginTop: 24, maxWidth: 920,
          opacity: clamp((localTime - 0.8) / 0.5, 0, 1),
        }}>
          Cafes, shops and kitchens send orders from their phone. You start the day with a clean list, not a voicemail box.
        </div>
      </div>

      {/* Phone mock with incoming order list */}
      <div style={{
        position: 'absolute', left: 90, top: 740, width: 420, height: 820,
        background: '#111', borderRadius: 56, padding: 14,
        boxShadow: '0 40px 100px rgba(0,0,0,0.5)',
        transform: `rotate(-4deg) translateY(${(1 - clamp((localTime - 1.0) / 0.6, 0, 1)) * 40}px)`,
        opacity: clamp((localTime - 1.0) / 0.6, 0, 1),
      }}>
        <div style={{ width: '100%', height: '100%', background: R_CREAM, borderRadius: 44, overflow: 'hidden', position: 'relative' }}>
          <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', width: 130, height: 32, background: '#111', borderRadius: 16, zIndex: 10 }}/>
          <div style={{ padding: '18px 30px 4px', display: 'flex', justifyContent: 'space-between', fontFamily: R_FONT, fontSize: 16, fontWeight: 700, color: R_NAVY }}>
            <span>9:41</span><span>●●●</span>
          </div>
          <div style={{ padding: '28px 26px 16px' }}>
            <div style={{ fontFamily: R_MONO, fontSize: 13, letterSpacing: '0.15em', color: R_BRAND, fontWeight: 700 }}>
              HARBOR CAFE
            </div>
            <div style={{ fontFamily: R_FONT, fontSize: 28, fontWeight: 700, color: R_NAVY, marginTop: 4 }}>Place order</div>
          </div>
          <div style={{ padding: '0 22px' }}>
            {[
              { n: 'Oat Milk 12 x 1L', q: 6, price: '$54.00' },
              { n: 'Espresso Beans 1kg', q: 4, price: '$96.00' },
              { n: 'Paper Cups 500', q: 2, price: '$48.00' },
              { n: 'Sourdough Loaf', q: 10, price: '$62.00' },
              { n: 'Oat Milk 12 x 1L', q: 6, price: '$54.00' },
            ].map((it, i) => {
              const show = clamp((localTime - 1.8 - i * 0.2) / 0.3, 0, 1);
              return (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '14px 16px', background: '#fff',
                  border: `1px solid ${R_BORDER}`, borderRadius: 14,
                  marginBottom: 10,
                  opacity: show, transform: `translateX(${(1 - show) * -14}px)`,
                }}>
                  <div>
                    <div style={{ fontFamily: R_FONT, fontSize: 15, fontWeight: 700, color: R_NAVY }}>{it.n}</div>
                    <div style={{ fontFamily: R_MONO, fontSize: 12, color: R_NAVY_60 }}>qty {it.q}</div>
                  </div>
                  <div style={{ fontFamily: R_FONT, fontSize: 15, fontWeight: 700, color: R_NAVY }}>{it.price}</div>
                </div>
              );
            })}
          </div>
          <div style={{
            position: 'absolute', left: 22, right: 22, bottom: 30,
            padding: 18, background: R_BRAND, color: '#fff',
            borderRadius: 16, textAlign: 'center',
            fontFamily: R_FONT, fontSize: 18, fontWeight: 700,
            boxShadow: `0 10px 24px rgba(37,99,235,0.4)`,
            opacity: clamp((localTime - 3.0) / 0.4, 0, 1),
          }}>Send to wholesaler</div>
        </div>
      </div>

      {/* Your dashboard list appearing on the right */}
      <div style={{
        position: 'absolute', right: 60, top: 780, width: 520,
        background: '#fff', borderRadius: 24, padding: 24,
        boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
        opacity: clamp((localTime - 1.4) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 1.4) / 0.5, 0, 1)) * 24}px)`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ fontFamily: R_FONT, fontSize: 22, fontWeight: 700, color: R_NAVY }}>Your inbox</div>
          <div style={{ fontFamily: R_MONO, fontSize: 12, color: R_NAVY_60, letterSpacing: '0.12em' }}>LIVE</div>
        </div>
        {[
          { cust: 'Harbor Cafe', items: 28, time: '6:02am' },
          { cust: 'Bluestone Grocery', items: 41, time: '6:14am' },
          { cust: 'Nordic Deli', items: 17, time: '6:27am' },
          { cust: 'Station Street Bar', items: 22, time: '6:38am' },
          { cust: 'Maple & Oak', items: 19, time: '6:52am' },
          { cust: 'The Roast House', items: 33, time: '7:08am' },
        ].map((o, i) => {
          const show = clamp((localTime - 2.2 - i * 0.2) / 0.3, 0, 1);
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 100px 90px',
              alignItems: 'center', padding: '14px 0',
              borderBottom: `1px solid ${R_BORDER}`,
              opacity: show, transform: `translateX(${(1 - show) * 16}px)`,
            }}>
              <div style={{ fontFamily: R_FONT, fontSize: 18, fontWeight: 600, color: R_NAVY }}>{o.cust}</div>
              <div style={{ fontFamily: R_FONT, fontSize: 14, color: R_NAVY_60 }}>{o.items} items</div>
              <div style={{ fontFamily: R_MONO, fontSize: 12, color: R_BRAND, fontWeight: 700, letterSpacing: '0.08em', textAlign: 'right' }}>{o.time}</div>
            </div>
          );
        })}
        <div style={{
          marginTop: 14, padding: '12px 16px',
          background: R_SUCCESS_BG, color: R_SUCCESS,
          borderRadius: 12, fontFamily: R_FONT, fontSize: 15, fontWeight: 700,
          textAlign: 'center',
          opacity: clamp((localTime - 3.8) / 0.5, 0, 1),
        }}>
          0 phone calls this morning
        </div>
      </div>
    </div>
  );
}

// ─── SCENE 4 — Route builds itself (16.5 to 22.0s) ─────────────────────
function ReelRoute() {
  const { localTime } = useSprite();
  const tMessy = clamp((localTime - 0.9) / 0.7, 0, 1);
  const tOpt = clamp((localTime - 2.2) / 0.8, 0, 1);

  const stops = [[120,380],[250,220],[420,320],[560,180],[700,360],[850,240],[960,380],[820,540],[540,560],[260,520]];
  const optOrder = [0,1,2,3,4,5,6,7,8,9];
  const messyPath = `M ${stops.map(s=>s.join(' ')).join(' L ')}`;
  const optPath = `M 60 420 L ${optOrder.map(i=>stops[i].join(' ')).join(' L ')}`;

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 60, top: 140, right: 60 }}>
        <div style={{
          fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em',
          color: R_BRAND, fontWeight: 700, opacity: clamp(localTime / 0.4, 0, 1),
        }}>THE ROUTE</div>
        <div style={{
          fontFamily: R_FONT, fontSize: 96, fontWeight: 700,
          color: R_NAVY, letterSpacing: '-0.035em', lineHeight: 1.02,
          marginTop: 20,
          opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
        }}>
          We plan the day.<br/>
          <span style={{ color: R_BRAND }}>You drink your coffee.</span>
        </div>
      </div>

      {/* Map */}
      <div style={{
        position: 'absolute', left: 60, right: 60, top: 580,
        height: 760,
        background: '#F1F5F9',
        border: `1px solid ${R_BORDER}`,
        borderRadius: 28,
        overflow: 'hidden',
      }}>
        <svg width="100%" height="100%" viewBox="0 0 960 700" style={{ display: 'block' }}>
          <defs>
            <pattern id="mapReel" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#CBD5E1" strokeWidth="1" opacity="0.4"/>
            </pattern>
          </defs>
          <rect width="960" height="700" fill="url(#mapReel)"/>
          <path d="M 0 200 Q 300 160 600 210 T 960 180" stroke="#CBD5E1" strokeWidth="4" fill="none" opacity="0.6"/>
          <path d="M 0 480 Q 400 500 800 460 T 960 500" stroke="#CBD5E1" strokeWidth="4" fill="none" opacity="0.6"/>
          <path d="M 320 0 L 300 700" stroke="#CBD5E1" strokeWidth="3" fill="none" opacity="0.5"/>
          <path d="M 760 0 L 780 700" stroke="#CBD5E1" strokeWidth="3" fill="none" opacity="0.5"/>

          {/* Messy first */}
          <path d={messyPath}
            stroke="#DC2626" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray="14 10"
            strokeDashoffset={(1 - tMessy) * 3000}
            opacity={tMessy * (1 - tOpt)}
          />

          {/* Optimized */}
          <path d={optPath}
            stroke={R_BRAND} strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray="3500"
            strokeDashoffset={(1 - tOpt) * 3500}
            opacity={tOpt}
          />

          {/* Depot */}
          <g transform="translate(60, 420)">
            <rect x="-24" y="-24" width="48" height="48" rx="8" fill={R_NAVY}/>
            <text y="7" textAnchor="middle" fontFamily={R_MONO} fontSize="18" fontWeight="700" fill="#fff">W</text>
          </g>

          {stops.map(([cx,cy], i) => {
            const a = clamp((localTime - 0.2 - i * 0.05) / 0.3, 0, 1);
            const idx = optOrder.indexOf(i) + 1;
            return (
              <g key={i} transform={`translate(${cx},${cy}) scale(${a})`} opacity={a}>
                <circle r="24" fill={tOpt > 0.5 ? R_BRAND : '#fff'} stroke={tOpt > 0.5 ? R_BRAND_DARK : '#64748B'} strokeWidth="3"/>
                <text y="7" textAnchor="middle" fontFamily={R_MONO} fontSize="17" fontWeight="700" fill={tOpt > 0.5 ? '#fff' : R_NAVY}>
                  {tOpt > 0.5 ? idx : i + 1}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Before / After pill */}
        <div style={{
          position: 'absolute', top: 20, left: 20,
          padding: '10px 18px', borderRadius: 10,
          fontFamily: R_MONO, fontSize: 16, fontWeight: 700, letterSpacing: '0.18em',
          background: tOpt > 0.5 ? R_BRAND_LIGHT : '#FEE2E2',
          color: tOpt > 0.5 ? R_BRAND_DARK : '#DC2626',
        }}>{tOpt > 0.5 ? 'OPTIMIZED' : 'DOING IT BY HAND'}</div>

        {/* Stat chips after optimization */}
        <div style={{
          position: 'absolute', bottom: 24, left: 24, right: 24,
          display: 'flex', gap: 12,
          opacity: clamp((localTime - 3.4) / 0.5, 0, 1),
        }}>
          {[
            { k: 'Miles', v: '-34%' },
            { k: 'Hours saved', v: '2.1 / day' },
            { k: 'Fuel', v: '-28%' },
          ].map((c, i) => (
            <div key={i} style={{
              flex: 1, padding: '14px 18px',
              background: 'rgba(255,255,255,0.96)',
              border: `1px solid ${R_BORDER}`, borderRadius: 12,
            }}>
              <div style={{ fontFamily: R_MONO, fontSize: 12, letterSpacing: '0.12em', color: R_NAVY_60, fontWeight: 700 }}>{c.k.toUpperCase()}</div>
              <div style={{ fontFamily: R_FONT, fontSize: 26, fontWeight: 700, color: R_BRAND, marginTop: 4 }}>{c.v}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{
        position: 'absolute', left: 60, right: 60, bottom: 100,
        fontFamily: R_FONT, fontSize: 36, fontWeight: 500, lineHeight: 1.35,
        color: R_NAVY_80, textAlign: 'center',
        opacity: clamp((localTime - 4.0) / 0.5, 0, 1),
      }}>
        Stops arranged the smart way. Every morning. Automatically.
      </div>
    </div>
  );
}

// ─── SCENE 5 — Driver phone (22.0 to 28.0s) ────────────────────────────
function ReelDriver() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: R_CREAM, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 60, top: 140, right: 60 }}>
        <div style={{
          fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em',
          color: R_BRAND, fontWeight: 700, opacity: clamp(localTime / 0.4, 0, 1),
        }}>THE VAN</div>
        <div style={{
          fontFamily: R_FONT, fontSize: 96, fontWeight: 700,
          color: R_NAVY, letterSpacing: '-0.035em', lineHeight: 1.02,
          marginTop: 20,
          opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
        }}>Your driver just taps.</div>
        <div style={{
          fontFamily: R_FONT, fontSize: 34, fontWeight: 500, lineHeight: 1.35,
          color: R_NAVY_80, marginTop: 22, maxWidth: 860,
          opacity: clamp((localTime - 0.7) / 0.5, 0, 1),
        }}>
          Turn by turn guidance. Scan the crate. Capture a signature. Move on. Nothing to write down. Nothing to remember.
        </div>
      </div>

      {/* Phone centered */}
      <div style={{
        position: 'absolute', left: '50%', top: 700,
        transform: `translateX(-50%) scale(${0.96 + 0.04 * Easing.easeOutCubic(clamp(localTime / 0.8, 0, 1))})`,
        opacity: clamp(localTime / 0.6, 0, 1),
      }}>
        <div style={{
          width: 520, height: 1060, background: '#111',
          borderRadius: 70, padding: 16,
          boxShadow: '0 50px 120px rgba(0,0,0,0.35)',
        }}>
          <div style={{ width: '100%', height: '100%', background: R_CREAM, borderRadius: 56, overflow: 'hidden', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 18, left: '50%', transform: 'translateX(-50%)', width: 160, height: 40, background: '#111', borderRadius: 20, zIndex: 10 }}/>
            <div style={{ padding: '24px 36px 10px', display: 'flex', justifyContent: 'space-between', fontFamily: R_FONT, fontSize: 20, fontWeight: 700, color: R_NAVY }}>
              <span>9:41</span><span>●●●</span>
            </div>

            {/* Header */}
            <div style={{ padding: '28px 32px 14px' }}>
              <div style={{ fontFamily: R_MONO, fontSize: 14, letterSpacing: '0.15em', color: R_BRAND, fontWeight: 700 }}>
                ROUTE R-28 · STOP 3 OF 10
              </div>
              <div style={{ fontFamily: R_FONT, fontSize: 36, fontWeight: 700, color: R_NAVY, marginTop: 6, letterSpacing: '-0.02em' }}>Nordic Deli</div>
              <div style={{ fontFamily: R_FONT, fontSize: 18, color: R_NAVY_80, marginTop: 2 }}>221 Pine Ave</div>
            </div>

            {/* Phase 1: stop card */}
            <PhaseCrossfade localTime={localTime} aStart={1.2} aEnd={2.8} bStart={3.0} bEnd={4.6}
              phaseA={
                <div style={{ padding: '0 30px' }}>
                  {[
                    { n: 'Oat Milk 12 x 1L', q: 6, scanned: true },
                    { n: 'Espresso Beans 1kg', q: 4, scanned: true },
                    { n: 'Paper Cups 500', q: 2, scanned: true },
                    { n: 'Sourdough Loaf', q: 10, scanned: false },
                  ].map((it, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '16px 18px', marginBottom: 10,
                      background: it.scanned ? R_SUCCESS_BG : '#fff',
                      border: `1px solid ${it.scanned ? '#BBF7D0' : R_BORDER}`,
                      borderRadius: 14,
                    }}>
                      <div>
                        <div style={{ fontFamily: R_FONT, fontSize: 18, fontWeight: 700, color: R_NAVY }}>{it.n}</div>
                        <div style={{ fontFamily: R_MONO, fontSize: 13, color: R_NAVY_60 }}>qty {it.q}</div>
                      </div>
                      <div style={{
                        fontFamily: R_MONO, fontSize: 18, fontWeight: 700,
                        color: it.scanned ? R_SUCCESS : R_NAVY_60,
                      }}>{it.scanned ? '✓' : '...'}</div>
                    </div>
                  ))}
                  <div style={{
                    marginTop: 14, padding: 18, background: R_BRAND,
                    color: '#fff', borderRadius: 16, textAlign: 'center',
                    fontFamily: R_FONT, fontSize: 20, fontWeight: 700,
                    boxShadow: `0 10px 24px rgba(37,99,235,0.35)`,
                  }}>Scan next item</div>
                </div>
              }
              phaseB={
                <div style={{ padding: '0 30px' }}>
                  <div style={{
                    padding: 20, background: '#fff',
                    border: `1px solid ${R_BORDER}`, borderRadius: 16,
                  }}>
                    <div style={{ fontFamily: R_MONO, fontSize: 12, letterSpacing: '0.12em', color: R_NAVY_60, fontWeight: 700 }}>DELIVERY TOTAL</div>
                    <div style={{ fontFamily: R_FONT, fontSize: 36, fontWeight: 700, color: R_NAVY, marginTop: 4 }}>$284.50</div>
                    <div style={{ fontFamily: R_FONT, fontSize: 15, color: R_NAVY_60, marginTop: 2 }}>4 line items · all scanned</div>
                  </div>
                  <div style={{
                    marginTop: 14, height: 240,
                    background: '#fff', border: `1px dashed ${R_BORDER}`,
                    borderRadius: 16, position: 'relative', overflow: 'hidden',
                  }}>
                    <div style={{ position: 'absolute', top: 14, left: 18, fontFamily: R_MONO, fontSize: 12, color: '#94A3B8', letterSpacing: '0.12em', fontWeight: 700 }}>SIGN HERE</div>
                    <svg width="100%" height="100%" viewBox="0 0 460 240" style={{ position: 'absolute', inset: 0 }}>
                      <path
                        d="M 60 160 Q 100 80 150 140 T 240 120 Q 290 100 320 150 T 400 140"
                        stroke={R_NAVY} strokeWidth="4" fill="none" strokeLinecap="round"
                        strokeDasharray="600"
                        strokeDashoffset={clamp(600 - (localTime - 3.2) * 400, 0, 600)}
                      />
                    </svg>
                  </div>
                  <div style={{
                    marginTop: 14, padding: 18, background: R_SUCCESS,
                    color: '#fff', borderRadius: 16, textAlign: 'center',
                    fontFamily: R_FONT, fontSize: 20, fontWeight: 700,
                    boxShadow: `0 10px 24px rgba(22,163,74,0.3)`,
                  }}>Delivered. Invoice sent.</div>
                </div>
              }
            />
          </div>
        </div>
      </div>

      {/* Reassuring caption */}
      <div style={{
        position: 'absolute', left: 60, right: 60, bottom: 80,
        fontFamily: R_FONT, fontSize: 34, fontWeight: 500,
        color: R_NAVY_80, textAlign: 'center', lineHeight: 1.3,
        opacity: clamp((localTime - 4.8) / 0.4, 0, 1),
      }}>
        Works offline. Syncs when the signal comes back.
      </div>
    </div>
  );
}

function PhaseCrossfade({ localTime, aStart, aEnd, bStart, bEnd, phaseA, phaseB }) {
  const aOpacity = localTime < bStart
    ? clamp((localTime - aStart) / 0.3, 0, 1)
    : 1 - clamp((localTime - bStart) / 0.3, 0, 1);
  const bOpacity = clamp((localTime - bStart) / 0.3, 0, 1);
  return (
    <>
      <div style={{ opacity: aOpacity, position: 'absolute', left: 0, right: 0 }}>{phaseA}</div>
      <div style={{ opacity: bOpacity, position: 'absolute', left: 0, right: 0 }}>{phaseB}</div>
    </>
  );
}

// ─── SCENE 6 — Invoices auto (28.0 to 33.0s) ───────────────────────────
function ReelInvoice() {
  const { localTime } = useSprite();
  return (
    <div style={{ position: 'absolute', inset: 0, background: R_BRAND_LIGHT, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 60, top: 140, right: 60 }}>
        <div style={{
          fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em',
          color: R_BRAND, fontWeight: 700, opacity: clamp(localTime / 0.4, 0, 1),
        }}>PAID FASTER</div>
        <div style={{
          fontFamily: R_FONT, fontSize: 96, fontWeight: 700,
          color: R_NAVY, letterSpacing: '-0.035em', lineHeight: 1.02,
          marginTop: 20,
          opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
        }}>
          Delivered means invoiced.
        </div>
        <div style={{
          fontFamily: R_FONT, fontSize: 36, fontWeight: 500, lineHeight: 1.35,
          color: R_NAVY_80, marginTop: 22, maxWidth: 900,
          opacity: clamp((localTime - 0.7) / 0.5, 0, 1),
        }}>
          The moment the signature lands, your invoice is out the door. Statements, credit notes and returns are one tap away.
        </div>
      </div>

      {/* Invoice paper slide-in */}
      <div style={{
        position: 'absolute', left: 80, right: 80, top: 680, height: 900,
        background: '#fff', borderRadius: 28,
        boxShadow: '0 40px 100px rgba(15,31,51,0.2)',
        padding: 48,
        opacity: clamp((localTime - 1.0) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 1.0) / 0.5, 0, 1)) * 40}px) rotate(-1deg)`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Wordmark size={44} color={R_NAVY} mark={R_BRAND} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: R_MONO, fontSize: 14, letterSpacing: '0.12em', color: R_NAVY_60, fontWeight: 700 }}>INVOICE</div>
            <div style={{ fontFamily: R_FONT, fontSize: 32, fontWeight: 700, color: R_NAVY, marginTop: 4 }}>INV-10428</div>
          </div>
        </div>

        <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div style={{ fontFamily: R_MONO, fontSize: 12, letterSpacing: '0.12em', color: R_NAVY_60 }}>BILL TO</div>
            <div style={{ fontFamily: R_FONT, fontSize: 22, fontWeight: 700, color: R_NAVY, marginTop: 6 }}>Nordic Deli</div>
            <div style={{ fontFamily: R_FONT, fontSize: 16, color: R_NAVY_80, marginTop: 2 }}>221 Pine Ave</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: R_MONO, fontSize: 12, letterSpacing: '0.12em', color: R_NAVY_60 }}>DELIVERED</div>
            <div style={{ fontFamily: R_FONT, fontSize: 22, fontWeight: 700, color: R_NAVY, marginTop: 6 }}>Apr 17, 2026</div>
            <div style={{ fontFamily: R_FONT, fontSize: 16, color: R_NAVY_80, marginTop: 2 }}>at 9:42am</div>
          </div>
        </div>

        {/* Line items */}
        <div style={{ marginTop: 36, borderTop: `1px solid ${R_BORDER}` }}>
          {[
            { n: 'Oat Milk 12 x 1L', q: 6, p: 54.00 },
            { n: 'Espresso Beans 1kg', q: 4, p: 96.00 },
            { n: 'Paper Cups 500', q: 2, p: 48.00 },
            { n: 'Sourdough Loaf', q: 10, p: 62.00 },
          ].map((it, i) => {
            const show = clamp((localTime - 1.4 - i * 0.15) / 0.3, 0, 1);
            return (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '1fr 80px 120px',
                alignItems: 'center', gap: 20,
                padding: '18px 0', borderBottom: `1px solid ${R_BORDER}`,
                opacity: show, transform: `translateX(${(1 - show) * -12}px)`,
              }}>
                <div style={{ fontFamily: R_FONT, fontSize: 20, color: R_NAVY, fontWeight: 600 }}>{it.n}</div>
                <div style={{ fontFamily: R_FONT, fontSize: 16, color: R_NAVY_60 }}>qty {it.q}</div>
                <div style={{ fontFamily: R_FONT, fontSize: 20, fontWeight: 700, color: R_NAVY, textAlign: 'right' }}>${it.p.toFixed(2)}</div>
              </div>
            );
          })}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '24px 0', marginTop: 12,
        }}>
          <div style={{ fontFamily: R_FONT, fontSize: 26, fontWeight: 700, color: R_NAVY }}>Total</div>
          <div style={{ fontFamily: R_FONT, fontSize: 48, fontWeight: 700, color: R_NAVY, letterSpacing: '-0.02em' }}>
            $<Counter to={260.00} duration={1.0} start={2.2} decimals={2} />
          </div>
        </div>

        {/* PAID stamp */}
        <div style={{
          position: 'absolute', top: 56, right: 80,
          padding: '14px 28px',
          border: `4px solid ${R_SUCCESS}`,
          color: R_SUCCESS, fontFamily: R_FONT, fontWeight: 800, fontSize: 38,
          letterSpacing: '0.08em',
          transform: `rotate(-14deg) scale(${clamp((localTime - 3.4) / 0.4, 0, 1)})`,
          opacity: clamp((localTime - 3.4) / 0.4, 0, 1),
          borderRadius: 6,
        }}>SENT</div>
      </div>

      <div style={{
        position: 'absolute', left: 60, right: 60, bottom: 80,
        fontFamily: R_FONT, fontSize: 34, fontWeight: 500,
        color: R_NAVY_80, textAlign: 'center',
        opacity: clamp((localTime - 4.0) / 0.4, 0, 1),
      }}>
        Operators get paid, on average, 12 days sooner.
      </div>
    </div>
  );
}

// ─── SCENE 7 — Everything in one place (33.0 to 40.0s) ─────────────────
function ReelAll() {
  const { localTime } = useSprite();
  const features = [
    'Orders in from every customer',
    'Route optimization, built in',
    'Driver mobile app',
    'Barcode scanning and POD',
    'Auto invoices on delivery',
    'Standing and recurring orders',
    'Returns and credit notes',
    'Customer self service portal',
    'Statements on demand',
    'Inventory and suppliers',
    'Finance dashboard',
    'Team roles and permissions',
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#fff' }}>
      <div style={{ position: 'absolute', left: 60, top: 140, right: 60 }}>
        <div style={{
          fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em',
          color: R_BRAND, fontWeight: 700, opacity: clamp(localTime / 0.4, 0, 1),
        }}>ALL OF IT</div>
        <div style={{
          fontFamily: R_FONT, fontSize: 92, fontWeight: 700,
          color: R_NAVY, letterSpacing: '-0.035em', lineHeight: 1.02,
          marginTop: 20,
          opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
        }}>
          One login.<br/>Twelve jobs done.
        </div>
        <div style={{
          fontFamily: R_FONT, fontSize: 34, fontWeight: 500, lineHeight: 1.35,
          color: R_NAVY_80, marginTop: 20, maxWidth: 900,
          opacity: clamp((localTime - 0.7) / 0.5, 0, 1),
        }}>
          No more spreadsheets stuck together with tape. It all lives here.
        </div>
      </div>
      <div style={{
        position: 'absolute', left: 60, right: 60, top: 680,
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
      }}>
        {features.map((f, i) => {
          const show = clamp((localTime - 1.1 - i * 0.14) / 0.35, 0, 1);
          return (
            <div key={i} style={{
              padding: '22px 24px',
              background: R_CREAM,
              border: `1px solid ${R_BORDER}`, borderRadius: 16,
              display: 'flex', alignItems: 'center', gap: 16,
              opacity: show, transform: `translateY(${(1 - show) * 16}px)`,
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: R_BRAND, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="20" height="20" viewBox="0 0 14 14"><path d="M3 7l3 3 5-6" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div style={{
                fontFamily: R_FONT, fontSize: 22, fontWeight: 600,
                color: R_NAVY, letterSpacing: '-0.01em',
              }}>{f}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── SCENE 8 — The promise (40.0 to 47.0s) ─────────────────────────────
// Warm human voice. Big numbers. Warmth.
function ReelPromise() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(180deg, ${R_NAVY} 0%, #0F2544 100%)`,
      overflow: 'hidden',
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.08 }}>
        <defs>
          <pattern id="promiseGrid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#promiseGrid)"/>
      </svg>

      <div style={{ position: 'absolute', left: 60, top: 140, right: 60 }}>
        <div style={{
          fontFamily: R_MONO, fontSize: 22, letterSpacing: '0.22em',
          color: '#7DB6FF', fontWeight: 700, opacity: clamp(localTime / 0.4, 0, 1),
        }}>90 DAYS IN</div>
        <div style={{
          fontFamily: R_FONT, fontSize: 96, fontWeight: 700,
          color: '#fff', letterSpacing: '-0.035em', lineHeight: 1.02,
          marginTop: 20,
          opacity: clamp((localTime - 0.3) / 0.5, 0, 1),
        }}>
          What wholesalers<br/>tell us they feel.
        </div>
      </div>

      {/* Stacked big stats */}
      <div style={{
        position: 'absolute', left: 60, right: 60, top: 640,
        display: 'flex', flexDirection: 'column', gap: 28,
      }}>
        {[
          { v: 34, suffix: '%', label: 'less time planning routes', delay: 0.7 },
          { v: 3.2, suffix: 'x', decimals: 1, label: 'faster invoicing cycle', delay: 1.1 },
          { v: 97, suffix: '%', label: 'on time delivery rate', delay: 1.5 },
          { v: 12, suffix: ' days', label: 'shorter days to paid', delay: 1.9 },
        ].map((m, i) => {
          const show = clamp((localTime - m.delay) / 0.4, 0, 1);
          return (
            <div key={i} style={{
              borderTop: `2px solid ${R_BRAND}`,
              paddingTop: 24,
              opacity: show, transform: `translateY(${(1 - show) * 20}px)`,
              display: 'grid', gridTemplateColumns: '420px 1fr', gap: 32, alignItems: 'center',
            }}>
              <div style={{
                fontFamily: R_FONT, fontSize: 144, fontWeight: 700,
                letterSpacing: '-0.04em', lineHeight: 1, color: '#fff',
              }}>
                <Counter to={m.v} duration={1.0} start={m.delay + 0.1} suffix={m.suffix} decimals={m.decimals || 0} />
              </div>
              <div style={{
                fontFamily: R_FONT, fontSize: 30, fontWeight: 400,
                color: 'rgba(255,255,255,0.78)', lineHeight: 1.3,
              }}>{m.label}</div>
            </div>
          );
        })}
      </div>

      <div style={{
        position: 'absolute', left: 80, right: 80, bottom: 120,
        fontFamily: R_FONT, fontSize: 34, fontWeight: 500, lineHeight: 1.35,
        color: 'rgba(255,255,255,0.8)', textAlign: 'center', fontStyle: 'italic',
        opacity: clamp((localTime - 5.2) / 0.5, 0, 1),
      }}>
        “I get Saturday afternoons back.”
        <div style={{
          fontStyle: 'normal', fontSize: 22, marginTop: 12, color: '#7DB6FF',
          letterSpacing: '0.1em', fontFamily: R_MONO, fontWeight: 600,
        }}>JORDAN, HARBOR COFFEE SUPPLY</div>
      </div>
    </div>
  );
}

// ─── SCENE 9 — CTA (47.0 to 52.5s) ─────────────────────────────────────
function ReelCTA() {
  const { localTime } = useSprite();
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: `linear-gradient(135deg, ${R_NAVY} 0%, ${R_BRAND_DARK} 100%)`,
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.07 }}>
        <defs>
          <pattern id="ctaGrid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#fff" strokeWidth="1"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ctaGrid)"/>
      </svg>

      <div style={{
        opacity: clamp(localTime / 0.5, 0, 1),
        transform: `scale(${0.9 + 0.1 * Easing.easeOutBack(clamp(localTime / 0.6, 0, 1))})`,
      }}>
        <Wordmark size={130} color="#fff" mark="#fff" />
      </div>

      <div style={{
        fontFamily: R_FONT, fontSize: 84, fontWeight: 700,
        color: '#fff', letterSpacing: '-0.03em', lineHeight: 1.05,
        marginTop: 80, textAlign: 'center',
        maxWidth: 920, textWrap: 'balance',
        opacity: clamp((localTime - 0.6) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 0.6) / 0.5, 0, 1)) * 20}px)`,
      }}>
        Ready for a calmer Monday?
      </div>

      <div style={{
        fontFamily: R_FONT, fontSize: 34, fontWeight: 400, lineHeight: 1.4,
        color: 'rgba(255,255,255,0.78)', marginTop: 28, textAlign: 'center',
        maxWidth: 900,
        opacity: clamp((localTime - 1.2) / 0.5, 0, 1),
      }}>
        14 day trial. No card. We move your customer list in a day.
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 20, marginTop: 80,
        alignItems: 'center',
        opacity: clamp((localTime - 1.8) / 0.5, 0, 1),
        transform: `translateY(${(1 - clamp((localTime - 1.8) / 0.5, 0, 1)) * 20}px)`,
      }}>
        <div style={{
          padding: '26px 70px', background: '#fff', color: R_NAVY,
          borderRadius: 20, fontFamily: R_FONT, fontSize: 34, fontWeight: 700,
          letterSpacing: '-0.01em', boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
        }}>Start free trial</div>
        <div style={{
          padding: '22px 60px', background: 'transparent', color: '#fff',
          border: '2px solid rgba(255,255,255,0.5)',
          borderRadius: 20, fontFamily: R_FONT, fontSize: 28, fontWeight: 600,
        }}>Book a 15 minute demo</div>
      </div>

      <div style={{
        position: 'absolute', bottom: 100, left: 0, right: 0,
        textAlign: 'center',
        fontFamily: R_MONO, fontSize: 24, letterSpacing: '0.25em',
        color: 'rgba(255,255,255,0.75)', fontWeight: 600,
        opacity: clamp((localTime - 2.6) / 0.5, 0, 1),
      }}>WWW.ROUTEFLOW.INFO</div>
    </div>
  );
}

Object.assign(window, {
  ReelHook, ReelMeet, ReelMorning, ReelRoute, ReelDriver,
  ReelInvoice, ReelAll, ReelPromise, ReelCTA,
});
