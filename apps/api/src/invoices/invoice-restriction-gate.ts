import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { OverrideStamp } from "../common/restriction-override-columns";
import type { HeldLine, StaffWriteDecision } from "../selling-restrictions/restriction-warning";
import { salePathForOrder, type SalePath } from "../selling-restrictions/jurisdiction";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import type {
  SellableLinesArgs,
  SellableLinesParams,
} from "../selling-restrictions/selling-restrictions.service";
import { addedRestrictionLinesWithHeld } from "./invoice-restriction-lines";

/**
 * Row 510: the parameter builders of the staff restriction gate for the invoice writers (manual create, the DRAFT item
 * edit, a duplicate) and the estimate conversion. The services keep the choke-point CALL (`assertLinesSellable`, so the
 * coverage ratchets see it); the keys, the held lines and the stamp target live here, which keeps `invoices.service.ts`
 * flat (size-ratchet). Imported as a namespace (`import * as iGate`).
 *
 * An invoice has no fulfil path: it is judged at the customer's address (`DELIVERY`). The actor is the staff user
 * (`undefined` for an internal caller, which can never override). `lineKey`: "n:<index>" for a payload entry,
 * "l:<lineId>" for an existing line the payload names or a source line being copied.
 */

export { stampOverrideNames } from "../common/restriction-override-names";
export type Decision = StaffWriteDecision;
export type Ack = SellableLinesParams["ack"];
type Actor = Pick<JwtPayload, "sub" | "role"> | undefined;
type Held = Array<Partial<OverrideStamp> & { id?: string | null; productId?: string | null }>;

/** The ambient tenant, or a 403: a tenant-less session cannot be judged (fail closed). */
export const tenantId = (prisma: { getTenantId(): string | null | undefined }): string =>
  requireRestrictionTenantId(prisma.getTenantId());

const base = (
  tenant: string,
  customerId: string,
  actor: Actor,
  ack: Ack,
  held?: Held,
  path: SalePath = "DELIVERY",
) =>
  ({
    tenantId: tenant,
    customerId,
    path,
    principal: actor,
    ack,
    held: held?.flatMap((h) => (h.id ? [{ ...h, id: h.id, productId: h.productId ?? null }] : [])),
    document: "INVOICE",
  }) as const;

/** Manual invoice create: one warned line per payload entry, keyed by its index. */
export function create(
  tenant: string,
  customerId: string,
  items: ReadonlyArray<{ productId?: string | null }>,
  actor: Actor,
  ack: Ack,
): SellableLinesArgs {
  return {
    ...base(tenant, customerId, actor, ack),
    lines: items.flatMap((it, i) =>
      it.productId ? [{ productId: it.productId, lineKey: `n:${i}` }] : [],
    ),
  };
}

/**
 * The DRAFT item edit: the netted lines (per product), each keyed by the FIRST payload entry of its product ("l:<id>" when
 * the entry names a kept line, else "n:<index>"), with the invoice's held lines for coverage.
 */
export function edit(
  tenant: string,
  customerId: string,
  netted: ReadonlyArray<{ productId: string; qtyDelta?: number }>,
  items: ReadonlyArray<{ id?: string | null; productId?: string | null }>,
  held: Held,
  actor: Actor,
  ack: Ack,
  path: SalePath = "DELIVERY",
): SellableLinesArgs {
  const keyOf = (productId: string) => {
    const i = items.findIndex((it) => it.productId === productId);
    return items[i]?.id ? `l:${items[i].id}` : `n:${i}`;
  };
  return {
    ...base(tenant, customerId, actor, ack, held, path),
    lines: netted.map((l) => ({ ...l, lineKey: keyOf(l.productId) })),
  };
}

/**
 * `InvoicesService.update` with an item replace: reads the netted lines and the held lines (one read of the invoice's
 * items, the same the edit always made) and builds the gate's parameters. `lines` is also what the lock-time re-check
 * (`assertEditStillJudged`) compares against.
 */
export async function editParams(
  prisma: { forTenant(): any; getTenantId(): string | null | undefined },
  inv: { id: string; customerId: string; orderId?: string | null },
  items: ReadonlyArray<{ id?: string | null; productId?: string | null }>,
  actor: Actor,
  ack: Ack,
) {
  const { lines, held } = await addedRestrictionLinesWithHeld(prisma.forTenant(), inv.id, items);
  // An order-linked invoice is the same sale as its order: a counter / pickup order's invoice is judged at the store.
  const order = inv.orderId
    ? await prisma.forTenant().order.findUnique({
        where: { id: inv.orderId },
        select: { fulfillPath: true, counterSale: true },
      })
    : null;
  const path = order ? salePathForOrder(order) : "DELIVERY";
  return {
    lines,
    params: edit(tenantId(prisma), inv.customerId, lines, items, held, actor, ack, path),
  };
}

/**
 * A copy of existing lines (an invoice duplicate, an estimate conversion): every distinct catalog product is judged, keyed by
 * the SOURCE line ("l:<sourceLineId>", the first line of the product). Nothing is held: the copy is a new document.
 */
export function copy(
  tenant: string,
  customerId: string,
  source: ReadonlyArray<{ id?: string | null; productId?: string | null }>,
  actor: Actor,
  ack: Ack,
): SellableLinesArgs {
  const seen = new Set<string>();
  return {
    ...base(tenant, customerId, actor, ack),
    lines: source.flatMap((it, i) => {
      if (!it.productId || seen.has(it.productId)) return [];
      seen.add(it.productId);
      return [{ productId: it.productId, lineKey: it.id ? `l:${it.id}` : `n:${i}` }];
    }),
  };
}

export type { HeldLine };
