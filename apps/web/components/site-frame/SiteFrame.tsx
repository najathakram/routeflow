import type { ReactNode } from "react";
import Link from "next/link";
import { BRAND, footerLine } from "@routeflow/types/brand";
import { BrandTokens } from "@/components/brand/BrandTokens";
import { SiteFrameHeader } from "./SiteFrameHeader";
import { FOOTER_COLUMNS, SITE_EMAIL } from "./site-frame-nav";

// The three depth pages are the only Explore links the phone footer keeps (site.css hides the rest).
const DEPTH = new Set(["/does-and-doesnt", "/data-in-and-out", "/security"]);

// The frame the public site's React pages wear (Privacy, Terms, sign-in, sign-up, forgot password,
// 404): the same header, footer, type and colours as the ready-made pages in public/site. The
// site's own stylesheets are loaded as links, so they exist only while one of these pages is on
// screen; site-frame.css (imported by app/layout.tsx, because the not-found page drops a CSS
// chunk imported from its own segment) adds the few rules for the page body, scoped to .rf-frame.
export function SiteFrame({
  children,
  current,
  width = "wide",
}: {
  children: ReactNode;
  /** The nav link to mark as the current page, if the page is one of them. */
  current?: string;
  width?: "wide" | "narrow";
}) {
  return (
    <div className="rf-frame">
      {/* Links, not imports: the site stylesheets style body and bare elements, so they must leave
          the page with the frame. They are plain files in public/site, shared with the ready-made pages. */}
      {/* The palette the stylesheet below points at (--brand-*): the one injected style. */}
      <BrandTokens />
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/site/graphics/rf-graphics.css" />
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/site/css/site.css" />
      <a className="skip" href="#main-content">
        Skip to main content
      </a>
      <SiteFrameHeader current={current} />
      <main id="main-content" className={`rf-frame-main rf-frame-main--${width}`}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <div className="footer-grid">
            <div>
              <Link className="brand" href="/">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={BRAND.logo.onLight} width={28} height={28} alt="" />
                <span>{BRAND.name}</span>
              </Link>
              <p className="foot-about">We make wholesalers’ lives easier.</p>
              <p className="foot-mail">
                Email: <a href={`mailto:${SITE_EMAIL}`}>{SITE_EMAIL}</a>
              </p>
            </div>
            {FOOTER_COLUMNS.map((col) => (
              <div key={col.title}>
                <h2>{col.title}</h2>
                <ul>
                  {col.links.map((l) => (
                    <li key={l.label} className={DEPTH.has(l.href) ? "foot-depth" : undefined}>
                      <Link href={l.href}>{l.label}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <h2>Account</h2>
              <ul>
                <li>
                  <Link href="/signup" data-where="footer">
                    Start free trial
                  </Link>
                </li>
                <li>
                  <Link href="/login">Sign in</Link>
                </li>
                <li>
                  <Link href="/buyer/login">Store sign in</Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="foot-bottom">
            <span>{footerLine()}</span>
            <span>
              <Link href="/privacy">Privacy Policy</Link> ·{" "}
              <Link href="/terms">Terms of Service</Link>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
