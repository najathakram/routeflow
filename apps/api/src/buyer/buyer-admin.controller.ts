import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { BuyerAdminService } from "./buyer-admin.service";

/**
 * SUPER_ADMIN endpoints for platform-level buyer account management.
 * Mirrors /platform-admin/* pattern — all routes require JwtAuthGuard + SuperAdminGuard.
 */
@ApiTags("platform-admin-buyers")
@ApiBearerAuth()
@Controller("platform-admin/buyer-accounts")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class BuyerAdminController {
  constructor(private readonly buyerAdminService: BuyerAdminService) {}

  // ─── Buyer account listing ─────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: "SUPER_ADMIN: List all buyer accounts" })
  listBuyers(
    @Query()
    query: { page?: number; limit?: number; search?: string; status?: string },
  ) {
    return this.buyerAdminService.listBuyers(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "SUPER_ADMIN: Get buyer account with links" })
  getBuyer(@Param("id") id: string) {
    return this.buyerAdminService.getBuyer(id);
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "SUPER_ADMIN: Set buyer account status (ACTIVE/SUSPENDED/DELETED)" })
  setBuyerStatus(
    @Param("id") id: string,
    @Body() dto: { status: "ACTIVE" | "SUSPENDED" | "DELETED" },
  ) {
    return this.buyerAdminService.setBuyerStatus(id, dto.status);
  }

  @Post(":id/impersonate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "SUPER_ADMIN: Issue a buyer JWT to impersonate this buyer" })
  impersonateBuyer(@Param("id") id: string, @CurrentUser() admin: JwtPayload) {
    return this.buyerAdminService.impersonateBuyer(id, admin.sub);
  }
}

/**
 * SUPER_ADMIN: CustomerLink management (separate controller prefix).
 */
@ApiTags("platform-admin-buyers")
@ApiBearerAuth()
@Controller("platform-admin/customer-links")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class CustomerLinksAdminController {
  constructor(private readonly buyerAdminService: BuyerAdminService) {}

  @Get()
  @ApiOperation({ summary: "SUPER_ADMIN: List all customer links across all tenants" })
  listLinks(
    @Query()
    query: { page?: number; limit?: number; status?: string; tenantId?: string },
  ) {
    return this.buyerAdminService.listLinks(query);
  }

  @Get("stats")
  @ApiOperation({ summary: "SUPER_ADMIN: Get link statistics" })
  linkStats() {
    return this.buyerAdminService.linkStats();
  }
}
