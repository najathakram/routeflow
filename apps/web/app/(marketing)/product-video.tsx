"use client";

import { useEffect, useRef } from "react";

const DURATION = 66; // animation seconds
const PX_PER_SEC = 120; // scroll pixels per animation second
const SCROLL_HEIGHT = DURATION * PX_PER_SEC; // total scroll distance = 7920px

export function ProductVideo() {
  const outerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastTimeRef = useRef(-1);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;

    const onScroll = () => {
      const rect = outer.getBoundingClientRect();
      // How far the user has scrolled past the top of the sticky section.
      // rect.top goes from 0 → -SCROLL_HEIGHT as user scrolls through.
      const scrolledIn = -rect.top;
      const clamped = Math.max(0, Math.min(SCROLL_HEIGHT, scrolledIn));
      const time = (clamped / SCROLL_HEIGHT) * DURATION;

      // Throttle: only postMessage when time changes by >= 0.05s
      if (Math.abs(time - lastTimeRef.current) >= 0.05) {
        lastTimeRef.current = time;
        iframeRef.current?.contentWindow?.postMessage({ type: "seekTo", time }, "*");
        if (progressRef.current) {
          progressRef.current.style.width = `${(clamped / SCROLL_HEIGHT) * 100}%`;
        }
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    // Kick off initial state
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    // Outer div is tall — scrolling through it drives the animation
    <div
      ref={outerRef}
      style={{ height: `calc(100vh + ${SCROLL_HEIGHT}px)`, position: "relative" }}
    >
      {/* Sticky full-screen container */}
      <div
        style={{
          position: "sticky",
          top: 0,
          height: "100vh",
          overflow: "hidden",
        }}
      >
        {/* Full-screen iframe */}
        <iframe
          ref={iframeRef}
          src="/video/marketing-video.html?scroll=1"
          title="RouteFlow Product Tour"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          loading="eager"
        />

        {/* Thin scroll-progress bar at the very bottom */}
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

        {/* Scroll hint — fades out after first scroll */}
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
            <path d="M10 4v12M5 11l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
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
