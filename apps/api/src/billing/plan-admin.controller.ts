import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { PlanCatalogService } from "./plan-catalog.service";
import { UpdatePlanDefinitionDto } from "./dto/update-plan-definition.dto";
import { UpdateAddonSkuDto } from "./dto/update-addon-sku.dto";

/**
 * Platform-admin authoring of the versioned plan catalog (admin-plans surface).
 * SUPER_ADMIN only. Editing is confined to DRAFT versions; publishing supersedes
 * the prior published version. Existing tenants are never re-pinned by a publish.
 */
@ApiTags("billing")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("billing/admin/plans")
export class PlanAdminController {
  constructor(private readonly catalog: PlanCatalogService) {}

  @Get("versions")
  @ApiOperation({ summary: "List every catalog version (newest first)" })
  listVersions() {
    return this.catalog.listVersions();
  }

  @Post("versions")
  @ApiOperation({ summary: "Open a new DRAFT cloned from the published catalog" })
  createDraft() {
    return this.catalog.createDraft();
  }

  @Patch("versions/:versionId/definitions/:planKey")
  @ApiOperation({ summary: "Edit a plan definition in a DRAFT version" })
  updateDefinition(
    @Param("versionId") versionId: string,
    @Param("planKey") planKey: string,
    @Body() dto: UpdatePlanDefinitionDto,
  ) {
    return this.catalog.updateDefinition(versionId, planKey, dto);
  }

  @Patch("versions/:versionId/skus/:sku")
  @ApiOperation({ summary: "Edit an add-on SKU in a DRAFT version" })
  updateSku(
    @Param("versionId") versionId: string,
    @Param("sku") sku: string,
    @Body() dto: UpdateAddonSkuDto,
  ) {
    return this.catalog.updateSku(versionId, sku, dto);
  }

  @Post("versions/:versionId/publish")
  @ApiOperation({ summary: "Publish a DRAFT version (supersedes the prior published one)" })
  publish(
    @Param("versionId") versionId: string,
    @Req() req: Request & { user?: { sub?: string } },
  ) {
    return this.catalog.publish(versionId, req.user?.sub);
  }

  @Delete("versions/:versionId")
  @ApiOperation({ summary: "Discard a DRAFT version" })
  discardDraft(@Param("versionId") versionId: string) {
    return this.catalog.discardDraft(versionId);
  }
}
