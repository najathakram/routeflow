import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { ReturnsService } from "./returns.service";

@Controller("returns")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Post()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  create(@Body() dto: any, @CurrentUser() user: JwtPayload) {
    return this.returnsService.create(dto, user.sub, user.role);
  }

  @Get()
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query("orderId") orderId?: string,
    @Query("customerId") customerId?: string,
    @Query("status") status?: string,
    @Query("reason") reason?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.returnsService.findAllForUser(
      user,
      orderId,
      customerId,
      status,
      reason,
      page ? +page : 1,
      limit ? +limit : 20,
    );
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER)
  findOne(@Param("id") id: string) {
    return this.returnsService.findOne(id);
  }

  @Post(":id/cancel")
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  cancel(@Param("id") id: string) {
    return this.returnsService.cancel(id);
  }
}
