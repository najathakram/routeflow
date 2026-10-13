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
import { PreferencesBodyPipe } from "./dto/update-preferences.dto";
import { OperatorPermissionsService } from "../auth/permissions/operator-permissions.service";

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly permissions: OperatorPermissionsService,
  ) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  findAll(@Query() query: ListUsersDto, @CurrentUser() user: JwtPayload) {
    return this.usersService.findAll(query, user.role);
  }

  @Post("operator")
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  createOperator(@Body() dto: CreateOperatorDto) {
    return this.usersService.createOperator(dto);
  }

  @Get("me")
  getMe(@CurrentUser() user: JwtPayload) {
    return this.usersService.findById(user.sub);
  }

  /** The caller's feature groups (any authenticated staff role). Declared before `:id` so it is not shadowed. */
  @Get("me/permissions")
  getMyPermissions(@CurrentUser() user: JwtPayload) {
    return this.permissions.mine(user);
  }

  @Get("me/preferences")
  getMyPreferences(@CurrentUser() user: JwtPayload) {
    return this.usersService.getPreferences(user.sub);
  }

  @Patch("me/preferences")
  async updateMyPreferences(
    @CurrentUser() user: JwtPayload,
    @Body(PreferencesBodyPipe) dto: Record<string, string>,
  ) {
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
   * Editing another user's record is account administration: TENANT_ADMIN only. Anyone may edit
   * THEIR OWN record (email / username), and a self edit never carries a role: RF-073 (a driver or
   * customer could `PATCH /users/{ownId} {role:"OPERATOR"}` and self-promote) stays closed for every
   * role, an admin included. Only an admin editing someone else can change a role.
   */
  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: JwtPayload) {
    const isSelf = user.sub === id;
    // SUPER_ADMIN satisfies every role requirement in the roles guard, so it is an admin here too
    const isAdmin = user.role === UserRole.TENANT_ADMIN || user.role === UserRole.SUPER_ADMIN;
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException("Access denied");
    }
    const safeDto: UpdateUserDto = isAdmin && !isSelf ? dto : { ...dto, role: undefined };
    return this.usersService.updateUser(id, safeDto, user.username, user.role);
  }

  @Patch(":id/status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  changeStatus(
    @Param("id") id: string,
    @Body() dto: ChangeUserStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.usersService.changeStatus(id, dto, user.role, user.sub);
  }

  @Post(":id/reset-password")
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  resetPassword(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.usersService.resetPassword(id, user.role);
  }

  /** Clear a login lockout early (10 failed attempts → 15-min lock) so the
   *  tenant's admin can self-serve instead of waiting out the window. */
  @Post(":id/unlock")
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  unlock(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.usersService.unlockUser(id, user.role);
  }

  @Patch(":id/admin")
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  toggleAdmin(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const callerIsAdmin = user.isAdmin || user.role === UserRole.TENANT_ADMIN;
    return this.usersService.toggleAdmin(id, callerIsAdmin);
  }

  @Patch(":id/driver-permit")
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  toggleDriverPermit(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.usersService.toggleDriverPermit(id, user.role);
  }
}
