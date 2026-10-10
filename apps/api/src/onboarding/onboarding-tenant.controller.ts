import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { OnboardingTenantService } from "./onboarding-tenant.service";
import { OnboardingSignOffDto } from "./dto/onboarding.dto";

interface AuthUser {
  id: string;
  tenantId: string | null;
  impersonatedBy?: string;
}

/**
 * The workspace's own "Getting started" view (#2159 S4). The case is always the CALLER's
 * (JWT tenantId) — no route takes a case or tenant id.
 */
@ApiTags("onboarding")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("onboarding/me")
export class OnboardingTenantController {
  constructor(private readonly onboarding: OnboardingTenantService) {}

  /** A SUPER_ADMIN satisfies every role but carries no tenant — refuse rather than 500. */
  private tenantIdOf(user: AuthUser): string {
    if (!user.tenantId) throw new ForbiddenException("This view requires a workspace.");
    return user.tenantId;
  }

  @Get()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "This workspace's onboarding progress (customer-owned steps)" })
  get(@CurrentUser() user: AuthUser) {
    return this.onboarding.getForTenant(this.tenantIdOf(user));
  }

  @Post("sign-off")
  @HttpCode(200)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: "The workspace admin's written sign-off (VERIFY_TRAIN)" })
  signOff(@CurrentUser() user: AuthUser, @Body() dto: OnboardingSignOffDto, @Req() req: Request) {
    const ua = req.headers["user-agent"];
    return this.onboarding.signOff(
      {
        userId: user.id,
        tenantId: this.tenantIdOf(user),
        impersonatedBy: user.impersonatedBy ?? null,
        ip: req.ip ?? null,
        userAgent: typeof ua === "string" ? ua.slice(0, 300) : null,
      },
      dto.signedName,
    );
  }
}
