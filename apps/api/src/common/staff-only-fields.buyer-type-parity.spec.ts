import type {
  BuyerInvoiceItem,
  BuyerInvoiceListItem,
  BuyerInvoicePayment,
  BuyerOrder,
  BuyerOrderLine,
  ChangeRequest,
  LineComponentView,
} from "@routeflow/types";
import { pickCustomerInvoiceFields, pickCustomerOrderFields } from "./staff-only-fields";

/**
 * Every key of the shared buyer response types (packages/types/api/buyer.ts) is CLASSIFIED here:
 * "keep" (the customer projection carries it), "strip" (the type declares it but the projection
 * drops it on purpose), or a nested plan (a relation projected key by key). Each plan `satisfies
 * Record<keyof T, …>`, so a field added to a shared type fails check-types until someone decides
 * which it is, and the runtime half proves the projection agrees with the decision.
 */
type Leaf = "keep" | "strip";
interface Nested {
  plan: Record<string, Plan>;
  many?: boolean;
}
type Plan = Leaf | Nested;

const CUSTOMER = { id: "keep", businessName: "keep" } satisfies Record<
  keyof BuyerOrder["customer"],
  Leaf
>;
const PRODUCT = { id: "keep", name: "keep", unit: "keep", unitsPerBox: "keep" } satisfies Record<
  keyof NonNullable<BuyerOrderLine["product"]>,
  Leaf
>;
const COMPONENT = {
  id: "keep",
  componentProductId: "keep",
  name: "keep",
  qty: "keep",
  unitSku: "keep",
  unitBarcode: "keep",
  barcodeSymbology: "keep",
  displayUnitPrice4: "keep",
  position: "keep",
} satisfies Record<keyof LineComponentView, Leaf>;

const ORDER_LINE = {
  id: "keep",
  productId: "keep",
  name: "keep",
  qty: "keep",
  unitPrice: "keep",
  subtotal: "keep",
  priceType: "keep",
  originalPrice: "keep",
  status: "keep",
  deliveredQty: "keep",
  boxes: "keep",
  pieces: "keep",
  promoFreeUnits: "keep",
  categoryTaxAmount: "keep",
  unitLabel: "keep",
  notes: "keep",
  components: { plan: COMPONENT, many: true },
  product: { plan: PRODUCT },
} satisfies Record<keyof BuyerOrderLine, Plan>;

const CHANGE_REQUEST = {
  id: "keep",
  orderId: "keep",
  orderItemId: "keep",
  productId: "keep",
  type: "keep",
  status: "keep",
  payload: "keep",
  note: "keep",
  // who raised / resolved it is the operator surface's view of the shared row, never the buyer's
  requestedByName: "strip",
  requestedByRole: "strip",
  resolvedByName: "strip",
  resolvedByRole: "strip",
  resolution: "keep",
  resolutionReason: "keep",
  nextOrderId: "keep",
  resolvedAt: "keep",
  createdAt: "keep",
} satisfies Record<keyof ChangeRequest, Leaf>;

const ORDER = {
  id: "keep",
  orderNumber: "keep",
  status: "keep",
  createdAt: "keep",
  requestedDeliveryDate: "keep",
  deliveredAt: "keep",
  notes: "keep",
  urgent: "keep",
  subtotal: "keep",
  tax: "keep",
  total: "keep",
  discountAmount: "keep",
  customer: { plan: CUSTOMER },
  lineItems: { plan: ORDER_LINE, many: true },
  invoices: {
    plan: { id: "keep", invoiceNumber: "keep", status: "keep", total: "keep" } satisfies Record<
      keyof BuyerOrder["invoices"][number],
      Leaf
    >,
    many: true,
  },
  changeRequests: { plan: CHANGE_REQUEST, many: true },
  editWindow: "keep",
  routeRun: {
    plan: { status: "keep", startedAt: "keep" } satisfies Record<
      keyof NonNullable<BuyerOrder["routeRun"]>,
      Leaf
    >,
  },
} satisfies Record<keyof BuyerOrder, Plan>;

