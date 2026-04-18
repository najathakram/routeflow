"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  Truck,
  Users,
  MapPin,
  Receipt,
  Scan,
  Signature,
  TrendingDown,
  Clock,
  Zap,
} from "lucide-react";

const DURATION = 66; // animation seconds
const PX_PER_SEC = 120; // scroll pixels per animation second
const SCROLL_HEIGHT = DURATION * PX_PER_SEC; // desktop drives through 7920px
const MOBILE_BREAKPOINT = 768;

export function ProductVideo() {
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (mounted && isMobile) return <MobileProductTour />;
  return <DesktopScrollVideo />;
}

// ─── Desktop scroll-driven (unchanged) ────────────────────────────────────

function DesktopScrollVideo() {
  const outerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastTimeRef = useRef(-1);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;

    const onScroll = () => {
      const rect = outer.getBoundingClientRect();
      const scrolledIn = -rect.top;
      const clamped = Math.max(0, Math.min(SCROLL_HEIGHT, scrolledIn));
      const time = (clamped / SCROLL_HEIGHT) * DURATION;

      if (Math.abs(time - lastTimeRef.current) >= 0.05) {
        lastTimeRef.current = time;
        iframeRef.current?.contentWindow?.postMessage({ type: "seekTo", time }, "*");
        if (progressRef.current) {
          progressRef.current.style.width = `${(clamped / SCROLL_HEIGHT) * 100}%`;
        }
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      ref={outerRef}
      style={{ height: `calc(100vh + ${SCROLL_HEIGHT}px)`, position: "relative" }}
    >
      <div
        style={{
          position: "sticky",
          top: 0,
          height: "100vh",
          overflow: "hidden",
        }}
      >
        <iframe
          ref={iframeRef}
          src="/video/marketing-video.html?scroll=1"
          title="RouteFlow Product Tour"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          loading="eager"
        />

        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 3,
            background: "rgba(255,255,255,0.1)",
          }}
        >
          <div
            ref={progressRef}
            style={{
              height: "100%",
              width: "0%",
              background: "#2563EB",
              transition: "width 80ms linear",
            }}
          />
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            color: "rgba(255,255,255,0.5)",
            fontSize: 12,
            fontFamily: "Inter, system-ui, sans-serif",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            pointerEvents: "none",
            animation: "fadeHint 3s ease 1.5s forwards",
          }}
        >
          <span>Scroll to explore</span>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M10 4v12M5 11l5 5 5-5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <style>{`
          @keyframes fadeHint {
            0%   { opacity: 1; }
            70%  { opacity: 1; }
            100% { opacity: 0; }
          }
        `}</style>
      </div>
    </div>
  );
}

// ─── Mobile native product tour ───────────────────────────────────────────
// Instead of a scaled-down 16:9 video, render the same story as a stack of
// portrait-first scenes. Each scene fades/slides in when scrolled into view.

function MobileProductTour() {
  return (
    <div className="bg-white">
      <SceneIntro />
      <SceneOperator />
      <SceneRoutes />
      <SceneDriver />
      <SceneCustomer />
      <SceneOutro />
    </div>
  );
}

// Fade/slide-in wrapper triggered when element scrolls into view
function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setVisible(true);
        });
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      } ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

