"use client";

import { useEffect, useState } from "react";
import { useSide } from "./use-side";
import { AppleIcon, AndroidIcon } from "./icons";

// Floating "Get the retailer app" pill that fades in mid-scroll on long pages.
// Hidden on the retailer side (the page already pushes the app heavily) so we
// don't double-CTA. Hidden on auth pages (those don't render the marketing layout).
export function StickyAppBar() {
  const side = useSide();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const max = document.body.scrollHeight - 1500;
      setVisible(y > 1200 && y < max);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible || side === "retailer") return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px 10px 18px",
        background: "var(--rf-ink)",
        color: "var(--rf-cream)",
        borderRadius: 999,
        boxShadow: "0 20px 40px -10px rgba(14,31,54,0.4)",
        border: "1px solid rgba(255,255,255,0.1)",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 500 }}>Get the retailer app</span>
      <a
        href="#"
        className="btn btn-sm"
        style={{ background: "var(--rf-cream)", color: "var(--rf-ink)" }}
        aria-label="Download for iOS"
      >
        <AppleIcon /> iOS
      </a>
      <a
        href="#"
        className="btn btn-sm"
        style={{ background: "var(--rf-cream)", color: "var(--rf-ink)" }}
        aria-label="Download for Android"
      >
        <AndroidIcon /> Android
      </a>
    </div>
  );
}
