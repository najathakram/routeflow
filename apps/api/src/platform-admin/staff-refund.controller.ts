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
import { PlatformScoped } from "../tenant/platform-scoped.decorator";
import { StaffRefundDto } from "./dto/staff-refund.dto";
import { StaffRefundService } from "./staff-refund.service";

/**
 * R-2 (SA-1297 ruling 10): "Record staff refund" and the billing-events list. Its own controller, like
 * catchup-admin.controller.ts (platform-admin.controller.ts is untouched); the class-level guards cover every route.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@PlatformScoped()
@Controller("platform-admin")
export class StaffRefundController {
  constructor(private readonly refunds: StaffRefundService) {}

  @Get("tenants/:id/staff-refunds/refundable")
  @ApiOperation({
    summary:
      "What the staff-refund button shows: the latest yearly payment, its deadline, any refusal (no lock)",
  })
  refundable(@Param("id", ParseUUIDPipe) id: string) {
    return this.refunds.resolveRefundable(id);
  }

  @Post("tenants/:id/staff-refunds")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Record a staff refund of the latest yearly payment (a record only; moves no money)",
  })
  record(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: StaffRefundDto,
    @CurrentUser() admin: JwtPayload,
  ) {
    return this.refunds.record(id, dto, admin.sub);
  }

  @Get("tenants/:id/billing-events")
  @ApiOperation({
    summary: "The tenant's billing events, newest first (100), labelled, with actor names",
  })
  billingEvents(@Param("id", ParseUUIDPipe) id: string) {
    return this.refunds.listBillingEvents(id);
  }
}
