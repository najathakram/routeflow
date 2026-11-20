"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND } from "@routeflow/types/brand";
import { hasBuyerPresence, hasOpPresence, readLastPortalCookie } from "@/lib/presence-cookies";
import { resolveLandingTarget } from "@/lib/portal-routing";
import { MENU_LINKS, NAV_LINKS } from "./site-frame-nav";

// The site header for the React pages (same markup and classes as public/site/*.html, styled by
// the same /site/css/site.css). The only moving parts are the two the ready-made pages have too:
// the phone menu, and "Sign in" becoming "Open dashboard" when a presence cookie says someone is
// signed in (the rule is resolveLandingTarget, the one public/site/js/auth-nav.js mirrors).
export function SiteFrameHeader({ current }: { current?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [dashboard, setDashboard] = useState<string | null>(null);

  useEffect(() => {
    setDashboard(
      resolveLandingTarget({
        opAuthed: hasOpPresence(),
        buyerAuthed: hasBuyerPresence(),
        lastPortal: readLastPortalCookie(),
      }),
    );
  }, []);

  useEffect(() => {
    document.body.classList.toggle("menu-open", open);
    return () => document.body.classList.remove("menu-open");
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth > 1080) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // The sign-up page is the trial: no second trial button in its header or menu.
  const p = pathname ?? "";
  const showTrial = !(p === "/signup" || p.startsWith("/signup/"));
  const signIn = dashboard ?? "/login";
  const signInLabel = dashboard ? "Open dashboard" : "Sign in";

  return (
    <>
      <header className="site-header">
        <div className="wrap nav">
          <Link className="brand" href="/" aria-label={`${BRAND.name} home`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={BRAND.logo.onLight} width={30} height={30} alt="" />
            <span>{BRAND.name}</span>
          </Link>
          <nav aria-label="Main">
            <ul className="nav-links">
              {NAV_LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} aria-current={current === l.href ? "page" : undefined}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="nav-actions">
            <Link className="nav-price" href="/pricing">
              Pricing
            </Link>
            <Link className="nav-signin" href={signIn}>
              {signInLabel}
            </Link>
            {showTrial && (
              <Link className="btn btn-primary btn-sm" href="/signup">
                Start free trial
              </Link>
            )}
            <button
              className="menu-btn"
              type="button"
              aria-expanded={open}
              aria-controls="mobile-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((v) => !v)}
            >
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d={open ? "M6 6l12 12M18 6L6 18" : "M4 8h16M4 16h16"} />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <div
        className={open ? "mobile-menu open" : "mobile-menu"}
        id="mobile-menu"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        <nav aria-label="Mobile">
          {MENU_LINKS.map((l) => (
            <Link key={l.label} href={l.href}>
              {l.label}
            </Link>
          ))}
          <Link href={signIn}>{signInLabel}</Link>
          {showTrial && (
            <Link className="btn btn-primary btn-lg" href="/signup">
              Start free trial
            </Link>
          )}
        </nav>
      </div>
    </>
  );
}
