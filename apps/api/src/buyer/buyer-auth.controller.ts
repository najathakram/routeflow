import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
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

@ApiTags("buyer-auth")
@Controller("buyer/auth")
export class BuyerAuthController {
  constructor(private readonly buyerAuthService: BuyerAuthService) {}

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Create a new buyer portal account" })
  register(@Body() dto: BuyerRegisterDto) {
    return this.buyerAuthService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Login to buyer portal" })
  login(@Body() dto: BuyerLoginDto) {
    return this.buyerAuthService.login(dto);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: "Refresh buyer access token" })
  refresh(@Body() dto: BuyerRefreshDto) {
    return this.buyerAuthService.refresh(dto.refreshToken);
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
  changePassword(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @Body() dto: { currentPassword: string; newPassword: string },
  ) {
    return this.buyerAuthService.changePassword(buyer.sub, dto.currentPassword, dto.newPassword);
  }

  @Patch("profile")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update buyer profile (name, phone, mobile)" })
  updateProfile(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @Body() dto: { name?: string; phone?: string; mobile?: string },
  ) {
    return this.buyerAuthService.updateProfile(buyer.sub, dto);
  }
}
