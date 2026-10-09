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
import { CatchupCheckoutService, catchupReportJson } from "../billing/catchup-checkout.service";
import { CatchupCheckoutDto } from "./dto/catchup-checkout.dto";

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
  constructor(private readonly catchup: CatchupCheckoutService) {}

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
  open(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CatchupCheckoutDto) {
    return this.catchup.open(id, { expectedStubCents: dto.expectedStubCents });
  }
}
