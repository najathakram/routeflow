import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PlatformAdminService } from "./platform-admin.service";
import { UpdateTenantStatusDto } from "./dto/update-tenant-status.dto";
import { UpdateTenantPlanDto } from "./dto/update-tenant-plan.dto";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { ExtendTrialDto } from "./dto/extend-trial.dto";
import type { JwtPayload } from "../auth/jwt-payload.interface";

@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class PlatformAdminController {
  constructor(private readonly svc: PlatformAdminService) {}

  @Get("stats")
  @ApiOperation({ summary: "Platform-wide aggregate stats" })
  getStats() {
    return this.svc.getStats();
  }

  @Get("tenants")
  @ApiOperation({ summary: "Paginated list of all tenants with stats" })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  listTenants(
    @Query("page") page = "1",
    @Query("limit") limit = "20",
  ) {
    return this.svc.listTenants(Number(page), Number(limit));
  }

  @Post("tenants")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Manually create a new tenant (admin-provisioned, starts ACTIVE)" })
  createTenant(@Body() dto: CreateTenantDto) {
    return this.svc.createTenant(dto);
  }

  @Get("tenants/:id")
  @ApiOperation({ summary: "Get a single tenant with full details" })
  getTenant(@Param("id") id: string) {
    return this.svc.getTenant(id);
  }

  @Delete("tenants/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete (cancel) a tenant" })
  deleteTenant(@Param("id") id: string) {
    return this.svc.deleteTenant(id);
  }

  @Patch("tenants/:id/status")
  @ApiOperation({ summary: "Suspend or reactivate a tenant" })
  updateStatus(@Param("id") id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.svc.updateStatus(id, dto);
  }

  @Patch("tenants/:id/plan")
  @ApiOperation({ summary: "Change a tenant's plan" })
  updatePlan(@Param("id") id: string, @Body() dto: UpdateTenantPlanDto) {
    return this.svc.updatePlan(id, dto);
  }

  @Post("tenants/:id/impersonate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Issue a 15-min impersonation token for a tenant. Read-only — mutations are blocked.",
  })
  impersonate(@Param("id") id: string, @CurrentUser() admin: JwtPayload) {
    return this.svc.impersonate(id, admin.sub);
  }

  @Post("tenants/:id/extend-trial")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Extend tenant trial period by N days from now" })
  extendTrial(@Param("id") id: string, @Body() dto: ExtendTrialDto) {
    return this.svc.extendTrial(id, dto.days);
  }

  @Post("tenants/:id/reset-admin-password")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset the TENANT_ADMIN password and force change on next login" })
  resetAdminPassword(@Param("id") id: string) {
    return this.svc.resetTenantAdminPassword(id);
  }

  @Get("audit-logs")
  @ApiOperation({ summary: "Platform-wide audit log" })
  @ApiQuery({ name: "tenantId", required: false })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getAuditLogs(
    @Query("tenantId") tenantId?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "50",
  ) {
    return this.svc.getAuditLogs(tenantId || null, Number(page), Number(limit));
  }
}
