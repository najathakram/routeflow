import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AutoLockAdminService } from "../billing/auto-lock-admin.service";
import { AdminAuditAction } from "./audit-actions.constant";
import { SetAutoLocksDto } from "./dto/set-auto-locks.dto";
import { PlatformAdminService } from "./platform-admin.service";

/**
 * SA-775 (row 381): the super-admin side of the rollout pause on AUTOMATIC tenant locks. Its own controller
 * (platform-admin.controller.ts keeps its constructor); the class-level guards are the platform-admin pair, so
 * a non-super-admin gets 403 on every route. GET never mutates; the preview is read-only by construction.
 */
@ApiTags("platform-admin")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("platform-admin")
export class AutoLocksAdminController {
  constructor(
    private readonly autoLocks: AutoLockAdminService,
    private readonly admin: PlatformAdminService,
  ) {}

  @Get("config/auto-locks")
  @ApiOperation({
    summary:
      "Whether automatic locks of PRODUCTION tenants are paused (a missing key = paused), the tenants that would be locked now, and the locks held so far",
  })
  state() {
    return this.autoLocks.getState();
  }

  // Declared next to the state route; a distinct, longer path.
  @Get("config/auto-locks/preview")
  @ApiOperation({
    summary:
      "Read-only unpause preview: the PRODUCTION tenants the automatic jobs would lock within the hour",
  })
  preview() {
    return this.autoLocks.preview();
  }

  @Patch("config/auto-locks")
  @ApiOperation({
    summary:
      "Pause or unpause every automatic lock of PRODUCTION tenants (reversible, never unlocks anyone). Audited with the reason and the actor.",
  })
  async set(@Body() dto: SetAutoLocksDto, @CurrentUser() admin: JwtPayload) {
    const result = await this.autoLocks.setPaused(dto.paused, dto.reason, admin.sub);
    await this.admin.recordAdminAction(
      null,
      admin.sub,
      AdminAuditAction.PLATFORM_AUTO_LOCKS_SWITCHED,
      {
        paused: dto.paused,
        reason: dto.reason,
        previous: result.previous,
      },
    );
    return result;
  }
}
