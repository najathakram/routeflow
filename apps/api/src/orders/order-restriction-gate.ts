import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { OVERRIDE_STAMP_SELECT } from "../common/restriction-override-columns";
import { saleFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import type {
  GateLine,
  HeldLine,
  StaffWriteDecision,
} from "../selling-restrictions/restriction-warning";
import type { ChannelPrincipal } from "../selling-restrictions/selling-restrictions.core";
import type {
  SellableLinesArgs,
  SellableLinesParams,
} from "../selling-restrictions/selling-restrictions.service";
import type { ChangeRequestFacts } from "../selling-restrictions/order-edit-lines";
import type { PrismaService } from "../prisma/prisma.service";
import {
  planChangeRequestRestrictions,
  type ChangeRequestRestrictionPlan,
} from "./change-request-restrictions";
import {
  orderEditMode,
  planOrderEditRestrictions,
  type HeldEditLine,
  type OrderEditRestrictionPlan,
} from "./order-edit-restrictions";

/**
 * Row 510: the parameter builders and the under-the-lock half of the staff restriction gate for the order writers that
 * judge a whole order (create, the DRAFT promotion, reopen, the fulfil-path switch). The services keep the choke-point
 * CALL (`assertLinesSellable`, so the coverage ratchets see it); everything around it lives here, which keeps
 * `orders.service.ts` flat (size-ratchet). The edit paths have their own plans (order-edit-restrictions.ts,
 * change-request-restrictions.ts). Imported as a namespace (`import * as rGate`), like `driverAccess` / `unitAware`.
 */

export { stampOverrideNames } from "../common/restriction-override-names";
export type Decision = StaffWriteDecision;
export type Ack = SellableLinesParams["ack"];
export type Args = SellableLinesArgs;
type User = JwtPayload | undefined;

/**
 * Tenant scope for the selling-restrictions choke point: the row being written's own tenant when there is one
 * (authoritative for an existing order), else the caller's, else the ambient one. None of them means the check cannot
 * be evaluated — refuse (fail closed, 403) rather than skip: a tenant-less caller must act inside a tenant-scoped
 * session.
 */
export function tenantId(
  prisma: { getTenantId(): string | null | undefined },
  user: User,
  rowTenantId?: string | null,
): string {
  const id = rowTenantId ?? user?.tenantId ?? prisma.getTenantId();
  if (id) return id;
  throw new ForbiddenException("Selling restrictions require a tenant-scoped session");
}

/** `create()`: one warned line per payload entry, keyed by its index in `dto.items`. */
export function create(a: {
  tenant: string;
  customerId: string;
  user: ChannelPrincipal & { sub?: string };
  lineItemsData: ReadonlyArray<{ productId?: string | null }>;
  fulfillPath: string | null | undefined;
  /** The internal create options (`counterSale` judges the sale at the till). */
  options: { counterSale?: boolean };
  dto: Ack;
}): SellableLinesArgs {
  return {
    tenantId: a.tenant,
    customerId: a.customerId,
    lines: a.lineItemsData.flatMap((li, i) =>
      li.productId ? [{ productId: li.productId, lineKey: `n:${i}` }] : [],
    ),
    fulfilmentKind: saleFulfilmentKind({
      fulfillPath: a.fulfillPath,
      counterSale: a.options.counterSale,
    }),
    principal: a.user,
    ack: a.dto,
    document: "ORDER",
  };
}

/** The lines selected for the whole-order judgements below (the stamp columns ride the same select). */
export const WHOLE_LINE_SELECT = {
  id: true,
  productId: true,
  status: true,
  ...OVERRIDE_STAMP_SELECT,
} as const;

type OrderLine = HeldLine;

/**
 * The promotion / reopen / path-switch judgement: every catalog line of the order is judged (keyed `l:<lineId>`), at
 * the order's own path (or the path it is switching TO), and the lines already on it are the coverage. `allLive`:
 * reopen puts every line on sale, so a CANCELLED line covers and is judged like any other.
 */
export function whole(a: {
  tenant: string;
  order: { customerId: string; fulfillPath?: string | null; counterSale?: boolean | null };
  user: User;
  lines: readonly OrderLine[];
  dto?: Ack;
  allLive?: boolean;
}): SellableLinesArgs {
  return {
    tenantId: a.tenant,
    customerId: a.order.customerId,
    lines: a.lines.flatMap((l) =>
      l.productId ? [{ productId: l.productId, lineKey: `l:${l.id}` }] : [],
    ),
    fulfilmentKind: saleFulfilmentKind({
      counterSale: a.order.counterSale,
      fulfillPath: a.order.fulfillPath,
    }), // the path switch passes the path switched TO
    principal: a.user,
    ack: a.dto,
    held: a.allLive ? a.lines.map((l) => ({ ...l, status: null })) : a.lines,
    document: "ORDER",
  };
}

export type EditPlan = OrderEditRestrictionPlan;
export type CrPlan = ChangeRequestRestrictionPlan;

/** `updateOrderItems` (non-draft): the edit's plan, built from the order read before the lock and the payload. */
export function editPlan(
  prisma: Pick<PrismaService, "forTenant">,
  a: {
    tenant: string;
    order: {
      customerId: string;
      lineItems?: readonly HeldEditLine[];
      fulfillPath?: string | null;
      counterSale?: boolean | null;
    };
    user: User;
    dto: { items?: readonly any[]; replaceAll?: boolean } & NonNullable<Ack>;
    isDiffPayload: boolean;
  },
): Promise<EditPlan> {
  return planOrderEditRestrictions(prisma, {
    tenantId: a.tenant,
    customerId: a.order.customerId,
    existing: a.order.lineItems ?? [],
    items: a.dto.items ?? [],
    mode: orderEditMode(a.user?.role, a.dto.replaceAll, a.isDiffPayload),
    principal: a.user,
    fulfilmentKind: saleFulfilmentKind({
      counterSale: a.order.counterSale,
      fulfillPath: a.order.fulfillPath,
    }),
    ack: a.dto,
  });
}

/** `approveChangeRequestAtStop`: the at-door approval's plan. */
export function crPlan(a: {
  tenant: string;
  order: {
    customerId: string;
    lineItems?: readonly HeldEditLine[];
    fulfillPath?: string | null;
    counterSale?: boolean | null;
  };
  cr: ChangeRequestFacts & { id: string };
  /** The resolver, or the BUYER channel when the requester is the stricter side (F1 i: `leastPrivilegedPrincipal`). */
  user: User | { type: "BUYER" };
  ack?: Ack;
}): CrPlan {
  return planChangeRequestRestrictions({
    tenantId: a.tenant,
    customerId: a.order.customerId,
    existing: a.order.lineItems ?? [],
    cr: a.cr,
    principal: a.user,
    fulfilmentKind: saleFulfilmentKind({
      counterSale: a.order.counterSale,
      fulfillPath: a.order.fulfillPath,
    }),
    ack: a.ack,
  });
}

/**
 * Inside the write's transaction, AFTER the row is locked (a `FOR UPDATE`, or the compare-and-set claim): the order's
 * lines are read again, a product the pre-lock judgement never saw refuses with the retryable 409, and the override is
 * re-judged as a pure recompute against the locked rows (`decision.recheck`: a mismatch throws the fresh
 * RESTRICTION_WARNING). `lock` takes the `Order FOR UPDATE` first (reopen, the path switch: no claim before it).
 * Resolves to the final decision; the caller stamps it after its line writes (`decision?.stamp(tx, orderId)`).
 */
export async function recheck(
  tx: any,
  ov: StaffWriteDecision | null | undefined,
  orderId: string,
  judged: ReadonlySet<string> | undefined,
  opts: { lock?: boolean; allLive?: boolean } = {},
): Promise<StaffWriteDecision | undefined> {
  if (opts.lock) await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  const rows: HeldLine[] = await tx.orderItem.findMany({
    where: { orderId },
    select: WHOLE_LINE_SELECT,
  });
  const held = opts.allLive ? rows.map((r) => ({ ...r, status: null })) : rows;
  const live = held.filter((r) => r.status !== "CANCELLED");
  if (live.some((r) => r.productId && judged && !judged.has(r.productId)))
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order's items changed while it was being updated — review it and try again.",
    });
  const lines: GateLine[] = live.flatMap((r) =>
    r.productId ? [{ productId: r.productId, lineKey: `l:${r.id}` }] : [],
  );
  return ov?.recheck(held, lines);
}
