import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { DraftsService } from "./drafts.service";
import { SaveDraftDto } from "./dto/save-draft.dto";

@ApiTags("drafts")
@ApiBearerAuth()
@Controller("drafts")
@UseGuards(JwtAuthGuard, RolesGuard)
// Operators and drivers both build orders/invoices, so both may park drafts.
@Roles(UserRole.OPERATOR, UserRole.DRIVER)
export class DraftsController {
  constructor(private readonly svc: DraftsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.svc.list(user);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: SaveDraftDto) {
    return this.svc.create(user, dto);
  }

  @Get(":id")
  get(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.svc.get(user, id);
  }

  @Patch(":id")
  update(@CurrentUser() user: JwtPayload, @Param("id") id: string, @Body() dto: SaveDraftDto) {
    return this.svc.update(user, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.svc.remove(user, id);
  }
}
