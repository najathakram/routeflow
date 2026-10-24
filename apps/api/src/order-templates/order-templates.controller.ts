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
import { GenerateTemplateOrderDto } from "./dto/generate-template-order.dto";
import { toCustomerOrder } from "../common/staff-only-fields";

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
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  create(@Body() dto: CreateOrderTemplateDto, @CurrentUser() user: JwtPayload) {
    return this.service.createForUser(dto, user);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
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
  @Roles(UserRole.OPERATOR)
  addItem(
    @Param("id") templateId: string,
    @Body() dto: AddTemplateItemDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.addItemForUser(templateId, dto, user);
  }

  @Post(":id/items/:itemId/lift-suspension")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  liftItemSuspension(
    @Param("id") templateId: string,
    @Param("itemId") itemId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.liftItemSuspension(templateId, itemId, user);
  }

  @Delete(":id/items/:itemId")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  removeItem(
    @Param("id") templateId: string,
    @Param("itemId") itemId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.removeItemForUser(templateId, itemId, user);
  }

  @Post(":id/generate")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER)
  async generateOrder(
    @Param("id") templateId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto?: GenerateTemplateOrderDto,
  ) {
    const order = await this.service.generateOrderForUser(templateId, user, dto);
    // A CUSTOMER gets the customer-facing allowlist of the order it generated; staff get the row itself.
    return user.role === UserRole.CUSTOMER ? toCustomerOrder(order) : order;
  }
}
