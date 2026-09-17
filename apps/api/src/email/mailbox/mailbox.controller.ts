import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { AddonGuard } from "../../billing/addon.guard";
import { RequireAddon } from "../../billing/require-addon.decorator";
import { MailboxConnectionService } from "./mailbox-connection.service";

/**
 * Connect/disconnect a tenant Google mailbox for sending (email-connect-google PR-2). Every
 * route except the OAuth callback is TENANT_ADMIN-only and gated behind the
 * `email.connected_mailbox` add-on (registered `dark` — `feature-registry.ts`). The callback
 * cannot carry the app's bearer token (it's a top-level browser redirect FROM Google, and this
 * app authenticates via `Authorization: Bearer` from localStorage, not cookies) so it is
 * deliberately unguarded here — its security comes from the single-use, PKCE-bound state nonce
 * verified inside `MailboxConnectionService.handleCallback`, not from a second JWT check.
 */
@ApiTags("settings")
@Controller(["settings/email/mailbox", "tenant/settings/email/mailbox"])
export class MailboxController {
  private readonly logger = new Logger(MailboxController.name);
  private readonly webUrl: string;

  constructor(
    private readonly mailboxConnection: MailboxConnectionService,
    private readonly config: ConfigService,
  ) {
    this.webUrl = (this.config.get<string>("WEB_URL") ?? "http://localhost:3001").replace(
      /\/$/,
      "",
    );
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  async getStatus(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    return this.mailboxConnection.getStatus(user.tenantId);
  }

  @Get("google/start")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  async startGoogle(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    const url = await this.mailboxConnection.startConnect(user.tenantId, user.sub);
    return { url };
  }

  // No guards — see class doc. Security = single-use PKCE-bound state, not a bearer token.
  @Get("google/callback")
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    try {
      await this.mailboxConnection.handleCallback(code, state);
      return res.redirect(`${this.webUrl}/settings?tab=email&mailbox=connected`);
    } catch (err: any) {
      this.logger.warn(`Mailbox Google callback failed: ${err?.message ?? err}`);
      return res.redirect(`${this.webUrl}/settings?tab=email&mailbox_error=1`);
    }
  }

  @Delete()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  async disconnect(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    await this.mailboxConnection.disconnect(user.tenantId, user.sub);
    return { ok: true };
  }
}
