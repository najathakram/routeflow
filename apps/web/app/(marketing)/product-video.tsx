"use client";

import { useEffect, useRef, useState } from "react";

export function ProductVideo() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && !started) {
          setStarted(true);
          iframeRef.current?.contentWindow?.postMessage("play", "*");
        }
      },
      { threshold: 0.4 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [started]);

  return (
    <div ref={wrapperRef} className="relative w-full overflow-hidden rounded-2xl shadow-2xl border border-navy/10" style={{ paddingBottom: "56.25%" }}>
      <iframe
        ref={iframeRef}
        src="/video/marketing-video.html"
        title="RouteFlow Product Tour"
        className="absolute inset-0 w-full h-full"
        style={{ border: "none" }}
        loading="lazy"
      />
    </div>
  );
}
