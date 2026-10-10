import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
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
 * The connect secret `/google/start` or `/microsoft/start` handed the initiating browser tab
 * (#2115). Preview and confirm read it ONLY from this header, never from a URL or the body.
 */
const CONNECT_SECRET_HEADER = "x-mailbox-connect-secret";

/**
 * The `error` codes RFC 6749 §4.1.2.1 defines (`access_denied`, `server_error`, ...) are short
 * ASCII tokens. Both OAuth callbacks are unauthenticated, so anyone can put anything in these
 * query params: a CR/LF-bearing string that would forge log lines, or a repeated param that
 * Express hands over as an array. Only a value of the token shape is ever logged.
 */
const OAUTH_ERROR_CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Microsoft puts a machine-readable `AADSTS<digits>` code inside its free-text
 *  `error_description`. That code is the ONLY thing ever read out of a description. */
function aadstsCodeOf(errorDescription: unknown): string | undefined {
  return typeof errorDescription === "string"
    ? errorDescription.match(/AADSTS\d+/)?.[0]
    : undefined;
}

/**
 * The log-safe form of a provider's `error` redirect, shared by both callbacks. A provider's
 * `error_description` is free text (Microsoft's can carry the org/tenant name) and is never
 * logged raw: only a diagnostic code is taken from it. That is Microsoft's AADSTS code; Google
 * sends no such code, so for Google only the `error` code itself is logged.
 */
function oauthDenialForLog(error: unknown, errorDescription: unknown): string {
  const code =
    typeof error === "string" && OAUTH_ERROR_CODE_SHAPE.test(error) ? error : "<malformed error>";
  const aadsts = aadstsCodeOf(errorDescription);
  return aadsts ? `${code} (${aadsts})` : code;
}

/**
 * Connect/disconnect a tenant Google OR Microsoft mailbox for sending (email-connect-google
 * PR-2, email-connect-microsoft PR-4 — one row per tenant, either provider). Every route except
 * the two OAuth callbacks is TENANT_ADMIN-only and gated behind the `email.connected_mailbox`
 * add-on (registered `dark` — `feature-registry.ts`).
 *
 * Connect is TWO HTTP steps for BOTH providers (security review fix round, HIGH —
 * account-binding): a callback (below) cannot carry the app's bearer token (it's a top-level
 * browser redirect FROM the provider, and this app authenticates via `Authorization: Bearer`
 * from localStorage, not cookies), so each callback is deliberately unguarded and does NOT bind
 * a `MailboxConnection` row — it only stashes a pending grant and hands the browser a one-time
 * confirm token via the redirect. `POST .../confirm` is the ONE authenticated, TENANT_ADMIN-gated
 * step (shared by both providers) that actually binds the row, and only after
 * `MailboxConnectionService.confirmConnect` proves the confirming JWT's `(userId, tenantId)`
 * matches whoever called `/google/start` or `/microsoft/start`. Without this split, anyone who
 * could observe or guess the callback URL (shared machine, browser history sync, referrer leak)
 * could attach an attacker's mailbox grant to whatever tenant happens to be signed in.
 *
 * #2115 (SA-215) closes the rest of that path. `/start` also returns a connect secret the
 * initiating tab keeps in sessionStorage. Preview and confirm require it in a header, so a
 * confirm link opened in any other tab or browser is refused, even with the same admin's JWT.
 * The web never confirms on page load: it previews the grant (`GET confirm/:token/preview`,
 * non-consuming, provider + account email only) and binds only when the admin clicks Confirm
 * in a dialog that names the account. Cancel (`POST confirm/cancel`) burns the grant, and the
 * callbacks burn the state on every non-success exit.
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
  // The body carries the connect secret: no browser, proxy or CDN may keep a copy of it.
  @Header("Cache-Control", "no-store")
  async startGoogle(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    // `{ url, connectSecret }`: the tab keeps the secret for preview/confirm (#2115).
    return this.mailboxConnection.startConnect(user.tenantId, user.sub);
  }

  // No guards — see class doc. This step never binds a MailboxConnection row; it only mints a
  // one-time confirm token for the authenticated POST /confirm step below to redeem. Like
  // microsoftCallback, Google can redirect here with `error` (RFC 6749 §4.1.2.1) instead of a
  // `code`. That is handled before any exchange is attempted. `access_denied` means the user
  // backed out on Google's consent screen ("Cancel", or "Back to safety" on the unverified-app
  // warning), and the web gets its own `mailbox_cancelled=google` flag, because a cancel is
  // not a failure and nothing was changed. Every other Google error keeps the generic flag.
  // Every non-success exit burns the state FIRST (discardState, the same atomic GETDEL as the
  // success path), so a cancelled or failed state can never be replayed with a code (#2115).
  @Get("google/callback")
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    if (error) {
      await this.mailboxConnection.discardState(state);
      this.logger.warn(
        `Mailbox Google callback denied: ${oauthDenialForLog(error, errorDescription)}`,
      );
      const flag = error === "access_denied" ? "mailbox_cancelled=google" : "mailbox_error=1";
      return res.redirect(`${this.webUrl}/settings?tab=email&${flag}`);
    }
    try {
      const { confirmToken } = await this.mailboxConnection.handleCallback(code, state);
      return res.redirect(
        `${this.webUrl}/settings?tab=email&mailbox_confirm=${encodeURIComponent(confirmToken)}`,
      );
    } catch (err: any) {
      // handleCallback consumes the state itself once it gets that far. This also covers the
      // exits before its GETDEL (a callback naming a state but carrying no code).
      await this.mailboxConnection.discardState(state);
      this.logger.warn(`Mailbox Google callback failed: ${err?.message ?? err}`);
      return res.redirect(`${this.webUrl}/settings?tab=email&mailbox_error=1`);
    }
  }

  @Get("microsoft/start")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  // Carries the connect secret, like google/start: never cached.
  @Header("Cache-Control", "no-store")
  async startMicrosoft(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    // `{ url, connectSecret }`: the tab keeps the secret for preview/confirm (#2115).
    return this.mailboxConnection.startConnectMicrosoft(user.tenantId, user.sub);
  }

  // No guards — mirrors google/callback exactly (see class doc). Microsoft can also redirect
  // here with `error`/`error_description` instead of a `code` — e.g. the user cancelled, or
  // their org's risk-based step-up consent blocked it (AADSTS65001, design §1) — surfaced to
  // the web as a distinct query flag so it can point the admin at the admin-consent URL instead
  // of a bare "couldn't connect" message. As in googleCallback, every non-success exit burns the
  // state first (#2115).
  @Get("microsoft/callback")
  async microsoftCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    if (error) {
      await this.mailboxConnection.discardState(state);
      // `error_description` is Microsoft/attacker-controlled free text — potentially carrying
      // the org/tenant name or other identifying detail — so only the bare AADSTS code (if any)
      // is logged, never the raw description (Opus review, LOW). `error` itself is just as
      // attacker-controlled, so it goes through the same log-safe formatter as Google's.
      const aadstsCode = aadstsCodeOf(errorDescription);
      this.logger.warn(
        `Mailbox Microsoft callback denied: ${oauthDenialForLog(error, errorDescription)}`,
      );
      const flag =
        aadstsCode === "AADSTS65001" ? "mailbox_admin_consent_required" : "mailbox_error";
      return res.redirect(`${this.webUrl}/settings?tab=email&${flag}=1`);
    }
    try {
      const { confirmToken } = await this.mailboxConnection.handleMicrosoftCallback(code, state);
      return res.redirect(
        `${this.webUrl}/settings?tab=email&mailbox_confirm=${encodeURIComponent(confirmToken)}`,
      );
    } catch (err: any) {
      await this.mailboxConnection.discardState(state);
      this.logger.warn(`Mailbox Microsoft callback failed: ${err?.message ?? err}`);
      const flag =
        err?.message === "microsoft_admin_consent_required"
          ? "mailbox_admin_consent_required"
          : "mailbox_error";
      return res.redirect(`${this.webUrl}/settings?tab=email&${flag}=1`);
    }
  }

  // What the explicit confirm dialog shows before anything is bound (#2115): the pending
  // grant's provider and account email only. Authenticated and NON-consuming. Like confirm, it
  // requires the caller to be the admin who started the connect AND to present the connect
  // secret of the tab that started it (header only, never a URL).
  @Get("confirm/:token/preview")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  async previewConfirm(
    @CurrentUser() user: JwtPayload,
    @Param("token") token: string,
    @Headers(CONNECT_SECRET_HEADER) connectSecret: string | undefined,
  ) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    return this.mailboxConnection.previewConnect(token, connectSecret, user.sub, user.tenantId);
  }

  // The ONLY place a MailboxConnection row is ever bound from an OAuth flow — see class doc.
  // The web calls it only when the admin clicks Confirm in the dialog (#2115), never on load.
  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async confirm(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmMailboxDto,
    @Headers(CONNECT_SECRET_HEADER) connectSecret: string | undefined,
  ) {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    return this.mailboxConnection.confirmConnect(dto.state, connectSecret, user.sub, user.tenantId);
  }

  // Cancel in the confirm dialog (or the web giving up on a confirm it can't finish): burns the
  // pending grant so it can never be confirmed (#2115). 204 whether or not it still existed.
  @Post("confirm/cancel")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @RequireAddon("email.connected_mailbox")
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async cancelConfirm(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmMailboxDto,
  ): Promise<void> {
    if (!user.tenantId) throw new ForbiddenException("A tenant context is required.");
    await this.mailboxConnection.discardPendingGrant(dto.state);
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
