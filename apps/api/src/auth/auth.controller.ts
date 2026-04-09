import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { LocalAuthGuard } from "./guards/local-auth.guard";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { GoogleAuthGuard } from "./guards/google-auth.guard";
import { CurrentUser } from "./decorators/current-user.decorator";
import { TenantGoogleOAuthService } from "../tenants/tenant-google-oauth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly tenantGoogleOAuth: TenantGoogleOAuthService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard, LocalAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // 10 login attempts per minute
  @ApiOperation({ summary: "Login with username and password" })
  login(@CurrentUser() user: any, @Body() _dto: LoginDto) {
    return this.authService.login(user);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } }) // 20 refresh attempts per minute
  @ApiOperation({ summary: "Refresh access token" })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
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

  // ─── Google OAuth ──────────────────────────────────────────────────────────
  // NOTE: Set these env vars in Railway before enabling Google OAuth:
  //   GOOGLE_CLIENT_ID     — from Google Cloud Console OAuth 2.0 credentials
  //   GOOGLE_CLIENT_SECRET — from Google Cloud Console OAuth 2.0 credentials
  //   GOOGLE_CALLBACK_URL  — e.g. https://your-api.railway.app/auth/google/callback
  //   WEB_URL              — e.g. https://your-web-app.vercel.app

  @Get("google")
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: "Initiate Google OAuth login" })
  googleLogin() {
    // Passport redirects to Google — no body needed
  }

  @Get("google/callback")
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: "Google OAuth callback" })
  async googleCallback(@Req() req: any, @Res() res: Response) {
    const tokens = await this.authService.login(req.user);
    const webUrl =
      this.configService.get<string>("WEB_URL") ?? "http://localhost:3001";
    res.redirect(
      `${webUrl}/auth/callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&role=${tokens.user.role}`,
    );
  }

  // ─── Per-tenant Google OAuth ───────────────────────────────────────────────

  @Get("google/:tenantSlug")
  @ApiOperation({ summary: "Initiate per-tenant Google OAuth login" })
  async tenantGoogleLogin(@Param("tenantSlug") slug: string, @Res() res: Response) {
    const url = await this.tenantGoogleOAuth.buildAuthUrl(slug);
    res.redirect(url);
  }

  @Get("google/:tenantSlug/callback")
  @ApiOperation({ summary: "Per-tenant Google OAuth callback" })
  async tenantGoogleCallback(
    @Param("tenantSlug") slug: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const code = req.query?.code as string;
    if (!code) {
      const webUrl = this.configService.get<string>("WEB_URL") ?? "http://localhost:3001";
      return res.redirect(`${webUrl}/auth/error?message=oauth_cancelled`);
    }
    const user = await this.tenantGoogleOAuth.exchangeCode(code, slug);
    const tokens = await this.authService.login(user as any);
    const webUrl = this.configService.get<string>("WEB_URL") ?? "http://localhost:3001";
    res.redirect(
      `${webUrl}/auth/callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&role=${tokens.user.role}&tenantSlug=${slug}`,
    );
  }
}
