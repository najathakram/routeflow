import { Body, Controller, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { OrdersService } from "../orders/orders.service";
import { quoteForBuyer, type BuyerCartQuote } from "../orders/order-quote";
import { PrismaService } from "../prisma/prisma.service";
import { assertBuyerQtySplit } from "./buyer-qty-split";
import { BuyerTenantInterceptor } from "./buyer-tenant.interceptor";
import { makePseudoUser } from "./buyer.controller";
import { CurrentBuyerCustomer } from "./decorators/current-buyer.decorator";
import { BuyerCreateOrderDto } from "./dto/buyer-create-order.dto";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "./guards/buyer-seller-context.guard";

/**
 * SA-1172 (B304): `POST /buyer/cart/quote` returns what the buyer's cart will be billed, as create() itself prices it
 * (order-quote.ts). It lives in its own controller so BuyerController's hand-built specs are untouched, with POST
 * /buyer/orders' own guard set; the global ThrottlerGuard (100/60s per IP per handler) is tightened here to 60/60s.
 *
 * It stops before the license gate, the credit gate and the stock lock: a restricted buyer can see a total and still
 * get create's refusal on submit. The catalogue price can also change between quote and submit; create stays the authority.
 */
@ApiTags("buyer")
@Controller("buyer")
@UseGuards(BuyerJwtAuthGuard)
@ApiBearerAuth()
export class BuyerQuoteController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("cart/quote")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "Quote the cart: subtotal, tax, levy and total, as the order will bill",
  })
  async quote(
    @Body() dto: BuyerCreateOrderDto,
    @CurrentBuyerCustomer() ctx: any,
  ): Promise<BuyerCartQuote> {
    await assertBuyerQtySplit(this.prisma.forTenant(), dto.items, "buyer.cartQuote", ctx.tenantId);
    return quoteForBuyer(this.ordersService, dto.items, dto.fulfillPath, makePseudoUser(ctx));
  }
}
