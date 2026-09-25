import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { bookRestockMovement } from "./returns-restock.util";

/**
 * The OPERATOR resolution of a parked STANDARD-return restock (B665 follow-up, Senior Architect ruling
 * 2026-09-21). receive() parked the item because the sold line's pack was unknown: no stock movement was
 * booked. The operator supplies only the PACK; the restock is the stored `returnedQty` (in the line's own
 * unit) x that pack, booked through the SAME `bookRestockMovement` writer as receive(), so `cancel()` undoes
 * it like any other RET-<id> movement. The pack is stored only on the parked row: never written back to a
 * line or product. Independent of any regulated addon.
 */
@Injectable()
export class ParkedRestockResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The tenant's unresolved parked restocks, oldest first. */
  list() {
    if (!this.prisma.getTenantId())
      throw new BadRequestException("Parked restocks are tenant-scoped");
    // (the model exists once the ledger migration's schema is generated; `any` until then, like the writer)
    return (this.prisma.forTenant() as any).returnParkedRestock.findMany({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * ONE transaction: the conditional claim (`resolvedAt IS NULL`: the idempotency guard), the CANCELLED-return
   * refusal, the stock movement + increment, and the resolvedMovementId stamp. An already-resolved row is a
   * no-op (`alreadyResolved`), another tenant's row is a 404, and a CANCELLED return is a 404.
   *
   * ORDER MATTERS, and the claim deliberately comes FIRST. `cancel()` deletes this return's unresolved
   * parked rows (`resolvedAt: null`), so the claim's UPDATE and that DELETE contend for the SAME row lock:
   * if cancel committed first the row is gone and the claim matches 0 rows (nothing is booked); if the claim
   * wins, cancel's delete waits on this transaction. The status re-read then happens INSIDE the same
   * transaction, after the claim, so a return cancelled by any path that does NOT delete the parked row is
   * still refused and the throw rolls the claim back with it. Checking before the transaction, or outside
   * it, would leave a window where a stock movement is booked onto a cancelled return.
   */
  async resolve(id: string, unitsPerBoxSupplied: number, actor: { id: string }) {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("Parked restocks are tenant-scoped");
    const result = await this.prisma.tenantTransaction(async (tx: any) => {
      const row = await tx.returnParkedRestock.findFirst({ where: { id } });
      if (!row) throw new NotFoundException("Parked restock not found");
      if (row.resolvedAt) return { alreadyResolved: true as const, row };

      const claim = await tx.returnParkedRestock.updateMany({
        where: { id, resolvedAt: null },
        data: { resolvedAt: new Date(), resolvedById: actor.id, unitsPerBoxSupplied },
      });
      if (claim.count === 0) {
        return {
          alreadyResolved: true as const,
          row: await tx.returnParkedRestock.findFirst({ where: { id } }),
        };
      }

      // The claim is held; now refuse a CANCELLED return. A cancelled return's goods were never kept, so
      // restocking them would inflate stock with no offsetting movement — and `cancel()` would not undo it,
      // because it only removes movements that existed when it ran. The throw rolls the claim back, leaving
      // the row parked and unresolved. Tenant-scoped read, so another tenant's return is a 404 here too.
      const ret = await tx.return.findFirst({
        where: { id: row.returnId },
        select: { status: true },
      });
      if (!ret || ret.status === "CANCELLED") {
        throw new NotFoundException("Parked restock not found");
      }

      const pieces = new Prisma.Decimal(row.returnedQty).mul(unitsPerBoxSupplied);
      const movementId = await bookRestockMovement(tx, {
        returnId: row.returnId,
        productId: row.productId,
        pieces,
        userId: actor.id,
      });
      await tx.returnParkedRestock.updateMany({
        where: { id },
        data: { resolvedMovementId: movementId },
      });
      return { alreadyResolved: false as const, row, pieces, movementId };
    });

    if (!result.alreadyResolved) {
      await this.audit.log({
        tenantId,
        userId: actor.id,
        action: "return_restock.parked_resolved",
        entityType: "ReturnParkedRestock",
        entityId: id,
        meta: {
          returnId: result.row.returnId,
          returnItemId: result.row.returnItemId,
          productId: result.row.productId,
          returnedQty: Number(result.row.returnedQty),
          unitsPerBoxSupplied,
          pieces: Number(result.pieces),
          resolvedMovementId: result.movementId,
        },
      });
    }
    return {
      alreadyResolved: result.alreadyResolved,
      resolvedMovementId: result.alreadyResolved
        ? (result.row?.resolvedMovementId ?? null)
        : result.movementId,
    };
  }
}
