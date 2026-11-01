import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import type {
  FirstRunResult,
  FirstRunStatus,
  FulfilmentPreview,
  FulfilmentSettings,
  FulfilmentSettingsUpdated,
} from "@routeflow/types";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { NoImpersonation } from "../auth/decorators/no-impersonation.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { FulfilmentEditGuard } from "./fulfilment-edit";
import { FirstRunService } from "./first-run.service";
import { SettingsFulfilmentService } from "./settings-fulfilment.service";

import { PermissionBase } from "../auth/permissions/permission.decorators";
/**
 * Preview and change are throttled to 10 per 60 s (the ordinary 100 would let a script hammer the
 * aggregate counts behind the preview). The throttle key is the guard's default, the client IP, per
 * route handler: two admins behind one office IP share the 10. That trade-off is deliberate (SA Q9);
 * a per-user tracker can replace it without touching this contract.
 */
const EDIT_THROTTLE = { default: { ttl: 60_000, limit: 10 } };

// Reads OPERATOR; preview and change are TENANT_ADMIN (SUPER_ADMIN satisfies it via the RolesGuard
// hierarchy; OPERATOR gets 403) AND the `canEditFulfilment` predicate. Bodies are `unknown`: the
// service parses them into coded 400s, which the global whitelist pipe would otherwise pre-empt.
@PermissionBase("settings read for every staff user, SA-977")
@ApiTags("settings")
@ApiBearerAuth()
@Controller("settings/fulfilment")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettingsFulfilmentController {
  constructor(
    private readonly settings: SettingsFulfilmentService,
    private readonly firstRun: FirstRunService,
  ) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "Fulfillment settings: delivery method and counter sales" })
  get(@CurrentUser() user: JwtPayload): Promise<FulfilmentSettings> {
    return this.settings.get(user);
  }

  // W1: the new account's first question. The account admin only, and NOT behind FulfilmentEditGuard (that
  // guard is dark): the gate is the marker, read inside the confirm lock. The POST refuses a platform admin
  // impersonating, as the billing routes do, because a team setup is the back office's job.
  @Get("first-run")
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: "The first question on a new account's dashboard: state and next steps",
  })
  firstRunStatus(@CurrentUser() user: JwtPayload): Promise<FirstRunStatus> {
    return this.firstRun.status(user);
  }

  @Post("first-run")
  @HttpCode(200)
  @Roles(UserRole.TENANT_ADMIN)
  @NoImpersonation("billing")
  @Throttle(EDIT_THROTTLE)
  @ApiOperation({ summary: "Answer the first question (fills blanks only; audited)" })
  firstRunAnswer(@Body() body: unknown, @CurrentUser() user: JwtPayload): Promise<FirstRunResult> {
    return this.firstRun.answer(body, user);
  }

  @Post("preview")
  @HttpCode(200)
  @Roles(UserRole.TENANT_ADMIN)
  @UseGuards(FulfilmentEditGuard)
  @Throttle(EDIT_THROTTLE)
  @ApiOperation({ summary: "Preview a fulfillment change (writes nothing)" })
  preview(@Body() body: unknown, @CurrentUser() user: JwtPayload): Promise<FulfilmentPreview> {
    return this.settings.preview(body, user);
  }

  @Patch()
  @Roles(UserRole.TENANT_ADMIN)
  @UseGuards(FulfilmentEditGuard)
  @Throttle(EDIT_THROTTLE)
  @ApiOperation({ summary: "Change the delivery method and/or counter sales (audited)" })
  update(
    @Body() body: unknown,
    @CurrentUser() user: JwtPayload,
  ): Promise<FulfilmentSettingsUpdated> {
    return this.settings.update(body, user);
  }
}
