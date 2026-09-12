import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";
import { CrmConnectionService } from "./crm-connection.service";
import { GoHighLevelPollService } from "./gohighlevel/gohighlevel-poll.service";
import { SaveCrmConnectionDto } from "./dto/save-crm-connection.dto";
import { UpdateCrmConfigDto } from "./dto/update-crm-config.dto";
import { ListHandoffsDto } from "./dto/list-handoffs.dto";

/**
 * GoHighLevel CRM connector (spec R1-R8, R22, R23). Every route requires an authenticated
 * OPERATOR AND the `crm_gohighlevel` add-on grant (registered `dark` at launch — see
 * `addon-gate-registry.ts`, WP3). Per-handler `@UseGuards(AddonGuard)` + `@RequireAddon`
 * (rather than only at the class) mirrors `BookkeepingController`'s OCR-gated routes.
 *
 * The add-on key is written as a STRING LITERAL at every site on purpose: the registry
 * scanner in `addon-gate-registry.spec.ts` is literal-only by design, and a shared const
 * made all of these routes invisible to it (F6).
 */
@ApiTags("crm")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller("crm/gohighlevel")
export class CrmController {
  constructor(
    private readonly crmConnectionService: CrmConnectionService,
    private readonly pollService: GoHighLevelPollService,
  ) {}

  private tenantIdOf(user: JwtPayload): string {
    if (!user.tenantId) {
      throw new ForbiddenException("This feature requires a tenant context.");
    }
    return user.tenantId;
  }

  @Get()
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.crmConnectionService.getStatus(this.tenantIdOf(user));
  }

  @Patch("connection")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  saveConnection(@CurrentUser() user: JwtPayload, @Body() dto: SaveCrmConnectionDto) {
    return this.crmConnectionService.saveConnection(this.tenantIdOf(user), dto, user.sub);
  }

  @Post("connection/test")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  testConnection(@CurrentUser() user: JwtPayload) {
    return this.crmConnectionService.testConnection(this.tenantIdOf(user));
  }

  @Delete("connection")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.crmConnectionService.disconnect(this.tenantIdOf(user), user.sub);
  }

  @Patch("config")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  updateConfig(@CurrentUser() user: JwtPayload, @Body() dto: UpdateCrmConfigDto) {
    return this.crmConnectionService.updateConfig(this.tenantIdOf(user), dto, user.sub);
  }

  @Get("pipelines")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  listPipelines(@CurrentUser() user: JwtPayload) {
    return this.crmConnectionService.listPipelines(this.tenantIdOf(user));
  }

  @Get("handoffs")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  listHandoffs(@CurrentUser() user: JwtPayload, @Query() dto: ListHandoffsDto) {
    return this.crmConnectionService.listHandoffs(this.tenantIdOf(user), dto);
  }

  /** spec R8 — "Check now": runs one poll for the caller's tenant and returns the counts. */
  @Post("sync")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  sync(@CurrentUser() user: JwtPayload) {
    return this.pollService.pollTenant(this.tenantIdOf(user));
  }

  /** spec R22 — reopens one handoff row and processes it immediately. */
  @Post("handoffs/:id/retry")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  retryHandoff(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    // The tenant is ALWAYS the caller's own (L-100): a handoff id from another tenant must
    // resolve to a 404, never to that tenant's row.
    return this.pollService.retryHandoff(this.tenantIdOf(user), id);
  }

  /** spec R22 — dismisses a NEEDS_REVIEW/FAILED/DRY_RUN row as SKIPPED. */
  @Post("handoffs/:id/dismiss")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  dismissHandoff(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.pollService.dismissHandoff(this.tenantIdOf(user), id);
  }

  /** spec R23 — read-only count + sample of pre-cutoff opportunities; writes nothing. */
  @Post("import-existing/preview")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  previewImportExisting(@CurrentUser() user: JwtPayload) {
    return this.pollService.previewImportExisting(this.tenantIdOf(user));
  }

  /** spec R23 — the same poll with the cutoff and the enabled gate lifted. */
  @Post("import-existing")
  @UseGuards(AddonGuard)
  @RequireAddon("crm_gohighlevel")
  importExisting(@CurrentUser() user: JwtPayload) {
    return this.pollService.importExisting(this.tenantIdOf(user));
  }
}
