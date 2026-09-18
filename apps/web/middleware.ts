import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { tenantSlugFromHostname } from "@/lib/tenant-host";
import {
  BUYER_PRESENCE_COOKIE,
  LAST_PORTAL_COOKIE,
  OP_PRESENCE_COOKIE,
} from "@/lib/presence-cookies";
import { resolveLandingTarget, resolveOperatorPathGuard } from "@/lib/portal-routing";
import {
  MARKETING_AUTH_PATHS,
  MARKETING_PAGE_PATHS,
  isMarketingAsset,
  isWebOnlyPath,
} from "@/lib/marketing-routes";

// Platform-level subdomains and hosting-provider base domains live in
// `@/lib/tenant-host` so the login page derives the workspace with exactly these
// rules. They were duplicated here and there, and the copies drifted — see the
// header of that module.

// Mobile-web build served by the @routeflow/mobile Railway service. When phones
// hit the Next.js web app we rewrite (proxy) the response from this URL so the
// browser address bar keeps showing www.routeflow.info instead of changing domains.
const MOBILE_WEB_URL =
  process.env.NEXT_PUBLIC_MOBILE_WEB_URL ?? "https://routeflowmobile-production.up.railway.app";

// Public marketing pages the mobile-web proxy must not intercept — phones get
// the marketing site like any other device. Exact-path match only (no prefix
// matching), so a marketing-looking sub-route stays subject to the proxy.
// The pages come from `@/lib/marketing-routes` (single source, L-072); the two
// metadata routes (app/robots.ts, app/sitemap.ts) are added here because they
// are not pages — a mobile crawler UA must get their body, not the SPA shell.
export const MARKETING_PATHS = new Set<string>([
  ...MARKETING_PAGE_PATHS,
  "/robots.txt",
  "/sitemap.xml",
]);

/** True when `pathname` is one of the public marketing pages (R11). */
function isMarketingPath(pathname: string): boolean {
  return MARKETING_PATHS.has(pathname);
}

// Auth entry points the marketing chrome links but the Expo mobile-web build
// has no route for. Exact-path match, same as the pages. `/login` is NOT a
// member on purpose — the mobile-web login is the operator entry point on a
// phone. Source list in `@/lib/marketing-routes` (L-072).
const MARKETING_AUTH_PATH_SET = new Set<string>(MARKETING_AUTH_PATHS);

/**
 * Marker cookie meaning "this browser has been served the mobile-web build".
 *
 * The Expo build keeps its session in AsyncStorage/SecureStore and never writes
 * a cookie, so the presence cookies (`rf-op-auth` / `rf-buyer-auth`, written by
 * the Next app's own auth code) are structurally invisible for the mobile-app
 * population. Without this marker a returning mobile-app user who types the
 * domain lands on the marketing home instead of their app. The middleware sets
 * it on every phone DOCUMENT request it proxies, and reads it back at "/".
 * httpOnly: it is a routing signal for this middleware only, never for page JS.
 *
 * 30-day ROLLING marker: every proxied document load re-stamps it, so a real
 * mobile-app user never loses it, while a first-time visitor who taps "Sign in"
 * on the marketing site and then abandons the app stops being proxied at "/"
 * after 30 days instead of a year. `?desktop=1` and the `prefer-desktop`
 * cookie still win immediately, at any age.
 */
export const MOBILE_APP_COOKIE = "rf-mobile-app";
const MOBILE_APP_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, re-stamped on every proxied document

