import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { PlatformScoped } from "../tenant/platform-scoped.decorator";
import { EntitlementSweepService } from "../billing/entitlement-sweep.service";

/**
 * FG-1 WP1 (R10): the read-only entitlement sweep. Its own controller (platform-admin.controller.ts
 * keeps its constructor); the class-level guards are the platform-admin pair, so anyone but a
 * super admin gets 403 (401 without a token). Hashed ids only, no business names.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@PlatformScoped()
@Controller("platform-admin")
export class EntitlementSweepController {
  constructor(private readonly sweep: EntitlementSweepService) {}

  @Get("entitlements/sweep")
  @ApiOperation({
    summary:
      "Read-only: per tenant (hashed id), old / effective / strict / client bits for every gated key; the first page also carries mode and planFlagEnforcement",
  })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  page(@Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.sweep.sweep({
      cursor: cursor || undefined,
      limit: limit === undefined ? undefined : Number(limit),
    });
  }
}
