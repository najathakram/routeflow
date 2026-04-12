import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { LocalAuthGuard } from "./guards/local-auth.guard";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { CurrentUser } from "./decorators/current-user.decorator";
import { TenantGoogleOAuthService } from "../tenants/tenant-google-oauth.service";
import { GoogleOAuthService } from "./google-oauth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  private readonly webUrl: string;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly tenantGoogleOAuth: TenantGoogleOAuthService,
    private readonly googleOAuth: GoogleOAuthService,
  ) {
    this.webUrl = configService.get<string>("WEB_URL") ?? "http://localhost:3001";

    if (this.webUrl.includes("localhost") && configService.get("NODE_ENV") !== "development") {
      console.warn(
        "[GoogleAuth] WEB_URL is not set — OAuth callbacks will redirect to localhost, which will fail in production.",
      );
    }
  }

  // ─── Username / password ───────────────────────────────────────────────────

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UseGuards(LocalAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } }) // 30/min: still brute-force resistant, allows shared-NAT offices + E2E test suites
  @ApiOperation({ summary: "Login with username and password" })
  login(@CurrentUser() user: any, @Body() _dto: LoginDto, @Req() req: any) {
    const deviceInfo = this.extractDeviceInfo(req);
    return this.authService.login(user, deviceInfo);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: "Refresh access token" })
  refresh(@Body() dto: RefreshDto, @Req() req: any) {
    const deviceInfo = this.extractDeviceInfo(req);
    return this.authService.refresh(dto.refreshToken, deviceInfo);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Logout and revoke all refresh tokens" })
  logout(@CurrentUser() user: { id: string }) {
    return this.authService.logout(user.id);
  }

  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change password" })
  changePassword(@CurrentUser() user: { id: string }, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  // ─── Session management ────────────────────────────────────────────────────────

  @Get("sessions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List active sessions for the current user" })
  listSessions(@CurrentUser() user: { id: string }) {
    return this.authService.listSessions(user.id);
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke a specific session by ID" })
  revokeSession(@CurrentUser() user: { id: string }, @Param("id") sessionId: string) {
    return this.authService.revokeSession(user.id, sessionId);
  }

  // ─── Google OAuth (tenant — OPERATOR, DRIVER, or buyer portal) ────────────
  //
  // ENV VARS required in Railway:
  //   GOOGLE_CLIENT_ID              — GCP OAuth 2.0 client ID
  //   GOOGLE_CLIENT_SECRET          — GCP OAuth 2.0 client secret
  //   GOOGLE_REDIRECT_URI_TENANT    — https://<api-domain>/api/v1/auth/google/callback
  //   GOOGLE_REDIRECT_URI_PLATFORM  — https://<api-domain>/api/v1/platform-admin/auth/google/callback
  //   WEB_URL                       — https://<frontend-domain>
  //
  // Both redirect URIs must be added to the "Authorised redirect URIs" list
  // in the Google Cloud Console OAuth 2.0 credential.

  /**
   * GET /api/v1/auth/google
   *
   * Returns the Google consent URL for the caller to redirect the browser to.
   * Query params:
   *   tenant  — tenant slug (required)
   *   context — "portal" (buyer portal) | "staff" (tenant dashboard) — default staff
   *
   * No authentication required — this initiates the login flow.
   */
  @Get("google")
  @ApiOperation({ summary: "Get Google OAuth URL for tenant sign-in (staff or buyer portal)" })
  async googleAuthUrl(
    @Query("tenant") tenantSlug: string,
    @Query("context") context: "portal" | "staff" | "buyer-standalone" = "staff",
    @Query("invite_token") inviteToken: string | undefined,
    @Res({ passthrough: true }) res: any,
  ) {
    if (!this.googleOAuth.isConfigured()) {
      res.status(503);
      return { message: "Google sign-in is not configured for this environment.", statusCode: 503 };
    }
    // buyer-standalone: buyers sign in directly without a seller invite link — no tenant slug needed.
    if (context !== "buyer-standalone" && !tenantSlug) {
      res.status(400);
      return { message: "tenant query parameter is required", statusCode: 400 };
    }
    const url = await this.googleOAuth.generateAuthUrl("tenant", tenantSlug, inviteToken, context);
    return { url };
  }

  /**
   * GET /api/v1/auth/google/link
   *
   * Authenticated endpoint — returns a Google consent URL that, when completed,
   * links the Google account to the currently signed-in user instead of logging in.
   * Requires a valid JWT (the user must already be authenticated).
   */
  @Get("google/link")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get Google OAuth URL to link Google account to current user" })
  async linkGoogleUrl(@CurrentUser() user: { sub: string }, @Res({ passthrough: true }) res: any) {
    if (!this.googleOAuth.isConfigured()) {
      res.status(503);
      return { message: "Google sign-in is not configured for this environment.", statusCode: 503 };
    }
    const url = await this.googleOAuth.generateLinkUrl("tenant", user.sub);
    return { url };
  }

  /**
   * GET /api/v1/auth/google/callback
   *
   * Google redirects here after user consent. Tenant is recovered from the
   * state param — no X-Tenant-Slug header needed.
   * On success: redirects to the frontend callback page with JWT in query params.
   */
  @Get("google/callback")
  @ApiOperation({ summary: "Google OAuth callback for tenant users" })
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") oauthError: string,
    @Res() res: Response,
  ) {
    const base = this.webUrl;

    if (oauthError) {
      return res.redirect(`${base}/auth/google/callback?error=oauth_cancelled`);
    }
    if (!code || !state) {
      return res.redirect(`${base}/auth/google/callback?error=state_invalid`);
    }

    try {
      const profile = await this.googleOAuth.verifyCallback(code, state);

      // ── Link-account flow ────────────────────────────────────────────────────
      // When `linkUserId` is present the user is already authenticated and just
      // wants to attach their Google account — don't issue new tokens.
      if (profile.linkUserId) {
        await this.googleOAuth.linkGoogleAccount(profile);
        return res.redirect(`${base}/auth/google/callback?action=linked`);
      }

      // ── Sign-in flow ─────────────────────────────────────────────────────────
      const result = await this.googleOAuth.findOrCreateUser(profile);

      if (result.kind === "staff" || result.kind === "platform") {
        const r = result as any;
        return res.redirect(
          `${base}/auth/google/callback` +
            `?accessToken=${r.accessToken}` +
            `&refreshToken=${r.refreshToken}` +
            `&role=${r.user.role}` +
            `&tenantSlug=${r.user.tenantSlug ?? ""}`,
        );
      }

      // Buyer portal result
      const r = result as any;
      const linked = profile.inviteToken ? "true" : "false";
      return res.redirect(
        `${base}/auth/google/callback` +
          `?accessToken=${r.accessToken}` +
          `&refreshToken=${r.refreshToken}` +
          `&type=BUYER` +
          `&sellerCount=${r.sellerCount}` +
          `&linked=${linked}`,
      );
    } catch (err: any) {
      const errCode = err?.message ?? "unknown_error";
      const safeCode = this.mapErrorCode(errCode);
      return res.redirect(`${base}/auth/google/callback?error=${safeCode}`);
    }
  }

  // ─── Per-tenant Google OAuth (legacy path-param variant) ──────────────────
  // Kept for backward compatibility. New integrations should use the header-based flow above.

  @Get("google/:tenantSlug")
  @ApiOperation({ summary: "Initiate per-tenant Google OAuth login (legacy)" })
  async tenantGoogleLogin(@Param("tenantSlug") slug: string, @Res() res: Response) {
    const url = await this.tenantGoogleOAuth.buildAuthUrl(slug);
    res.redirect(url);
  }

  @Get("google/:tenantSlug/callback")
  @ApiOperation({ summary: "Per-tenant Google OAuth callback (legacy)" })
  async tenantGoogleCallback(
    @Param("tenantSlug") slug: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const code = req.query?.code as string;
    if (!code) {
      return res.redirect(`${this.webUrl}/auth/error?message=oauth_cancelled`);
    }
    const user = await this.tenantGoogleOAuth.exchangeCode(code, slug);
    const tokens = await this.authService.login(user as any);
    res.redirect(
      `${this.webUrl}/auth/callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&role=${tokens.user.role}&tenantSlug=${slug}`,
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private extractDeviceInfo(req: any) {
    const ua = (req.headers?.["user-agent"] as string) ?? undefined;
    const ip =
      (req.headers?.["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket?.remoteAddress ??
      undefined;
    return { userAgent: ua, ipAddress: ip };
  }

  private mapErrorCode(raw: string): string {
    const allowed = new Set([
      "state_invalid",
      "unauthorized",
      "tenant_suspended",
      "google_token_invalid",
      "google_email_is_staff",
      "google_already_linked",
      "google_id_taken",
    ]);
    return allowed.has(raw) ? raw : "unknown_error";
  }
}
