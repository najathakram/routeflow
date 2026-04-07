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
import { OrderTemplatesService } from "./order-templates.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { CreateOrderTemplateDto } from "./dto/create-order-template.dto";
import { UpdateOrderTemplateDto } from "./dto/update-order-template.dto";
import { AddTemplateItemDto } from "./dto/add-template-item.dto";

@ApiTags("order-templates")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("order-templates")
export class OrderTemplatesController {
  constructor(private readonly service: OrderTemplatesService) {}

  @Get()
  findAll(@CurrentUser() user: JwtPayload, @Query("customerId") customerId?: string) {
    return this.service.findAllForUser(user, customerId);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOneForUser(id, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  create(@Body() dto: CreateOrderTemplateDto, @CurrentUser() user: JwtPayload) {
    return this.service.createForUser(dto, user);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  update(
    @Param("id") id: string,
    @Body() dto: UpdateOrderTemplateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateForUser(id, dto, user);
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  remove(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.service.removeForUser(id, user);
  }

  @Post(":id/items")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  addItem(@Param("id") templateId: string, @Body() dto: AddTemplateItemDto) {
    return this.service.addItem(templateId, dto);
  }

  @Delete(":id/items/:itemId")
  removeItem(@Param("id") templateId: string, @Param("itemId") itemId: string) {
    return this.service.removeItem(templateId, itemId);
  }

  @Post(":id/generate")
  generateOrder(@Param("id") templateId: string) {
    return this.service.generateOrder(templateId);
  }
}
