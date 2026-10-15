import {
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
import { PaymentDueService } from "./payment-due.service";

interface AuthUser {
  tenantId: string | null;
}

/**
 * The signed-in tenant's own "payment due" read and self-serve pay. The tenant id is ALWAYS the JWT's: no route here
 * takes an id, an amount or a plan from the request. The pay route is a workspace admin's, and the read-only guard
 * lets it through (paying is how read-only ends: see read-only-registry.ts).
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
  @ApiOperation({ summary: "Open (or reuse) the Stripe Checkout for the amount due (admin only)" })
  pay(@CurrentUser() user: AuthUser) {
    return this.paymentDue.pay(this.tenantIdOf(user));
  }
}
