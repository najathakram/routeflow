"use client";

// Visitor counts with Umami (W3 / M2-M4). Cookie-free, so nothing to consent to; the Privacy
// Policy names it. Five rules, each pinned in UmamiScript.test.tsx:
//   1. No site ID baked in at build time means no script at all (a local or test stack sends
//      nothing). The ID is the build variable NEXT_PUBLIC_UMAMI_WEBSITE_ID and is never in git.
//   2. Only the public marketing pages and /signup count. Never the dashboard, the retailer
//      portal, the admin area or any sign-in page, whatever mounts this component.
//   3. `data-domains` keeps Umami to the live site's hostname, so a preview or local host that
//      does carry the ID still reports nothing.
//   4. The tracker never follows the page. Left to itself it wraps history.pushState, and Next's
//      router moves through pushState, so a script loaded on /signup would go on to report
//      /signup/check-email?email=... and every signed-in page after it. `data-auto-track="false"`
//      turns that off, and this component sends each pageview itself.
//   5. A pageview carries the five fields in umamiPageview and nothing else: the Privacy Policy's
//      list, whatever a later tracker adds to its own payload.

import { useCallback, useEffect, useRef } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { routes, site } from "@/app/(marketing)/lib/site";

interface UmamiPayload {
  website?: string;
  hostname?: string;
  screen?: string;
  url?: string;
  referrer?: string;
}

declare global {
  interface Window {
    // Hands `build` the tracker's own payload and posts what it returns. No `name` means a pageview.
    umami?: { track?: (build: (tracker: UmamiPayload) => UmamiPayload) => unknown };
  }
}

export const UMAMI_SCRIPT_SRC = "https://cloud.umami.is/script.js";

// The marketing routes come from the one `routes` table; /book-a-demo is a marketing page that is
// not a nav route (see app/sitemap.ts). `/sign-in` is deliberately not here.
const COUNTED_PATHS: ReadonlySet<string> = new Set([
  "/",
  ...routes.map((route) => `/${route.slug}`),
  "/book-a-demo",
  "/signup",
]);

// www, the bare domain and every tenant's host. A tenant's host names a client.
const OWN_DOMAIN = new URL(site.origin).hostname.replace(/^www\./, "");

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

// The referring site, as a bare origin. A referrer from our own hosts is dropped: it can name a
// sign-in page or a client, and Referrer-Policy lets a same-origin one carry `?email=`.
function referringSite(referrer: string | undefined): string {
  if (!referrer) return "";
  try {
    const url = new URL(referrer, site.origin);
    const ours = url.hostname === OWN_DOMAIN || url.hostname.endsWith(`.${OWN_DOMAIN}`);
    return ours || !url.protocol.startsWith("http") ? "" : url.origin;
  } catch {
    return "";
  }
}

function umamiPageview(tracker: UmamiPayload, path: string, firstView: boolean): UmamiPayload {
  return {
    website: tracker.website,
    hostname: tracker.hostname,
    screen: tracker.screen,
    url: path,
    referrer: firstView ? referringSite(tracker.referrer) : "",
  };
}

// Trackers that have sent a pageview. One tracker lives as long as the document, and the marketing
// layout and /signup each mount their own UmamiScript, so this can't live in a ref.
const trackersUsed = new WeakSet<object>();

function sendPageviews(paths: string[]) {
  const umami = window.umami;
  if (typeof umami?.track !== "function") return;
  for (const path of paths.splice(0)) {
    const firstView = !trackersUsed.has(umami);
    trackersUsed.add(umami);
    try {
      umami.track((tracker) => umamiPageview(tracker, path, firstView));
    } catch {
      // Analytics never takes a page down with it (M3).
    }
  }
}

export function UmamiScript() {
  const pathname = usePathname();
  // Written out in full so Next inlines it at build time.
  const props = umamiScriptProps(process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID, pathname);
  const counted = props !== null;
  // Counted pages the tracker hasn't had yet. The first waits here until the script has loaded.
  const waiting = useRef<string[]>([]);
  const lastCounted = useRef<string | null>(null);

  // Next calls a script's onLoad from the first render's props, so this reads only the ref.
  const flush = useCallback(() => sendPageviews(waiting.current), []);

  useEffect(() => {
    if (!counted || pathname === null) {
      lastCounted.current = null;
      return;
    }
    if (pathname === lastCounted.current) return;
    lastCounted.current = pathname;
    waiting.current.push(pathname);
    flush();
  }, [counted, pathname, flush]);

  if (!props) return null;
  return <Script strategy="afterInteractive" {...props} onLoad={flush} />;
}
