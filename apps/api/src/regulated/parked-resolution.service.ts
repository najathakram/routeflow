import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { listParkedReversals } from "./parked-reversals";

/**
 * The OPERATOR resolution of a parked return reversal (Senior Architect ruling 2026-09-21). The operator
 * supplies only the PACK of the sold line; the reversal is booked from the row's stored `returnedPieces` and
 * its stored SALE row through `RegulatedLedgerService.reverseReturnEntries` (the SAME maths as the automatic
 * path, in its `resolution` mode). Nothing is retyped, and the supplied pack is stored ONLY on the parked row:
 * it is never written back onto an order line, invoice line or product, and no historical row is rewritten.
 */
@Injectable()
export class ParkedResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: RegulatedLedgerService,
    private readonly audit: AuditService,
  ) {}

  /** The tenant's unresolved parked reversals (oldest first), optionally for one category. */
  list(category?: string) {
    return listParkedReversals(this.prisma.forTenant(), { trackedCategoryId: category });
  }

  /**
   * Resolve one parked reversal. ONE transaction: the conditional claim (`resolvedAt IS NULL`: the idempotency
   * guard), the booking and the resolvedEntryId stamp commit together or not at all. Resolving an
   * already-resolved row is a no-op (`alreadyResolved: true`), never a second booking. A row of another
   * tenant is a 404 (tenant-scoped read, no existence leak).
   */
  async resolve(id: string, unitsPerBoxSupplied: number, actor: { id: string }) {
    const tenantId = this.prisma.getTenantId();
    const result = await this.prisma.tenantTransaction(async (tx: any) => {
      const row = await tx.regulatedLedgerParkedReversal.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Parked reversal not found");
      if (row.resolvedAt) return { alreadyResolved: true as const, row };

      const claim = await tx.regulatedLedgerParkedReversal.updateMany({
        where: { id, resolvedAt: null },
        data: { resolvedAt: new Date(), resolvedById: actor.id, unitsPerBoxSupplied },
      });
      if (claim.count === 0) {
        // Lost a race with a concurrent resolve: the winner booked it.
        return {
          alreadyResolved: true as const,
          row: await tx.regulatedLedgerParkedReversal.findFirst({ where: { id } }),
        };
      }

      const sale = await tx.regulatedSalesLedger.findFirst({ where: { id: row.saleEntryId } });
      const item = sale?.invoiceItemId
        ? await tx.invoiceItem.findFirst({
            where: { id: sale.invoiceItemId },
            select: { productId: true },
          })
        : null;
      if (!sale || !item?.productId) {
        // Nothing to book against: leave it parked (the throw rolls the claim back) so it keeps blocking.
        throw new UnprocessableEntityException(
          "This reversal cannot be resolved: the sale entry it points at no longer exists.",
        );
      }

      const entryId = randomUUID();
      const booked: number = await this.ledger.reverseReturnEntries({
        returnId: row.returnId,
        orderId: row.orderId,
        returnedByProduct: new Map([[item.productId, Number(row.returnedPieces)]]),
        resolution: { saleEntryId: row.saleEntryId, pack: unitsPerBoxSupplied, entryId },
        db: tx,
      });
      // The line's remaining was already 0 (closed elsewhere): nothing to book, so no entry to point at.
      const resolvedEntryId = booked > 0 ? entryId : null;
      await tx.regulatedLedgerParkedReversal.updateMany({
        where: { id },
        data: { resolvedEntryId },
      });
      return { alreadyResolved: false as const, row: { ...row, resolvedEntryId }, booked };
    });

    if (!result.alreadyResolved) {
      await this.audit.log({
        tenantId,
        userId: actor.id,
        action: "regulated_ledger.parked_resolved",
        entityType: "RegulatedLedgerParkedReversal",
        entityId: id,
        meta: {
          returnId: result.row.returnId,
          saleEntryId: result.row.saleEntryId,
          returnedPieces: Number(result.row.returnedPieces),
          unitsPerBoxSupplied,
          resolvedEntryId: result.row.resolvedEntryId,
          ...(result.booked === 0
            ? { note: "the line's remaining was already 0: resolved with nothing booked" }
            : {}),
        },
      });
    }
    return {
      alreadyResolved: result.alreadyResolved,
      resolvedEntryId: result.row.resolvedEntryId ?? null,
    };
  }
}
