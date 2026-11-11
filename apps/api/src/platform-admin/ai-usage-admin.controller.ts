import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { PlatformScoped } from "../tenant/platform-scoped.decorator";
import { AiUsageAdminService } from "./ai-usage-admin.service";

/**
 * AI limits PR-2: the super-admin usage view. Its own controller (platform-admin.controller.ts keeps its constructor);
 * the class-level guards are the platform-admin pair, so every other role gets 403. Read-only.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@PlatformScoped()
@Controller("platform-admin")
export class AiUsageAdminController {
  constructor(private readonly usage: AiUsageAdminService) {}

  @Get("ai-usage/by-business")
  @ApiOperation({
    summary:
      "Every business's estimated AI spend for one UTC month next to its allowance (the platform cap, or its own override)",
  })
  @ApiQuery({ name: "month", required: false, description: "YYYY-MM (UTC); default this month" })
  byBusiness(@Query("month") month?: string) {
    return this.usage.byBusiness(month);
  }
}
