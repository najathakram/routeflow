import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { latestEditRevisionNumber } from "./order-revisions";

/**
 * SA-422 (#2320) — a buyer order edit must never revive a seller-CANCELLED line.
 *
 * The CUSTOMER full-replace branch of `updateOrderItems` deletes and re-creates the order's catalog
 * lines from `{productId, qty}`. Before this, it also deleted CANCELLED rows (erasing the seller's
 * cancellation record and F07's reopen marks) and let a cancelled line decide a fresh add's
 * denomination — so re-sending a cancelled product brought it back as a pack line at pack price.
 *
 * Buyer branch: (1) the buyer's deleteMany keeps CANCELLED rows (service); (2) a payload item whose
 * product has at least one CANCELLED line and NO live line ⇒ 409 LINE_CANCELLED_BY_SELLER, before
 * any write — never a silent drop (a 200 that changes the buyer's stated intent is the B465 round-2
 * anti-pattern); a live line of the same product beside a cancelled one is an ordinary echo;
 * (3) the denomination sets are built from LIVE lines only (`liveLines`, service).
 * Diff path (a buyer after #2286 / SA-407, a DRIVER today): (4) any action other than CANCEL/DELETE
 * on a CANCELLED line's id ⇒ the same 409; CANCEL/DELETE on it ⇒ a no-op (idempotent strike-off).
 * Staff paths are out of scope (the staff replaceAll's own history loss is a separate B-id).
 */
export const LINE_CANCELLED_BY_SELLER = "LINE_CANCELLED_BY_SELLER";

interface LineLike {
  id: string;
  productId?: string | null;
  status?: string | null;
}
interface ItemLike {
  id?: string | null;
  productId?: string | null;
  action?: string | null;
  /** Carried by every edit item (unused by these rules; typed so real payloads fit, #1315). */
  qty?: number;
}
type Principal = { role?: string; sub?: string } | undefined;

const isCancelled = (l: { status?: string | null }): boolean => l.status === "CANCELLED";
const isStrikeOff = (i: ItemLike): boolean => i.action === "CANCEL" || i.action === "DELETE";

/** SA-422 (3): the live lines — the only ones that may decide a fresh add's denomination. */
export const liveLines = <T extends { status?: string | null }>(lines: readonly T[]): T[] =>
  lines.filter((l) => !isCancelled(l));

/** Products with at least one CANCELLED line and no live line on the order. */
export function sellerCancelledOnly(lines: readonly LineLike[]): Set<string> {
  const live = new Set(liveLines(lines).map((l) => l.productId));
  return new Set(
    lines
      .filter((l) => isCancelled(l) && l.productId && !live.has(l.productId))
      .map((l) => l.productId as string),
  );
}

/** The first payload item SA-422 refuses, with the product it names — or null. */
function refusedItem(
  lines: readonly LineLike[],
  items: readonly ItemLike[],
  principal: Principal,
  isDiff: boolean,
): { productId: string } | null {
  if (principal?.role === "CUSTOMER" && !isDiff) {
    const cancelledOnly = sellerCancelledOnly(lines);
    const hit = items.find((i) => i.productId && cancelledOnly.has(i.productId));
    return hit ? { productId: hit.productId as string } : null;
  }
  if ((principal?.role === "CUSTOMER" || principal?.role === "DRIVER") && isDiff) {
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const i of items) {
      const line = i.id ? byId.get(i.id) : undefined;
      if (line && isCancelled(line) && !isStrikeOff(i)) return { productId: line.productId ?? "" };
    }
  }
  return null;
}

const refusal = (productId: string, name: string | null) =>
  new ConflictException({
    code: LINE_CANCELLED_BY_SELLER,
    productId,
    message: `Your supplier removed ${name ?? "this product"} from this order — ask them to add it back.`,
  });

/** A buyer must own the order before this module names a product on it OR reads it back (SA-422a). */
async function assertBuyerOwns(
  prisma: Pick<PrismaService, "forTenant">,
  principal: Principal,
  customerId: string,
): Promise<void> {
  if (principal?.role !== "CUSTOMER") return;
  const owner = await prisma
    .forTenant()
    .customer.findFirst({ where: { userId: principal.sub, deletedAt: null } });
  if (!owner || owner.id !== customerId) throw new ForbiddenException();
}

/**
 * SA-422 (2)+(4) before any write (call it before the linked-invoice revert). Throws the 409; for a
 * non-staff diff it drops CANCEL/DELETE entries aimed at an already-CANCELLED line from `dto.items`
 * (mutating, like `classifyEditPayload`). `noop` = the diff held nothing else, so the edit writes
 * nothing at all. A buyer's ownership is settled FIRST — before the refusal (it names a product on
 * THIS order) and before a no-op (the caller then reads THIS order back): SA-422a. A payload that
 * also carries an `inlineReturn` is never a no-op — the return must still run (Opus N1).
 */
export async function planCancelledLines(
  prisma: Pick<PrismaService, "forTenant">,
  order: { customerId: string; lineItems: readonly LineLike[] },
  dto: UpdateOrderItemsDto,
  principal: Principal,
  isDiff: boolean,
): Promise<{ noop: boolean }> {
  const items = (dto.items ?? []) as ItemLike[];
  const hit = refusedItem(order.lineItems, items, principal, isDiff);
  if (hit) {
    await assertBuyerOwns(prisma, principal, order.customerId);
    const product = hit.productId
      ? await prisma
          .forTenant()
          .product.findFirst({ where: { id: hit.productId }, select: { name: true } })
      : null;
    throw refusal(hit.productId, product?.name ?? null);
  }
  const nonStaffDiff = isDiff && (principal?.role === "CUSTOMER" || principal?.role === "DRIVER");
  if (!nonStaffDiff || items.length === 0) return { noop: false };
  const cancelledIds = new Set(order.lineItems.filter(isCancelled).map((l) => l.id));
  const kept = items.filter((i) => !(i.id && cancelledIds.has(i.id) && isStrikeOff(i)));
  if (kept.length === items.length) return { noop: false };
  dto.items = kept as UpdateOrderItemsDto["items"];
  if (kept.length > 0) return { noop: false };
  await assertBuyerOwns(prisma, principal, order.customerId); // SA-422a: never read back a foreign order
  return { noop: !dto.inlineReturn }; // Opus N1: an inline return still runs (with no line edits)
}

/**
 * The same rules re-checked against the lock-time rows (`heldItems`): a seller may have cancelled a
 * product's last live line while this edit waited on the lock. Pure; ownership was settled above.
 */
export function assertHeldCancelledLines(
  held: readonly LineLike[],
  items: readonly ItemLike[] | undefined,
  principal: Principal,
  isDiff: boolean,
): void {
  const hit = refusedItem(held, items ?? [], principal, isDiff);
  if (hit) throw refusal(hit.productId, null);
}

/**
 * `updateOrderItems`'s response shape: the order with its lines (creation order) and products, plus the
 * `revisionNumber` the edit just produced (row 372) — the web caches this response, and an editor re-opened
 * before the refetch lands must be based on it, not on a missing revision.
 */
export async function readEditedOrder(prisma: Pick<PrismaService, "forTenant">, orderId: string) {
  const db = prisma.forTenant();
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { id: true, businessName: true, contactName: true } },
      lineItems: {
        include: { product: { select: { id: true, name: true, unit: true } } },
        // Stable creation order so newly added items appear at the bottom.
        orderBy: { createdAt: "asc" },
      },
      transaction: true,
    },
  });
  return order ? { ...order, revisionNumber: await latestEditRevisionNumber(db, orderId) } : order;
}
