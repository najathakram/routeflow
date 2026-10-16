import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { NoImpersonation } from "../auth/decorators/no-impersonation.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PaymentDuePayDto } from "./dto/payment-due-pay.dto";
import { PaymentDueService } from "./payment-due.service";

interface AuthUser {
  tenantId: string | null;
}

/**
 * The signed-in tenant's own "payment due" read and self-serve pay. The tenant id is ALWAYS the JWT's: no route here
 * takes an id, an amount or a plan from the request; the pay route's one body is the terms the banner SHOWED (row
 * 542c: compared with the fresh plan, never charged). The pay route is a workspace admin's. It is NOT on the read-only
 * allow-list (read-only-registry.ts): a read-only tenant has no payment due here (the planner refuses a tenant that is
 * not ACTIVE) and the guard refuses the POST; making billing read-only payable is a separate row.
 */
@ApiTags("billing")
@ApiBearerAuth()
@Controller("billing/payment-due")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class PaymentDueController {
  constructor(private readonly paymentDue: PaymentDueService) {}

  private tenantIdOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException("This billing view requires a tenant context.");
    }
    return user.tenantId;
  }

  @Get()
  @ApiOperation({ summary: "Is a subscription payment due? (the dashboard banner's one read)" })
  get(@CurrentUser() user: AuthUser) {
    return this.paymentDue.get(this.tenantIdOf(user));
  }

  @Post("pay")
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @ApiOperation({
    summary:
      "Open (or reuse) the Stripe Checkout for the amount due, or to add the card (admin only)",
  })
  pay(@CurrentUser() user: AuthUser, @Body() body: PaymentDuePayDto) {
    // 542c: the body is only the terms the banner showed (compared, never charged); the tenant id stays the JWT's
    return this.paymentDue.pay(this.tenantIdOf(user), undefined, body?.shown);
  }
}
