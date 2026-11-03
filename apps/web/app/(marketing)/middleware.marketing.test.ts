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
import { middleware } from "../../middleware";
import { MARKETING_PAGE_PATHS } from "@/lib/marketing-routes";
import { BUYER_PRESENCE_COOKIE, OP_PRESENCE_COOKIE } from "@/lib/presence-cookies";
import { routes } from "./lib/site";

// R-MKT T11 (owner ruling, mobile-web-proxy-redesign) — the middleware used to
// rewrite every phone-UA request to the Expo mobile-web build, which never
// got the redesign; Android/iPhone Chrome users kept seeing the old UI.
// Removed: phones now get the same redesigned Next web site as desktop, and
// the middleware no longer branches on user-agent at all. These tests are
// RED-FIRST proof against the old code — the rows below name the exact paths
// the old proxy carve-out logic special-cased (login, dashboard, "/" signed
// in, "/" with the old mobile-app marker) and assert none of them are
// rewritten anymore, for any UA.

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// The marker a phone that WAS proxied under the old code would have carried.
// The middleware no longer mints or reads this cookie at all — kept here only
// as a literal so the "old marker changes nothing now" row means what it says
// without depending on an export the removal deleted.
const OLD_MOBILE_APP_MARKER = "rf-mobile-app=1";

function requestFor(pathname: string, userAgent: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "user-agent": userAgent };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`http://localhost:3001${pathname}`, { headers });
}

// NextResponse.rewrite() stamps an `x-middleware-rewrite` response header
// with the target URL; NextResponse.next() does not. Reading that header is
// how a middleware test observes a rewrite decision without depending on any
// particular internal helper name — and, post-removal, without depending on
// anything that no longer exists.
function rewriteTarget(response: Response): string | null {
  return response.headers.get("x-middleware-rewrite");
}

describe("middleware — no user-agent-based rewriting (R-MKT T11, red-first)", () => {
  it.each([
    ["/login", IPHONE_UA, undefined],
    ["/login", ANDROID_UA, undefined],
    ["/dashboard", IPHONE_UA, undefined],
    ["/dashboard", ANDROID_UA, undefined],
    ["/", IPHONE_UA, `${OP_PRESENCE_COOKIE}=1`], // "/" signed in, phone
    ["/", ANDROID_UA, `${BUYER_PRESENCE_COOKIE}=1`], // "/" signed in as buyer, phone
    ["/", IPHONE_UA, OLD_MOBILE_APP_MARKER], // "/" carrying the old marker, signed out
  ])("never rewrites %s for %s (cookie: %s)", (pathname, ua, cookie) => {
    const response = middleware(requestFor(pathname, ua, cookie));
    expect(rewriteTarget(response)).toBeNull();
  });

  // The old marker alone, with no presence cookie, used to mean "proxy to the
  // app" — now it means nothing: a signed-out visitor is a signed-out visitor,
  // marketing home, no redirect at all (not even to /login).
  it("a signed-out phone with only the old mobile-app marker gets the marketing home, no redirect", () => {
    const response = middleware(requestFor("/", IPHONE_UA, OLD_MOBILE_APP_MARKER));
    expect(rewriteTarget(response)).toBeNull();
    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
  });
});

describe("middleware — / is always the home page (owner order 2026-11-03)", () => {
  // The site is live for everyone: a signed-in visitor sees home too. The header offers "Open dashboard"
  // (public/site/js/auth-nav.js) instead of a redirect, so nothing a cookie decides is ever cached or bounced.
  const BOTH = `${OP_PRESENCE_COOKIE}=1; ${BUYER_PRESENCE_COOKIE}=1; rf-last-portal=buyer`;
  it.each([
    ["an operator", `${OP_PRESENCE_COOKIE}=1`],
    ["a buyer", `${BUYER_PRESENCE_COOKIE}=1`],
    ["someone with both sessions", BOTH],
    ["a first-time visitor", undefined],
  ])("does not redirect / for %s on any UA", (_label, cookie) => {
    for (const ua of [IPHONE_UA, ANDROID_UA, DESKTOP_UA]) {
      const response = middleware(requestFor("/", ua, cookie));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(rewriteTarget(response)).toBeNull();
    }
  });

  it("does not redirect /pricing for a signed-in operator on any UA", () => {
    for (const ua of [IPHONE_UA, ANDROID_UA, DESKTOP_UA]) {
      const response = middleware(requestFor("/pricing", ua, `${OP_PRESENCE_COOKIE}=1`));
      expect(response.status).not.toBe(307);
    }
  });

  it("the buyer-only guard on operator paths still holds", () => {
    const response = middleware(requestFor("/dashboard", DESKTOP_UA, `${BUYER_PRESENCE_COOKIE}=1`));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login?redirect=");
  });
});

describe("middleware — ?desktop=1 / prefer-desktop are accepted and inert (R-MKT T11)", () => {
  it("does not error and sets no prefer-desktop cookie for ?desktop=1 on a phone", () => {
    const response = middleware(requestFor("/dashboard?desktop=1", IPHONE_UA));
    expect(response.headers.get("set-cookie") ?? "").not.toContain("prefer-desktop");
  });

  it("an old prefer-desktop cookie has no special effect anymore", () => {
    const response = middleware(requestFor("/dashboard", IPHONE_UA, "prefer-desktop=1"));
    expect(rewriteTarget(response)).toBeNull();
    expect(response.status).not.toBe(307);
  });
});

// One source for the marketing path list (L-072): adding a row to site.ts's
// `routes` without updating MARKETING_PAGE_PATHS should turn this red. Kept
// here per lib/marketing-routes.ts's own header pointer, even though the
// export it validates is no longer consumed by this middleware itself.
describe("marketing path list parity — MKT-PIN T11-parity", () => {
  it("MARKETING_PAGE_PATHS equals site.ts routes plus / (MKT-PIN T11-parity)", () => {
    const fromSite = ["/", ...routes.map((route) => `/${route.slug}`)];
    expect([...MARKETING_PAGE_PATHS].sort()).toEqual(fromSite.sort());
  });
});
