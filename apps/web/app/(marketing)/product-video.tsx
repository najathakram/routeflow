"use client";

import { useEffect, useRef, useState } from "react";

const DURATION = 66; // animation seconds
const PX_PER_SEC = 120; // scroll pixels per animation second
const SCROLL_HEIGHT = DURATION * PX_PER_SEC; // total scroll distance = 7920px
const MOBILE_BREAKPOINT = 768; // below this, use the mobile adaptation

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

  if (mounted && isMobile) return <MobileVideo />;
  return <DesktopScrollVideo />;
}

// ─── Desktop scroll-driven ────────────────────────────────────────────────

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

// ─── Mobile adaptation ────────────────────────────────────────────────────
// The 16:9 scroll-driven animation can't fit a portrait viewport without
// clipping, so on mobile we drop the scroll drive and play it inside a
// contained 16:9 card with the iframe's native controls.

function MobileVideo() {
  return (
    <section className="bg-gradient-to-b from-[#0f1b2d] to-[#152238] px-5 py-14">
      <div className="mx-auto max-w-xl text-center">
        <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-brand-400/20 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-widest text-brand-300">
          Product Tour
        </div>
        <h2 className="text-2xl font-bold text-white">See RouteFlow in action</h2>
        <p className="mt-2 text-sm leading-relaxed text-blue-200/70">
          A 60-second walkthrough of the whole cycle — from order to delivery to invoice.
        </p>

        <div className="relative mt-6 overflow-hidden rounded-2xl border border-white/10 bg-black/40 shadow-2xl">
          <div style={{ position: "relative", width: "100%", paddingTop: "56.25%" }}>
            <iframe
              src="/video/marketing-video.html"
              title="RouteFlow Product Tour"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                border: "none",
                display: "block",
              }}
              loading="lazy"
            />
          </div>
        </div>

        <p className="mt-4 text-xs text-blue-300/50">Rotate to landscape for a fuller view</p>
      </div>
    </section>
  );
}
