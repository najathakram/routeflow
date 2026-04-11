import { Controller, Get, Query, Res, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { GoogleOAuthService } from "./google-oauth.service";

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
      if (errCode === "state_invalid")
        return res.redirect(`${base}/auth/callback?error=state_invalid`);
      if (errCode === "google_token_invalid")
        return res.redirect(`${base}/auth/callback?error=state_invalid`);
      if (errCode === "unauthorized")
        return res.redirect(`${base}/auth/callback?error=unauthorized`);
      if (errCode === "tenant_suspended")
        return res.redirect(`${base}/auth/callback?error=tenant_suspended`);

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
