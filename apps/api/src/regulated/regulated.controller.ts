import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { RegulatedService } from "./regulated.service";
import { ListLedgerDto } from "./dto/list-ledger.dto";

// Generic feature — no addon gate (mirrors tracked-categories; tobacco stays the
// only addon-gated surface). TENANT_ADMIN satisfies OPERATOR via the RolesGuard.
@Controller("regulated")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class RegulatedController {
  constructor(private readonly regulated: RegulatedService) {}

  @Get("ledger")
  getLedger(@Query() query: ListLedgerDto) {
    return this.regulated.getLedger(query);
  }
}
