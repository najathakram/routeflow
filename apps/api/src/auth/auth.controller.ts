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
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { LocalAuthGuard } from "./guards/local-auth.guard";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { CurrentUser } from "./decorators/current-user.decorator";
import { TenantGoogleOAuthService } from "../tenants/tenant-google-oauth.service";
import { GoogleOAuthService } from "./google-oauth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { SetPasswordDto } from "./dto/set-password.dto";
import { RequestPasswordResetDto } from "./dto/request-password-reset.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ExchangeCodeDto } from "./dto/exchange-code.dto";
import { resolveLoginThrottle } from "./login-throttle.config";
import { extractDeviceInfo } from "./device-info.util";

// SEC-4 / F11-002: name + scope of the httpOnly refresh cookie. Path is scoped
// to the auth routes so it is never sent to unrelated API endpoints. Kept in
// sync with the global prefix (`api/v1`) + this controller's base path (`auth`).
const REFRESH_COOKIE = "rf_refresh";
const REFRESH_COOKIE_PATH = "/api/v1/auth";
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d fallback (matches refresh TTL)

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
  // RF-160: 10 attempts per 5 min per IP to block brute-force. pB10: env override for
  // local stacks only, prod defaults unchanged. Resolved per request (memoized on first
  // use) rather than at module init — this module is imported before
  // `ConfigModule.forRoot()` runs, so a module-init read would ignore `apps/api/.env`.
  @Throttle({
    default: {
      limit: () => resolveLoginThrottle().limit,
      ttl: () => resolveLoginThrottle().ttl,
    },
  })
  @ApiOperation({ summary: "Login with username and password" })
  async login(
    @CurrentUser() user: any,
    @Body() _dto: LoginDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceInfo = extractDeviceInfo(req);
    const result = await this.authService.login(user, deviceInfo);
    // SEC-4 / F11-002: ALSO set the refresh token as an httpOnly cookie. Purely
    // additive — the body still carries the token, so mobile and the current web
    // client are unaffected; web can later stop persisting it in localStorage.
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: "Refresh access token" })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceInfo = extractDeviceInfo(req);
    // SEC-4 / F11-002: prefer the httpOnly cookie, fall back to the request body
    // (mobile can't use cookies, so its body token keeps working unchanged).
    const token = this.readRefreshCookie(req) ?? dto.refreshToken;
    if (!token) throw new UnauthorizedException("Invalid or expired refresh token");
    const result = await this.authService.refresh(token, deviceInfo);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Logout and revoke all refresh tokens" })
  async logout(
    @CurrentUser() user: { id: string; impersonatedBy?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    // SEC-4 / F11-002: drop the httpOnly refresh cookie alongside server-side revocation.
    this.clearRefreshCookie(res);
    // B138: an impersonation token's `sub` IS the tenant's TENANT_ADMIN
    // (platform-admin.service.ts impersonate()), so revoking "the caller's" refresh
    // tokens would sign that admin out of every device. An impersonation has no
    // refresh token of its own — there is nothing to revoke. The claim reaches
    // req.user through JwtStrategy (B165); RolesGuard never reads it.
    if (user.impersonatedBy) {
      return { message: "Impersonation session ended" };
    }
    return this.authService.logout(user.id);
  }

  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Verify email from signup link and return auth tokens" })
  verifyEmail(@Body() body: { token: string }, @Req() req: any) {
    const deviceInfo = extractDeviceInfo(req);
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

  @Post("set-password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP — matches reset endpoints
  @ApiOperation({ summary: "Set a first password on a Google-only account (no current password)" })
  setPassword(@CurrentUser() user: { id: string }, @Body() dto: SetPasswordDto, @Req() req: any) {
    return this.authService.setPassword(user.id, dto.newPassword, extractDeviceInfo(req));
  }

  // ─── Password reset (RF-018) ───────────────────────────────────────────────

  @Post("request-password-reset")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP
  @ApiOperation({ summary: "Request a password reset link (RF-018)" })
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.authService.requestPasswordReset(dto.email, dto.surface);
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
    @Query("device_state") deviceState: string | undefined,
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
      // F12-005: only meaningful on the mobile deep-link flow; echoed back to the app.
      mobile ? deviceState : undefined,
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
    @Req() req: Request,
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
      const result = await this.googleOAuth.findOrCreateUser(profile, extractDeviceInfo(req));

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

      // Mobile deep-link path: the native app reads tokens from the routeflow://
      // deep link (not exposed to web CDN/proxy logs or Referer).
      if (profile.mobile) {
        // F12-005: echo the device-generated state nonce back so the app can
        // reject unsolicited deep links (session fixation). Absent for older app
        // builds that don't send `device_state` — additive, nothing breaks.
        if (profile.deviceState) bundle.state = profile.deviceState;
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
   * Decode the state param without consuming the nonce or verifying its signature,
   * so we can pick the correct redirect base (web vs mobile) on error paths.
   * Non-throwing — returns false on any parse failure and the flow falls back to the
   * web URL. Not a security decision: it only chooses which URL an error bounces to;
   * the authoritative signature check happens in GoogleOAuthService.verifyCallback.
   * B349: state is now `base64url(payload).base64url(mac)` — read the payload segment.
   */
  private peekMobileFlag(state: string | undefined): boolean {
    if (!state) return false;
    try {
      const payloadPart = state.split(".")[0];
      const obj = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf-8"));
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

  // ─── Refresh-cookie helpers (SEC-4 / F11-002) ──────────────────────────────
  //
  // A minimal, dependency-free httpOnly-cookie carrier for the refresh token.
  // cookie-parser is intentionally NOT wired globally — reading is done by hand
  // for just this one cookie to keep the change small and reversible.

  /** Set the refresh token as an httpOnly, Secure, SameSite=Lax cookie. */
  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: REFRESH_COOKIE_PATH,
      maxAge: this.refreshCookieMaxAge(token),
    });
  }

  /** Clear the refresh cookie — options must match those used when setting it. */
  private clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: REFRESH_COOKIE_PATH,
    });
  }

  /** Read the `rf_refresh` cookie from the raw Cookie header (no cookie-parser). */
  private readRefreshCookie(req: any): string | undefined {
    const raw = req?.headers?.cookie;
    if (!raw || typeof raw !== "string") return undefined;
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() === REFRESH_COOKIE) {
        return decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
    return undefined;
  }

  /** Align the cookie lifetime with the refresh token's own `exp` when decodable. */
  private refreshCookieMaxAge(token: string): number {
    try {
      const seg = token.split(".")[1];
      const decoded = JSON.parse(Buffer.from(seg, "base64url").toString("utf-8"));
      if (typeof decoded?.exp === "number") {
        const ms = decoded.exp * 1000 - Date.now();
        if (ms > 0) return ms;
      }
    } catch {
      // fall through to the default
    }
    return REFRESH_COOKIE_MAX_AGE_MS;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

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
