import type { POStatus } from "../../inventory/_components/purchase-orders-shared";

export interface PoActions {
  edit: boolean;
  send: boolean;
  receive: boolean;
  close: boolean;
}

/** Which actions a purchase order offers in each status — the same rules the list row applies. */
export function poActions(status: POStatus): PoActions {
  return {
    edit: status !== "CLOSED",
    send: status === "DRAFT",
    receive: status === "SENT" || status === "PARTIAL",
    close: status === "SENT" || status === "PARTIAL" || status === "RECEIVED",
  };
}

export interface CreateBillAction {
  label: string;
  href: string;
}

/**
 * SA-1207 P2b (decision item 19): the PO detail offers to create the supplier bill. Only an ordered PO that is
 * not closed and has no live bill (a voided one leaves it billable), and only where the plan has bills. After a
 * partial receive the button says what it bills.
 */
export function createBillAction(
  po: { id: string; status: POStatus; vendorBill?: { status?: string } | null },
  billsVisible: boolean,
): CreateBillAction | null {
  // The same ordered-and-not-closed set `poActions` already names (no second hand-typed status list).
  const billable = poActions(po.status).close;
  const liveBill = !!po.vendorBill && po.vendorBill.status !== "VOID";
  if (!billsVisible || !billable || liveBill) return null;
  return {
    label: po.status === "PARTIAL" ? "Bill what arrived so far" : "Create supplier bill",
    href: `/vendor-bills?tab=inventory&fromPo=${po.id}`,
  };
}
