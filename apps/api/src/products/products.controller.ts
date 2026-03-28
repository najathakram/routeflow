import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { ProductsService } from "./products.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ListProductsDto } from "./dto/list-products.dto";
import { ImportProductsDto } from "./dto/import-products.dto";

@Controller("products")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(@Query() query: ListProductsDto) {
    return this.productsService.findAll(query);
  }

  // Must be declared before :id to avoid route collision
  @Get("barcode/:barcode")
  findByBarcode(@Param("barcode") barcode: string) {
    return this.productsService.findByBarcode(barcode);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.productsService.findOne(id);
  }

  @Post()
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  // Must be declared before :id to avoid route collision
  @Post("import")
  @Roles(UserRole.OPERATOR)
  importFromZoho(@Body() dto: ImportProductsDto) {
    return this.productsService.importFromZoho(dto);
  }

  @Patch(":id")
  @Roles(UserRole.OPERATOR)
  update(@Param("id") id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Delete(":id")
  @Roles(UserRole.OPERATOR)
  remove(@Param("id") id: string) {
    return this.productsService.remove(id);
  }
}
