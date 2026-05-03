import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Middleware that runs before authentication and resolves the tenant from:
 * 1. X-Tenant-Slug request header
 * 2. Subdomain extracted from the Host header (e.g. "acme" from "acme.routeflow.io")
 *
 * Sets req.resolvedTenantId and req.resolvedTenantSlug for use by LocalStrategy
 * and the tenant-specific Google OAuth handler.
 */
@Injectable()
export class TenantResolutionMiddleware implements NestMiddleware {
  private static readonly RESERVED_SLUGS = new Set([
    "api",
    "www",
    "admin",
    "app",
    "static",
    "assets",
    "mail",
    "support",
  ]);

  // Hosting-provider base domains — never extract a tenant slug from these.
  // Mirrors HOSTING_PROVIDER_DOMAINS in apps/web/middleware.ts.
  private static readonly HOSTING_PROVIDER_DOMAINS = new Set([
    "railway.app",
    "up.railway.app",
    "vercel.app",
    "netlify.app",
    "render.com",
    "fly.dev",
    "onrender.com",
    "herokuapp.com",
  ]);

  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const headerSlug = req.headers["x-tenant-slug"] as string | undefined;
    const slug = headerSlug || this.extractSubdomain(req.headers.host);

    if (slug && !TenantResolutionMiddleware.RESERVED_SLUGS.has(slug)) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { slug },
        select: { id: true, status: true },
      });
      if (tenant && tenant.status !== "SUSPENDED" && tenant.status !== "CANCELLED") {
        (req as any).resolvedTenantId = tenant.id;
        (req as any).resolvedTenantSlug = slug;
      }
    }

    next();
  }

  private extractSubdomain(host?: string): string | null {
    if (!host) return null;
    const hostname = host.split(":")[0]; // strip port
    const parts = hostname.split(".");
    // Only treat as subdomain if there are at least 3 parts (sub.domain.tld)
    if (parts.length < 3) return null;
    const twoPartBase = parts.slice(-2).join(".");
    const threePartBase = parts.slice(-3).join(".");
    if (
      TenantResolutionMiddleware.HOSTING_PROVIDER_DOMAINS.has(twoPartBase) ||
      TenantResolutionMiddleware.HOSTING_PROVIDER_DOMAINS.has(threePartBase)
    ) {
      return null;
    }
    const sub = parts[0];
    return sub || null;
  }
}
