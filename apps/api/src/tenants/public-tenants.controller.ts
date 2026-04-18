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
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
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
  @ApiOperation({ summary: "Get public branding info for a tenant (includes presigned logoUrl)" })
  @Throttle({ default: { ttl: 60_000, limit: 100 } })
  async getBranding(@Param("slug") slug: string) {
    const branding = await this.tenantsService.getBranding(slug);
    if (!branding) throw new NotFoundException("Tenant not found");

    // Resolve logoUrl so clients can display the logo without extra round-trips
    const logoUrl = branding.logoKey ? await this.storage.presignedUrl(branding.logoKey) : null;

    return { ...branding, logoUrl };
  }
}
