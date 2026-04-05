import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { ListSuppliersDto } from "./dto/list-suppliers.dto";

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListSuppliersDto) {
    const page = Number(query.page ?? 1);
    const limitRaw = Number(query.limit ?? 20);
    const fetchAll = limitRaw === 0;
    const limit = fetchAll ? 100_000 : limitRaw;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { contactName: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.isActive !== undefined) where.isActive = query.isActive;

    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, skip, take: limit, orderBy: { name: "asc" } }),
      this.prisma.supplier.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page: fetchAll ? 1 : page,
        limit: fetchAll ? total : limit,
        totalPages: fetchAll ? 1 : Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException("Supplier not found");
    return supplier;
  }

  async create(dto: CreateSupplierDto) {
    return this.prisma.supplier.create({ data: { ...dto } });
  }

  async update(id: string, dto: UpdateSupplierDto) {
    await this.findOne(id);
    return this.prisma.supplier.update({ where: { id }, data: { ...dto } });
  }

  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.supplier.update({ where: { id }, data: { isActive: false } });
  }

  async remove(id: string) {
    await this.findOne(id);
    // Null out supplierId on related records before deleting to avoid FK violations
    await this.prisma.$transaction([
      this.prisma.expense.updateMany({ where: { supplierId: id }, data: { supplierId: null as any } }),
      this.prisma.vendorBill.updateMany({ where: { supplierId: id }, data: { supplierId: null as any } }),
      this.prisma.purchaseOrder.updateMany({ where: { supplierId: id }, data: { supplierId: null as any } }),
      this.prisma.stockMovement.updateMany({ where: { supplierId: id }, data: { supplierId: null as any } }),
      this.prisma.supplier.delete({ where: { id } }),
    ]);
    return { deleted: true };
  }
}
