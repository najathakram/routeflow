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
import { UserRole } from "@prisma/client";
import { CreateOrderTemplateDto } from "./dto/create-order-template.dto";
import { UpdateOrderTemplateDto } from "./dto/update-order-template.dto";
import { AddTemplateItemDto } from "./dto/add-template-item.dto";

@ApiTags("order-templates")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller("order-templates")
export class OrderTemplatesController {
  constructor(private readonly service: OrderTemplatesService) {}

  @Get()
  findAll(@Query("customerId") customerId?: string) {
    return this.service.findAll(customerId);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.service.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateOrderTemplateDto) {
    return this.service.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateOrderTemplateDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.remove(id);
  }

  @Post(":id/items")
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
