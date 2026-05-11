"use client";

import Link from "next/link";
import { useSide } from "./use-side";
import { getAuthHref } from "./auth-links";
import { Logo } from "./logo";
import { ArrowIcon } from "./icons";

export function MarketingNav() {
  const side = useSide();

  // Sign in / CTA only render on a side-themed page (`/retailers`,
  // `/wholesalers`, `/pricing`). On neutral pages (`/`, `/product`, `/company`)
  // the audience-switch in the middle of the nav is the entry point.
  // Retailer CTA is "Sign up" (free portal account) since the standalone
  // mobile app isn't shipped yet — used to say "Get the app".
  const ctaLabel = side === "retailer" ? "Sign up" : "Start free trial";
  const ctaHref = getAuthHref(side, "up");

  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand">
          <Logo size={28} />
          <span>RouteFlow</span>
          {side !== "neutral" && (
            <span className="side-tag">{side === "retailer" ? "Retailers" : "Wholesalers"}</span>
          )}
        </Link>

        {/* Side switch — pinned to the visual centre of the nav via
            `position: absolute; left: 50%` in marketing.css. */}
        <div className="side-switch" role="tablist" aria-label="Choose your side">
          <Link href="/" className={side === "neutral" ? "active" : ""}>
            Overview
          </Link>
          <Link href="/retailers" className={side === "retailer" ? "active" : ""}>
            I&apos;m a retailer
          </Link>
          <Link href="/wholesalers" className={side === "wholesaler" ? "active" : ""}>
            I&apos;m a wholesaler
          </Link>
        </div>

        {/* Right-side container. We deliberately do NOT render side-specific
            links (Features / Pricing / Help / Company) here — they overlapped
            the centred side-switch on side pages, and they're already in the
            footer. The Sign in + CTA stays. */}
        <div className="nav-right">
          {side !== "neutral" && (
            <div className="nav-actions">
              <Link href={getAuthHref(side, "in")} className="signin">
                Sign in
              </Link>
              <Link href={ctaHref} className="btn btn-side btn-sm">
                {ctaLabel} <ArrowIcon />
              </Link>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
