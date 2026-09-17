import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
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
import { ConfirmMailboxDto } from "./dto/confirm-mailbox.dto";

/**
 * Connect/disconnect a tenant Google mailbox for sending (email-connect-google PR-2). Every
 * route except the OAuth callback is TENANT_ADMIN-only and gated behind the
 * `email.connected_mailbox` add-on (registered `dark` — `feature-registry.ts`).
 *
 * Connect is TWO HTTP steps (security review fix round, HIGH — account-binding): the callback
 * (below) cannot carry the app's bearer token (it's a top-level browser redirect FROM Google,
 * and this app authenticates via `Authorization: Bearer` from localStorage, not cookies), so it
 * is deliberately unguarded and does NOT bind a `MailboxConnection` row — it only stashes a
 * pending grant and hands the browser a one-time confirm token via the redirect. `POST
 * .../confirm` is the authenticated, TENANT_ADMIN-gated step that actually binds the row, and
 * only after `MailboxConnectionService.confirmConnect` proves the confirming JWT's
 * `(userId, tenantId)` matches whoever called `/google/start`. Without this split, anyone who
 * could observe or guess the callback URL (shared machine, browser history sync, referrer leak)
 * could attach an attacker's Gmail grant to whatever tenant happens to be signed in.
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

  // No guards — see class doc. This step never binds a MailboxConnection row; it only mints a
  // one-time confirm token for the authenticated POST /confirm step below to redeem.
  @Get("google/callback")
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    try {
      const { confirmToken } = await this.mailboxConnection.handleCallback(code, state);
      return res.redirect(
        `${this.webUrl}/settings?tab=email&mailbox_confirm=${encodeURIComponent(confirmToken)}`,
      );
    } catch (err: any) {
      this.logger.warn(`Mailbox Google callback failed: ${err?.message ?? err}`);
      return res.redirect(`${this.webUrl}/settings?tab=email&mailbox_error=1`);
    }
  }

  // The ONLY place a MailboxConnection row is ever bound from an OAuth flow — see class doc.
  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async confirm(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmMailboxDto) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    return this.mailboxConnection.confirmConnect(dto.state, user.sub, user.tenantId);
  }

  @Delete()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  async disconnect(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    return this.mailboxConnection.disconnect(user.tenantId, user.sub);
  }
}
