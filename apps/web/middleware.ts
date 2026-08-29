import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { tenantSlugFromHostname } from "@/lib/tenant-host";

// Platform-level subdomains and hosting-provider base domains live in
// `@/lib/tenant-host` so the login page derives the workspace with exactly these
// rules. They were duplicated here and there, and the copies drifted — see the
// header of that module.

// Mobile-web build served by the @routeflow/mobile Railway service. When phones
// hit the Next.js web app we rewrite (proxy) the response from this URL so the
// browser address bar keeps showing www.routeflow.info instead of changing domains.
const MOBILE_WEB_URL =
  process.env.NEXT_PUBLIC_MOBILE_WEB_URL ?? "https://routeflowmobile-production.up.railway.app";

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
  const skipMobileRedirect =
    optedOutOfMobile || pathname.startsWith("/api/") || pathname.startsWith("/_next/");

  if (!skipMobileRedirect) {
    const ua = request.headers.get("user-agent") ?? "";
    if (isMobileUserAgent(ua)) {
      // Proxy the mobile-web content so the browser URL stays at www.routeflow.info.
      // The JS bundles/assets are still served from the Railway origin directly (CORS),
      // but the initial HTML is proxied and the visible URL never changes.
      const proxyTarget = new URL(MOBILE_WEB_URL);
      proxyTarget.pathname = pathname;
      proxyTarget.search = url.search;
      return NextResponse.rewrite(proxyTarget);
    }
  }

  // Signed-in users skip the landing page: operators → dashboard, buyers →
  // buyer portal. Keyed on the presence cookies, which now track the live
  // session (3-day sliding window re-set on every token refresh, cleared on
  // refresh failure — see lib/presence-cookies.ts). Deliberately scoped to
  // exactly "/": every other marketing page stays reachable while signed in.
  // Runs AFTER the mobile-UA proxy so phones land in the mobile-web build,
  // which does its own role-based routing. Operator wins when both cookies
  // are present (consistent with the buyer guard below). 307 (never 308) so
  // nothing is cached if the user signs out.
  if (pathname === "/") {
    const opAuthed = request.cookies.get("rf-op-auth")?.value === "1";
    const buyerAuthed = request.cookies.get("rf-buyer-auth")?.value === "1";
    const target = opAuthed ? "/dashboard" : buyerAuthed ? "/buyer/portal" : null;
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

  // Buyer-only guard: signed-in buyers without an operator session must not be
  // able to reach operator surfaces — bounce them back to the buyer portal.
  const OPERATOR_PATH_PREFIXES = [
    "/dashboard",
    "/settings",
    "/invoices",
    "/customers",
    "/products",
    "/routes",
    "/orders",
    "/finance",
    "/credit-notes",
    "/estimates",
    "/inventory",
    "/suppliers",
    "/purchases",
    "/vendor-bills",
    "/returns",
    "/analytics",
    "/bookkeeping",
    "/drivers",
  ];
  const isOperatorPath = OPERATOR_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (isOperatorPath) {
    const buyerCookie = request.cookies.get("rf-buyer-auth")?.value;
    const opCookie = request.cookies.get("rf-op-auth")?.value;
    if (buyerCookie && !opCookie) {
      const target = url.clone();
      target.pathname = "/buyer/portal";
      target.search = "";
      return NextResponse.redirect(target);
    }
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
  const isProd = process.env.NODE_ENV === "production";
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
