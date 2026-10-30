import type { ToastData } from "@routeflow/ui/web";
import { unitWords } from "@routeflow/pricing";
import { markOrderCreatedHere } from "@/lib/order-created-echo";
import { formatMoney } from "@/lib/format";

export interface AddedLine {
  name: string;
  /** The quantity in the line's own words ("3 cases", "2 boxes + 6 pcs", "2"). See `addedLineQty`. */
  qty: string;
}

/** The quantity of one submitted line in its own unit words (pack + loose for a boxed line, the named unit, or a bare count). */
export function addedLineQty(li: {
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  unitLabel?: string;
  packLabel?: string | null;
  baseLabel?: string | null;
}): string {
  if (li.unitLabel) return `${li.qty} ${li.unitLabel}`;
  if (li.unitsPerBox) {
    const w = unitWords({ packLabel: li.packLabel, baseUnitLabel: li.baseLabel });
    const boxes = li.boxes ?? 0;
    const pieces = li.pieces ?? 0;
    const parts = [
      ...(boxes > 0 ? [`${boxes} ${w.packFor(boxes)}`] : []),
      ...(pieces > 0 ? [`${pieces} ${w.baseShortFor(pieces)}`] : []),
    ];
    if (parts.length) return parts.join(" + ");
  }
  return String(li.qty);
}

const MAX_NAMED_LINES = 3;

/** "+3 cases Corn Chips, +2 Iced Tea · new total $131.94", or null when there is nothing to say. */
function mergeDescription(
  addedLines: AddedLine[] | undefined,
  total: number | string | null | undefined,
): string | undefined {
  const lines = addedLines ?? [];
  const named = lines.slice(0, MAX_NAMED_LINES).map((l) => `+${l.qty} ${l.name}`);
  if (lines.length > MAX_NAMED_LINES) named.push(`+${lines.length - MAX_NAMED_LINES} more`);
  const parts = [
    named.join(", "),
    total != null && total !== "" && Number.isFinite(Number(total))
      ? `new total ${formatMoney(total)}`
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export interface OrderCreatedToastInput {
  /** The operator's answer to the merge prompt ("merge" folds the lines into an open order). */
  mergeChoice?: string | null;
  /** True for "Save as draft". */
  asDraft?: boolean | null;
  /** The API response — only `id` / `orderNumber` are read; the merge case returns the merged order. */
  created?: {
    id?: string | null;
    orderNumber?: string | null;
    /** The merged order's total AS THE SERVER RETURNED IT (a number or a Decimal string); shown, never recomputed. */
    total?: number | string | null;
  } | null;
  /** N01, merge only: what the merge added, one entry per submitted line ("3 cases" of "Corn Chips"). */
  addedLines?: AddedLine[];
  /** Navigates to an order. Optional: with no handler the toast has no action (the old behaviour). */
  onViewOrder?: (orderId: string) => void;
}

/**
 * The success toast for CreateOrderModal. The modal closes on success and the operator used to
 * have no path from the confirmation to the order (order-ui-redesign-spec.md §8): a forced
 * redirect would fight rapid multi-order entry, so this offers a one-click "View order" action
 * on the toast instead of navigating on its own.
 */
/** F28: with an action the toast stays until dismissed (the X), so a glance away never loses "View order". */
export const ACTION_TOAST_MS = 24 * 60 * 60 * 1000;

export function orderCreatedToast({
  mergeChoice,
  asDraft,
  created,
  addedLines,
  onViewOrder,
}: OrderCreatedToastInput): Omit<ToastData, "id"> {
  // F17: record this tab's own order so the realtime echo does not toast it a second time.
  markOrderCreatedHere(created?.orderNumber);
  const merged = mergeChoice === "merge";
  const orderId = created?.id ?? null;
  const action =
    orderId && onViewOrder
      ? {
          label: merged ? "View merged order" : "View order",
          onClick: () => onViewOrder(orderId),
        }
      : undefined;

  if (merged) {
    const description = mergeDescription(addedLines, created?.total);
    return {
      title: `Merged into order ${created?.orderNumber ?? "#" + created?.id?.slice(0, 6)}`,
      ...(description ? { description } : {}),
      variant: "success",
      action,
      ...(action ? { duration: ACTION_TOAST_MS } : {}),
    };
  }
  return {
    title: asDraft ? "Order saved as draft" : "Order created",
    variant: "success",
    action,
    ...(action ? { duration: ACTION_TOAST_MS } : {}),
  };
}

/** The id of the order-created toast still on screen, so the next one can replace it (row 604 S6). */
let lastOrderCreatedToastId: string | null = null;

/**
 * Shows the order-created toast, replacing the previous one rather than stacking a 24 h toast per order.
 * The echo dedupe (`markOrderCreatedHere`) still runs for every order, inside `orderCreatedToast`.
 */
export function showOrderCreatedToast(
  api: { toast: (data: Omit<ToastData, "id">) => string; dismiss: (id: string) => void },
  input: OrderCreatedToastInput,
): string {
  const data = orderCreatedToast(input);
  if (lastOrderCreatedToastId) api.dismiss(lastOrderCreatedToastId);
  lastOrderCreatedToastId = api.toast(data);
  return lastOrderCreatedToastId;
}
