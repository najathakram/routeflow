import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { PlatformAdminBuyersService } from "./platform-admin-buyers.service";

/**
 * Read-only enrichment endpoints for the platform-admin Buyers screen. Writes
 * (approve/reject merge, suspend buyer) stay on the existing buyer-module
 * endpoints under /platform-admin/buyer-accounts and /buyer-merge-requests.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class PlatformAdminBuyersController {
  constructor(private readonly svc: PlatformAdminBuyersService) {}

  @Get("buyer-directory")
  @ApiOperation({
    summary: "Cross-tenant buyer directory with business name, seller count, orders-90d + segments",
  })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "segment", required: false, enum: ["all", "multi-seller", "unverified"] })
  getBuyerDirectory(
    @Query("page") page = "1",
    @Query("limit") limit = "25",
    @Query("search") search?: string,
    @Query("segment") segment?: string,
  ) {
    return this.svc.getBuyerDirectory({
      page: Number(page),
      limit: Number(limit),
      search: search || null,
      segment: segment || null,
    });
  }

  @Get("buyer-merge-summary")
  @ApiOperation({
    summary: "Pending buyer-merge requests enriched with per-account sellers + orders-90d",
  })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getPendingMergeSummary(@Query("limit") limit = "20") {
    return this.svc.getPendingMergeSummary({ limit: Number(limit) });
  }
}