function SceneKicker({ label, dark = false }: { label: string; dark?: boolean }) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-widest ${
        dark
          ? "border-brand-400/30 bg-white/5 text-brand-300"
          : "border-brand-200 bg-brand-50 text-brand-700"
      }`}
    >
      {label}
    </div>
  );
}

// ─── Scene: Intro / Pitch ─────────────────────────────────────────────────

function SceneIntro() {
  const pillars = [
    {
      icon: ClipboardList,
      tag: "Operator",
      title: "Dashboard",
      sub: "Orders • Dispatch • Invoicing",
    },
    {
      icon: Truck,
      tag: "Driver",
      title: "Mobile App",
      sub: "Routes • POD • Scanning",
    },
    {
      icon: Users,
      tag: "Customer",
      title: "Portal",
      sub: "Orders • Invoices • Returns",
    },
  ];

  return (
    <section className="bg-white px-5 py-16">
      <div className="mx-auto max-w-lg">
        <Reveal>
          <SceneKicker label="Product Tour" />
        </Reveal>
        <Reveal delay={100}>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-navy">
            One platform,<br />
            <span className="text-brand-600">end to end.</span>
          </h2>
        </Reveal>
        <Reveal delay={200}>
          <p className="mt-3 text-sm leading-relaxed text-navy/60">
            Your orders, routes, drivers, invoices, and customers — connected from the warehouse to
            the doorstep.
          </p>
        </Reveal>

        <div className="mt-8 grid gap-3">
          {pillars.map((p, i) => (
            <Reveal key={p.tag} delay={300 + i * 120}>
              <div className="flex items-center gap-4 rounded-2xl border border-surface-border bg-surface-raised p-4 shadow-sm">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
                  <p.icon className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-brand-600">
                    {p.tag}
                  </div>
                  <div className="text-base font-bold text-navy">{p.title}</div>
                  <div className="text-xs text-navy/60">{p.sub}</div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Scene: Operator ──────────────────────────────────────────────────────

function SceneOperator() {
  const features = [
    "Multi-stop route builder with ORS optimization",
    "Auto-invoice the moment a delivery is signed",
    "Recurring orders & weekly standing templates",
    "Returns, credit notes & customer ledger built in",
  ];

  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-[#0f1b2d] via-[#152238] to-[#1a2d4a] px-5 py-16">
      <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-brand-600/20 blur-3xl" />
      <div className="relative mx-auto max-w-lg">
        <Reveal>
          <SceneKicker label="01 · In the office" dark />
        </Reveal>
        <Reveal delay={100}>
          <h2 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-white">
            Orders in.<br />
            Routes out.<br />
            <span className="text-brand-400">Invoices done.</span>
          </h2>
        </Reveal>

        <div className="mt-8 space-y-3">
          {features.map((f, i) => (
            <Reveal key={i} delay={200 + i * 120}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500">
                  <CheckCircle2 className="h-4 w-4 text-white" />
                </div>
                <p className="text-sm leading-relaxed text-blue-100/90">{f}</p>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Dashboard mockup */}
        <Reveal delay={800} className="mt-10">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-brand-300">
                  Orders · Today
                </div>
                <div className="text-base font-bold text-white">14 to dispatch</div>
              </div>
              <div className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-bold text-white">
                Build route
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {[
                { id: "ORD-1042", cust: "Harbor Cafe", status: "Ready", tone: "ready" },
                { id: "ORD-1043", cust: "Bluestone Grocery", status: "Ready", tone: "ready" },
                { id: "ORD-1044", cust: "Nordic Deli", status: "Picking", tone: "picking" },
                { id: "ORD-1045", cust: "Maple & Oak", status: "New", tone: "new" },
              ].map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2"
                >
                  <div>
                    <div className="font-mono text-[10px] text-blue-200/60">{o.id}</div>
                    <div className="text-xs font-semibold text-white">{o.cust}</div>
                  </div>
                  <StatusPill tone={o.tone} label={o.status} />
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function StatusPill({ tone, label }: { tone: string; label: string }) {
  const map: Record<string, string> = {
    ready: "bg-emerald-500/20 text-emerald-300",
    picking: "bg-amber-500/20 text-amber-300",
    new: "bg-sky-500/20 text-sky-300",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        map[tone] ?? "bg-white/10 text-white"
      }`}
    >
      {label}
    </span>
  );
}

// ─── Scene: Routes ────────────────────────────────────────────────────────

