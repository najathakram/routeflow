import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { tenantSlugFromHostname } from "@/lib/tenant-host";
import {
  BUYER_PRESENCE_COOKIE,
  LAST_PORTAL_COOKIE,
  OP_PRESENCE_COOKIE,
} from "@/lib/presence-cookies";
import { resolveLandingTarget, resolveOperatorPathGuard } from "@/lib/portal-routing";

// Platform-level subdomains and hosting-provider base domains live in
// `@/lib/tenant-host` so the login page derives the workspace with exactly these
// rules. They were duplicated here and there, and the copies drifted — see the
// header of that module.

/**
 * Extracts the tenant slug from the subdomain of the Host header and stores it
 * as a cookie so the TenantProvider can fetch branding on the client side.
 *
 * e.g.  acme.routeflow.io  →  cookie tenant-slug=acme
 *       localhost:3001      →  no cookie set (dev: use X-Tenant-Slug header instead)
 */
export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const url = request.nextUrl;
  const opAuthed = request.cookies.get(OP_PRESENCE_COOKIE)?.value === "1";
  const buyerAuthed = request.cookies.get(BUYER_PRESENCE_COOKIE)?.value === "1";
  const isProd = process.env.NODE_ENV === "production";

  // Signed-in users skip the landing page: operators → dashboard, buyers →
  // buyer portal; when both sessions are live the portal used last wins
  // (rf-last-portal, written by each portal's authenticated layout) and the
  // seller dashboard is the default. Keyed on the presence cookies, which track
  // the live session (30-day sliding window re-set on every token refresh,
  // cleared on refresh failure — see lib/presence-cookies.ts). Deliberately
  // scoped to exactly "/": every other marketing page stays reachable while
  // signed in. Everyone reaches this block now — phones included: the
  // mobile-web (Expo) proxy this middleware used to run for phone UAs is
  // gone (owner ruling: phones get the same redesigned web site as desktop;
  // drivers use the installed app). 307 (never 308) so nothing is cached if
  // the user signs out. Decisions live in lib/portal-routing.ts.
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
      return NextResponse.redirect(dest, 307);
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

  // `?desktop=1` and the `prefer-desktop` cookie are dead now that there's no
  // mobile-web build to opt out of — harmless (never an error) but no longer
  // read or written by this middleware. Left un-stripped from any old link/
  // bookmark rather than actively rejected.
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
