import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ListLedgerDto } from "./dto/list-ledger.dto";

/**
 * Phase 4 (W5): read side of the regulated sales ledger — aggregates per category
 * + period for the compliance hub + filings. Amounts are pre-signed (REVERSAL
 * negative) so a plain _sum nets to the reportable figure.
 */
@Injectable()
export class RegulatedService {
  constructor(private readonly prisma: PrismaService) {}

  async getLedger(query: ListLedgerDto, opts?: { exclusiveTo?: boolean }) {
    const where: any = {};
    if (query.category) where.trackedCategoryId = query.category;
    // from/to filter by TRANSACTION date (soldAt): a SALE at its issue date, a
    // REVERSAL at the void date. This is consistent with periodBucket (also
    // derived from soldAt), so grouping by periodBucket over a full-month range
    // nets each period's booked activity. A partial range is a transaction-date
    // window, NOT a guarantee that cross-period reversals net within it.
    //
    // `to` is INCLUSIVE (.lte) for the user-facing /ledger endpoint. Filings pass
    // exclusiveTo=true to get an exact half-open [from, to) window — a plain `.lt`
    // is precision-exact at any granularity (a sub-millisecond boundary sale is
    // never silently dropped, unlike a `to − 1ms` + `.lte` reconstruction).
    if (query.from || query.to) {
      where.soldAt = {};
      if (query.from) where.soldAt.gte = new Date(query.from);
      if (query.to) {
        if (opts?.exclusiveTo) where.soldAt.lt = new Date(query.to);
        else where.soldAt.lte = new Date(query.to);
      }
    }

    // RF-3: optionally add the subcategory as an extra grouping dimension. Default
    // (bySubcategory unset) keeps the exact section+period grouping — byte-identical.
    const by: ("trackedCategoryId" | "periodBucket" | "trackedSubcategoryId")[] =
      query.bySubcategory
        ? ["trackedCategoryId", "trackedSubcategoryId", "periodBucket"]
        : ["trackedCategoryId", "periodBucket"];

    const grouped = await this.prisma.forTenant().regulatedSalesLedger.groupBy({
      by,
      where,
      _sum: { qty: true, unitBasisQty: true, netSales: true, categoryTax: true },
      orderBy: [{ periodBucket: "desc" }],
    });

    const catIds = [...new Set(grouped.map((g: any) => g.trackedCategoryId))] as string[];
    const cats =
      catIds.length > 0
        ? await this.prisma.forTenant().trackedCategory.findMany({
            where: { id: { in: catIds } },
            select: { id: true, name: true },
          })
        : [];
    const nameById = new Map<string, string>(cats.map((c: any) => [c.id, c.name]));

    // RF-3: resolve subcategory names only when grouping by them (reporting label).
    const subIds = query.bySubcategory
      ? ([...new Set(grouped.map((g: any) => g.trackedSubcategoryId).filter(Boolean))] as string[])
      : [];
    const subs =
      subIds.length > 0
        ? await this.prisma.forTenant().trackedSubcategory.findMany({
            where: { id: { in: subIds } },
            select: { id: true, name: true },
          })
        : [];
    const subNameById = new Map<string, string>(subs.map((s: any) => [s.id, s.name]));

    const rows = grouped.map((g: any) => ({
      trackedCategoryId: g.trackedCategoryId,
      categoryName: nameById.get(g.trackedCategoryId) ?? "—",
      // Only surface the subcategory keys when the caller asked to break down by them,
      // so the default response shape is unchanged.
      ...(query.bySubcategory
        ? {
            trackedSubcategoryId: g.trackedSubcategoryId ?? null,
            subcategoryName: g.trackedSubcategoryId
              ? (subNameById.get(g.trackedSubcategoryId) ?? "—")
              : null,
          }
        : {}),
      periodBucket: g.periodBucket,
      qty: Number(g._sum.qty ?? 0),
      unitBasisQty: Number(g._sum.unitBasisQty ?? 0),
      netSales: Number(g._sum.netSales ?? 0),
      categoryTax: Number(g._sum.categoryTax ?? 0),
    }));

    const totals = rows.reduce(
      (t, r) => ({
        qty: t.qty + r.qty,
        netSales: t.netSales + r.netSales,
        categoryTax: t.categoryTax + r.categoryTax,
      }),
      { qty: 0, netSales: 0, categoryTax: 0 },
    );

    return { rows, totals };
  }
}
