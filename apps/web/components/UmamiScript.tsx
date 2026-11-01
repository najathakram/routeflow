"use client";

// Visitor counts with Umami (W3 / M2-M4). Cookie-free, so nothing to consent to; the Privacy
// Policy names it. Four rules, each pinned in UmamiScript.test.tsx:
//   1. No site ID baked in at build time means no script at all (a local or test stack sends
//      nothing). The ID is the build variable NEXT_PUBLIC_UMAMI_WEBSITE_ID and is never in git.
//   2. Only the public marketing pages and /signup count. Never the dashboard, the retailer
//      portal, the admin area or any sign-in page, whatever mounts this component.
//   3. `data-domains` keeps Umami to the live site's hostname, so a preview or local host that
//      does carry the ID still reports nothing.
//   4. The tracker never watches navigation itself. Once loaded it stays in the document, and by
//      default it wraps `history.pushState` and sends every new URL with its query string, which
//      Next's router calls on every in-app move: /signup to /signup/check-email?email=... would
//      send the person's email address, and a move to /login or the dashboard would count too.
//      So `data-auto-track="false"` (read from the tracker at cloud.umami.is/script.js on
//      2026-11-01: with it, the tracker never wraps history or sends a view by itself), and this
//      component sends one view per counted page, pathname only, from an effect. A page that does
//      not count sends nothing, even though the tracker is still loaded. `data-exclude-search`
//      is set as well, as a second lock on the query string.

import * as React from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { routes, site } from "@/app/(marketing)/lib/site";

export const UMAMI_SCRIPT_SRC = "https://cloud.umami.is/script.js";

// The marketing routes come from the one `routes` table; /book-a-demo is a marketing page that is
// not a nav route (see app/sitemap.ts). `/sign-in` is deliberately not here.
const COUNTED_PATHS: ReadonlySet<string> = new Set([
  "/",
  ...routes.map((route) => `/${route.slug}`),
  "/book-a-demo",
  "/signup",
]);

export function umamiAllowedPath(pathname: string | null): boolean {
  return pathname !== null && COUNTED_PATHS.has(pathname);
}

export function umamiScriptProps(websiteId: string | undefined, pathname: string | null) {
  const id = websiteId?.trim();
  if (!id || !umamiAllowedPath(pathname)) return null;
  return {
    src: UMAMI_SCRIPT_SRC,
    defer: true,
    "data-website-id": id,
    "data-domains": new URL(site.origin).hostname,
    "data-auto-track": "false",
    "data-exclude-search": "true",
  };
}

type PageviewPayload = Record<string, unknown>;
type UmamiGlobal = { track?: (build: (props: PageviewPayload) => PageviewPayload) => unknown };

// The last counted path in this document. It stops a double send when the script's ready callback
// and the pathname effect both fire, and it is the referrer of the next in-app view.
let lastCounted: string | null = null;

/** Sends one view for `pathname` (the path alone, never the query) if the tracker has loaded. */
export function sendUmamiPageview(pathname: string): boolean {
  const umami = (window as unknown as { umami?: UmamiGlobal }).umami;
  if (typeof umami?.track !== "function" || lastCounted === pathname) return false;
  const referrer = lastCounted;
  lastCounted = pathname;
  umami.track((props) => ({ ...props, url: pathname, ...(referrer ? { referrer } : {}) }));
  return true;
}

/** For tests: forget the last counted path. */
export function resetUmamiPageviews(): void {
  lastCounted = null;
}

export function UmamiScript() {
  const pathname = usePathname();
  // Written out in full so Next inlines it at build time.
  const props = umamiScriptProps(process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID, pathname);
  const counted = props !== null;
  const pathRef = React.useRef(pathname);
  pathRef.current = pathname;

  React.useEffect(() => {
    if (!counted || pathname === null) {
      // Left the counted pages: the next counted page starts fresh and has no in-app referrer.
      lastCounted = null;
      return;
    }
    sendUmamiPageview(pathname);
  }, [counted, pathname]);

  if (!props) return null;
  return (
    <Script
      strategy="afterInteractive"
      {...props}
      // Fires after the first load and again on a later mount: the first view of a fresh document.
      onReady={() => {
        if (pathRef.current !== null && umamiAllowedPath(pathRef.current)) {
          sendUmamiPageview(pathRef.current);
        }
      }}
    />
  );
}
