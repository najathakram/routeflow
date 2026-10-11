import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CatchupCheckoutService, catchupReportJson } from "../billing/catchup-checkout.service";
import { CatchupCheckoutDto } from "./dto/catchup-checkout.dto";
import { AdminAuditAction } from "./audit-actions.constant";
import { PlatformAdminService } from "./platform-admin.service";

/**
 * SA-733 D7: the October catch-up of a manually invoiced tenant. Its own controller (platform-admin.controller.ts
 * is untouched); the class-level guards cover both routes. The owner's tool (scripts/billing-catchup.mjs) is the
 * normal caller: dry-run first, then `--apply` with the amount it printed.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class CatchupAdminController {
  constructor(
    private readonly catchup: CatchupCheckoutService,
    private readonly admin: PlatformAdminService,
  ) {}

  // Declared before any `:id` route.
  @Get("billing/catchup-census")
  @ApiOperation({
    summary: "Dry-run census: every active production tenant's catch-up verdict (ids only)",
  })
  census() {
    return this.catchup.census();
  }

  @Get("tenants/:id/billing/catchup-plan")
  @ApiOperation({ summary: "Dry-run: what the October catch-up would charge (writes nothing)" })
  async plan(@Param("id", ParseUUIDPipe) id: string) {
    return catchupReportJson(await this.catchup.plan(id));
  }

  @Post("tenants/:id/billing/catchup-checkout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Claim the tenant and create its ONE catch-up Checkout session" })
  async open(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CatchupCheckoutDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    const out = await this.catchup.open(id, { expectedStubCents: dto.expectedStubCents });
    // Who opened which payment session for which tenant, for what amount. Written only after the session exists
    // (a refusal creates nothing and records nothing); the checkout URL is a payment link and is never logged.
    await this.admin.recordAdminAction(id, admin.sub, AdminAuditAction.TENANT_CONFIG_UPDATED, {
      kind: "billing_catchup_checkout_opened",
      sessionId: out.sessionId,
      shape: out.shape,
      stubCents: out.stubCents,
    });
    return out;
  }
}
