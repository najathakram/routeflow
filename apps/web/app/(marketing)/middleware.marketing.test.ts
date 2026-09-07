/**
 * @jest-environment node
 */
// `next/server` touches the Fetch API globals (`Request`, `Response`,
// `Headers`) at import time, and the jsdom environment this workspace defaults
// to does not define them — importing it under jsdom throws
// `ReferenceError: Request is not defined` before a single assertion runs.
// The node environment (Node 18+ undici globals) provides them.
//
// This file lives under `app/(marketing)/` rather than at the workspace root
// because apps/web/jest.config.js scopes `roots` to app/components/lib/hooks;
// a root-level test file is never collected.
import { NextRequest } from "next/server";
import { middleware, MARKETING_PATHS, MOBILE_APP_COOKIE } from "../../middleware";
import {
  MARKETING_ASSET_FILES,
  MARKETING_ASSET_PREFIXES,
  MARKETING_AUTH_PATHS,
  MARKETING_PAGE_PATHS,
} from "@/lib/marketing-routes";
import { BUYER_PRESENCE_COOKIE, OP_PRESENCE_COOKIE } from "@/lib/presence-cookies";
import { routes } from "./lib/site";

// R-MKT T11 — the mobile-UA proxy must skip the nine public marketing paths
// (plus /distributors) so phones see the marketing site instead of being
// rewritten to the mobile-web build; every other path keeps today's
// rewrite behaviour byte-for-byte (R11).

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Same default the middleware falls back to when NEXT_PUBLIC_MOBILE_WEB_URL is unset.
const MOBILE_WEB_URL =
  process.env.NEXT_PUBLIC_MOBILE_WEB_URL ?? "https://routeflowmobile-production.up.railway.app";

function requestFor(
  pathname: string,
  userAgent: string,
  cookie?: string,
  accept?: string,
): NextRequest {
  const headers: Record<string, string> = { "user-agent": userAgent };
  if (cookie) headers.cookie = cookie;
  // Only the rows that assert on the marker cookie send an Accept header: the
  // marker is stamped on DOCUMENT requests only, so leaving it off keeps every
  // other row asserting the rewrite decision alone.
  if (accept) headers.accept = accept;
  return new NextRequest(`http://localhost:3001${pathname}`, { headers });
}

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** The `Set-Cookie` the middleware wrote for `name`, or null. */
function setCookieFor(response: Response, name: string): string | null {
  const header = response.headers.get("set-cookie");
  if (!header) return null;
  return header.split(/,(?=[^;]+?=)/).find((part) => part.trim().startsWith(`${name}=`)) ?? null;
}

// NextResponse.rewrite() stamps an `x-middleware-rewrite` response header
// with the target URL; NextResponse.next() does not. Reading that header is
// how a middleware test observes the rewrite decision without depending on
// any particular internal helper name.
function rewriteTarget(response: Response): string | null {
  return response.headers.get("x-middleware-rewrite");
}

describe("middleware mobile-UA proxy — R-MKT T11", () => {
  it.each([...MARKETING_PAGE_PATHS])(
    "does not rewrite %s for a mobile UA (R-MKT T11)",
    (pathname) => {
      const response = middleware(requestFor(pathname, IPHONE_UA));
      expect(rewriteTarget(response)).toBeNull();
    },
  );

  // The metadata routes (app/robots.ts, app/sitemap.ts) are not pages, so they
  // are not in MARKETING_PAGE_PATHS — but a mobile crawler UA (Googlebot-
  // Smartphone contains both "Android" and "Mobile") must still get their body
  // rather than the mobile-web SPA shell.
  it.each(["/robots.txt", "/sitemap.xml"])(
    "does not rewrite %s for a mobile UA (R-MKT T11)",
    (pathname) => {
      const response = middleware(requestFor(pathname, IPHONE_UA));
      expect(rewriteTarget(response)).toBeNull();
    },
  );
});

