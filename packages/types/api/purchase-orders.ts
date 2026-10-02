/** One row of a purchase order's receipts history (the detail page). */
export interface PurchaseOrderReceipt {
  /** The StockMovement id. */
  id: string;
  /** A receipt posted stock; a REVERSAL is the compensating entry a re-apply writes (its
   *  `reversesId` is the receipt it undoes). Quantities are PIECES. */
  kind: "RECEIPT" | "REVERSAL";
  productId: string;
  productName: string | null;
  quantity: number;
  unitCost: number | null;
  /** ISO timestamp. */
  at: string;
  reversesId?: string;
}

/** The linked supplier bill, when one exists. */
export interface PurchaseOrderBillLink {
  id: string;
  billNumber: string;
  status: string;
}
