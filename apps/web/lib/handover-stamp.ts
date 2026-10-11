import { cashierNameOf } from "@routeflow/pricing";

/**
 * Row 342: "Handed over at register main by Pat" on the staff order / invoice detail. Read-only: the stamp is what the API
 * sent (`registerKey`, `handedOverBy`, the `soldBy` cashier), staff reads only; a buyer's read has none of them.
 */

/** The cashier relation as the staff reads send it (the API selects the username only; the rest is tolerated). */
export interface HandOverSoldBy {
  id?: string | null;
  username?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** The slice of an order (or an invoice's linked `order`) the stamp reads. */
export interface HandOverStampSource {
  /** the register the order was handed over at (null/absent = not stamped) */
  registerKey?: string | null;
  /** the display name the API built once (`cashierNameOf` of the cashier's username); null = none */
  handedOverBy?: string | null;
  soldBy?: HandOverSoldBy | null;
}

/** The roles that run the till and see who handed an order over (the server's staff set; anything else fails closed). */
const STAMP_ROLES: ReadonlySet<string> = new Set(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"]);
export const seesHandOverStamp = (role: string | null | undefined): boolean =>
  !!role && STAMP_ROLES.has(role);

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/** Who handed it over: the API's `handedOverBy`, else the cashier's username (never an email), else a name. */
export function handOverStampName(order: HandOverStampSource | null | undefined): string | null {
  if (!order) return null;
  const sent = clean(order.handedOverBy);
  if (sent) return sent;
  const by = order.soldBy;
  if (!by) return null;
  const username = cashierNameOf(by);
  if (username) return username;
  const name = clean(by.name);
  if (name && !name.includes("@")) return name;
  const full = [clean(by.firstName), clean(by.lastName)].filter(Boolean).join(" ");
  return full || null;
}

/**
 * The quiet info line: `Handed over at register main by Pat`, `Handed over at register main` (no cashier stamped),
 * `Handed over by Pat` (no register stamped), or null when neither is present.
 */
export function handOverStampLine(order: HandOverStampSource | null | undefined): string | null {
  if (!order) return null;
  const register = clean(order.registerKey);
  const name = handOverStampName(order);
  if (!register && !name) return null;
  return `Handed over${register ? ` at register ${register}` : ""}${name ? ` by ${name}` : ""}`;
}

/**
 * Whether the order was handed over at the till: a counter sale, or a PICKUP order that is DELIVERED (picked up). A page that
 * does not carry `fulfillPath` (the invoice's order stub) shows the stamp whenever it exists: only a hand-over is stamped.
 */
export function isHandedOver(order: {
  status?: string | null;
  fulfillPath?: string | null;
  counterSale?: boolean | null;
}): boolean {
  if (order.counterSale === true) return true;
  if (!order.fulfillPath) return true;
  return order.fulfillPath === "PICKUP" && order.status === "DELIVERED";
}