// Who owns "/" on a phone. The presence cookies are written only by the Next
// web app (lib/presence-cookies.ts via document.cookie); the Expo mobile-web
// build keeps its session in AsyncStorage and writes no cookie, so a row that
// manufactures rf-op-auth on an iPhone pins a state the mobile build cannot
// produce — it says nothing about the returning mobile-app user. The marker
// cookie rf-mobile-app is the signal that population actually carries, so the
// two ex-`signedIn` rows are restated here over BOTH signals.
describe("middleware landing carve-out, returning users — R-MKT T11", () => {
  it.each([
    ["a phone previously served the mobile-web build", `${MOBILE_APP_COOKIE}=1`],
    ["a phone signed in to the web app as an operator", `${OP_PRESENCE_COOKIE}=1`],
    ["a phone signed in to the web app as a buyer", `${BUYER_PRESENCE_COOKIE}=1`],
  ])("proxies / to the mobile-web build for %s (R-MKT T11)", (_label, cookie) => {
    const response = middleware(requestFor("/", IPHONE_UA, cookie));
    expect(rewriteTarget(response)).toBe(`${MOBILE_WEB_URL}/`);
  });

  it("does not proxy / for a first-time phone visitor (R-MKT T11)", () => {
    const response = middleware(requestFor("/", IPHONE_UA));
    expect(rewriteTarget(response)).toBeNull();
  });

  it("does not proxy /pricing for a signed-in operator on a phone (R-MKT T11)", () => {
    const response = middleware(requestFor("/pricing", IPHONE_UA, `${OP_PRESENCE_COOKIE}=1`));
    expect(rewriteTarget(response)).toBeNull();
  });

  it("still 307s / to /dashboard for a signed-in operator on desktop (R-MKT T11)", () => {
    const response = middleware(requestFor("/", DESKTOP_UA, `${OP_PRESENCE_COOKIE}=1`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(/\/dashboard$/);
  });

  // The opt-out outranks BOTH signals — a person who asked for the desktop UI
  // on their phone keeps it even though they have used the app before.
  it("does not proxy /?desktop=1 for a phone carrying the mobile-app marker (R-MKT T11)", () => {
    const response = middleware(requestFor("/?desktop=1", IPHONE_UA, `${MOBILE_APP_COOKIE}=1`));
    expect(rewriteTarget(response)).toBeNull();
  });

  it("does not proxy / for a phone with prefer-desktop and the mobile-app marker (R-MKT T11)", () => {
    const response = middleware(
      requestFor("/", IPHONE_UA, `prefer-desktop=1; ${MOBILE_APP_COOKIE}=1`),
    );
    expect(rewriteTarget(response)).toBeNull();
  });
});

// The marketing pages ask the SAME origin for icons, the web app manifest, the
// OG image and /sw.js. None of them is a page, so none was in the exempt set —
// on a phone every one was proxied to the Expo origin, whose nginx answers its
// own index.html with a 200 (broken manifest, no apple-touch-icon, no OG image).
describe("middleware mobile-UA proxy, marketing assets — R-MKT T11", () => {
  it.each([
    "/brand/routeflow-mark-64.png",
    "/brand/routeflow-mark-180.png",
    "/brand/routeflow-mark-192.png",
    "/brand/routeflow-mark-512.png",
    "/marketing/warehouse.webp",
    "/operator-manifest.json",
    "/buyer-manifest.json",
    "/sw.js",
  ])("does not rewrite %s for a mobile UA (R-MKT T11)", (pathname) => {
    const response = middleware(requestFor(pathname, IPHONE_UA));
    expect(rewriteTarget(response)).toBeNull();
  });

  // The allow-list is explicit, never an extension rule: the mobile-web build's
  // OWN subresources must keep proxying to the Railway origin. A `*.json` /
  // `*.js` exclusion would break the Expo app's manifest and bundles.
  it.each(["/_expo/static/js/web/entry-abc123.js", "/manifest.json", "/assets/icon.png"])(
    "still rewrites the mobile build's own %s for a mobile UA (MKT-PIN T11)",
    (pathname) => {
      const response = middleware(requestFor(pathname, IPHONE_UA));
      expect(rewriteTarget(response)).toBe(`${MOBILE_WEB_URL}${pathname}`);
    },
  );

  // Every exempt asset comes from the shared list, never a literal here (L-072).
  it("exempts exactly the shared asset allow-list (MKT-PIN T11-parity)", () => {
    for (const file of MARKETING_ASSET_FILES) {
      expect(rewriteTarget(middleware(requestFor(file, IPHONE_UA)))).toBeNull();
    }
    for (const prefix of MARKETING_ASSET_PREFIXES) {
      expect(rewriteTarget(middleware(requestFor(`${prefix}probe.png`, IPHONE_UA)))).toBeNull();
    }
  });
});

// Three of the four auth CTAs the marketing chrome links have no route in the
// Expo build, so proxying them dropped the visitor on the Expo landing screen.
// /login is the deliberate exception: the mobile-web login IS the phone
// operator entry point, so "Sign in" landing a phone in the app is correct.
describe("middleware mobile-UA proxy, auth CTAs — R-MKT T11", () => {
  it.each([...MARKETING_AUTH_PATHS])(
    "does not rewrite %s for a mobile UA (R-MKT T11)",
    (pathname) => {
      const response = middleware(requestFor(pathname, IPHONE_UA));
      expect(rewriteTarget(response)).toBeNull();
    },
  );

  it("still rewrites /login for a mobile UA (R-MKT T11)", () => {
    const response = middleware(requestFor("/login", IPHONE_UA));
    expect(rewriteTarget(response)).toBe(`${MOBILE_WEB_URL}/login`);
  });

  it("does not exempt /login (R-MKT T11)", () => {
    expect([...MARKETING_AUTH_PATHS]).not.toContain("/login");
  });
});

// The marker that makes the "/" decision above possible: the middleware stamps
// it whenever it proxies a phone's DOCUMENT request, and only then.
describe("middleware mobile-app marker cookie — R-MKT T11", () => {
  it("stamps rf-mobile-app on a proxied document request (R-MKT T11)", () => {
    const response = middleware(requestFor("/dashboard", IPHONE_UA, undefined, HTML_ACCEPT));
    expect(rewriteTarget(response)).toBe(`${MOBILE_WEB_URL}/dashboard`);
    const cookie = setCookieFor(response, MOBILE_APP_COOKIE);
    expect(cookie).not.toBeNull();
    expect(cookie).toContain(`${MOBILE_APP_COOKIE}=1`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    // 30-day rolling marker (H2): re-stamped on every proxied document load,
    // so an abandoned first-visit sign-in attempt expires instead of pinning
    // the browser to the app for a year.
    expect(cookie).toMatch(/Max-Age=2592000/i);
  });

  it("does not stamp rf-mobile-app on a proxied non-document request (R-MKT T11)", () => {
    const response = middleware(
      requestFor("/_expo/static/js/web/entry-abc123.js", IPHONE_UA, undefined, "*/*"),
    );
    expect(rewriteTarget(response)).not.toBeNull();
    expect(setCookieFor(response, MOBILE_APP_COOKIE)).toBeNull();
  });

  it("does not stamp rf-mobile-app on a marketing page served to a phone (R-MKT T11)", () => {
    const response = middleware(requestFor("/pricing", IPHONE_UA, undefined, HTML_ACCEPT));
    expect(rewriteTarget(response)).toBeNull();
    expect(setCookieFor(response, MOBILE_APP_COOKIE)).toBeNull();
  });

  it("does not stamp rf-mobile-app for a desktop document request (R-MKT T11)", () => {
    const response = middleware(requestFor("/dashboard", DESKTOP_UA, undefined, HTML_ACCEPT));
    expect(setCookieFor(response, MOBILE_APP_COOKIE)).toBeNull();
  });
});

// One source for the marketing path list (L-072): adding a row to site.ts's
// `routes` without updating MARKETING_PAGE_PATHS turns this red instead of
// silently proxying the new page to the mobile-web build for phones.
describe("marketing path list parity — MKT-PIN T11-parity", () => {
  it("MARKETING_PAGE_PATHS equals site.ts routes plus / and /distributors (MKT-PIN T11-parity)", () => {
    const fromSite = ["/", "/distributors", ...routes.map((route) => `/${route.slug}`)];
    expect([...MARKETING_PAGE_PATHS].sort()).toEqual(fromSite.sort());
  });

  it("the middleware exempt set is the pages plus the two metadata routes (MKT-PIN T11-parity)", () => {
    expect(Array.from(MARKETING_PATHS).sort()).toEqual(
      [...MARKETING_PAGE_PATHS, "/robots.txt", "/sitemap.xml"].sort(),
    );
  });
});

// Unchanged-behaviour pins: these three already hold on the untouched tree, so
// they carry the MKT-PIN token and stay out of the red gate (`jest -t "R-MKT"`).
// They still run in the full `npx jest` suite, where they are the guard that
// the marketing carve-out did not widen into the app routes.
describe("middleware mobile-UA proxy, unchanged paths — MKT-PIN T11", () => {
  it("still rewrites /dashboard for a mobile UA, unchanged (MKT-PIN T11)", () => {
    const response = middleware(requestFor("/dashboard", IPHONE_UA));
    const target = rewriteTarget(response);
    expect(target).not.toBeNull();
    expect(new URL(target as string).pathname).toBe("/dashboard");
  });

  it("still rewrites /orders/abc for a mobile UA, unchanged (MKT-PIN T11)", () => {
    const response = middleware(requestFor("/orders/abc", IPHONE_UA));
    const target = rewriteTarget(response);
    expect(target).not.toBeNull();
    expect(new URL(target as string).pathname).toBe("/orders/abc");
  });

  // Pinned on a NON-exempt path on purpose: /pricing is in MARKETING_PATHS, so
  // it skips the proxy before the UA is ever read and would pass even if the UA
  // check were deleted. /dashboard is proxied for phones (the pin above), so
  // this is the only row that fails when isMobileUserAgent starts saying true
  // for desktop.
  it("does not rewrite /dashboard for a desktop UA (MKT-PIN T11)", () => {
    const response = middleware(requestFor("/dashboard", DESKTOP_UA));
    expect(rewriteTarget(response)).toBeNull();
  });

  // The carve-out is exact-path match only — a sub-route under a marketing page
  // is not itself a marketing page and stays subject to the proxy.
  it("still rewrites /product/anything for a mobile UA (MKT-PIN T11)", () => {
    const response = middleware(requestFor("/product/anything", IPHONE_UA));
    expect(rewriteTarget(response)).toBe(`${MOBILE_WEB_URL}/product/anything`);
  });

  it("does not rewrite /dashboard for a phone with the prefer-desktop cookie (MKT-PIN T11)", () => {
    const response = middleware(requestFor("/dashboard", IPHONE_UA, "prefer-desktop=1"));
    expect(rewriteTarget(response)).toBeNull();
  });

  it("does not rewrite /dashboard?desktop=1 for a phone (MKT-PIN T11)", () => {
    const response = middleware(requestFor("/dashboard?desktop=1", IPHONE_UA));
    expect(rewriteTarget(response)).toBeNull();
  });
});
