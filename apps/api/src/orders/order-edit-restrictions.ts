import { ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { OVERRIDE_STAMP_SELECT, type OverrideStamp } from "../common/restriction-override-columns";
import type { PrismaService } from "../prisma/prisma.service";
import type { SaleFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import type { StaffWriteDecision } from "../selling-restrictions/restriction-warning";
import {
  sellableLinesForMergeEdit,
  sellableLinesForReplaceEdit,
  type EditItem,
  type EditLine,
  type ExistingLine,
  type LiveUnitsPerBox,
  type ReplaceActor,
} from "../selling-restrictions/order-edit-lines";
import {
  checkableProductIds,
  type ChannelPrincipal,
} from "../selling-restrictions/selling-restrictions.core";
import type {
  SellableLinesArgs,
  SellableLinesParams,
} from "../selling-restrictions/selling-restrictions.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { STORED_UNIT_LINE_SELECT } from "./unit-line-build";

/**
 * Selling restrictions at `OrdersService.updateOrderItems` (lane R 2a-7). The service keeps the
 * choke-point CALL (`assertLinesSellable`, literally in the method, so both coverage ratchets see it);
 * this module decides everything around it.
 *
 * The edit runs under a row lock in ONE transaction and the choke point uses its own pooled
 * connection, so it is called BEFORE the transaction on the lines read before the lock. A pre-lock
 * read can be stale under a concurrent edit, so the plan is RE-CHECKED inside the transaction against
 * the lock-time read the service already makes (`heldItems`): a pure recompute (no query) that refuses
 * with a retryable 409 when a product now needs a check the pre-lock judgment never made.
 *
 * Row 510: every edit is planned (the tenant switch no longer gates the staff channel), and the plan carries the
 * choke point's whole parameter set (`params`: the lines with their warning keys, the principal, the acknowledgement)
 * and, once the service has called it, the staff-write `decision`. The re-check ALSO re-judges the override under the
 * lock (`decision.recheck(heldItems)`: coverage and the acknowledged hash, a pure recompute), and `stamp` writes the
 * acknowledged stamps (and re-applies carried ones to recreated lines) inside the same transaction. In a tenant with no
 * active rule, `evaluate` ends after one indexed read.
 *
 * Known edges (fail closed or vanishingly narrow; pinned by review, not fixed here): a re-check refusal
 * rolls back the item writes but not the earlier `revertLinkedInvoicesForOrderEdit` (every in-tx guard
 * shares that shape); `heldItems` is tenant-scoped and `order.lineItems` is not, so a legacy NULL-tenant
 * line would refuse every retry (none exist); the catalog box size is read once, pre-lock.
 */

/** The `OrderItem` columns the edit decision reads; the service's lock-time read selects the same. */
export const EXISTING_LINE_SELECT = {
  id: true,
  productId: true,
  qty: true,
  boxes: true,
  pieces: true,
  unitsPerBox: true,
  status: true,
  // units_v1 (A1): the post-lock unit-resolution recompute needs the line's own snapshot.
  unitLabel: true,
  // Row 510: the override stamp the coverage test reads under the lock.
  ...OVERRIDE_STAMP_SELECT,
} as const;

/** `updateOrderItems`' LOCKED read (B709): plus every column the diff branch reads off an existing line. */
export const HELD_LINE_SELECT = {
  ...EXISTING_LINE_SELECT,
  ...STORED_UNIT_LINE_SELECT, // the stored unit snapshot the diff branch reads (master, units_v1)
  deliveredQty: true,
  invoicedQty: true,
  unitPrice: true,
  promoFreeUnits: true,
  overrideReason: true,
  authorChannel: true, // SA ruling #3418: carried onto a re-created line (editedLineAuthors)
} as const;

/** The `findMany` args of that LOCKED read, for one order. */
export const heldLinesOf = (orderId: string) =>
  ({ where: { orderId }, select: HELD_LINE_SELECT }) as const;

/** How `updateOrderItems` applies this payload for this principal (mirrors its branches). */
export type OrderEditMode = { kind: "merge" } | { kind: "replace"; actor: ReplaceActor };

export function orderEditMode(
  role: string | undefined,
  replaceAll: boolean | undefined,
  isDiffPayload: boolean,
): OrderEditMode {
  // SA-407: a buyer's per-line diff (a unit line's count / a removal) is merged like staff's.
  if (role === UserRole.CUSTOMER)
    return isDiffPayload ? { kind: "merge" } : { kind: "replace", actor: "buyer" };
  if (role === UserRole.DRIVER)
    return isDiffPayload ? { kind: "merge" } : { kind: "replace", actor: "driver" };
  return replaceAll === true ? { kind: "replace", actor: "staff" } : { kind: "merge" };
}

/** A lock-time line: the edit decision's columns plus (optionally) its override stamp. */
export type HeldEditLine = ExistingLine & Partial<OverrideStamp>;

export interface OrderEditRestrictionPlan {
  /** The choke point's parameters (the call site states the channel): the lines, each with its warning key, from the rows read BEFORE the lock. */
  params: SellableLinesArgs;
  /** The choke point's answer, set by the service (undefined when nothing came back). */
  decision?: StaffWriteDecision;
  /** Inside the transaction, after the lock-time read: refuses (409, retryable) when a product now needs a check, and re-judges the override. */
  assertHeld(lockTimeRows: readonly HeldEditLine[]): void;
  /** Inside the transaction, after the line writes: stamps the acknowledged lines and re-applies carried stamps. */
  stamp(tx: any, orderId: string): Promise<number>;
}

export async function planOrderEditRestrictions(
  prisma: Pick<PrismaService, "forTenant">,
  p: {
    tenantId: string;
    customerId: string;
    existing: readonly HeldEditLine[];
    items: readonly EditItem[];
    mode: OrderEditMode;
    /** Who is editing: the channel (a buyer's edit is judged at the portal) and the override right. */
    principal: ChannelPrincipal | null | undefined;
    fulfilmentKind: SaleFulfilmentKind;
    ack?: SellableLinesParams["ack"];
  },
): Promise<OrderEditRestrictionPlan> {
  const ids = [
    ...new Set(
      [...p.items.map((i) => i.productId), ...p.existing.map((l) => l.productId)].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const products: Array<{ id: string; unitsPerBox: number | null }> = ids.length
    ? await prisma.forTenant().product.findMany({
        where: { tenantId: p.tenantId, id: { in: ids } },
        select: { id: true, unitsPerBox: true },
      })
    : [];
  const live: LiveUnitsPerBox = new Map(products.map((r) => [r.id, r.unitsPerBox]));

  const linesFor = (rows: readonly ExistingLine[], keys?: string[]): EditLine[] =>
    p.mode.kind === "merge"
      ? sellableLinesForMergeEdit(rows, p.items, { liveUnitsPerBox: live, keys })
      : sellableLinesForReplaceEdit(rows, p.items, {
          actor: p.mode.actor,
          liveUnitsPerBox: live,
          keys,
        });

  const keys: string[] = [];
  const lines = linesFor(p.existing, keys);
  const judged = new Set(checkableProductIds(lines));
  const plan: OrderEditRestrictionPlan = {
    params: {
      tenantId: p.tenantId,
      customerId: p.customerId,
      lines: lines.map((l, i) => ({ ...l, lineKey: keys[i] })),
      fulfilmentKind: p.fulfilmentKind,
      principal: p.principal,
      ack: p.ack,
      held: p.existing,
      document: "ORDER",
    },
    assertHeld(lockTimeRows) {
      if (checkableProductIds(linesFor(lockTimeRows)).some((id) => !judged.has(id)))
        throw new ConflictException({
          code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
          message: "The order changed while your edit was being applied — review it and try again.",
        });
      plan.decision = plan.decision?.recheck(lockTimeRows);
    },
    stamp: async (tx, orderId) => (await plan.decision?.stamp(tx, orderId)) ?? 0,
  };
  return plan;
}

/**
 * A DRAFT edit skips the restriction plan only while the order has no live (non-VOID) linked invoice; the reconcile
 * after the edit copies the order's lines onto a SENT deposit mirror. That answer is read BEFORE the Order row lock, so
 * re-ask it under the lock: if a mirror appeared meanwhile (a concurrent bill with a deposit), the edit was never
 * judged, so refuse with the retryable 409 (the retry re-runs the pre-check and judges). Read-only.
 */
export async function assertNoMirrorAppearedUnderLock(
  tx: { invoice: { findFirst(args: any): Promise<any> } },
  orderId: string,
  // The PRE-lock answer: true when the pre-check already saw a live mirror (or the order is not a DRAFT), i.e. the
  // edit was judged (or the switch is off) on that basis. Only a mirror the pre-check did NOT see refuses here.
  precheckJudged: boolean,
  status: string | null | undefined,
): Promise<void> {
  if (precheckJudged || status !== "DRAFT") return;
  const live = await tx.invoice.findFirst({
    where: { orderId, status: { not: "VOID" } },
    select: { id: true },
  });
  if (live)
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order was billed while you were editing it — review it and try again.",
    });
}
