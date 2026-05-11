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

  const ctaLabel =
    side === "retailer" ? "Get the app" : side === "wholesaler" ? "Start free trial" : "Get started";
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

        {/* Side switch — always visible (hidden on small screens via CSS) */}
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

        {/* Side-specific page links — hidden on small screens via CSS */}
        <div
          className="nav-links nav-side-links"
          style={{ flex: 1, justifyContent: "flex-end", marginRight: 8 }}
        >
          {links?.map(([href, label]) => (
            <Link key={href + label} href={href} className="nav-link">
              {label}
            </Link>
          ))}
        </div>

        <div className="nav-actions">
          <Link href={getAuthHref(side, "in")} className="signin">
            Sign in
          </Link>
          <Link
            href={ctaHref}
            className={side === "neutral" ? "btn btn-primary btn-sm" : "btn btn-side btn-sm"}
          >
            {ctaLabel} <ArrowIcon />
          </Link>
        </div>
      </div>
    </nav>
  );
}
