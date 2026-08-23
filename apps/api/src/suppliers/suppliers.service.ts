import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { geocodeAddress, GeocodeCoords } from "../common/geocode.util";
import { CreateSupplierDto } from "./dto/create-supplier.dto";
import { UpdateSupplierDto } from "./dto/update-supplier.dto";
import { ListSuppliersDto } from "./dto/list-suppliers.dto";

/** The subset of Supplier address fields needed to attempt a geocode. */
interface SupplierAddressInput {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

/**
 * True when an optional DTO field is present AND differs from the stored value.
 * A field the client omitted (`undefined`) is untouched, and null/"" are treated
 * alike so a blank stored value doesn't read as a change.
 */
function fieldChanged(next: string | undefined, current: string | null): boolean {
  return next !== undefined && next !== (current ?? "");
}

@Injectable()
export class SuppliersService {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Geocode a supplier address, best-effort — wraps the same shared `geocodeAddress`
   * util CustomersService uses. Unlike customer addresses, every Supplier address
   * field is optional, so this only attempts a geocode once all four parts are
   * present; otherwise it returns null without ever throwing or blocking the write.
   */
  private async geocodeIfPossible(addr: SupplierAddressInput): Promise<GeocodeCoords | null> {
    if (!addr.addressLine1 || !addr.city || !addr.state || !addr.zip) return null;
    const key = this.config.get<string>("googleMaps.apiKey") ?? "";
    return geocodeAddress(
      { line1: addr.addressLine1, city: addr.city, state: addr.state, zip: addr.zip },
      key,
      this.logger,
    );
  }

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
    // Geocode before the write — best-effort, never blocks supplier creation.
    const coords = await this.geocodeIfPossible(dto);
    return this.prisma.forTenant().supplier.create({ data: { ...dto, ...(coords ?? {}) } });
  }

  async update(id: string, dto: UpdateSupplierDto) {
    const existing = await this.findOne(id);

    // Only re-geocode when the incoming DTO actually CHANGES an address field —
    // clients resubmit the whole form on every save, so presence alone would
    // bill a geocode (and risk wiping lat/lng) for an unrelated edit. Merge with
    // the existing row so a partial edit (e.g. ZIP only) still geocodes with the
    // full address. Clear stale coords only when the address genuinely changed
    // but the new one fails to resolve, so old lat/lng never survive pointing at
    // an address that no longer applies.
    const addressChanged =
      fieldChanged(dto.addressLine1, existing.addressLine1) ||
      fieldChanged(dto.city, existing.city) ||
      fieldChanged(dto.state, existing.state) ||
      fieldChanged(dto.zip, existing.zip);
    const coords = addressChanged
      ? await this.geocodeIfPossible({
          addressLine1: dto.addressLine1 ?? existing.addressLine1,
          city: dto.city ?? existing.city,
          state: dto.state ?? existing.state,
          zip: dto.zip ?? existing.zip,
        })
      : null;

    return this.prisma.forTenant().supplier.update({
      where: { id },
      data: {
        ...dto,
        ...(addressChanged && { lat: null, lng: null }),
        ...(coords ?? {}),
      },
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
