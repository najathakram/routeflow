import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  NotFoundException,
  HttpCode,
  HttpStatus,
  Res,
  Req,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { TenantsService } from "./tenants.service";
import { StorageService } from "../storage/storage.service";
import { RegisterTenantDto } from "./dto/register-tenant.dto";
import { IsEmail } from "class-validator";

@ApiTags("public/tenants")
@Controller("public/tenants")
export class PublicTenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly storage: StorageService,
  ) {}

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Self-service tenant signup — creates a new tenant and admin user (14-day trial)",
  })
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async register(@Body() dto: RegisterTenantDto) {
    const result = await this.tenantsService.register(dto);
    return {
      slug: result.tenant.slug,
      adminUsername: result.user.username,
      trialEndsAt: result.tenant.trialEndsAt,
    };
  }

  @Get("username-available")
  @ApiOperation({ summary: "Check if a username is available for self-service signup" })
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async checkUsernameAvailability(@Query("username") username: string) {
    if (!username) return { available: false, reason: "Username is required" };
    const available = await this.tenantsService.isUsernameAvailable(username);
    return {
      username,
      available,
      ...(available ? {} : { reason: "This username is reserved. Please choose a different one." }),
    };
  }

  @Post("resend-verification")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resend email verification link (best-effort, always 200)" })
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async resendVerification(@Body() body: { email: string }) {
    // Always returns 200 — don't leak whether the email exists
    await this.tenantsService.resendVerification(body.email ?? "").catch(() => {});
    return {
      message: "If an account with that email is pending verification, a new link has been sent.",
    };
  }

  @Get(":slug/available")
  @ApiOperation({ summary: "Check if a tenant slug is available" })
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async checkSlugAvailability(@Param("slug") slug: string) {
    const available = await this.tenantsService.isSlugAvailable(slug);
    return { slug, available };
  }

  @Get(":slug/branding")
  @ApiOperation({
    summary:
      "Get public branding info for a tenant (logoUrl points at the public /logo endpoint below)",
  })
  @Throttle({ default: { ttl: 60_000, limit: 100 } })
  async getBranding(@Param("slug") slug: string, @Req() req: Request) {
    const branding = await this.tenantsService.getBranding(slug);
    if (!branding) throw new NotFoundException("Tenant not found");

    // The raw `/api/v1/uploads/<key>` URL requires a JWT (RF-075) AND serves
    // every file as Content-Disposition: attachment (RF-078) — neither works
    // for an `<img src>` rendering the tenant's logo. Hand back the public
    // /public/tenants/:slug/logo URL instead, which streams the bytes inline
    // with no auth (the logo is intentionally public branding).
    const logoUrl = branding.logoKey
      ? `${req.protocol}://${req.get("host")}/api/v1/public/tenants/${encodeURIComponent(slug)}/logo`
      : null;

    return { ...branding, logoUrl };
  }

  @Get(":slug/logo")
  @ApiOperation({
    summary:
      "Stream the tenant's logo image inline. Public — no auth required. Returns 404 if no logo set.",
  })
  @Throttle({ default: { ttl: 60_000, limit: 200 } })
  async getLogo(@Param("slug") slug: string, @Res() res: Response) {
    const branding = await this.tenantsService.getBranding(slug);
    if (!branding?.logoKey) {
      // Use 404 (not throw) so we control the body — keeps it cacheable.
      res.status(HttpStatus.NOT_FOUND).end();
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await this.storage.download(branding.logoKey);
    } catch {
      res.status(HttpStatus.NOT_FOUND).end();
      return;
    }

    // Best-effort MIME detection from the stored key extension. The upload
    // endpoint (TenantsController.uploadLogo) already restricts to the safe
    // raster types via mimetype check (PNG/JPG/WEBP), so this is a closed set.
    const lower = branding.logoKey.toLowerCase();
    const contentType = lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
        ? "image/jpeg"
        : lower.endsWith(".webp")
          ? "image/webp"
          : "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    // Inline so <img src> renders it (the protected /uploads route forces
    // attachment per RF-078).
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Override the global Helmet defaults that would otherwise block this
    // image from being embedded cross-origin:
    //   - The web app loads from www.routeflow.info but the API serves from
    //     routeflowapi-production.up.railway.app, so CORP: same-origin (the
    //     default) makes the browser silently fail the image.
    //   - The API never serves HTML so a permissive CSP here is moot — but
    //     leaving the global same-origin CSP in place is fine; it doesn't
    //     affect cross-origin <img> loads.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // Public branding — safe to cache at edges. Short max-age so a logo swap
    // is visible without users having to bust their cache; the in-app upload
    // flow ALSO bumps the URL via tenantConfig.updatedAt (used as a cache key
    // by the front-end if needed).
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(buffer);
  }
}