function SceneRoutes() {
  return (
    <section className="bg-surface-raised px-5 py-16">
      <div className="mx-auto max-w-lg">
        <Reveal>
          <SceneKicker label="02 · On the road" />
        </Reveal>
        <Reveal delay={100}>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-navy">
            Smarter routes.<br />
            <span className="text-brand-600">Fewer miles.</span>
          </h2>
        </Reveal>
        <Reveal delay={200}>
          <p className="mt-3 text-sm leading-relaxed text-navy/60">
            Automatic optimization reorders every stop. Your drivers leave the depot on the best
            path, not the oldest one.
          </p>
        </Reveal>

        {/* Mini route map */}
        <Reveal delay={300} className="mt-8">
          <div className="rounded-2xl border border-surface-border bg-white p-4 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <span className="rounded-md bg-brand-50 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-brand-700">
                Optimized
              </span>
              <span className="text-[10px] text-navy/50">10 stops</span>
            </div>
            <MiniRouteMap />
          </div>
        </Reveal>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <Reveal delay={450}>
            <StatCard
              icon={TrendingDown}
              value="34%"
              label="fewer miles driven"
            />
          </Reveal>
          <Reveal delay={550}>
            <StatCard icon={Clock} value="2.1h" label="saved per driver / day" />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  label: string;
}) {
  return (
    <div className="rounded-2xl border border-surface-border bg-white p-4 shadow-sm">
      <Icon className="h-5 w-5 text-brand-600" />
      <div className="mt-2 text-3xl font-extrabold tracking-tight text-navy">{value}</div>
      <div className="mt-1 text-[11px] leading-snug text-navy/60">{label}</div>
    </div>
  );
}

