import { Controller, Get, Query, Res, UseGuards, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { GoogleOAuthService } from "./google-oauth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { CurrentUser } from "./decorators/current-user.decorator";

/**
 * Public Google OAuth endpoints for the Platform Admin (SUPER_ADMIN) flow.
 * No JwtAuthGuard — auth initiation must be reachable without a token.
 */
@ApiTags("platform-admin")
@Controller("platform-admin/auth/google")
export class PlatformGoogleAuthController {
  private readonly webUrl: string;

  constructor(
    private readonly googleOAuth: GoogleOAuthService,
    private readonly configService: ConfigService,
  ) {
    this.webUrl = configService.get<string>("WEB_URL") ?? "http://localhost:3001";

    if (this.webUrl.includes("localhost") && configService.get("NODE_ENV") !== "development") {
      console.warn(
        "[GoogleAuth] WEB_URL is not set — OAuth callbacks will redirect to localhost, which will fail in production.",
      );
    }
  }

  /**
   * GET /api/v1/platform-admin/auth/google
   * Returns the Google consent URL — frontend redirects the browser to it.
   */
  @Get()
  @ApiOperation({ summary: "Get Google OAuth URL for platform admin sign-in" })
  async getAuthUrl() {
    if (!this.googleOAuth.isConfigured()) {
      throw new ServiceUnavailableException(
        "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      );
    }
    const url = await this.googleOAuth.generateAuthUrl("platform");
    return { url };
  }

  /**
   * GET /api/v1/platform-admin/auth/google/link
   *
   * Authenticated endpoint — returns a Google consent URL that, when completed,
   * links the Google account to the currently signed-in platform admin.
   * Requires a valid SUPER_ADMIN JWT.
   */
  @Get("link")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get Google OAuth URL to link Google account to current platform admin" })
  async getLinkUrl(@CurrentUser() user: { sub: string }) {
    if (!this.googleOAuth.isConfigured()) {
      throw new ServiceUnavailableException(
        "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      );
    }
    const url = await this.googleOAuth.generateLinkUrl("platform", user.sub);
    return { url };
  }

  /**
   * GET /api/v1/platform-admin/auth/google/callback
   * Google redirects here after the user consents.
   * Verifies state nonce, exchanges code, issues JWT, redirects to platform UI.
   */
  @Get("callback")
  @ApiOperation({ summary: "Google OAuth callback for platform admin" })
  async handleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") oauthError: string,
    @Res() res: Response,
  ) {
    const base = `${this.webUrl}/platform`;

    if (oauthError) {
      return res.redirect(`${base}/auth/callback?error=oauth_cancelled`);
    }

    if (!code || !state) {
      return res.redirect(`${base}/auth/callback?error=state_invalid`);
    }

    try {
      const profile = await this.googleOAuth.verifyCallback(code, state);

      // ── Link-account flow ────────────────────────────────────────────────────
      if (profile.linkUserId) {
        await this.googleOAuth.linkGoogleAccount(profile);
        return res.redirect(`${base}/auth/callback?action=linked`);
      }

      // ── Sign-in flow ─────────────────────────────────────────────────────────
      const result = await this.googleOAuth.findOrCreateUser(profile);

      // Only SUPER_ADMIN platform accounts are expected here
      if (result.kind !== "platform") {
        return res.redirect(`${base}/auth/callback?error=unauthorized`);
      }

      return res.redirect(
        `${base}/auth/callback?accessToken=${result.accessToken}&refreshToken=${result.refreshToken}&role=${result.user.role}`,
      );
    } catch (err: any) {
      const errCode = err?.message ?? "unknown_error";

      // Map known error codes to safe redirect codes; never expose stack traces
      const knownCodes = new Set([
        "state_invalid",
        "unauthorized",
        "tenant_suspended",
        "google_already_linked",
        "google_id_taken",
      ]);
      if (errCode === "google_token_invalid")
        return res.redirect(`${base}/auth/callback?error=state_invalid`);
      if (knownCodes.has(errCode))
        return res.redirect(`${base}/auth/callback?error=${errCode}`);

      this.logError(err);
      return res.redirect(`${base}/auth/callback?error=unknown_error`);
    }
  }

  private logError(err: any) {
    // Log without leaking sensitive details
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PlatformGoogleAuth] Unhandled callback error: ${msg}`);
  }
}
