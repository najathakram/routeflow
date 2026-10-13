// #2339: moved verbatim out of NewOrderScreen.tsx (a behaviour-preserving prefactor).
import { type CreditNote } from "../../lib/api/credit-notes";

/**
 * An ad-hoc, non-catalog ("unlisted") line. Has a free-text name + a required
 * per-piece price; never boxed. Serialised as `{ name, qty, unitPrice }` on
 * submit (no productId). Keyed locally by a synthetic id.
 */
export type UnlistedLine = {
  id: string;
  name: string;
  unitPrice: number;
  qty: number;
  /** Optional per-line note — carried onto the invoice line (buyer-visible). */
  note?: string;
  noteOpen?: boolean;
};

/** Order-level fields, owned by ProductPickView and edited inside the cart. */
export interface OrderOptions {
  urgent: boolean;
  onToggleUrgent: () => void;
  deliveryDate: string;
  onChangeDeliveryDate: (v: string) => void;
  /** Business date of the order (YYYY-MM-DD); blank = today. */
  orderDate: string;
  onChangeOrderDate: (v: string) => void;
  /** Staff only — drivers must never see the backdate field. */
  canBackdate: boolean;
  discountRaw: string;
  onChangeDiscount: (v: string) => void;
  shippingFeeRaw: string;
  onChangeShippingFee: (v: string) => void;
  notes: string;
  onChangeNotes: (v: string) => void;
  /** Ad-hoc trips (plan §WP11): ROUTE (default) or SHIP (carrier-shipped). */
  fulfillPath: "ROUTE" | "SHIP";
  onChangeFulfillPath: (v: "ROUTE" | "SHIP") => void;
  /** POS mode: the delivery-only fields (urgent, delivery date, ROUTE/SHIP) step aside; values are kept. */
  posMode?: boolean;
}

export interface CreditPicker {
  rows: CreditNote[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onCreateNew: () => void;
}
