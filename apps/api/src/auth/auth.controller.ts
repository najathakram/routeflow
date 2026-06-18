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
  UnauthorizedException,
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
import { RequestPasswordResetDto } from "./dto/request-password-reset.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ExchangeCodeDto } from "./dto/exchange-code.dto";

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
  @Throttle({ default: { ttl: 300_000, limit: 10 } }) // RF-160: 10 attempts per 5 min per IP to block brute-force
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

  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Verify email from signup link and return auth tokens" })
  verifyEmail(@Body() body: { token: string }, @Req() req: any) {
    const deviceInfo = this.extractDeviceInfo(req);
    return this.authService.verifyEmailAndLogin(body.token, deviceInfo);
  }

  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change password" })
  changePassword(@CurrentUser() user: { id: string }, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  // ─── Password reset (RF-018) ───────────────────────────────────────────────

  @Post("request-password-reset")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP
  @ApiOperation({ summary: "Request a password reset link (RF-018)" })
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP
  @ApiOperation({ summary: "Reset password with token (RF-018)" })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
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
    @Query("mobile") mobileFlag: string | undefined,
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
    const mobile = mobileFlag === "1" || mobileFlag === "true";
    const url = await this.googleOAuth.generateAuthUrl(
      "tenant",
      tenantSlug,
      inviteToken,
      context,
      mobile,
    );
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
    // Peek at the state blob (without consuming the nonce) to decide web vs mobile redirect
    // on OAuth-cancelled or invalid-state paths. verifyCallback() still consumes the nonce
    // atomically on the success path.
    const peekedMobile = this.peekMobileFlag(state);
    const base = peekedMobile
      ? (this.configService.get<string>("GOOGLE_MOBILE_SCHEME") ?? "routeflow://auth/callback")
      : `${this.webUrl}/auth/google/callback`;

    if (oauthError) {
      return res.redirect(`${base}?error=oauth_cancelled`);
    }
    if (!code || !state) {
      return res.redirect(`${base}?error=state_invalid`);
    }

    try {
      const profile = await this.googleOAuth.verifyCallback(code, state);
      const callbackBase = profile.mobile
        ? (this.configService.get<string>("GOOGLE_MOBILE_SCHEME") ?? "routeflow://auth/callback")
        : `${this.webUrl}/auth/google/callback`;

      // ── Link-account flow ────────────────────────────────────────────────────
      // When `linkUserId` is present the user is already authenticated and just
      // wants to attach their Google account — don't issue new tokens.
      if (profile.linkUserId) {
        await this.googleOAuth.linkGoogleAccount(profile);
        return res.redirect(`${callbackBase}?action=linked`);
      }

      // ── Sign-in flow ─────────────────────────────────────────────────────────
      const result = await this.googleOAuth.findOrCreateUser(profile);

      // Build the param bundle the web callback page expects.
      let bundle: Record<string, string>;
      if (result.kind === "staff" || result.kind === "platform") {
        const r = result as any;
        bundle = {
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          role: r.user.role,
          tenantSlug: r.user.tenantSlug ?? "",
        };
      } else {
        const r = result as any;
        bundle = {
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          type: "BUYER",
          sellerCount: String(r.sellerCount),
          linked: profile.inviteToken ? "true" : "false",
        };
      }

      // Mobile deep-link path is unchanged: the native app reads tokens from the
      // routeflow:// deep link (not exposed to web CDN/proxy logs or Referer).
      if (profile.mobile) {
        const q = new URLSearchParams(bundle).toString();
        return res.redirect(`${callbackBase}?${q}`);
      }

      // Web (F8-001): hand off via a single-use opaque code — tokens never appear
      // in the redirect URL. The callback page POSTs the code to /auth/google/exchange.
      const exchangeCode = await this.googleOAuth.createExchangeCode(bundle);
      return res.redirect(`${callbackBase}?code=${exchangeCode}`);
    } catch (err: any) {
      const errCode = err?.message ?? "unknown_error";
      const safeCode = this.mapErrorCode(errCode);
      return res.redirect(`${base}?error=${safeCode}`);
    }
  }

  /**
   * POST /api/v1/auth/google/exchange
   *
   * F8-001: trade the single-use opaque code from the OAuth callback redirect for
   * the token bundle. Public (the user is mid-sign-in, no JWT yet) and rate-limited
   * to blunt brute-forcing of the 256-bit code space.
   */
  @Post("google/exchange")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Exchange a one-time Google sign-in code for tokens" })
  async googleExchange(@Body() dto: ExchangeCodeDto) {
    const bundle = await this.googleOAuth.consumeExchangeCode(dto.code);
    if (!bundle) throw new UnauthorizedException("exchange_code_invalid");
    return bundle;
  }

  /**
   * Decode the state param without consuming the nonce so we can pick the correct
   * redirect base (web vs mobile) on error paths. Non-throwing — returns false on
   * any parse failure and the flow falls back to the web URL.
   */
  private peekMobileFlag(state: string | undefined): boolean {
    if (!state) return false;
    try {
      const obj = JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
      return obj?.mobile === true;
    } catch {
      return false;
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
