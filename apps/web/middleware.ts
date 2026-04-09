import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Subdomains that are platform-level, never tenant slugs
const PLATFORM_HOSTS = new Set([
  "www", "app", "api", "admin", "static", "assets",
  "mail", "support", "platform", "billing", "localhost",
]);

/**
 * Extracts the tenant slug from the subdomain of the Host header and stores it
 * as a cookie so the TenantProvider can fetch branding on the client side.
 *
 * e.g.  acme.routeflow.io  →  cookie tenant-slug=acme
 *       localhost:3001      →  no cookie set (dev: use X-Tenant-Slug header instead)
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Allow manual override via request header (useful in dev / mobile apps)
  const headerSlug = request.headers.get("x-tenant-slug");
  if (headerSlug) {
    response.cookies.set("tenant-slug", headerSlug, {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return response;
  }

  const host = request.headers.get("host") ?? "";
  // host may be "acme.routeflow.io" or "acme.routeflow.io:443" — strip port
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");

  // A real subdomain looks like  <slug>.routeflow.io  →  3 parts
  // localhost or bare domain → 1 part → skip
  if (parts.length >= 3) {
    const subdomain = parts[0];
    if (subdomain && !PLATFORM_HOSTS.has(subdomain)) {
      response.cookies.set("tenant-slug", subdomain, {
        httpOnly: false,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }
  }

  return response;
}

export const config = {
  // Run on all routes except Next.js internals and static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
