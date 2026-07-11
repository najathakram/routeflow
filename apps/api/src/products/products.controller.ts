import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
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
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  findAll(@Query() query: ListProductsDto) {
    return this.productsService.findAll(query);
  }

  // Must be declared before :id to avoid route collision
  @Get("categories")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  listCategories() {
    return this.productsService.listCategories();
  }

  // Must be declared before :id to avoid route collision
  @Get("barcode/:barcode")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  findByBarcode(@Param("barcode") barcode: string) {
    return this.productsService.findByBarcode(barcode);
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
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

  // Must be declared before :id to avoid route collision
  @Delete("clear-all")
  @Roles(UserRole.OPERATOR)
  clearAll(@Query("confirm") confirm?: string) {
    if (confirm !== "true") {
      throw new BadRequestException(
        "This action permanently deletes ALL products and cascades to orders, invoices, and inventory. Pass ?confirm=true to proceed.",
      );
    }
    return this.productsService.clearAll();
  }

  // Must be declared before :id to avoid route collision
  @Delete("bulk")
  @Roles(UserRole.OPERATOR)
  bulkDelete(@Body() dto: { ids: string[] }) {
    return this.productsService.bulkDelete(dto.ids);
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

  // ─── Image endpoints (declared after :id to avoid prefix collision) ──────────

  @Post(":id/images")
  @Roles(UserRole.OPERATOR)
  @UseInterceptors(
    FilesInterceptor("files", 10, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
      fileFilter: (_req, file, cb) => {
        // RF-076/RF-157: Strict MIME allowlist — only safe raster image types accepted.
        // SVG is explicitly blocked (can embed JS). Any other type is also rejected.
        const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
        if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
          cb(
            new BadRequestException(
              `File type "${file.mimetype}" is not permitted. Allowed types: JPEG, PNG, WEBP.`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadImages(
    @Param("id") id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { focalX?: string | string[]; focalY?: string | string[] },
  ) {
    // Multer + multipart: when one focal field per file is sent the form
    // engine collapses single values to strings and multiples to arrays.
    // Normalise to a per-index lookup. Missing/invalid → centre default.
    const focalXs = toArray(body.focalX);
    const focalYs = toArray(body.focalY);
    const results = await Promise.all(
      files.map((f, i) => {
        const x = parseFinite(focalXs[i]);
        const y = parseFinite(focalYs[i]);
        const focal = x !== null && y !== null ? { x, y } : undefined;
        return this.productsService.uploadImage(id, f.buffer, f.originalname, f.mimetype, focal);
      }),
    );
    return { uploaded: results };
  }

  @Delete(":id/images")
  @Roles(UserRole.OPERATOR)
  deleteImage(@Param("id") id: string, @Body() dto: { key: string }) {
    return this.productsService.deleteImage(id, dto.key);
  }
}

function toArray(v: string | string[] | undefined): (string | undefined)[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function parseFinite(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
