import { Logger } from "@nestjs/common";
import { InvoiceStatus, UserRole } from "@prisma/client";
import { evidenceOrigin, isEvidenceRow } from "../invoices/delivered-basis-by-line";
import { liveReturnWhere } from "../returns/live-return-guard";
import {
  deliveredLineEditMode,
  lineEditFields,
  type DeliveredLineFacts,
  type LineEditDecision,
} from "./delivered-line-edit-mode";
import {
  isDeliveredLine,
  isLiveDeliveredLine,
  type DeliveredLockLine,
} from "./delivered-line-lock";
import { shouldSkipInPlaceResync } from "./merge-idempotency";
import * as carrierGuard from "./order-carrier-guard";

/**
 * SA-1506 PR-1a: the one load of the order-level facts `deliveredLineEditMode` reads, and the per-line decision map
 * built from them. READ ONLY. Called on the pre-transaction read (advisory) and again on the Order-locked read inside
 * the edit transaction (authoritative); the order detail read calls it for the viewing user so the clients show what
 * the server will decide. An order that holds no live delivered line reads nothing (an ordinary edit pays no query).
 */
type FactsDb = {
  deliveryMutation: { findMany(args: any): Promise<any[]> };
  return: { count(args: any): Promise<number> };
  invoice: { findFirst(args: any): Promise<{ invoiceNumber: string } | null> };
  order: { findUnique(args: any): Promise<any> };
};

export interface DeliveredModeInput {
  /** `CarrierDeps`: the service itself (its `featureConfig` + prisma). */
  deps: Parameters<typeof carrierGuard.carrierEditGuard>[0];
  db: FactsDb;
  order: Parameters<typeof carrierGuard.carrierEditGuard>[1] & { id: string; status: string };
  /** The order's lines: the pre-tx read, or the locked `heldItems`. */
  held: ReadonlyArray<
    DeliveredLockLine & { status?: unknown; qty?: unknown; invoicedQty?: unknown }
  >;
  /** The status to judge by: the one read under the Order lock, else the pre-tx one. */
  status: string;
  user: { role?: string } | undefined;
  /** The REQUEST's tenant id (`prisma.getTenantId()`), never the token's. */
  tenantId: string | null | undefined;
}

export type DeliveredModes = Map<string, LineEditDecision>;

export async function loadDeliveredLineFacts(i: DeliveredModeInput): Promise<DeliveredLineFacts> {
  const rows: Array<{
    orderItemId: string | null;
    type: string;
    quantityDelivered: unknown;
    routeRunStopId: string | null;
    driverId: string | null;
  }> = await i.db.deliveryMutation.findMany({
    where: { orderId: i.order.id },
    select: {
      orderItemId: true,
      type: true,
      quantityDelivered: true,
      routeRunStopId: true,
      driverId: true,
    },
  });
  const routeLineIds = new Set<string>();
  const officeLineIds = new Set<string>();
  for (const m of rows.filter(isEvidenceRow)) {
    if (!m.orderItemId) continue;
    (evidenceOrigin(m) === "route" ? routeLineIds : officeLineIds).add(m.orderItemId);
  }
  const head: { routeRunStopId: string | null; routeRunStop?: { status: string } | null } | null =
    await i.db.order.findUnique({
      where: { id: i.order.id },
      select: { routeRunStopId: true, routeRunStop: { select: { status: true } } },
    });
  const stopStatus = head?.routeRunStopId ? (head.routeRunStop?.status ?? "PENDING") : null;
  const writtenOff = await i.db.invoice.findFirst({
    where: { orderId: i.order.id, status: InvoiceStatus.WRITTEN_OFF },
    select: { invoiceNumber: true },
    orderBy: { id: "asc" },
  });
  return {
    role: i.user?.role,
    hasTenant: !!i.tenantId,
    orderStatus: i.status,
    onRun: stopStatus != null && stopStatus !== "COMPLETED",
    stopCompleted: stopStatus === "COMPLETED",
    routeLineIds,
    officeLineIds,
    liveReturn: (await i.db.return.count({ where: liveReturnWhere([i.order.id]) })) > 0,
    partlyInvoiced: shouldSkipInPlaceResync(i.held),
    writtenOffInvoiceNumber: writtenOff?.invoiceNumber ?? null,
    shipmentBilled: (await carrierGuard.carrierEditGuard(i.deps, i.order)).withCarrier,
  };
}

/** Every delivered line of the order (struck-off ones included, they keep the legacy rules) -> its decision. */
export async function deliveredLineModes(i: DeliveredModeInput): Promise<DeliveredModes> {
  const modes: DeliveredModes = new Map();
  if (!i.held.some(isLiveDeliveredLine)) {
    for (const l of i.held) if (isDeliveredLine(l)) modes.set(l.id, { mode: "EDIT" });
    return modes;
  }
  const facts = await loadDeliveredLineFacts(i);
  for (const l of i.held) if (isDeliveredLine(l)) modes.set(l.id, deliveredLineEditMode(l, facts));
  return modes;
}

const attachLog = new Logger("DeliveredLineModes");

/**
 * The wire (`LineEditModeFields`): every line of a STAFF order read carries `lineEditMode` and `lockedReason`, decided by
 * the same function the edit's guards call, for the viewing user. A customer or driver read gets neither (they never edit
 * a delivered line here). Advisory: a database failure leaves the fields out and the clients fall back to the legacy lock,
 * the edit itself still judges authoritatively.
 */
export async function attachLineEditModes(
  self: DeliveredModeInput["deps"] & { prisma: { forTenant(): any; getTenantId(): string | null } },
  order: DeliveredModeInput["order"] & { lineItems?: DeliveredModeInput["held"] },
  user: { role?: string },
): Promise<void> {
  if (user.role === UserRole.CUSTOMER || user.role === UserRole.DRIVER) return;
  try {
    const held = order.lineItems ?? [];
    const modes = await deliveredLineModes({
      deps: self,
      db: self.prisma.forTenant(),
      order,
      held,
      status: order.status,
      user,
      tenantId: self.prisma.getTenantId(),
    });
    for (const line of held as Array<{ id: string }>) {
      Object.assign(line, lineEditFields(modes.get(line.id) ?? { mode: "EDIT" }));
    }
  } catch (err) {
    attachLog.warn(
      `lineEditModes for order ${order.id} skipped: ${(err as Error)?.message ?? err}`,
    );
  }
}
