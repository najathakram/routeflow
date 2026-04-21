import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { DriversService } from "./drivers.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { ListDriversDto } from "./dto/list-drivers.dto";
import { CreateDriverDto } from "./dto/create-driver.dto";
import { UpdateDriverDto } from "./dto/update-driver.dto";
import { ChangeDriverStatusDto } from "./dto/change-driver-status.dto";
import { PostLocationDto } from "./dto/post-location.dto";

@ApiTags("drivers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("drivers")
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  findAll(@Query() query: ListDriversDto) {
    return this.driversService.findAll(query);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateDriverDto) {
    return this.driversService.create(dto);
  }

  @Get("me")
  getMe(@CurrentUser() user: JwtPayload) {
    return this.driversService.findByUserId(user.sub);
  }

  @Patch("me")
  updateMe(@CurrentUser() user: JwtPayload, @Body() dto: UpdateDriverDto) {
    return this.driversService.updateByUserId(user.sub, dto);
  }

  @Post("me/location")
  @UseGuards(RolesGuard)
  @Roles(UserRole.DRIVER)
  postLocation(@CurrentUser() user: JwtPayload, @Body() dto: PostLocationDto) {
    return this.driversService.recordLocation(user.sub, dto);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.driversService.findOne(id, user);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  update(@Param("id") id: string, @Body() dto: UpdateDriverDto) {
    return this.driversService.update(id, dto);
  }

  @Patch(":id/status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  changeStatus(@Param("id") id: string, @Body() dto: ChangeDriverStatusDto) {
    return this.driversService.changeStatus(id, dto);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  remove(@Param("id") id: string) {
    return this.driversService.remove(id);
  }

  @Get(":id/history")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  findHistory(
    @Param("id") id: string,
    @Query("page") page?: number,
    @Query("limit") limit?: number,
  ) {
    return this.driversService.findHistory(id, page ? Number(page) : 1, limit ? Number(limit) : 20);
  }

  @Get(":id/metrics")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  findMetrics(@Param("id") id: string) {
    return this.driversService.findMetrics(id);
  }
}
