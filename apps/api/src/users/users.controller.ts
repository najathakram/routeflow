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
  @Roles(UserRole.OPERATOR)
  findAll(@Query() query: ListUsersDto) {
    return this.usersService.findAll(query);
  }

  @Post("operator")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  createOperator(@Body() dto: CreateOperatorDto) {
    return this.usersService.createOperator(dto);
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
    if (user.role !== UserRole.OPERATOR && user.sub !== id) {
      throw new ForbiddenException("Access denied");
    }
    return this.usersService.findById(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: JwtPayload) {
    if (user.role !== UserRole.OPERATOR && user.sub !== id) {
      throw new ForbiddenException("Access denied");
    }
    return this.usersService.updateUser(id, dto);
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
}
