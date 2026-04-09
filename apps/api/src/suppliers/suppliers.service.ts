import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
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
      this.prisma.forTenant().supplier.findMany({ where, skip, take: limit, orderBy: { name: "asc" } }),
      this.prisma.forTenant().supplier.count({ where }),
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
    const supplier = await this.prisma.forTenant().supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException("Supplier not found");
    return supplier;
  }

  async create(dto: CreateSupplierDto) {
    return this.prisma.forTenant().supplier.create({ data: { ...dto } });
  }

  async update(id: string, dto: UpdateSupplierDto) {
    await this.findOne(id);
    return this.prisma.forTenant().supplier.update({ where: { id }, data: { ...dto } });
  }

  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.forTenant().supplier.update({ where: { id }, data: { isActive: false } });
  }

  async remove(id: string) {
    await this.findOne(id);

    // VendorBill.supplierId and PurchaseOrder.supplierId are non-nullable —
    // we cannot null them out, so block deletion if any exist.
    const [billCount, poCount] = await Promise.all([
      this.prisma.forTenant().vendorBill.count({ where: { supplierId: id } }),
      this.prisma.forTenant().purchaseOrder.count({ where: { supplierId: id } }),
    ]);

    if (billCount > 0 || poCount > 0) {
      const parts: string[] = [];
      if (billCount > 0) parts.push(`${billCount} vendor bill${billCount !== 1 ? "s" : ""}`);
      if (poCount > 0) parts.push(`${poCount} purchase order${poCount !== 1 ? "s" : ""}`);
      throw new BadRequestException(
        `Cannot delete: supplier has ${parts.join(" and ")}. Delete those first, or deactivate the supplier instead.`,
      );
    }

    // Expense.supplierId and StockMovement.supplierId are nullable — safe to clear
    await this.prisma.$transaction([
      this.prisma.forTenant().expense.updateMany({ where: { supplierId: id }, data: { supplierId: null } }),
      this.prisma.forTenant().stockMovement.updateMany({ where: { supplierId: id }, data: { supplierId: null } }),
      this.prisma.forTenant().supplier.delete({ where: { id } }),
    ]);

    return { deleted: true };
  }
}
