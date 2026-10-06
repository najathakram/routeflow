/**
 * B1134: which controls of the order page's action bar THIS session may use.
 *
 * The page is reachable by CUSTOMER sessions on purpose (`RouteGuard`'s CUSTOMER_ALLOWED lists
 * /orders), but its action bar was gated by order status alone, so a customer was offered Confirm,
 * Out for Delivery, Mark delivered, Unconfirm, Reopen, Delete and Edit Items after dispatch. Those are
 * the staff actions; a customer's own are two: edit the items and cancel, while the order is still
 * PENDING or DRAFT (the only ones the order API accepts from a customer). This only hides what the
 * session cannot use; the server still decides.
 *
 * Fails closed: a role this file does not name (DRIVER, or no session while auth loads) is treated as
 * non-staff, so it is offered nothing here.
 */

/** The roles that run the order's staff actions: the server's staff set (SUPER_ADMIN satisfies every role there). */
const STAFF_ROLES: ReadonlySet<string> = new Set(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"]);

/** The statuses in which a customer may still change or cancel their own order. */
const CUSTOMER_OPEN_STATUSES: ReadonlySet<string> = new Set(["PENDING", "DRAFT"]);

export interface OrderActionAccess {
  /** Status transitions (Publish, Confirm, Out for Delivery, Delivered, Unconfirm, Reopen), Delete, Record return. */
  staff: boolean;
  /** The "Edit Items" button (the page's own `canEdit` still applies on top). */
  editItems: boolean;
  /** The "Cancel Order" button. */
  cancel: boolean;
  /** A customer's way forward on an order with the carrier: it has shipped, so offer the exits that exist. */
  shippedExits: boolean;
  /** Invoice card controls: "Generate Invoice (full order)" and "Split into invoice…". */
  invoiceActions: boolean;
  /** The Summary card's Fulfillment row (the delivery-route / carrier selector). */
  fulfillmentPath: boolean;
  /** The Shipment card's "Add tracking" / "Edit shipment" (the tracking details stay visible). */
  shipmentEdit: boolean;
}

export function orderActionAccess(
  role: string | null | undefined,
  status: string,
  withCarrier: boolean,
): OrderActionAccess {
  const staff = !!role && STAFF_ROLES.has(role);
  const customer = role === "CUSTOMER";
  // A customer's open order that is with the carrier is frozen too (SA-696): nothing to edit or cancel.
  const customerMay = customer && CUSTOMER_OPEN_STATUSES.has(status) && !withCarrier;
  return {
    staff,
    editItems: staff || customerMay,
    cancel: staff || customerMay,
    shippedExits: customer && withCarrier,
    invoiceActions: staff,
    fulfillmentPath: staff,
    shipmentEdit: staff,
  };
}
