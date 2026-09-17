import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListUsersDto } from "./dto/list-users.dto";
import { CreateOperatorDto } from "./dto/create-operator.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ChangeUserStatusDto } from "./dto/change-user-status.dto";

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  findAll(@Query() query: ListUsersDto) {
    return this.usersService.findAll(query);
  }

  @Post("operator")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  createOperator(@Body() dto: CreateOperatorDto) {
    return this.usersService.createOperator(dto);
  }

  @Get("me")
  getMe(@CurrentUser() user: JwtPayload) {
    return this.usersService.findById(user.sub);
  }

  @Get("me/preferences")
  getMyPreferences(@CurrentUser() user: JwtPayload) {
    return this.usersService.getPreferences(user.sub);
  }

  @Patch("me/preferences")
  async updateMyPreferences(@CurrentUser() user: JwtPayload, @Body() dto: Record<string, string>) {
    await this.usersService.setPreferences(user.sub, dto);
    return this.usersService.getPreferences(user.sub);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN && user.sub !== id) {
      throw new ForbiddenException("Access denied");
    }
    return this.usersService.findById(id);
  }

  /**
   * RF-073: Previously, `UpdateUserDto.role` was passed straight through Prisma
   * for self-updates, allowing any authenticated user (driver, customer) to
   * call PATCH /users/{ownId} with `{role: "OPERATOR"}` and self-promote.
   * The role field is now stripped for any caller who is not an OPERATOR
   * or TENANT_ADMIN.
   */
  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: JwtPayload) {
    if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN && user.sub !== id) {
      throw new ForbiddenException("Access denied");
    }
    const isPrivileged = user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
    const safeDto: UpdateUserDto = isPrivileged ? dto : { ...dto, role: undefined };
    return this.usersService.updateUser(id, safeDto, user.username);
  }

  @Patch(":id/status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  changeStatus(@Param("id") id: string, @Body() dto: ChangeUserStatusDto) {
    return this.usersService.changeStatus(id, dto);
  }

  @Post(":id/reset-password")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  resetPassword(@Param("id") id: string) {
    return this.usersService.resetPassword(id);
  }

  /** Clear a login lockout early (10 failed attempts → 15-min lock) so the
   *  tenant's admin can self-serve instead of waiting out the window. */
  @Post(":id/unlock")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  unlock(@Param("id") id: string) {
    return this.usersService.unlockUser(id);
  }

  @Patch(":id/admin")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  toggleAdmin(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const callerIsAdmin = user.isAdmin || user.role === UserRole.TENANT_ADMIN;
    return this.usersService.toggleAdmin(id, callerIsAdmin);
  }

  @Patch(":id/driver-permit")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  toggleDriverPermit(@Param("id") id: string) {
    return this.usersService.toggleDriverPermit(id);
  }
}
