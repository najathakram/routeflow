import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { OVERRIDE_STAMP_SELECT } from "../common/restriction-override-columns";
import { defaultSaleFulfilmentKind } from "../orders/default-sale-fulfilment";
import type { PrismaService } from "../prisma/prisma.service";
import type { HeldLine } from "../selling-restrictions/restriction-warning";
import { orderFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import type { SellableLinesArgs } from "../selling-restrictions/selling-restrictions.service";
import * as iGate from "./invoice-restriction-gate";

/**
 * Row 460 (SA-958 §3.1): UNVOID brings a dead sale back to life (VOID -> DRAFT), SA-272's case: a new sale of the WHOLE
 * document. Same shape as the order reopen (`orders.service.ts` `reopenOrder`):
 *   - `unvoidParams` (before any write): every catalog line of the invoice is judged on the STAFF channel, no delta, every
 *     line counted live (a VOID invoice's lines hold their pre-void stamps, which still cover: row 510 sticky coverage);
 *   - `lockedUnvoidHeld` (inside the tx, after `lockInvoiceRow`): the lines re-read under the lock; a line set that no
 *     longer matches what was judged is a 409, and the held lines are what the decision's `recheck` re-judges against.
 * The service keeps the choke-point CALL (`assertLinesSellable`, so the coverage ratchets see it). REOPEN (PAID -> DRAFT)
 * keeps a live sale live and is NOT judged here (SA-958).
 */
type Actor = Parameters<typeof iGate.whole>[3];
type Ack = iGate.Ack;

const HELD_SELECT = { id: true, productId: true, ...OVERRIDE_STAMP_SELECT } as const;
const asLive = (rows: readonly HeldLine[]): HeldLine[] => rows.map((r) => ({ ...r, status: null }));
const productsOf = (rows: ReadonlyArray<{ productId?: string | null }>) =>
  new Set(rows.flatMap((r) => (r.productId ? [r.productId] : [])));

export async function unvoidParams(
  prisma: Pick<PrismaService, "tenantFeatureConfig"> & {
    forTenant(): any;
    getTenantId(): string | null | undefined;
  },
  inv: { id: string; customerId: string; orderId?: string | null },
  actor: Actor,
  ack: Ack,
): Promise<{ params: SellableLinesArgs; judged: ReadonlySet<string> }> {
  const rows: HeldLine[] = await prisma
    .forTenant()
    .invoiceItem.findMany({ where: { invoiceId: inv.id }, select: HELD_SELECT });
  // An order-linked invoice is the same sale as its order: a counter / pickup order's invoice is judged at the store.
  // An order-less one is judged as the customer's NEXT order would be (L8, SA-958 A-1), as create and duplicate do.
  const tenant = iGate.tenantId(prisma);
  const sale = {
    fulfilmentKind: inv.orderId
      ? await orderFulfilmentKind(prisma.forTenant(), inv.orderId)
      : await defaultSaleFulfilmentKind(prisma, tenant, inv.customerId),
  };
  return {
    params: iGate.whole(tenant, inv.customerId, asLive(rows), actor, ack, sale),
    judged: productsOf(rows),
  };
}

/** Inside the tx, under the invoice lock: the lines as they are NOW, or a 409 when the judged set no longer holds. */
export async function lockedUnvoidHeld(
  tx: any,
  invoiceId: string,
  judged: ReadonlySet<string>,
): Promise<HeldLine[]> {
  const rows: HeldLine[] = await tx.invoiceItem.findMany({
    where: { invoiceId },
    select: HELD_SELECT,
  });
  const now = productsOf(rows);
  if (now.size !== judged.size || [...now].some((p) => !judged.has(p))) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: "The invoice changed while it was being restored. Refresh and try again.",
    });
  }
  return asLive(rows);
}
