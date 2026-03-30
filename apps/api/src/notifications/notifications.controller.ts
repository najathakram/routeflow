import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post("register-token")
  registerToken(
    @CurrentUser() user: JwtPayload,
    @Body() dto: { token: string; platform: "IOS" | "ANDROID" },
  ) {
    return this.notificationsService.registerToken(user.sub, dto.token, dto.platform);
  }

  @Delete("token/:token")
  removeToken(@CurrentUser() user: JwtPayload, @Param("token") token: string) {
    return this.notificationsService.removeToken(user.sub, token);
  }

  @Post("test")
  sendTest(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.sendTestNotification(user.sub);
  }

  @Get("status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  getStatus() {
    return this.notificationsService.getStatus();
  }
}