function MiniRouteMap() {
  const stops: Array<[number, number]> = [
    [12, 70], [26, 30], [42, 55], [56, 25], [70, 65],
    [82, 35], [92, 60], [68, 85], [42, 85], [24, 80],
  ];
  const path = `M 0 50 ${stops.map(([x, y]) => `L ${x} ${y}`).join(" ")}`;

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-gradient-to-br from-slate-50 to-slate-100">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
        {/* grid */}
        <defs>
          <pattern id="mmg" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#cbd5e1" strokeWidth="0.3" />
          </pattern>
        </defs>
        <rect width="100" height="100" fill="url(#mmg)" />
        {/* roads */}
        <path d="M 0 30 Q 50 20 100 35" stroke="#cbd5e1" strokeWidth="0.8" fill="none" />
        <path d="M 0 75 Q 60 85 100 70" stroke="#cbd5e1" strokeWidth="0.8" fill="none" />

        {/* optimized route */}
        <path
          d={path}
          stroke="#2563EB"
          strokeWidth="1.2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="400"
          className="animate-[dashdraw_2.5s_ease-out_forwards]"
        />

        {/* depot */}
        <rect x="-3" y="47" width="6" height="6" rx="1" fill="#1B3A5C" />
        {/* stops */}
        {stops.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r="2.4" fill="#2563EB" />
            <text
              x={x}
              y={y + 0.9}
              textAnchor="middle"
              fontSize="2.4"
              fontWeight="700"
              fill="#fff"
              fontFamily="monospace"
            >
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
      <style>{`
        @keyframes dashdraw {
          from { stroke-dashoffset: 400; }
          to   { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  );
}

// ─── Scene: Driver ────────────────────────────────────────────────────────

function SceneDriver() {
  const benefits = [
    { icon: MapPin, t: "Turn-by-turn guidance", s: "to the next customer" },
    { icon: Scan, t: "Barcode scanning", s: "confirm every item leaves the van" },
    { icon: Signature, t: "Proof of delivery", s: "signature + damage capture" },
    { icon: Zap, t: "Offline-ready", s: "keeps working when the signal drops" },
  ];

  return (
    <section className="bg-white px-5 py-16">
      <div className="mx-auto max-w-lg">
        <Reveal>
          <SceneKicker label="03 · In the van" />
        </Reveal>
        <Reveal delay={100}>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-navy">
            A co-pilot for<br />
            <span className="text-brand-600">every driver.</span>
          </h2>
        </Reveal>

        {/* Phone mockup */}
        <Reveal delay={200} className="mt-8">
          <div className="mx-auto w-full max-w-[280px]">
            <div className="rounded-[36px] bg-navy p-2 shadow-2xl">
              <div className="relative overflow-hidden rounded-[30px] bg-surface-raised">
                <div className="absolute left-1/2 top-2 z-10 h-5 w-20 -translate-x-1/2 rounded-full bg-navy" />
                <div className="flex items-center justify-between px-5 pb-1 pt-3 text-[10px] font-bold text-navy">
                  <span>9:41</span>
                  <span>●●●</span>
                </div>
                <div className="px-4 pb-4 pt-4">
                  <div className="font-mono text-[9px] font-bold uppercase tracking-widest text-brand-600">
                    Route R-28
                  </div>
                  <div className="text-base font-bold text-navy">Today's run</div>

                  <div className="mt-3 space-y-1.5">
                    {[
                      { n: 1, name: "Harbor Cafe", addr: "12 Quay St", done: true },
                      { n: 2, name: "Bluestone Grocery", addr: "48 Mill Rd", done: true },
                      { n: 3, name: "Nordic Deli", addr: "221 Pine Ave", active: true },
                      { n: 4, name: "Station Street", addr: "7 Elm Ln" },
                    ].map((s) => (
                      <div
                        key={s.n}
                        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                          s.active
                            ? "border-brand-600 bg-brand-50"
                            : "border-surface-border bg-white"
                        }`}
                      >
                        <div
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold ${
                            s.done
                              ? "bg-emerald-600 text-white"
                              : s.active
                                ? "bg-brand-600 text-white"
                                : "border-2 border-surface-border text-navy"
                          }`}
                        >
                          {s.done ? "✓" : s.n}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-bold text-navy">{s.name}</div>
                          <div className="truncate text-[9px] text-navy/60">{s.addr}</div>
                        </div>
                        {s.active && (
                          <span className="rounded bg-brand-600 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-white">
                            NEXT
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        <div className="mt-8 space-y-3">
          {benefits.map((b, i) => (
            <Reveal key={b.t} delay={400 + i * 120}>
              <div className="flex items-start gap-3 rounded-xl border border-surface-border bg-white p-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <b.icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-bold text-navy">{b.t}</div>
                  <div className="text-xs text-navy/60">{b.s}</div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Scene: Customer ──────────────────────────────────────────────────────

function SceneCustomer() {
  return (
    <section className="bg-surface-raised px-5 py-16">
      <div className="mx-auto max-w-lg">
        <Reveal>
          <SceneKicker label="04 · For your customers" />
        </Reveal>
        <Reveal delay={100}>
          <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-navy">
            Your customers, on<br />
            <span className="text-brand-600">self-service.</span>
          </h2>
        </Reveal>
        <Reveal delay={200}>
          <p className="mt-3 text-sm leading-relaxed text-navy/60">
            No more phone calls for stock checks or invoice copies. Customers order, track, and pay
            from their own portal — any time.
          </p>
        </Reveal>

        <Reveal delay={300} className="mt-8">
          <div className="rounded-2xl border border-surface-border bg-white p-4 shadow-card">
            <div className="flex items-center justify-between border-b border-surface-border pb-3">
              <div>
                <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-brand-600">
                  Harbor Cafe · Portal
                </div>
                <div className="text-base font-bold text-navy">Recent orders</div>
              </div>
              <Receipt className="h-5 w-5 text-navy/40" />
            </div>
            <div className="mt-3 space-y-2">
              {[
                { id: "ORD-2301", date: "Mar 12", total: "$284.50", status: "Delivered" },
                { id: "ORD-2298", date: "Mar 08", total: "$412.00", status: "Delivered" },
                { id: "ORD-2294", date: "Mar 05", total: "$197.25", status: "Delivered" },
              ].map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between rounded-lg bg-surface-raised px-3 py-2"
                >
                  <div>
                    <div className="font-mono text-[10px] text-navy/50">
                      {o.id} · {o.date}
                    </div>
                    <div className="text-xs font-bold text-navy">{o.total}</div>
                  </div>
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                    {o.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ─── Scene: Outro ─────────────────────────────────────────────────────────

function SceneOutro() {
  return (
    <section className="bg-gradient-to-br from-brand-600 to-brand-800 px-5 py-16">
      <div className="mx-auto max-w-lg text-center">
        <Reveal>
          <h2 className="text-3xl font-extrabold tracking-tight text-white">
            Delivery operations,<br />simplified.
          </h2>
        </Reveal>
        <Reveal delay={120}>
          <p className="mt-3 text-sm text-white/80">
            Everything you just saw, working together on day one.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