const INVOICE_ITEM = {
  id: "keep",
  description: "keep",
  productId: "keep",
  qty: "keep",
  unitPrice: "keep",
  discount: "keep",
  originalPrice: "keep",
  msrp: "keep",
  priceType: "keep",
  subtotal: "keep",
  unitLabel: "keep",
  boxes: "keep",
  pieces: "keep",
  unitsPerBox: "keep",
  promoFreeUnits: "keep",
  notes: "keep",
  categoryTaxAmount: "keep",
  product: { plan: PRODUCT },
  // no buyer screen (web portal or mobile) renders a line's tracked category or subcategory
  trackedCategory: "strip",
  trackedSubcategory: "strip",
} satisfies Record<keyof BuyerInvoiceItem, Plan>;

const PAYMENT = {
  id: "keep",
  amount: "keep",
  method: "keep",
  reference: "keep",
  // the seller's internal memo on a payment; the buyer's payment history never shows it
  notes: "strip",
  paidAt: "keep",
  createdAt: "keep",
  status: "keep",
  checkStatus: "keep",
  nsfFeeAmount: "keep",
  creditNote: {
    plan: {
      id: "keep",
      creditNoteNumber: "keep",
      reason: "keep",
      amount: "keep",
      amountUsed: "keep",
      status: "keep",
    } satisfies Record<keyof NonNullable<BuyerInvoicePayment["creditNote"]>, Leaf>,
  },
} satisfies Record<keyof BuyerInvoicePayment, Plan>;

const INVOICE_LIST = {
  id: "keep",
  invoiceNumber: "keep",
  status: "keep",
  issueDate: "keep",
  createdAt: "keep",
  dueDate: "keep",
  subtotal: "keep",
  taxAmount: "keep",
  total: "keep",
  balanceDue: "keep",
  paidAmount: "keep",
  creditApplied: "keep",
  advanceApplied: "keep",
  isOverdue: "keep",
  customer: { plan: CUSTOMER },
} satisfies Record<keyof BuyerInvoiceListItem, Plan>;

// The detail response is the list row plus its lines and payments.
const INVOICE: Record<string, Plan> = {
  ...INVOICE_LIST,
  items: { plan: INVOICE_ITEM, many: true },
  payments: { plan: PAYMENT, many: true },
};

/** A row carrying every classified key (a distinct value each) plus a column no type knows yet. */
function fixture(plan: Record<string, Plan>, path: string): Record<string, unknown> {
  const row: Record<string, unknown> = { futureColumn: `${path}.futureColumn` };
  for (const [key, entry] of Object.entries(plan)) {
    if (typeof entry === "string") row[key] = `${path}.${key}`;
    else {
      const child = fixture(entry.plan, `${path}.${key}`);
      row[key] = entry.many ? [child] : child;
    }
  }
  return row;
}

/** Every "keep" survives with its value, every "strip" and the unknown column are gone. */
function expectMatchesPlan(out: unknown, plan: Record<string, Plan>, path: string) {
  const row = out as Record<string, unknown>;
  expect(row).not.toHaveProperty("futureColumn");
  for (const [key, entry] of Object.entries(plan)) {
    const at = `${path}.${key}`;
    if (entry === "keep") expect({ at, value: row[key] }).toEqual({ at, value: at });
    else if (entry === "strip") expect({ at, present: key in row }).toEqual({ at, present: false });
    else {
      const value = row[key];
      expect({ at, isArray: Array.isArray(value) }).toEqual({ at, isArray: !!entry.many });
      expectMatchesPlan(entry.many ? (value as unknown[])[0] : value, entry.plan, at);
    }
  }
}

describe("customer projection ↔ shared buyer types: every key is classified", () => {
  it("an order (BuyerOrder) keeps exactly its keep-classified keys, at every level", () => {
    expectMatchesPlan(pickCustomerOrderFields(fixture(ORDER, "order")), ORDER, "order");
  });

  it("an invoice (BuyerInvoiceListItem + items + payments) keeps exactly its keep-classified keys", () => {
    expectMatchesPlan(pickCustomerInvoiceFields(fixture(INVOICE, "invoice")), INVOICE, "invoice");
  });
});
