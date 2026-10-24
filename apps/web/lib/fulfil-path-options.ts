/**
 * The staff order-detail "Fulfillment" select. Every fulfil path has a label, so a PICKUP order never renders a
 * blank select; PICKUP is shown but not selectable (the PATCH only writes ROUTE / SHIP — writable-fulfill-paths.ts).
 */
export type FulfilPath = "ROUTE" | "SHIP" | "PICKUP";

const LABELS: Record<FulfilPath, string> = {
  ROUTE: "Delivery route",
  SHIP: "Ship via carrier",
  PICKUP: "Pick up at store",
};

export const fulfilPathLabel = (path: FulfilPath): string => LABELS[path];

export function fulfilPathOptions(
  current: FulfilPath | null | undefined,
): Array<{ value: FulfilPath; label: string; disabled?: boolean }> {
  const writable = (["ROUTE", "SHIP"] as const).map((value) => ({ value, label: LABELS[value] }));
  return current === "PICKUP"
    ? [...writable, { value: "PICKUP", label: LABELS.PICKUP, disabled: true }]
    : writable;
}
