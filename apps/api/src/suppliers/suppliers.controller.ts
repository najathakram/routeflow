import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { SuppliersService } from "./suppliers.service";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { ListSuppliersDto } from "./dto/list-suppliers.dto";

@Controller("suppliers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  findAll(@Query() query: ListSuppliersDto) {
    return this.suppliersService.findAll(query);
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR)
  findOne(@Param("id") id: string) {
    return this.suppliersService.findOne(id);
  }

  @Post()
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliersService.create(dto);
  }

  @Patch(":id")
  @Roles(UserRole.OPERATOR)
  update(@Param("id") id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(id, dto);
  }

  @Patch(":id/deactivate")
  @Roles(UserRole.OPERATOR)
  deactivate(@Param("id") id: string) {
    return this.suppliersService.deactivate(id);
  }

  @Delete(":id")
  @Roles(UserRole.OPERATOR)
  remove(@Param("id") id: string) {
    return this.suppliersService.remove(id);
  }
}
