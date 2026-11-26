import { OrderStatus, UserRole } from "@prisma/client";
import type { CorrectionBasis, LineEditMode, LineLockedReason } from "@routeflow/types";
import { isDeliveredLine, isLiveDeliveredLine } from "./delivered-line-lock";

/**
 * SA-1506 PR-1a (Amendment 1 C1, Amendment 2 section C): the ONE decider for "may this delivered line be edited, and
 * how". Pure: no Prisma, no Nest. Every refusal, every control the clients show and the stock / evidence / routing rules
 * of a correction read its answer; nothing else re-derives it. The facts it needs are loaded once per edit by
 * `delivered-line-facts.ts` (`loadDeliveredLineFacts`), for the edit transaction and for the order-detail wire alike.
 *
 * `LINE_EDIT_MODES` / `LOCKED_REASONS` / `CORRECTION_BASES` are the api's own literals (the api cannot value-import
 * `@routeflow/types`); `delivered-line-edit-mode.parity.spec.ts` pins them set-equal to the wire's.
 *
 *  - EDIT: not a live delivered line; the ordinary rules apply.
 *  - CORRECT(basis): an admin may restate the delivery (quantity, box split, price, take-off); never a substitution, a
 *    product change or a unit-label change (guards in delivered-line-lock.ts). The basis says what evidence moves with
 *    it: NONE (no rows: the column only), OFFICE (the office's rows, restated in place), ROUTE (PR-1c).
 *  - LOCKED(reason): refused. The reasons are separate and named so a later ruling turns one into CORRECT by changing
 *    this function (and adding its rules), never by rewriting a guard. PR-1c flips ROUTE (case 6) and RETURN (case 7).
 *
 * Cases, first hit wins:
 *  1 not a live delivered line: EDIT   2 unit line: UNIT   3 not a tenant admin / no tenant: ROLE
 *  4 DELIVERED: REOPEN_FIRST; any status but CONFIRMED / PARTIALLY_DELIVERED: STATUS
 *  5 the order's stop is not COMPLETED: ON_RUN
 *  6 a driver / stop row on the line, a COMPLETED stop, or any run link on the order (routeRunId): ROUTE (SA-1533 M-3)
 *  7 a live return: RETURN   8 partly invoiced: SPLIT_BILL   9 a linked invoice WRITTEN_OFF: WRITTEN_OFF
 *  10 bills-at-shipment order with the carrier: SHIPMENT_BILLED   11 otherwise CORRECT (OFFICE if the line has rows, else NONE).
 * A line with zero rows on an order that never was on a run is CORRECT NONE (A2 NEW-M2); on a run order case 6 locks it.
 */
export const LINE_EDIT_MODES = [
  "EDIT",
  "CORRECT",
  "LOCKED",
] as const satisfies readonly LineEditMode[];
export const LOCKED_REASONS = [
  "ROLE",
  "UNIT",
  "STATUS",
  "REOPEN_FIRST",
  "ON_RUN",
  "ROUTE",
  "RETURN",
  "RETURN_BASIS",
  "RETURN_REMAINDER",
  "RETURN_PRICE",
  "SPLIT_BILL",
  "WRITTEN_OFF",
  "SHIPMENT_BILLED",
] as const satisfies readonly LineLockedReason[];
export const CORRECTION_BASES = [
  "NONE",
  "OFFICE",
  "ROUTE",
] as const satisfies readonly CorrectionBasis[];

/** The statuses a CORRECT may run on (an allow-list, A2 M8). */
export const CORRECTABLE_STATUSES: readonly string[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PARTIALLY_DELIVERED,
];

/** The order-level facts the decider reads (one load per edit, `loadDeliveredLineFacts`). */
export interface DeliveredLineFacts {
  role: string | undefined;
  /** The REQUEST's tenant id is present (a tenantless SUPER_ADMIN is never CORRECT, B5). */
  hasTenant: boolean;
  orderStatus: string;
  /** The order is linked to a route stop that is NOT COMPLETED (on a delivery run now). */
  onRun: boolean;
  /** The order is linked to a COMPLETED route stop. */
  stopCompleted: boolean;
  /** The order carries a route run link (`routeRunId`), even when its stop link was released (SA-1533 M-3). */
  routeRunLinked: boolean;
  /**
   * SA-1536 (z): ANY delivery row of the ORDER carries a stop or a driver (no per-line, no evidence-type filter). A pickup
   * switch nulls both order links and keeps the rows, so a no-row sibling line stays locked ROUTE.
   */
  orderRouteRows: boolean;
  /** Lines with a qualifying evidence row written by a driver or a route stop. */
  routeLineIds: ReadonlySet<string>;
  /** Lines with a qualifying evidence row written by the office (no stop, no driver). */
  officeLineIds: ReadonlySet<string>;
  /** `liveReturnWhere([order]).count > 0` (SA-1101 A-6, the one predicate). */
  liveReturn: boolean;
  /** `shouldSkipInPlaceResync(held)`: some lines billed, not all. */
  partlyInvoiced: boolean;
  /** The number of a linked WRITTEN_OFF invoice, or null. */
  writtenOffInvoiceNumber: string | null;
  /** A bills-at-shipment order the carrier holds (`carrierEditGuard().withCarrier`). */
  shipmentBilled: boolean;
}

