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
