import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { BuyerPaymentRequestStatus, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { refDedupeFromRequest } from "../invoices/payment-ref-dedupe";
import { PaymentRequestsService } from "./payment-requests.service";

class ApprovePaymentRequestDto {
  /** SA-837b item 2: the approving staff member's resend of an approval refused as a duplicate payment reference. */
  @IsOptional() @IsBoolean() recordAnyway?: boolean;
}

class RejectPaymentRequestDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class ListPaymentRequestsDto {
  /** class-validator rejects anything outside the enum with a 400 — a raw
   * `@Query("status") status?: string` would otherwise pass a garbage value
   * straight into a Prisma `where.status` and 500. */
  @IsOptional() @IsEnum(BuyerPaymentRequestStatus) status?: BuyerPaymentRequestStatus;
}

/**
 * Tenant-side review of buyer payment requests. Approving a CASH declaration is
 * the moment money is written (oldest-first allocation via
 * recordStandalonePayment); CARD requests settle from the Stripe webhook and
 * appear here as history only.
 */
@ApiTags("payment-requests")
@Controller("payment-requests")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@ApiBearerAuth()
export class PaymentRequestsController {
  constructor(private readonly payments: PaymentRequestsService) {}

  @Get()
  @ApiOperation({ summary: "Buyer payment requests, with allocation preview on pending ones" })
  list(@Query() query: ListPaymentRequestsDto) {
    return this.payments.listForTenant(query.status);
  }

  @Post(":id/approve")
  @ApiOperation({ summary: "Approve a declared cash payment — writes the money" })
  approve(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ApprovePaymentRequestDto = {},
  ) {
    // SA-837b item 2: the APPROVING staff member's actor, role and flag: they are the one who can record a repeat anyway.
    return this.payments.approve(
      id,
      { id: user.sub, username: user.username },
      refDedupeFromRequest(user, dto ?? {}),
    );
  }

  @Post(":id/reject")
  @ApiOperation({ summary: "Reject a declared cash payment" })
  reject(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: RejectPaymentRequestDto,
  ) {
    return this.payments.reject(id, { id: user.sub, username: user.username }, dto.reason);
  }
}
