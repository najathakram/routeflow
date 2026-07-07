import { BadRequestException, Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import { DocumentNumberType, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { NumberingService, DOCUMENT_NUMBER_TYPES } from "./numbering.service";
import { UpdateNumberingDto } from "./dto/update-numbering.dto";

/**
 * Tenant-facing numbering-continuity settings (spec §1). Lives in the import
 * module so it can be surfaced on the import page and reused by the migration
 * hub. TENANT_ADMIN satisfies @Roles(OPERATOR).
 */
@Controller("import/numbering")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  /** All four document-type sequences with current config + a live preview. */
  @Get()
  getSettings() {
    return this.numbering.getSettings();
  }

  /** Edit one sequence (prefix / next number / padding). */
  @Put(":docType")
  updateSettings(@Param("docType") docType: string, @Body() dto: UpdateNumberingDto) {
    return this.numbering.updateSettings(this.parseDocType(docType), dto);
  }

  private parseDocType(raw: string): DocumentNumberType {
    const normalized = (raw ?? "").toUpperCase() as DocumentNumberType;
    if (!DOCUMENT_NUMBER_TYPES.includes(normalized)) {
      throw new BadRequestException(`Unknown document type "${raw}".`);
    }
    return normalized;
  }
}
