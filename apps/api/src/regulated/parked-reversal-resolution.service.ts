import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";

/**
 * SA-089/SA-089a/SA-089b — B660 PR B: the OPERATOR resolution of a parked regulated-ledger
 * reversal (B681/SA-067(3) parked one because the sold line's box/piece axis could not be
 * classified — `regulated-ledger.service.ts`'s `parkReturnReversal`/`bookReversalChunk`). The
 * claim-first transaction shape mirrors `ParkedRestockResolutionService` exactly; the actual
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
   * ONE transaction: the conditional claim (`resolvedAt IS NULL` — the idempotency guard), the
   * Order row lock, the CANCELLED-return refusal, `RegulatedLedgerService.resolveParkedReversal`'s
   * classify/correct/book, and the `resolvedAt`/`resolvedById`/`unitsPerBoxSupplied`/
   * `resolvedReason`/`resolvedEntryId` stamp. An already-resolved row is a no-op
   * (`alreadyResolved`), another tenant's row is a 404, and a CANCELLED return is a 404 — same
   * ORDER as the restock service (claim FIRST, so a racing `cancel()` and this resolve contend
   * for the same row lock exactly like `cancel()`/`ParkedRestockResolutionService.resolve()`
   * do): `cancel()` deletes this return's UNRESOLVED parked rows (`unreverseReturnEntries`), so
   * if cancel commits first the claim matches 0 rows (nothing booked); if the claim wins,
   * cancel's delete waits on this transaction and the CANCELLED-return check below still
   * catches a cancel that does NOT delete the row on some other path.
   *
   * SA-089a(c)/SA-089b: `SELECT id FROM "Order" WHERE id = $orderId FOR UPDATE`, taken AFTER
   * the claim, inside this SAME transaction — the SAME lock the live create/cancel paths take
   * around their own read-then-book (`inline-returns.service.ts`'s `capture()`/`cancel()`, both
   * `Order FOR UPDATE` before touching the regulated ledger). Not an advisory lock: an advisory
   * lock (a SEPARATE session-level lock on its own dedicated connection) does not exclude a
   * `FOR UPDATE` row lock (a transactional lock on the same connection as the writes) — an
   * earlier version of this method took `withAdvisoryLock("order-merge", orderId)`, which would
   * have looked correct while providing NO real serialization against the live paths' own row
   * lock (caught in review before merge). `buildLineRemainingBalances`'s remaining is a SUM
   * over every SALE/REVERSAL row of one order line, not a single row, so this must be the whole
   * ORDER, never a `FOR UPDATE` on the sale row alone. Lock order stays acyclic: this method
   * locks Order only; `cancel()` locks Return then Order — never the reverse in either path.
   *
   * An `unresolvable` verdict (classifier still says legacy/unknown after the supplied pack)
   * throws a 409 `PARKED_REVERSAL_UNRESOLVABLE` — the throw rolls back the claim, leaving the
   * row parked and unresolved, exactly like the restock service's cancelled-return refusal.
   */
  async resolve(id: string, pack: number, reason: string, actor: { id: string }) {
    const tenantId = this.prisma.getTenantId();
    const result = await this.prisma.tenantTransaction(async (tx: any) => {
      const row = await tx.regulatedLedgerParkedReversal.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Parked reversal not found");
      if (row.resolvedAt) return { alreadyResolved: true as const, row };

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
        return {
          alreadyResolved: true as const,
          row: await tx.regulatedLedgerParkedReversal.findFirst({ where: { id } }),
        };
      }

      // SA-089b: the Order row lock, taken AFTER the claim — see the method doc above.
      await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${row.orderId} FOR UPDATE`;

      // The claim is held; now refuse a CANCELLED return — its goods were never kept, so a
      // reversal against it would misstate the filing, and cancel() would not undo it (it
      // only deletes an UNRESOLVED parked row, and this one is now resolved). Tenant-scoped
      // read, so another tenant's return is a 404 here too.
      const ret = await tx.return.findFirst({
        where: { id: row.returnId },
        select: { status: true },
      });
      if (!ret || ret.status === "CANCELLED") {
        throw new NotFoundException("Parked reversal not found");
      }

      const resolution = await this.ledger.resolveParkedReversal(
        tx,
        {
          returnId: row.returnId,
          orderId: row.orderId,
          orderItemId: row.orderItemId,
          saleEntryId: row.saleEntryId,
          returnedPieces: Number(row.returnedPieces),
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
    };
  }
}
