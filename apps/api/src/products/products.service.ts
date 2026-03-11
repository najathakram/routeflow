import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsDto } from './dto/list-products.dto';

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
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.category) where.category = query.category;
    if (query.lowStock !== undefined) where.lowStock = query.lowStock;
    if (query.isActive !== undefined) where.isActive = query.isActive;

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
      this.prisma.product.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async create(dto: CreateProductDto) {
    if (dto.sku) {
      const existing = await this.prisma.product.findUnique({ where: { sku: dto.sku } });
      if (existing) throw new BadRequestException('SKU already exists');
    }
    return this.prisma.product.create({
      data: {
        name: dto.name,
        sku: dto.sku,
        unit: dto.unit,
        pricePerUnit: dto.pricePerUnit,
        category: dto.category,
        description: dto.description,
        isActive: dto.isActive,
        lowStock: dto.lowStock,
      },
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    if (dto.sku) {
      const existing = await this.prisma.product.findFirst({
        where: { sku: dto.sku, id: { not: id } },
      });
      if (existing) throw new BadRequestException('SKU already exists');
    }
    return this.prisma.product.update({
      where: { id },
      data: { ...dto, hasLocalOverride: true },
    });
  }

  async clearOverride(id: string) {
    await this.findOne(id);
    return this.prisma.product.update({
      where: { id },
      data: { hasLocalOverride: false, syncConflict: false },
    });
  }
}
