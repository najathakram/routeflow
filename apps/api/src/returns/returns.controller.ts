import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ReturnsService } from "./returns.service";

@Controller("returns")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Post()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  create(@Body() dto: any, @CurrentUser() user: { sub: string }) {
    return this.returnsService.create(dto, user.sub);
  }

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  findAll(
    @Query("orderId") orderId?: string,
    @Query("customerId") customerId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.returnsService.findAll(orderId, customerId, page ? +page : 1, limit ? +limit : 20);
  }

  @Get(":id")
  findOne(@Param("id") id: string) { return this.returnsService.findOne(id); }

  @Post(":id/cancel")
  cancel(@Param("id") id: string) { return this.returnsService.cancel(id); }
}
