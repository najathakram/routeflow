import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ListProductsDto } from "./dto/list-products.dto";
import { ImportProductsDto } from "./dto/import-products.dto";

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListProductsDto) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { sku: { contains: query.search, mode: "insensitive" } },
        { barcode: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.category) where.category = query.category;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({ where, skip, take: limit, orderBy: { name: "asc" } }),
      this.prisma.product.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }

  async findByBarcode(barcode: string) {
    const product = await this.prisma.product.findUnique({ where: { barcode } });
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }

  async create(dto: CreateProductDto) {
    if (dto.sku) {
      const existing = await this.prisma.product.findUnique({ where: { sku: dto.sku } });
      if (existing) throw new BadRequestException("SKU already exists");
    }
    if (dto.barcode) {
      const existing = await this.prisma.product.findUnique({ where: { barcode: dto.barcode } });
      if (existing) throw new BadRequestException("Barcode already exists");
    }
    return this.prisma.product.create({
      data: {
        name: dto.name,
        sku: dto.sku,
        barcode: dto.barcode,
        unit: dto.unit,
        pricePerUnit: dto.pricePerUnit,
        category: dto.category,
        description: dto.description,
        isActive: dto.isActive,
      },
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    if (dto.sku) {
      const existing = await this.prisma.product.findFirst({
        where: { sku: dto.sku, id: { not: id } },
      });
      if (existing) throw new BadRequestException("SKU already exists");
    }
    if (dto.barcode) {
      const existing = await this.prisma.product.findFirst({
        where: { barcode: dto.barcode, id: { not: id } },
      });
      if (existing) throw new BadRequestException("Barcode already exists");
    }
    return this.prisma.product.update({
      where: { id },
      data: { ...dto },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    const activeItems = await this.prisma.orderItem.count({
      where: { productId: id, status: { notIn: ["DELIVERED", "CANCELLED"] } },
    });
    if (activeItems > 0) {
      throw new BadRequestException("Cannot delete product with active order items");
    }
    return this.prisma.product.update({ where: { id }, data: { isActive: false } });
  }

  async importFromZoho(dto: ImportProductsDto): Promise<{
    created: number;
    skipped: number;
    errors: Array<{ row: number; name: string; reason: string }>;
  }> {
    let created = 0;
    let skipped = 0;
    const errors: Array<{ row: number; name: string; reason: string }> = [];

    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];
      const rowNum = i + 1;

      try {
        // Check for duplicate SKU
        if (item.sku) {
          const existing = await this.prisma.product.findUnique({ where: { sku: item.sku } });
          if (existing) {
            skipped++;
            continue;
          }
        }

        // Check for duplicate barcode
        if (item.barcode) {
          const existing = await this.prisma.product.findUnique({ where: { barcode: item.barcode } });
          if (existing) {
            // If no SKU collision but barcode exists, skip
            skipped++;
            continue;
          }
        }

        await this.prisma.product.create({
          data: {
            name: item.name,
            sku: item.sku ?? null,
            barcode: item.barcode ?? null,
            unit: item.unit,
            pricePerUnit: item.pricePerUnit,
            category: item.category ?? null,
            description: item.description ?? null,
            isActive: item.isActive ?? true,
            currentStock: item.currentStock ?? "0",
            averageCost: item.averageCost ?? null,
            reorderPoint: item.reorderPoint ?? null,
          },
        });

        created++;
      } catch (err: any) {
        errors.push({ row: rowNum, name: item.name, reason: err?.message ?? "Unknown error" });
      }
    }

    return { created, skipped, errors };
  }
}
