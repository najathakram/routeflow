import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { VariantResolutionService } from "./variant-resolution.service";
import {
  CompleteSetupDto,
  CreateBrandNewDto,
  CreateVariantDto,
  MatchExistingDto,
} from "./dto/resolution.dto";

/**
 * Variant resolution for unmatched scanned/imported lines (spec §5) + the
 * "Finish setup" queue for incomplete products. TENANT_ADMIN satisfies
 * @Roles(OPERATOR).
 */
@Controller("import/resolution")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ResolutionController {
  constructor(private readonly resolution: VariantResolutionService) {}

  @Post("variant")
  createVariant(@Body() dto: CreateVariantDto) {
    return this.resolution.createVariant(dto);
  }

  @Post("brand-new")
  createBrandNew(@Body() dto: CreateBrandNewDto) {
    return this.resolution.createBrandNew(dto);
  }

  @Post("match")
  matchExisting(@Body() dto: MatchExistingDto) {
    return this.resolution.matchExisting(dto);
  }

  /** Products still needing setup (brand-new, unconfirmed). */
  @Get("incomplete")
  listIncomplete() {
    return this.resolution.listIncomplete();
  }

  @Patch(":id/complete")
  complete(@Param("id") id: string, @Body() dto: CompleteSetupDto) {
    return this.resolution.completeSetup(id, dto);
  }
}
