"use client";

// Visitor counts with Umami (W3 / M2-M4). Cookie-free, so nothing to consent to; the Privacy
// Policy names it. Three rules, each pinned in UmamiScript.test.tsx:
//   1. No site ID baked in at build time means no script at all (a local or test stack sends
//      nothing). The ID is the build variable NEXT_PUBLIC_UMAMI_WEBSITE_ID and is never in git.
//   2. Only the public marketing pages and /signup count. Never the dashboard, the retailer
//      portal, the admin area or any sign-in page, whatever mounts this component.
//   3. `data-domains` keeps Umami to the live site's hostname, so a preview or local host that
//      does carry the ID still reports nothing.

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
  };
}

export function UmamiScript() {
  const pathname = usePathname();
  // Written out in full so Next inlines it at build time.
  const props = umamiScriptProps(process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID, pathname);
  if (!props) return null;
  return <Script strategy="afterInteractive" {...props} />;
}
