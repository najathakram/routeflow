import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CreditNotesService } from "./credit-notes.service";

@Controller("credit-notes")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class CreditNotesController {
  constructor(private readonly creditNotesService: CreditNotesService) {}

  @Post()
  create(@Body() dto: any) { return this.creditNotesService.create(dto); }

  @Get()
  findAll(@Query("customerId") customerId?: string, @Query("page") page?: string, @Query("limit") limit?: string) {
    return this.creditNotesService.findAll(customerId, page ? +page : 1, limit ? +limit : 20);
  }

  @Get(":id")
  findOne(@Param("id") id: string) { return this.creditNotesService.findOne(id); }

  @Post(":id/issue")
  issue(@Param("id") id: string) { return this.creditNotesService.issue(id); }

  @Post(":id/apply")
  apply(@Param("id") id: string, @Body("invoiceId") invoiceId: string) {
    return this.creditNotesService.applyToInvoice(id, invoiceId);
  }

  @Post(":id/void")
  voidNote(@Param("id") id: string) { return this.creditNotesService.voidCreditNote(id); }
}
