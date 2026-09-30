import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { BuyerJwtAuthGuard } from "../buyer/guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "../buyer/guards/buyer-seller-context.guard";
import { BuyerTenantInterceptor } from "../buyer/buyer-tenant.interceptor";
import { CurrentBuyer, CurrentBuyerCustomer } from "../buyer/decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "../buyer/interfaces/buyer-jwt-payload.interface";
import { PaymentRequestsService } from "./payment-requests.service";

class StartCardPaymentDto {
  @IsNumber() @Min(0.5) @Max(999999) amount: number;
  /** The invoice screen the buyer started from — provenance only, never allocation. */
  @IsOptional() @IsString() fromInvoiceId?: string;
}

class DeclareCashPaymentDto {
  @IsNumber() @Min(0.5) @Max(999999) amount: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() fromInvoiceId?: string;
}

/**
 * Buyer-side payments: the "Make a payment" panel. Card payments run on the
 * seller's connected Stripe account; cash declarations wait for the seller's
 * approval. Every payment settles the buyer's OLDEST invoices first.
 */
@ApiTags("buyer")
@Controller("buyer/payments")
@UseGuards(BuyerJwtAuthGuard, BuyerSellerContextGuard)
@UseInterceptors(BuyerTenantInterceptor)
@ApiBearerAuth()
@ApiHeader({ name: "X-Tenant-Slug", required: true })
export class BuyerPaymentsController {
  constructor(private readonly payments: PaymentRequestsService) {}

  @Get("context")
  @ApiOperation({ summary: "Balance due, open invoices, card availability, pending requests" })
  context(@CurrentBuyerCustomer() ctx: any) {
    return this.payments.paymentContext(ctx.tenantId, ctx.customerId);
  }

  @Get("preview")
  @ApiOperation({ summary: "Which invoices a payment of ?amount= would settle (oldest first)" })
  preview(@CurrentBuyerCustomer() ctx: any, @Query("amount") amount: string) {
    return this.payments.previewAllocation(ctx.customerId, Number(amount));
  }

  @Get("requests")
  @ApiOperation({ summary: "The buyer's payment requests at this seller, newest first" })
  requests(@CurrentBuyerCustomer() ctx: any) {
    return this.payments.listForBuyer(ctx.tenantId, ctx.customerId);
  }

  @Post("card")
  @ApiOperation({ summary: "Start a Stripe Checkout payment on the seller's account" })
  card(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @CurrentBuyerCustomer() ctx: any,
    @Body() dto: StartCardPaymentDto,
  ) {
    return this.payments.createCardRequest({
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      customerId: ctx.customerId,
      buyerAccountId: buyer.sub,
      amount: dto.amount,
      fromInvoiceId: dto.fromInvoiceId ?? null,
    });
  }

  @Post("cash")
  @ApiOperation({ summary: "Declare a cash payment for the seller to approve" })
  cash(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @CurrentBuyerCustomer() ctx: any,
    @Body() dto: DeclareCashPaymentDto,
  ) {
    return this.payments.createCashRequest({
      tenantId: ctx.tenantId,
      customerId: ctx.customerId,
      buyerAccountId: buyer.sub,
      amount: dto.amount,
      note: dto.note ?? null,
      reference: dto.reference ?? null,
      fromInvoiceId: dto.fromInvoiceId ?? null,
    });
  }

  @Post("requests/:id/cancel")
  @ApiOperation({ summary: "Cancel the buyer's own pending request" })
  cancel(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @CurrentBuyerCustomer() ctx: any,
    @Param("id") id: string,
  ) {
    return this.payments.cancelOwn(buyer.sub, ctx.customerId, id);
  }
}