/** Rough mobile UA detection — matches phones + small tablets, not desktop. */
function isMobileUserAgent(ua: string): boolean {
  // "Mobi" covers Firefox/Chrome mobile; "Android" covers Android WebViews.
  // iPad UAs say "Macintosh" in iPadOS 13+, so we also check for touch via
  // the viewport hint below. This is intentionally coarse — desktop browsers
  // in DevTools mobile mode will still match, which is fine.
  return /Mobi|Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

/**
 * Extracts the tenant slug from the subdomain of the Host header and stores it
 * as a cookie so the TenantProvider can fetch branding on the client side.
 * Also redirects mobile browsers to the mobile-web Railway deployment.
 *
 * e.g.  acme.routeflow.io  →  cookie tenant-slug=acme
 *       localhost:3001      →  no cookie set (dev: use X-Tenant-Slug header instead)
 */
export function middleware(request: NextRequest) {
  // Redirect phones to the mobile-web build. Skip API routes, Next.js
  // internals, and anyone who opts out via `?desktop=1` (escape hatch for
  // people intentionally using the desktop UI on a phone).
  const pathname = request.nextUrl.pathname;
  const url = request.nextUrl;
  const optedOutOfMobile =
    url.searchParams.get("desktop") === "1" || request.cookies.get("prefer-desktop")?.value === "1";
  const opAuthed = request.cookies.get(OP_PRESENCE_COOKIE)?.value === "1";
  const buyerAuthed = request.cookies.get(BUYER_PRESENCE_COOKIE)?.value === "1";
  const signedIn = opAuthed || buyerAuthed;
  const isProd = process.env.NODE_ENV === "production";
  // Set on this browser by the proxy block below the first time it was served
  // the mobile-web build. See MOBILE_APP_COOKIE.
  const mobileAppSeen = request.cookies.get(MOBILE_APP_COOKIE)?.value === "1";
  // Who owns "/" on a phone:
  //   - opted out (?desktop=1 / prefer-desktop) → the desktop UI, always wins;
  //   - signed in to the Next web app (presence cookie) OR previously served
  //     the mobile-web build (rf-mobile-app) → proxied to the mobile-web build,
  //     which does its own role routing. This is what the landing redirect
  //     below cannot do for them: it targets /dashboard and /buyer/portal,
  //     neither of which the mobile-web build has a route for;
  //   - otherwise (a first-time visitor) → the public marketing home.
  // Every OTHER marketing page is carved out unconditionally, as are the
  // assets those pages load, the auth CTAs their chrome links, and any
  // web-only surface with no Expo counterpart at all (B505) — platform-admin
  // and the email-link /verify-email flow, currently.
  const skipMobileRedirect =
    optedOutOfMobile ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    isMarketingAsset(pathname) ||
    MARKETING_AUTH_PATH_SET.has(pathname) ||
    isWebOnlyPath(pathname) ||
    (isMarketingPath(pathname) && !(pathname === "/" && (signedIn || mobileAppSeen)));

  if (!skipMobileRedirect) {
    const ua = request.headers.get("user-agent") ?? "";
    if (isMobileUserAgent(ua)) {
      // Proxy the mobile-web content so the browser URL stays at www.routeflow.info.
      // The JS bundles/assets are still served from the Railway origin directly (CORS),
      // but the initial HTML is proxied and the visible URL never changes.
      const proxyTarget = new URL(MOBILE_WEB_URL);
      proxyTarget.pathname = pathname;
      proxyTarget.search = url.search;
      const proxied = NextResponse.rewrite(proxyTarget);
      // Remember that this browser lives in the mobile-web build, so a later
      // visit to "/" goes back to the app instead of the marketing home. Only
      // on DOCUMENT requests: the SPA's own subresource fetches (bundles,
      // images, its manifest) are proxied too and must not mint the marker.
      if ((request.headers.get("accept") ?? "").includes("text/html")) {
        proxied.cookies.set(MOBILE_APP_COOKIE, "1", {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: MOBILE_APP_COOKIE_MAX_AGE,
          secure: isProd,
        });
      }
      return proxied;
    }
  }

  // Signed-in users skip the landing page: operators → dashboard, buyers →
  // buyer portal; when both sessions are live the portal used last wins
  // (rf-last-portal, written by each portal's authenticated layout) and the
  // seller dashboard is the default. Keyed on the presence cookies, which track
  // the live session (30-day sliding window re-set on every token refresh,
  // cleared on refresh failure — see lib/presence-cookies.ts). Deliberately
  // scoped to exactly "/": every other marketing page stays reachable while
  // signed in. Runs AFTER the mobile-UA proxy: a phone carrying either signal
  // the carve-out reads (a presence cookie, or rf-mobile-app) was proxied above
  // and never reaches this block, so a phone that does reach it is either a
  // first-time visitor — signed out, where resolveLandingTarget returns null —
  // or opted out of the mobile build, where landing on /dashboard is what they
  // asked for. 307 (never 308) so nothing is cached if the user signs out.
  // Decisions live in lib/portal-routing.ts.
  if (pathname === "/") {
    const target = resolveLandingTarget({
      opAuthed,
      buyerAuthed,
      lastPortal: request.cookies.get(LAST_PORTAL_COOKIE)?.value,
    });
    if (target) {
      const dest = url.clone();
      dest.pathname = target;
      dest.search = "";
      const res = NextResponse.redirect(dest, 307);
      // Preserve the desktop opt-out even though we return before the
      // prefer-desktop block below.
      if (url.searchParams.get("desktop") === "1") {
        res.cookies.set("prefer-desktop", "1", {
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24 * 30,
        });
      }
      return res;
    }
  }

  // Buyer-only guard: a signed-in buyer with no operator session who asks for an
  // operator surface goes to the operator sign-in with the destination kept, so
  // a person who is both a buyer and a seller can open the second session (the
  // sign-in page offers "Go to buyer portal" to everyone else). The operator
  // path list lives in lib/portal-routing.ts, shared with that page's redirect
  // validation so the two can never drift.
  const guardTarget = resolveOperatorPathGuard({
    pathname,
    search: url.search,
    opAuthed,
    buyerAuthed,
  });
  if (guardTarget) {
    const parsed = new URL(guardTarget, url.origin);
    const dest = url.clone();
    dest.pathname = parsed.pathname;
    dest.search = parsed.search;
    return NextResponse.redirect(dest, 307);
  }

  // Remember the desktop opt-out so subsequent nav on the phone stays here.
  if (url.searchParams.get("desktop") === "1") {
    const res = NextResponse.next();
    res.cookies.set("prefer-desktop", "1", {
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  const response = NextResponse.next();

  // Allow manual override via request header (useful in dev / mobile apps).
  // In production this header is stripped by the reverse proxy; only local dev uses it.
  const headerSlug = request.headers.get("x-tenant-slug");
  if (headerSlug) {
    response.cookies.set("tenant-slug", headerSlug, {
      // MUST be readable by client-side JS. The Axios interceptor in
      // apps/web/lib/api-client.ts attaches X-Tenant-Slug to every API
      // request by reading document.cookie; if this is httpOnly the
      // interceptor sees nothing, the API can't resolve the tenant on
      // /auth/login, and login fails with "Invalid credentials".
      // The slug is not a secret — it's the public subdomain — so httpOnly
      // adds no real security and breaks login. Do not change to httpOnly.
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });
    return response;
  }

  const host = request.headers.get("host") ?? "";
  // host may be "acme.routeflow.io" or "acme.routeflow.io:443" — strip port
  const hostname = host.split(":")[0];

  // Tenant resolution precedence:
  //   1. Real subdomain (e.g. acme.routeflow.info) → authoritative, overwrites cookie
  //   2. Existing cookie (user picked a workspace on the login form, or
  //      previous successful login anchored it to the user's actual tenant) → preserve
  //   3. Otherwise → no cookie set; the login page asks the user for a workspace.
  // Shared with the login page's getSubdomainWorkspace() — see `@/lib/tenant-host`.
  const subdomainSlug: string | null = tenantSlugFromHostname(hostname);

  const existingCookieSlug = request.cookies.get("tenant-slug")?.value || null;

  let resolvedSlug: string | null = null;
  if (subdomainSlug) {
    resolvedSlug = subdomainSlug;
  } else if (existingCookieSlug) {
    // Preserve — do not overwrite below
    resolvedSlug = null;
  }

  if (resolvedSlug) {
    response.cookies.set("tenant-slug", resolvedSlug, {
      // MUST stay non-httpOnly. The Axios interceptor in
      // apps/web/lib/api-client.ts and the TenantProvider both read this
      // via document.cookie. Making it httpOnly silently breaks login
      // (the API can't resolve the tenant on /auth/login → "Invalid
      // credentials") and tenant branding. The slug is the public
      // subdomain, not a secret, so httpOnly buys no real security.
      httpOnly: false,
      sameSite: "strict", // prevent cross-site requests from sending tenant context
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      secure: isProd,
    });
  }

  return response;
}

export const config = {
  // Run on all routes except Next.js internals and static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
