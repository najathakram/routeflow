import { Controller, Get, Param, NotFoundException } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { TenantsService } from "./tenants.service";
import { StorageService } from "../storage/storage.service";

@ApiTags("public/tenants")
@Controller("public/tenants")
export class PublicTenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly storage: StorageService,
  ) {}

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
    const logoUrl = branding.logoKey
      ? await this.storage.presignedUrl(branding.logoKey)
      : null;

    return { ...branding, logoUrl };
  }
}
