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
      this.prisma
        .forTenant()
        .supplier.findMany({ where, skip, take: limit, orderBy: { name: "asc" } }),
      this.prisma.forTenant().supplier.count({ where }),
    ]);

    // Aggregate outstanding balances from vendor bills (non-voided) per supplier
    const supplierIds = data.map((s) => s.id).filter(Boolean);
    const balanceMap: Record<string, { totalOwed: number; totalPaid: number; billCount: number }> =
      {};
    if (supplierIds.length > 0) {
      const billAgg = await this.prisma.forTenant().vendorBill.groupBy({
        by: ["supplierId"],
        where: { supplierId: { in: supplierIds }, status: { not: "VOID" } },
        _sum: { totalOwed: true, totalPaid: true },
        _count: { id: true },
      });
      for (const row of billAgg) {
        if (row.supplierId) {
          balanceMap[row.supplierId] = {
            totalOwed: Number(row._sum.totalOwed ?? 0),
            totalPaid: Number(row._sum.totalPaid ?? 0),
            billCount: row._count.id,
          };
        }
      }
    }

    const enriched = data.map((s) => {
      const agg = balanceMap[s.id] ?? { totalOwed: 0, totalPaid: 0, billCount: 0 };
      return {
        ...s,
        totalOwed: agg.totalOwed,
        totalPaid: agg.totalPaid,
        outstandingBalance: Math.max(0, agg.totalOwed - agg.totalPaid),
        billCount: agg.billCount,
      };
    });

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
    const supplier = await this.prisma.forTenant().supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException("Supplier not found");
    return supplier;
  }

  async create(dto: CreateSupplierDto) {
    return this.prisma.forTenant().supplier.create({
      // "" from the defaultTerms select means "no default" — store it as null
      // rather than an empty string so every other reader can use a plain
      // truthy check (`supplier.defaultTerms ? … : …`).
      data: { ...dto, defaultTerms: dto.defaultTerms === "" ? null : dto.defaultTerms },
    });
  }

  async update(id: string, dto: UpdateSupplierDto) {
    await this.findOne(id);
    return this.prisma.forTenant().supplier.update({
      where: { id },
      data: { ...dto, defaultTerms: dto.defaultTerms === "" ? null : dto.defaultTerms },
    });
  }

  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.forTenant().supplier.update({ where: { id }, data: { isActive: false } });
  }

  async remove(id: string) {
    await this.findOne(id);

    // VendorBill.supplierId, PurchaseOrder.supplierId and SupplierCredit.supplierId are
    // non-nullable (the credit FK is ON DELETE RESTRICT) — we cannot null them out, so
    // block deletion if any exist rather than letting Postgres raise a raw FK violation.
    const [billCount, poCount, creditCount] = await Promise.all([
      this.prisma.forTenant().vendorBill.count({ where: { supplierId: id } }),
      this.prisma.forTenant().purchaseOrder.count({ where: { supplierId: id } }),
      this.prisma.forTenant().supplierCredit.count({ where: { supplierId: id } }),
    ]);

    if (billCount > 0 || poCount > 0 || creditCount > 0) {
      const parts: string[] = [];
      if (billCount > 0) parts.push(`${billCount} vendor bill${billCount !== 1 ? "s" : ""}`);
      if (poCount > 0) parts.push(`${poCount} purchase order${poCount !== 1 ? "s" : ""}`);
      if (creditCount > 0)
        parts.push(`${creditCount} on-account credit${creditCount !== 1 ? "s" : ""}`);
      throw new BadRequestException(
        `Cannot delete: supplier has ${parts.join(" and ")}. Delete those first, or deactivate the supplier instead.`,
      );
    }

    // Expense.supplierId and StockMovement.supplierId are nullable — safe to clear
    await this.prisma.$transaction([
      this.prisma
        .forTenant()
        .expense.updateMany({ where: { supplierId: id }, data: { supplierId: null } }),
      this.prisma
        .forTenant()
        .stockMovement.updateMany({ where: { supplierId: id }, data: { supplierId: null } }),
      this.prisma.forTenant().supplier.delete({ where: { id } }),
    ]);

    return { deleted: true };
  }
}
