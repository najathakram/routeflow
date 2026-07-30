import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { ReturnsService } from "./returns.service";
import { ReceiveReturnDto } from "./dto/receive-return.dto";
import { ProcessRefundDto } from "./dto/process-refund.dto";

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

  /** RF-081: Restricted to OPERATOR | TENANT_ADMIN | CUSTOMER (no DRIVER).
   * CUSTOMER role gets an ownership check inside findOneForUser(). */
  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.returnsService.findOneForUser(id, user);
  }

  @Post(":id/approve")
  @Roles(UserRole.OPERATOR)
  approve(@Param("id") id: string) {
    return this.returnsService.approve(id);
  }

  @Post(":id/reject")
  @Roles(UserRole.OPERATOR)
  reject(@Param("id") id: string) {
    return this.returnsService.reject(id);
  }

  @Post(":id/in-transit")
  @Roles(UserRole.OPERATOR)
  markInTransit(@Param("id") id: string) {
    return this.returnsService.markInTransit(id);
  }

  @Post(":id/receive")
  @Roles(UserRole.OPERATOR)
  receive(@Param("id") id: string, @CurrentUser() user: JwtPayload, @Body() dto: ReceiveReturnDto) {
    return this.returnsService.receive(id, user.sub, { restock: dto?.restock });
  }

  @Post(":id/refund")
  @Roles(UserRole.OPERATOR)
  processRefund(@Param("id") id: string, @Body() dto: ProcessRefundDto) {
    return this.returnsService.processRefund(id, dto);
  }

  @Post(":id/cancel")
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  cancel(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.returnsService.cancel(id, user);
  }
}
