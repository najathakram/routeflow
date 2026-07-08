import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AuthorizationsService } from "./authorizations.service";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { CreateAuthorizationDto } from "./dto/create-authorization.dto";
import { RejectAuthorizationDto } from "./dto/reject-authorization.dto";
import { RenewAuthorizationDto } from "./dto/renew-authorization.dto";
import { CreateOverrideDto } from "./dto/create-override.dto";

// Operator/seller-side. Nested under the customer so it sits alongside customer
// detail. Generic feature — no addon gate. TENANT_ADMIN satisfies OPERATOR.
@Controller("customers/:customerId")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class AuthorizationsController {
  constructor(
    private readonly authorizations: AuthorizationsService,
    private readonly overrides: AuthorizationOverridesService,
  ) {}

  @Get("authorizations")
  list(@Param("customerId") customerId: string) {
    return this.authorizations.findForCustomer(customerId);
  }

  @Post("authorizations")
  create(
    @Param("customerId") customerId: string,
    @Body() dto: CreateAuthorizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authorizations.create(customerId, dto, user);
  }

  @Post("authorizations/:aid/approve")
  approve(
    @Param("customerId") customerId: string,
    @Param("aid") aid: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authorizations.approve(customerId, aid, user);
  }

  @Post("authorizations/:aid/reject")
  reject(
    @Param("customerId") customerId: string,
    @Param("aid") aid: string,
    @Body() dto: RejectAuthorizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authorizations.reject(customerId, aid, dto, user);
  }

  @Post("authorizations/:aid/renew")
  renew(
    @Param("customerId") customerId: string,
    @Param("aid") aid: string,
    @Body() dto: RenewAuthorizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authorizations.renew(customerId, aid, dto, user);
  }

  @Post("authorization-overrides")
  createOverride(
    @Param("customerId") customerId: string,
    @Body() dto: CreateOverrideDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.overrides.createOverride(customerId, dto, user);
  }
}

// Tenant-wide expiring/expired licenses for the operator expiry bell (W7b).
// Top-level (not customer-scoped) so it can power the header bell.
@Controller("authorizations")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ExpiringAuthorizationsController {
  constructor(private readonly authorizations: AuthorizationsService) {}

  @Get("expiring-soon")
  expiringSoon(@Query("withinDays") withinDays?: string) {
    const days = withinDays ? Number(withinDays) : 30;
    return this.authorizations.findExpiringSoon(Number.isFinite(days) && days > 0 ? days : 30);
  }
}
