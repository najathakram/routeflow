import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { periodBucketOf } from "./period";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { retryTxBusy } from "../common/tx-retry";

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
    private readonly ledger: RegulatedLedgerService,
  ) {}

  /** The tenant's unresolved parked reversals, oldest first — same shape as the parked
   *  restocks list, listed on the same "resolve this before filing" surface. */
  async list() {
    if (!this.prisma.getTenantId())
      throw new BadRequestException("Parked reversals are tenant-scoped");
    const db = this.prisma.forTenant();
    const rows: any[] = await db.regulatedLedgerParkedReversal.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
    });
    // SA-193 (5) / #2108: tell the operator BEFORE resolving whether the park's own period is already
    // filed. Resolving then books in the CURRENT period with the park's date as originalSoldAt, and an
    // amended return may be required for `amendedPeriod.periodKey`. It is the SAME fold and the SAME
    // lookup as the resolution (the parked row's category plus every live row of the product), through
    // the ledger service's one helper.
    const out: any[] = [];
    for (const r of rows) {
      out.push({ ...r, amendedPeriod: (await this.ledger.filedPeriodForParked(db, r)) ?? null });
    }
    return out;
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
    // SA-773 row 333(b): the whole resolve is idempotent (its claim is a CAS on resolvedAt), so a deadlock or serialization
    // conflict re-runs it; exhausted retries are a coded, retryable 503 (nothing saved), never a raw 40P01 as an uncoded 500
    return retryTxBusy(
      `parked reversal resolve ${id}`,
      () => this.resolveOnce(id, pack, reason, actor),
      "Another change to this return was in progress. Nothing was saved; please retry.",
    );
  }

  private async resolveOnce(id: string, pack: number, reason: string, actor: { id: string }) {
    if (!this.prisma.getTenantId())
      throw new BadRequestException("Parked reversals are tenant-scoped");
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
          code: API_ERROR_CODES.PARKED_REVERSAL_UNRESOLVABLE,
          message: `Cannot resolve this parked reversal with pack ${pack}: ${resolution.unresolvableReason}`,
        });
      }

      await tx.regulatedLedgerParkedReversal.updateMany({
        where: { id },
        data: { resolvedEntryId: resolution.resolvedEntryId },
      });

      // SA-193 (6): the audit row is written INSIDE the transaction, so a failed audit write rolls the
      // whole resolution back instead of being logged and swallowed after commit (every piece, parked or
      // unbooked, is accounted for in this row, never silent). The tenant scope is injected by the tx.
      await tx.auditLog.create({
        data: {
          // explicit tenantId (SA-197 LOW): the ROW's own tenant, not the caller context's (the tx
          // extension also injects it); a tenant-less caller is refused above, so the two agree
          tenantId: row.tenantId,
          userId: actor.id,
          action: "regulated_ledger.parked_reversal_resolved",
          entityType: "RegulatedLedgerParkedReversal",
          entityId: id,
          meta: {
            returnId: row.returnId,
            saleEntryId: row.saleEntryId,
            orderItemId: row.orderItemId,
            parkReason: row.reason,
            unitsPerBoxSupplied: pack,
            verdictAfter: resolution.verdictAfter,
            correctionEntryId: resolution.correctionEntryId,
            returnedPieces: Number(row.returnedPieces),
            bookedPieces: resolution.bookedPieces,
            bookedQty: resolution.bookedQty,
            bookedNet: resolution.bookedNet,
            bookedTax: resolution.bookedTax,
            // SA-167: every piece is accounted for — "booked" alone is never reported when any
            // piece was parked on a further row or could not be booked.
            outcome: resolution.outcome,
            parkedPieces: resolution.parkedPieces,
            parkedRowIds: resolution.parkedRowIds,
            unbookedPieces: resolution.unbookedPieces,
            // SA-182: set when the parked period was already filed and the reversal went to the CURRENT
            // period instead — an amended return may be required for that period.
            amendedPeriod: resolution.amendedPeriod ?? null,
            grownParks: resolution.grownParks ?? [],
            resolvedEntryId: resolution.resolvedEntryId,
            periodBucket: row.periodBucket,
            operatorReason: reason,
          },
        },
      });

      return { alreadyResolved: false as const, row, resolution };
    });

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
      grownParks: result.alreadyResolved ? [] : (result.resolution.grownParks ?? []),
    };
  }
}
