import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";

/**
 * SA-089/SA-089a/SA-089b — B660 PR B: the OPERATOR resolution of a parked regulated-ledger
 * reversal (B681/SA-067(3) parked one because the sold line's box/piece axis could not be
 * classified — `regulated-ledger.service.ts`'s `parkReturnReversal`/`bookReversalChunk`). The
 * transaction shape (Return then Order row locks, then the conditional claim) follows
 * `ParkedRestockResolutionService`, with the lock order made explicit; the actual
 * money math (classify → correct → book) lives on `RegulatedLedgerService.resolveParkedReversal`
 * — both `buildLineRemainingBalances` and `bookReversalChunk` are PRIVATE to that class
 * (SA-090), so the resolution logic lives there rather than duplicating either.
 */
@Injectable()
export class ParkedReversalResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: RegulatedLedgerService,
  ) {}

  /** The tenant's unresolved parked reversals, oldest first — same shape as the parked
   *  restocks list, listed on the same "resolve this before filing" surface. */
  list() {
    return this.prisma.forTenant().regulatedLedgerParkedReversal.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * ONE transaction: the Return and Order row locks, the CANCELLED-return refusal, the conditional
   * claim (`resolvedAt IS NULL` — the idempotency guard), `RegulatedLedgerService.resolveParkedReversal`'s
   * classify/correct/book, and the `resolvedAt`/`resolvedById`/`unitsPerBoxSupplied`/
   * `resolvedReason`/`resolvedEntryId` stamp. An already-resolved row is a no-op (`alreadyResolved`),
   * another tenant's row is a 404, and a CANCELLED return is a 404. The locks come FIRST, so a racing
   * `cancel()` (which deletes this return's UNRESOLVED parked rows via `unreverseReturnEntries`) and this
   * resolve serialise on the Return row: if cancel commits first this sees a CANCELLED return or a missing
   * row (404, nothing booked); if this wins, cancel waits for this transaction.
   *
   * SA-089a(c)/SA-167(2)/SA-170: the locks are `Return` FOR UPDATE, then `Order` FOR UPDATE (the source
   * order this row belongs to), then the conditional claim — all inside this SAME transaction. That is
   * the order `cancel()` takes (it claims the Return row, locks the CARRYING order, then deletes parked
   * rows), so the two never wait on each other in a cycle; the Return lock is what excludes a concurrent
   * cancel() (whose carrying order may differ from the source order), and the Order lock excludes the
   * live create/capture paths' own `Order FOR UPDATE` around their read-then-book. Row locks, not an
   * advisory lock (an advisory lock does not exclude a `FOR UPDATE` row lock); the Order lock covers the
   * WHOLE order because `buildLineRemainingBalances`'s remaining is a SUM over every SALE/REVERSAL row of
   * an order line. With the Return locked, a CANCELLED return, or a row cancel() deleted meanwhile, is a
   * 404 — never `alreadyResolved`, and never a resolution booked against a return whose REVERSAL rows
   * cancel() already removed.
   *
   * An `unresolvable` verdict (classifier still says legacy/unknown after the supplied pack)
   * throws a 409 `PARKED_REVERSAL_UNRESOLVABLE` — the throw rolls back the claim, leaving the
   * row parked and unresolved, exactly like the restock service's cancelled-return refusal.
   */
  async resolve(id: string, pack: number, reason: string, actor: { id: string }) {
    const tenantId = this.prisma.getTenantId();
    const result = await this.prisma.tenantTransaction(async (tx: any) => {
      const peek = await tx.regulatedLedgerParkedReversal.findFirst({ where: { id } });
      if (!peek) throw new NotFoundException("Parked reversal not found");

      // SA-167(2)/SA-170, amends SA-089b: lock order is Return -> Order -> parked row, the SAME
      // order `cancel()` takes (it claims the Return row, then locks the CARRYING order — which may
      // be a different order from the source order this row belongs to — then deletes parked rows).
      // The Return lock is what excludes a concurrent cancel(); the Order lock (the source order)
      // excludes the live create/capture paths. A row cancel() deleted meanwhile is a 404, never
      // "already resolved".
      await tx.$executeRaw`SELECT id FROM "Return" WHERE id = ${peek.returnId} FOR UPDATE`;
      await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${peek.orderId} FOR UPDATE`;
      const row = await tx.regulatedLedgerParkedReversal.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Parked reversal not found");
      if (row.resolvedAt) return { alreadyResolved: true as const, row };

      // With the Return locked, a CANCELLED return is final: its goods were never kept, so a
      // reversal against it would misstate the filing (and cancel() has already deleted its
      // REVERSAL rows and unresolved parked rows — resolving now would resurrect both). Tenant-scoped
      // read, so another tenant's return is a 404 here too.
      const ret = await tx.return.findFirst({
        where: { id: row.returnId },
        select: { status: true },
      });
      if (!ret || ret.status === "CANCELLED") {
        throw new NotFoundException("Parked reversal not found");
      }

      const claim = await tx.regulatedLedgerParkedReversal.updateMany({
        where: { id, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedById: actor.id,
          unitsPerBoxSupplied: pack,
          resolvedReason: reason,
        },
      });
      if (claim.count === 0) {
        const again = await tx.regulatedLedgerParkedReversal.findFirst({ where: { id } });
        if (!again) throw new NotFoundException("Parked reversal not found");
        return { alreadyResolved: true as const, row: again };
      }

      const resolution = await this.ledger.resolveParkedReversal(
        tx,
        {
          returnId: row.returnId,
          orderId: row.orderId,
          orderItemId: row.orderItemId,
          saleEntryId: row.saleEntryId,
          returnedPieces: Number(row.returnedPieces),
          // SA-182: the row's own period and the return's date (when it parked).
          periodBucket: row.periodBucket,
          parkedAt: row.createdAt,
        },
        pack,
      );

      if (resolution.outcome === "unresolvable") {
        throw new ConflictException({
          code: "PARKED_REVERSAL_UNRESOLVABLE",
          message: `Cannot resolve this parked reversal with pack ${pack}: ${resolution.unresolvableReason}`,
        });
      }

      await tx.regulatedLedgerParkedReversal.updateMany({
        where: { id },
        data: { resolvedEntryId: resolution.resolvedEntryId },
      });

      return { alreadyResolved: false as const, row, resolution };
    });

    if (!result.alreadyResolved) {
      await this.audit.log({
        tenantId,
        userId: actor.id,
        action: "regulated_ledger.parked_reversal_resolved",
        entityType: "RegulatedLedgerParkedReversal",
        entityId: id,
        meta: {
          returnId: result.row.returnId,
          saleEntryId: result.row.saleEntryId,
          orderItemId: result.row.orderItemId,
          parkReason: result.row.reason,
          unitsPerBoxSupplied: pack,
          verdictAfter: result.resolution.verdictAfter,
          correctionEntryId: result.resolution.correctionEntryId,
          returnedPieces: Number(result.row.returnedPieces),
          bookedPieces: result.resolution.bookedPieces,
          bookedQty: result.resolution.bookedQty,
          bookedNet: result.resolution.bookedNet,
          bookedTax: result.resolution.bookedTax,
          // SA-167: every piece is accounted for — "booked" alone is never reported when any
          // piece was parked on a further row or could not be booked.
          outcome: result.resolution.outcome,
          parkedPieces: result.resolution.parkedPieces,
          parkedRowIds: result.resolution.parkedRowIds,
          unbookedPieces: result.resolution.unbookedPieces,
          // SA-182: set when the parked period was already filed and the reversal went to the CURRENT
          // period instead — an amended return may be required for that period.
          amendedPeriod: result.resolution.amendedPeriod ?? null,
          resolvedEntryId: result.resolution.resolvedEntryId,
          periodBucket: result.row.periodBucket,
          operatorReason: reason,
        },
      });
    }
    return {
      alreadyResolved: result.alreadyResolved,
      outcome: result.alreadyResolved ? null : result.resolution.outcome,
      resolvedEntryId: result.alreadyResolved
        ? (result.row?.resolvedEntryId ?? null)
        : result.resolution.resolvedEntryId,
      // The full resolution, not just the outcome (SA-167): the operator surface and the DB lane read
      // the verdict after correction and every booked/parked/unbooked figure. null on a replay.
      correctionEntryId: result.alreadyResolved ? null : result.resolution.correctionEntryId,
      verdictAfter: result.alreadyResolved ? null : result.resolution.verdictAfter,
      bookedPieces: result.alreadyResolved ? null : result.resolution.bookedPieces,
      bookedQty: result.alreadyResolved ? null : result.resolution.bookedQty,
      bookedNet: result.alreadyResolved ? null : result.resolution.bookedNet,
      bookedTax: result.alreadyResolved ? null : result.resolution.bookedTax,
      parkedPieces: result.alreadyResolved ? null : result.resolution.parkedPieces,
      parkedRowIds: result.alreadyResolved ? [] : result.resolution.parkedRowIds,
      unbookedPieces: result.alreadyResolved ? null : result.resolution.unbookedPieces,
      amendedPeriod: result.alreadyResolved ? null : (result.resolution.amendedPeriod ?? null),
    };
  }
}
