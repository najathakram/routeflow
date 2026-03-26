import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreditNotesService } from "./credit-notes.service";

@Controller("credit-notes")
@UseGuards(JwtAuthGuard)
export class CreditNotesController {
  constructor(private readonly creditNotesService: CreditNotesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: any) { return this.creditNotesService.create(dto); }

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query("customerId") customerId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.creditNotesService.findAllForUser(user, customerId, page ? +page : 1, limit ? +limit : 20);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.creditNotesService.findOneForUser(id, user);
  }

  @Post(":id/issue")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  issue(@Param("id") id: string) { return this.creditNotesService.issue(id); }

  @Post(":id/apply")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  apply(@Param("id") id: string, @Body("invoiceId") invoiceId: string) {
    return this.creditNotesService.applyToInvoice(id, invoiceId);
  }

  @Post(":id/void")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  voidNote(@Param("id") id: string) { return this.creditNotesService.voidCreditNote(id); }
}