export interface DeliveredModeLine {
  id: string;
  status?: unknown;
  deliveredQty?: unknown;
  unitLabel?: unknown;
}

export type LineEditDecision =
  | { mode: "EDIT" }
  | { mode: "CORRECT"; basis: CorrectionBasis }
  | {
      mode: "LOCKED";
      reason: LineLockedReason;
      /** ROLE only: an OPERATOR is refused, and an admin could correct this line (SA-1408 item 3). */
      operatorNote?: boolean;
      /** WRITTEN_OFF only: the invoice the copy names. */
      invoiceNumber?: string | null;
      /** STATUS only: the order status the sentence is keyed by. */
      status?: string;
    };

/**
 * SEAM (SA-1514 A3 change a): who may correct a delivered line. Today this is the tenant-admin role in a tenant. "Admin"
 * means `isAdminInTenant` (apps/api/src/common/admin-in-tenant.ts), which lands with SA-1508 PR-2: replace the body of this
 * function with a call to it and nothing else. Every admin check of the correction path (this decider, the M5 lock class)
 * goes through here, so that file is the only one that changes.
 */
export function isAdminForCorrection(role: string | undefined, hasTenant: boolean): boolean {
  return role === UserRole.TENANT_ADMIN && hasTenant;
}

const locked = (reason: LineLockedReason, more: object = {}): LineEditDecision => ({
  mode: "LOCKED",
  reason,
  ...more,
});

export function deliveredLineEditMode(
  line: DeliveredModeLine,
  facts: DeliveredLineFacts,
): LineEditDecision {
  if (!isLiveDeliveredLine(line)) return { mode: "EDIT" }; // 1
  if (typeof line.unitLabel === "string" && line.unitLabel.trim() !== "") return locked("UNIT"); // 2
  if (!isAdminForCorrection(facts.role, facts.hasTenant)) {
    // 3: today's guards apply unchanged; an operator is also told who can correct, when an admin could.
    const asAdmin = deliveredLineEditMode(line, {
      ...facts,
      role: UserRole.TENANT_ADMIN,
      hasTenant: true,
    });
    return locked("ROLE", {
      operatorNote: facts.role === UserRole.OPERATOR && asAdmin.mode === "CORRECT",
    });
  }
  if (facts.orderStatus === OrderStatus.DELIVERED) return locked("REOPEN_FIRST"); // 4
  if (!CORRECTABLE_STATUSES.includes(facts.orderStatus))
    return locked("STATUS", { status: facts.orderStatus });
  if (facts.onRun) return locked("ON_RUN"); // 5
  const office = facts.officeLineIds.has(line.id);
  const route = facts.routeLineIds.has(line.id);
  // 6 (SA-1533 M-3, PR-1a): every delivered line of an order that is, or was, on a run answers LOCKED ROUTE, whatever rows
  // it has: master's own guards then judge it, so PR-1a changes nothing on a route order. PR-1c-server lifts this one line.
  if (route || facts.stopCompleted || facts.routeRunLinked || facts.orderRouteRows)
    return locked("ROUTE");
  if (facts.liveReturn) return locked("RETURN"); // 7
  if (facts.partlyInvoiced) return locked("SPLIT_BILL"); // 8
  if (facts.writtenOffInvoiceNumber != null)
    return locked("WRITTEN_OFF", { invoiceNumber: facts.writtenOffInvoiceNumber }); // 9
  if (facts.shipmentBilled) return locked("SHIPMENT_BILLED"); // 10
  return { mode: "CORRECT", basis: office ? "OFFICE" : "NONE" }; // 11
}

/** The wire fields of one decision (`LineEditModeFields`); PR-1a: correctMinQty 0, priceLocked false, needsReason false. */
export function lineEditFields(d: LineEditDecision) {
  return {
    lineEditMode: d.mode,
    lockedReason: d.mode === "LOCKED" ? d.reason : null,
    correctionBasis: d.mode === "CORRECT" ? d.basis : ("NONE" as CorrectionBasis),
    correctMinQty: 0,
    priceLocked: false,
    needsReason: false,
    ...(d.mode === "LOCKED" && d.operatorNote ? { lockedOperatorNote: true } : {}),
    ...(d.mode === "LOCKED" && d.invoiceNumber ? { lockedInvoiceNumber: d.invoiceNumber } : {}),
    ...(d.mode === "LOCKED" && d.status ? { lockedStatus: d.status } : {}),
  };
}

/**
 * The facts a unit line needs (none): `deliveredLineEditMode` answers UNIT before it reads any of them. The unit-line
 * writer (unit-line-edit.ts) consults the decider with this, so its floor is judged by the same function.
 */
export const NO_ORDER_FACTS: DeliveredLineFacts = {
  role: undefined,
  hasTenant: false,
  orderStatus: "",
  onRun: false,
  stopCompleted: false,
  routeRunLinked: false,
  orderRouteRows: false,
  routeLineIds: new Set(),
  officeLineIds: new Set(),
  liveReturn: false,
  partlyInvoiced: false,
  writtenOffInvoiceNumber: null,
  shipmentBilled: false,
};

/** True when `isDeliveredLine` holds but the line is not live (a struck-off delivered line, legacy data). */
export const isLegacyStruckDelivered = (line: {
  status?: unknown;
  deliveredQty?: unknown;
}): boolean => isDeliveredLine(line) && !isLiveDeliveredLine(line);
