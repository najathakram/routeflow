"use client";

import Link from "next/link";
import { useSide } from "./use-side";
import { getAuthHref } from "./auth-links";
import { Logo } from "./logo";
import { ArrowIcon } from "./icons";

const RETAILER_NAV: Array<[string, string]> = [
  ["/retailers", "Overview"],
  ["/product", "Features"],
  ["/company", "Help"],
];
const WHOLESALER_NAV: Array<[string, string]> = [
  ["/wholesalers", "Overview"],
  ["/product", "Features"],
  ["/pricing", "Pricing"],
  ["/company", "Company"],
];

export function MarketingNav() {
  const side = useSide();
  const links = side === "retailer" ? RETAILER_NAV : side === "wholesaler" ? WHOLESALER_NAV : null;

  // Sign in / CTA only render on a side-themed page (`/retailers`, `/wholesalers`,
  // `/pricing`). On neutral pages (`/`, `/product`, `/company`) we don't know
  // which login to send the user to — pushing them to `/login` (operator)
  // would silently bias the home toward wholesalers and confuse retailers.
  // The audience-switch in the middle of the nav is the right entry point.
  const ctaLabel = side === "retailer" ? "Get the app" : "Start free trial";
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

        {/* Side switch — pinned to the visual center of the nav by CSS Grid
            so it stays in the same screen position from page to page,
            regardless of what's on the right (side-specific links + Sign in
            + CTA on side pages, nothing on neutral pages). */}
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

        {/* Right-side container — always present (even when empty) so the
            grid keeps the side switch centered. */}
        <div className="nav-right">
          {links && (
            <div className="nav-links nav-side-links">
              {links.map(([href, label]) => (
                <Link key={href + label} href={href} className="nav-link">
                  {label}
                </Link>
              ))}
            </div>
          )}
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
