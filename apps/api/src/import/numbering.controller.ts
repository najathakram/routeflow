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
 * hub. TENANT_ADMIN satisfies @Roles(OPERATOR). SA-274: the card covers only
 * the three year-scoped types (INVOICE/ESTIMATE/CREDIT_NOTE) — PAYMENT is
 * dropped (Q6), so `:docType` = "PAYMENT" 400s via `parseDocType` below same
 * as any other unknown type; its own counter is unaffected and untouched.
 */
@Controller("import/numbering")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.TENANT_ADMIN)
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  /**
   * The three document-type sequences with current config + a live preview.
   * Once a row is saved it IS that doc type's live series (SA-274 Q1) — the
   * preview is the true next number that would be minted, not a static
   * default.
   */
  @Get()
  getSettings() {
    return this.numbering.getSettings();
  }

  /**
   * Edit one sequence (prefix / next number / padding). `expectedNextNumber`
   * is the optimistic-concurrency token (SA-274 Q3): pass the `nextNumber`
   * the card loaded to get a 409 instead of clobbering a save that landed in
   * between. A `nextNumber` at or below an existing document of this type is
   * refused with a 400 naming it (Q2) — never silently raised.
   */
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
