import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ListProductsDto, StockStatusFilter } from "./dto/list-products.dto";
import { ImportProductsDto } from "./dto/import-products.dto";
import { v4 as uuidv4 } from "uuid";

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async findAll(query: ListProductsDto) {
    const page = Number(query.page ?? 1);
    // limit=0 means "all" — use a high ceiling internally
    const limitRaw = Number(query.limit ?? 20);
    const fetchAll = limitRaw === 0;
    const limit = fetchAll ? 100_000 : limitRaw;
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

    // Server-side stock-status filtering so pagination counts are accurate
    if (query.stockStatus === StockStatusFilter.OUT_OF_STOCK) {
      where.OR = [
        ...(where.OR ?? []),
        { isActive: false },
        { currentStock: { lte: 0 } },
      ];
    } else if (query.stockStatus === StockStatusFilter.LOW) {
      where.isActive = true;
      where.currentStock = { gt: 0, lte: 5 };
    } else if (query.stockStatus === StockStatusFilter.IN_STOCK) {
      where.isActive = true;
      where.currentStock = { gt: 5 };
    }

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({ where, skip, take: limit, orderBy: { name: "asc" } }),
      this.prisma.product.count({ where }),
    ]);

    // Attach thumbnailUrl (first image only) for list/grid display without loading all images
    const enriched = await Promise.all(
      data.map(async (p) => {
        const thumbnailUrl = p.imageKeys.length > 0
          ? await this.storage.presignedUrl(p.imageKeys[0])
          : null;
        return { ...p, thumbnailUrl };
      }),
    );

    return {
      data: enriched,
      meta: {
        total,
        page: fetchAll ? 1 : page,
        limit: fetchAll ? total : limit,
        totalPages: fetchAll ? 1 : Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Product not found");
    // Attach presigned image URLs so the frontend can render them directly
    const imageUrls = product.imageKeys.length > 0
      ? await this.storage.presignedUrls(product.imageKeys)
      : [];
    return { ...product, imageUrls };
  }

  async uploadImage(
    id: string,
    buffer: Buffer,
    originalName: string,
    mimetype: string,
  ): Promise<{ key: string; url: string }> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Product not found");

    const ext = originalName.split(".").pop() ?? "jpg";
    const key = `products/${id}/${uuidv4()}.${ext}`;
    await this.storage.upload(key, buffer, mimetype);

    // Append key to the product's imageKeys array
    await this.prisma.product.update({
      where: { id },
      data: { imageKeys: { push: key } },
    });

    const url = await this.storage.presignedUrl(key);
    return { key, url };
  }

  async deleteImage(id: string, key: string): Promise<void> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Product not found");
    if (!product.imageKeys.includes(key)) {
      throw new NotFoundException("Image not found on this product");
    }

    // Remove from R2
    await this.storage.delete(key);

    // Remove key from array
    await this.prisma.product.update({
      where: { id },
      data: { imageKeys: product.imageKeys.filter((k) => k !== key) },
    });
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

  async clearAll(): Promise<{ deleted: number }> {
    // Count before clearing so we can report back
    const count = await this.prisma.product.count();
    // CASCADE removes all rows in dependent tables (OrderItem, InvoiceItem, etc.)
    await this.prisma.$executeRaw`TRUNCATE TABLE "Product" CASCADE`;
    return { deleted: count };
  }

  async bulkDelete(ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    // Delete dependent records first, then the products themselves
    await this.prisma.$transaction([
      this.prisma.stockMovement.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.orderItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.deliveryMutation.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.orderTemplateItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.invoiceItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.purchaseOrderItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.estimateItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.returnItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.product.deleteMany({ where: { id: { in: ids } } }),
    ]);
    return { deleted: ids.length };
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
