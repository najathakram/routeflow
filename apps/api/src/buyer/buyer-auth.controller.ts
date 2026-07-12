import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { BuyerAuthService } from "./buyer-auth.service";
import { BuyerJwtAuthGuard } from "./guards/buyer-jwt-auth.guard";
import { CurrentBuyer } from "./decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import { BuyerRegisterDto } from "./dto/buyer-register.dto";
import { BuyerLoginDto } from "./dto/buyer-login.dto";
import { BuyerRefreshDto } from "./dto/buyer-refresh.dto";
import { BuyerChangePasswordDto } from "./dto/buyer-change-password.dto";
import { BuyerSetPasswordDto } from "./dto/buyer-set-password.dto";
import { BuyerRequestPasswordResetDto } from "./dto/buyer-request-password-reset.dto";
import { BuyerResetPasswordDto } from "./dto/buyer-reset-password.dto";
import { BuyerUpdateAccountDto } from "./dto/buyer-update-account.dto";

@ApiTags("buyer-auth")
@Controller("buyer/auth")
export class BuyerAuthController {
  constructor(private readonly buyerAuthService: BuyerAuthService) {}

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Create a new buyer portal account" })
  register(@Body() dto: BuyerRegisterDto, @Req() req: any) {
    return this.buyerAuthService.register(dto, this.extractDeviceInfo(req));
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Login to buyer portal" })
  login(@Body() dto: BuyerLoginDto, @Req() req: any) {
    return this.buyerAuthService.login(dto, this.extractDeviceInfo(req));
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: "Refresh buyer access token" })
  refresh(@Body() dto: BuyerRefreshDto, @Req() req: any) {
    return this.buyerAuthService.refresh(dto.refreshToken, this.extractDeviceInfo(req));
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Logout and revoke all buyer refresh tokens" })
  logout(@CurrentBuyer() buyer: BuyerJwtPayload) {
    return this.buyerAuthService.logout(buyer.sub);
  }

  @Delete("account")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Permanently delete buyer account (soft delete)" })
  deleteAccount(@CurrentBuyer() buyer: BuyerJwtPayload) {
    return this.buyerAuthService.deleteAccount(buyer.sub);
  }

  @Post("change-password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change buyer account password" })
  changePassword(@CurrentBuyer() buyer: BuyerJwtPayload, @Body() dto: BuyerChangePasswordDto) {
    return this.buyerAuthService.changePassword(buyer.sub, dto.currentPassword, dto.newPassword);
  }

  @Post("set-password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP — matches reset endpoints
  @ApiOperation({ summary: "Set a first password on a Google-only buyer account" })
  setPassword(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @Body() dto: BuyerSetPasswordDto,
    @Req() req: any,
  ) {
    return this.buyerAuthService.setPassword(
      buyer.sub,
      dto.newPassword,
      this.extractDeviceInfo(req),
    );
  }

  // ─── Password reset ───────────────────────────────────────────────────────────

  @Post("request-password-reset")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP
  @ApiOperation({ summary: "Request a buyer password reset link" })
  requestPasswordReset(@Body() dto: BuyerRequestPasswordResetDto) {
    return this.buyerAuthService.requestPasswordReset(dto.email);
  }

  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 900_000, limit: 5 } }) // 5 per 15 min per IP
  @ApiOperation({ summary: "Reset buyer password with token" })
  resetPassword(@Body() dto: BuyerResetPasswordDto) {
    return this.buyerAuthService.resetPassword(dto.token, dto.newPassword);
  }

  // ─── Profile ──────────────────────────────────────────────────────────────────

  @Get("profile")
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the buyer account profile (authoritative hasPassword read)" })
  getProfile(@CurrentBuyer() buyer: BuyerJwtPayload) {
    return this.buyerAuthService.getProfile(buyer.sub);
  }

  @Patch("profile")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update buyer profile (name, phone, mobile)" })
  updateProfile(@CurrentBuyer() buyer: BuyerJwtPayload, @Body() dto: BuyerUpdateAccountDto) {
    return this.buyerAuthService.updateProfile(buyer.sub, dto);
  }

  // ─── Session management ───────────────────────────────────────────────────────

  @Get("sessions")
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List active sessions for the current buyer" })
  listSessions(@CurrentBuyer() buyer: BuyerJwtPayload) {
    return this.buyerAuthService.listSessions(buyer.sub);
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke a specific buyer session by ID" })
  revokeSession(@CurrentBuyer() buyer: BuyerJwtPayload, @Param("id") sessionId: string) {
    return this.buyerAuthService.revokeSession(buyer.sub, sessionId);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private extractDeviceInfo(req: any) {
    const ua = (req.headers?.["user-agent"] as string) ?? undefined;
    const ip =
      (req.headers?.["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket?.remoteAddress ??
      undefined;
    return { userAgent: ua, ipAddress: ip };
  }
}
