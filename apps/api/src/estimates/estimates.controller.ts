import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { EstimatesService } from "./estimates.service";

@Controller("estimates")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) {}

  @Post() create(@Body() dto: any) { return this.estimatesService.create(dto); }
  @Get() findAll(@Query("customerId") cId?: string, @Query("page") page?: string, @Query("limit") limit?: string) { return this.estimatesService.findAll(cId, page ? +page : 1, limit ? +limit : 20); }
  @Get(":id") findOne(@Param("id") id: string) { return this.estimatesService.findOne(id); }
  @Post(":id/send") send(@Param("id") id: string) { return this.estimatesService.send(id); }
  @Post(":id/accept") accept(@Param("id") id: string) { return this.estimatesService.accept(id); }
  @Post(":id/decline") decline(@Param("id") id: string) { return this.estimatesService.decline(id); }
  @Post(":id/convert-to-invoice") convertToInvoice(@Param("id") id: string) { return this.estimatesService.convertToInvoice(id); }
  @Post(":id/convert") convert(@Param("id") id: string) { return this.estimatesService.convertToInvoice(id); }
}
