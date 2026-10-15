import {
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
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
import { NoImpersonation } from "./decorators/no-impersonation.decorator";
import { CurrentUser } from "./decorators/current-user.decorator";
import { GoogleOAuthService } from "./google-oauth.service";
import { AppleOAuthService } from "./apple-oauth.service";
import { AppleNonceDto } from "./dto/apple-nonce.dto";
import { AppleSignInDto } from "./dto/apple-sign-in.dto";
import { AppleLinkDto } from "./dto/apple-link.dto";
import { AppleNotificationDto } from "./dto/apple-notification.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { SetPasswordDto } from "./dto/set-password.dto";
import { RequestPasswordResetDto } from "./dto/request-password-reset.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ExchangeCodeDto } from "./dto/exchange-code.dto";
import { resolveLoginThrottle } from "./login-throttle.config";
import { extractDeviceInfo } from "./device-info.util";
import { StaffHandoffService } from "./handoff/staff-handoff.service";
import { HandoffExchangeDto, HandoffMintDto } from "./handoff/handoff.dto";
import type { JwtPayload } from "./jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";

// SEC-4 / F11-002: name + scope of the httpOnly refresh cookie. Path is scoped
// to the auth routes so it is never sent to unrelated API endpoints. Kept in
// sync with the global prefix (`api/v1`) + this controller's base path (`auth`).
const REFRESH_COOKIE = "rf_refresh";
const REFRESH_COOKIE_PATH = "/api/v1/auth";
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d fallback (matches refresh TTL)

/** Fixed 410 body for the retired per-tenant Google sign-in routes. Nothing from the request is echoed. */
export const RETIRED_SIGN_IN_ROUTE = {
  statusCode: 410,
  code: API_ERROR_CODES.SIGN_IN_ROUTE_RETIRED,
  message: "This sign-in route has been retired. Use the standard Google sign-in.",
  error: "Gone",
} as const;

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  private readonly webUrl: string;
  /** B825/SA-132: the Expo mobile-web build's own origin — the second allowed
   *  `returnOrigin` value a browser Google flow may ask the callback to
   *  redirect back to (see `resolveReturnOrigin`). `undefined` when
   *  MOBILE_WEB_URL is unset or blank — there is deliberately NO hardcoded
   *  production fallback here (unlike `configuration.ts`'s `urls.mobileWeb`,
   *  used for password-reset links): a misconfigured/missing env var must
   *  fail CLOSED to WEB_URL-only, never silently trust a guessed prod origin. */
  private readonly mobileWebUrl: string | undefined;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly staffHandoff: StaffHandoffService,
    private readonly appleOAuth: AppleOAuthService,
  ) {
    this.webUrl = AuthController.normalizeOrigin(
      configService.get<string>("WEB_URL") || "http://localhost:3001",
    );
    // SA-132: `||` (not `??`) so a blank MOBILE_WEB_URL="" (the .env.example
    // default) is treated the same as unset, not as a configured empty origin.
    const rawMobileWebUrl = configService.get<string>("MOBILE_WEB_URL") || undefined;
    this.mobileWebUrl = rawMobileWebUrl
      ? AuthController.normalizeOrigin(rawMobileWebUrl)
      : undefined;

    if (this.webUrl.includes("localhost") && configService.get("NODE_ENV") !== "development") {
      console.warn(
        "[GoogleAuth] WEB_URL is not set — OAuth callbacks will redirect to localhost, which will fail in production.",
      );
    }
    if (!this.mobileWebUrl) {
      console.warn(
        "[GoogleAuth] MOBILE_WEB_URL is not set — the return_origin allow-list accepts WEB_URL only, " +
          "so a mobile-web (Expo) Google sign-in will land on the Next web app instead of returning to " +
          "itself. Set MOBILE_WEB_URL on the api service in Railway to fix this.",
      );
    }
  }

  /**
   * B825/SA-132: canonicalize a CONFIGURED trust-boundary value (WEB_URL /
   * MOBILE_WEB_URL) via the URL parser's own `.origin` so an operator-set
   * trailing slash or explicit default port (`:443`) doesn't silently make
   * every candidate comparison fail. Never applied to the untrusted
   * `return_origin` candidate itself — `resolveReturnOrigin` keeps an exact
   * `===` there, so a candidate with a trailing slash, different case, or a
   * userinfo/downgrade trick is still rejected rather than leniently matched.
   * Falls back to the raw value if it isn't a parseable absolute URL, so a
   * malformed env var can never crash boot.
   */
  private static normalizeOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
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

  // ─── #2653 in-app sign-in handoff (SA-542a/b), staff realm ──────────────────────

  @Post("handoff")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Mint a one-time code for the in-app web shell (OPERATOR/TENANT_ADMIN)",
  })
  mintHandoff(@CurrentUser() user: JwtPayload, @Body() dto: HandoffMintDto) {
    return this.staffHandoff.mint(user, dto.deviceId);
  }

  @Post("handoff/exchange")
  @HttpCode(HttpStatus.OK)
  // Same throttle as login: an exchange signs someone in.
  @Throttle({
    default: {
      limit: () => resolveLoginThrottle().limit,
      ttl: () => resolveLoginThrottle().ttl,
    },
  })
  @ApiOperation({ summary: "Trade a one-time handoff code for a fresh session" })
  async exchangeHandoff(
    @Body() dto: HandoffExchangeDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.staffHandoff.exchange(dto.code, extractDeviceInfo(req));
    // The same httpOnly refresh cookie login() sets (SEC-4).
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

  // Topmost on purpose: decorators apply bottom-up, so this guard lands AFTER JwtAuthGuard in the guard list.
  @NoImpersonation("account")
  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change password" })
  changePassword(@CurrentUser() user: { id: string }, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  @NoImpersonation("account")
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
    // B825: the Expo mobile-web build passes its own origin so a browser-based
    // sign-in there returns to it instead of always landing on the Next web
    // app; the Next web client passes nothing, so its own flow is unchanged.
    @Query("return_origin") returnOrigin: string | undefined,
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
    // Only meaningful for the BROWSER flow — the native deep-link flow always
    // uses GOOGLE_MOBILE_SCHEME regardless, never this origin.
    const resolvedReturnOrigin = mobile ? undefined : this.resolveReturnOrigin(returnOrigin);
    const url = await this.googleOAuth.generateAuthUrl(
      "tenant",
      tenantSlug,
      inviteToken,
      context,
      mobile,
      // F12-005: only meaningful on the mobile deep-link flow; echoed back to the app.
      mobile ? deviceState : undefined,
      resolvedReturnOrigin,
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
  @NoImpersonation("account")
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
    // atomically on the success path. B825: the peeked returnOrigin is UNVERIFIED input
    // (no signature check yet) — resolveReturnOrigin re-validates it against the exact
    // allow-list before it's ever used as a redirect target.
    const peekedMobile = this.peekMobileFlag(state);
    const base = peekedMobile
      ? (this.configService.get<string>("GOOGLE_MOBILE_SCHEME") ?? "routeflow://auth/callback")
      : `${this.resolveReturnOrigin(this.peekReturnOrigin(state))}/auth/google/callback`;

    if (oauthError) {
      return res.redirect(`${base}?error=oauth_cancelled`);
    }
    if (!code || !state) {
      return res.redirect(`${base}?error=state_invalid`);
    }

    try {
      const profile = await this.googleOAuth.verifyCallback(code, state);

      // Platform accounts sign in only through the platform callback. Turn a platform-type
      // state away before the link or sign-in step, so on this path no account is linked,
      // looked up or signed in and no token pair or exchange code is issued.
      if (profile.type === "platform") {
        return res.redirect(`${base}?error=unauthorized`);
      }

      // B825: profile.returnOrigin was already validated at mint time (googleAuthUrl's
      // resolveReturnOrigin call) and the signature above proves it wasn't tampered
      // with since — resolveReturnOrigin here is defense-in-depth, never a second
      // trust boundary. A request with no returnOrigin (the Next web client) resolves
      // to webUrl exactly as it always did.
      const callbackBase = profile.mobile
        ? (this.configService.get<string>("GOOGLE_MOBILE_SCHEME") ?? "routeflow://auth/callback")
        : `${this.resolveReturnOrigin(profile.returnOrigin)}/auth/google/callback`;

      // ── Link-account flow ────────────────────────────────────────────────────
      // When `linkUserId` is present the user is already authenticated and just
      // wants to attach their Google account — don't issue new tokens.
      if (profile.linkUserId) {
        await this.googleOAuth.linkGoogleAccount(profile);
        return res.redirect(`${callbackBase}?action=linked`);
      }

      // ── Sign-in flow ─────────────────────────────────────────────────────────
      const result = await this.googleOAuth.findOrCreateUser(profile, extractDeviceInfo(req));

      // Build the param bundle the web callback page expects. Platform results are
      // unreachable here: the platform-type state check above turns them away first.
      let bundle: Record<string, string>;
      if (result.kind === "staff") {
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
          // true only when this sign-in actually activated a link (a dead, removed, expired or refused invite is not).
          linked: r.inviteOutcome === "accepted" ? "true" : "false",
          // The seller's workspace is not taking the invite right now: the buyer is signed in, the link was skipped.
          ...(r.inviteOutcome === "seller_unavailable" ? { invite: "seller_unavailable" } : {}),
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

  /**
   * B825/SA-132: validate a candidate return origin against the EXACT
   * allow-list (`webUrl`, `mobileWebUrl` — the latter `undefined`, hence
   * never matchable, whenever MOBILE_WEB_URL isn't configured) — no prefix
   * or substring matching, so `https://routeflowmobile-production.up.railway
   * .app.evil.example` is rejected even though it starts with an allowed
   * origin. `candidate` is typed `unknown` because NestJS binds a repeated
   * query param (`?return_origin=a&return_origin=b`) as an array regardless
   * of the controller's declared `string | undefined` type — the `typeof`
   * guard below rejects that (and any other non-string) outright rather than
   * relying on `===` against a string to happen to be false. Anything not an
   * exact string match falls back to `webUrl`, which is also what a request
   * with no candidate at all resolves to — the Next web client's own flow is
   * byte-identical to before this existed.
   */
  private resolveReturnOrigin(candidate: unknown): string {
    if (
      typeof candidate === "string" &&
      (candidate === this.webUrl || candidate === this.mobileWebUrl)
    ) {
      return candidate;
    }
    if (candidate !== undefined) {
      // Only the parsed origin is logged, never the raw candidate — a
      // return_origin is attacker-controlled input we haven't verified yet.
      const rejectedOrigin = AuthController.safeOriginForLogging(candidate);
      console.warn(
        `[GoogleAuth] rejected return_origin${rejectedOrigin ? ` (${rejectedOrigin})` : ""} — not on the allow-list, falling back to WEB_URL.`,
      );
    }
    return this.webUrl;
  }

  /**
   * Best-effort extraction of just the `origin` of an untrusted candidate,
   * for logging only — never the full string (which may carry a path/query,
   * control characters, or not be a string at all). Returns undefined when
   * the candidate isn't a parseable absolute URL string.
   */
  private static safeOriginForLogging(candidate: unknown): string | undefined {
    if (typeof candidate !== "string") return undefined;
    try {
      return new URL(candidate).origin;
    } catch {
      return undefined;
    }
  }

  /**
   * Decode the state param's `returnOrigin` without consuming the nonce or
   * verifying its signature — mirrors `peekMobileFlag` above, for the same
   * error/cancelled paths. Non-authoritative: the raw peeked value is NEVER
   * used as a redirect target directly — always re-validated through
   * `resolveReturnOrigin` first, since (unlike the post-verifyCallback
   * `profile.returnOrigin`) this reads a state blob whose signature hasn't
   * been checked yet, so an attacker's crafted state could claim anything.
   */
  private peekReturnOrigin(state: string | undefined): string | undefined {
    if (!state) return undefined;
    try {
      const payloadPart = state.split(".")[0];
      const obj = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf-8"));
      return typeof obj?.returnOrigin === "string" ? obj.returnOrigin : undefined;
    } catch {
      return undefined;
    }
  }

  // ─── Sign in with Apple (#2309, SA-418 — native iOS only) ─────────────────
  //
  // ENV VARS required in Railway:
  //   APPLE_BUNDLE_ID     — the app's bundle identifier (exact `aud` match)
  //   APPLE_TEAM_ID       — Apple Developer Team ID
  //   APPLE_KEY_ID        — Sign in with Apple private key's Key ID
  //   APPLE_PRIVATE_KEY   — the .p8 private key contents, verbatim
  //
  // No redirect flow — the native client (expo-apple-authentication) does the
  // consent UI itself and posts identityToken/authorizationCode directly.

  @Post("apple/nonce")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Mint a server-side nonce for a Sign in with Apple request" })
  async appleNonce(@Body() dto: AppleNonceDto) {
    if (!this.appleOAuth.isConfigured()) {
      throw new ServiceUnavailableException(
        "Sign in with Apple is not configured for this environment.",
      );
    }
    return this.appleOAuth.mintNonce(dto.tenantSlug, dto.context);
  }

  @Post("apple")
  @HttpCode(HttpStatus.OK)
  // SA-418 §1: the SAME throttle as /auth/login.
  @Throttle({
    default: {
      limit: () => resolveLoginThrottle().limit,
      ttl: () => resolveLoginThrottle().ttl,
    },
  })
  @ApiOperation({ summary: "Sign in with Apple (native iOS only)" })
  async appleSignIn(@Body() dto: AppleSignInDto, @Req() req: Request) {
    if (!this.appleOAuth.isConfigured()) {
      throw new ServiceUnavailableException(
        "Sign in with Apple is not configured for this environment.",
      );
    }
    return this.appleOAuth.signIn(dto, extractDeviceInfo(req));
  }

  @NoImpersonation("account")
  @Post("apple/link")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Link an Apple account to the current user" })
  async appleLink(@CurrentUser() user: { sub: string }, @Body() dto: AppleLinkDto) {
    if (!this.appleOAuth.isConfigured()) {
      throw new ServiceUnavailableException(
        "Sign in with Apple is not configured for this environment.",
      );
    }
    await this.appleOAuth.linkAppleAccount(user.sub, dto.identityToken, dto.nonce);
    return { message: "Apple account linked" };
  }

  @Post("apple/notifications")
  // Unauthenticated and does a JWKS lookup + a Redis write per call: its own tight limit.
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Apple server-to-server notifications (consent-revoked, account-delete)",
  })
  async appleNotifications(@Body() dto: AppleNotificationDto) {
    // Unconfigured ⇒ refuse: with no bundle id there is no audience to verify against.
    if (!this.appleOAuth.isNotificationConfigured()) {
      throw new ServiceUnavailableException("Sign in with Apple is not configured");
    }
    await this.appleOAuth.handleNotification((dto.payload ?? dto.signedPayload) as string);
    return { received: true };
  }

  // ─── Retired per-tenant Google sign-in routes ─────────────────────────────
  // The legacy per-tenant sign-in routes are retired. Both answer 410 Gone with one fixed body
  // and read nothing from the request. Declared after the static GET google/link and
  // google/callback routes so these param routes never shadow them.

  @Get("google/:tenantSlug")
  @ApiOperation({ summary: "Retired per-tenant Google sign-in route (410 Gone)" })
  tenantGoogleLogin(): never {
    throw new GoneException(RETIRED_SIGN_IN_ROUTE);
  }

  @Get("google/:tenantSlug/callback")
  @ApiOperation({ summary: "Retired per-tenant Google sign-in callback (410 Gone)" })
  tenantGoogleCallback(): never {
    throw new GoneException(RETIRED_SIGN_IN_ROUTE);
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
      // #2495: an email match already bound to a DIFFERENT Google sub.
      "google_account_mismatch",
    ]);
    return allowed.has(raw) ? raw : "unknown_error";
  }
}
