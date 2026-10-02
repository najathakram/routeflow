import { API_ERROR_CODES } from "@routeflow/types";
import type {
  ProductCodeTakenError,
  ProductHoldersChangedError,
  ProductReactivationHolder,
} from "@routeflow/types";

/**
 * WS7: reactivating a product can be refused with a 409 naming the ACTIVE product(s) that now hold one
 * of its codes or its name (CODE_TAKEN / BARCODE_TAKEN / NAME_TAKEN), or the stale-holder-set code when a resolve
 * was sent with a stale holder set. The copy is mapped from code + field only — the server `message` is
 * never shown (L: no raw server strings).
 */

export interface ReactivationHolderView {
  productId: string;
  productName: string;
  /** The fixed plain-language line for this holder. */
  line: string;
  /** The server refuses to deactivate this holder in the one call (a family / has active variants). */
  blocked: boolean;
}

export type ReactivationRefusal =
  | {
      kind: "HOLDERS";
      holders: ReactivationHolderView[];
      /** Distinct holder ids — exactly what `deactivateHolderIds` must carry. */
      holderIds: string[];
      /** False when any holder is blocked: only "change it on that product" is offered. */
      canResolve: boolean;
    }
  | { kind: "RETRY" };

const WHAT: Record<"sku" | "unitSku" | "barcode", { noun: string; fix: string }> = {
  sku: { noun: "the SKU", fix: "a new SKU" },
  unitSku: { noun: "the unit code", fix: "a new unit code" },
  barcode: { noun: "the barcode", fix: "a new barcode" },
};

function holderLine(h: ProductReactivationHolder): string {
  if (h.code === API_ERROR_CODES.NAME_TAKEN || h.field === "name") {
    return `Can't reactivate: an active product is already named "${h.value || h.productName}". Rename one of them first.`;
  }
  const w = WHAT[h.field as "sku" | "unitSku" | "barcode"] ?? WHAT.sku;
  return `Can't reactivate: ${w.noun} "${h.value}" is now used by ${h.productName}. Change it on that product, or give this one ${w.fix}.`;
}

const isHolder = (h: unknown): h is ProductReactivationHolder => {
  const x = h as Partial<ProductReactivationHolder> | null;
  return (
    !!x &&
    typeof x.productId === "string" &&
    x.productId.length > 0 &&
    typeof x.productName === "string"
  );
};

/** The refusal to show in the dialog, or null when `err` is anything else (the caller toasts it). */
export function getReactivationRefusal(err: unknown): ReactivationRefusal | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data as
    (Partial<ProductCodeTakenError> & Partial<ProductHoldersChangedError>) | undefined;
  if (!data || typeof data !== "object") return null;
  if (data.code === API_ERROR_CODES.HOLDERS_CHANGED) return { kind: "RETRY" };
  if (
    data.code !== API_ERROR_CODES.CODE_TAKEN &&
    data.code !== API_ERROR_CODES.BARCODE_TAKEN &&
    data.code !== API_ERROR_CODES.NAME_TAKEN
  ) {
    return null;
  }
  const listed = Array.isArray(data.holders) ? data.holders.filter(isHolder) : [];
  // The flat keys repeat holders[0]; they stand alone when the server sent no holders[].
  const source: ProductReactivationHolder[] = listed.length
    ? listed
    : isHolder(data)
      ? [data as ProductReactivationHolder]
      : [];
  if (source.length === 0) {
    // A name clash with no holder to name still gets its sentence (the value), but nothing to link or
    // resolve. Any other clash without a holder has nothing to say: the caller toasts generically.
    if (data.code !== API_ERROR_CODES.NAME_TAKEN || typeof data.value !== "string") return null;
    return {
      kind: "HOLDERS",
      holders: [
        {
          productId: "",
          productName: "",
          line: holderLine({ ...(data as ProductReactivationHolder), field: "name" }),
          blocked: false,
        },
      ],
      holderIds: [],
      canResolve: false,
    };
  }
  const holders = source.map((h) => ({
    productId: h.productId,
    productName: h.productName,
    line: holderLine(h),
    blocked: h.blocked === "HAS_ACTIVE_VARIANTS",
  }));
  return {
    kind: "HOLDERS",
    holders,
    holderIds: [...new Set(holders.map((h) => h.productId))],
    canResolve: holders.every((h) => !h.blocked) && holders.length > 0,
  };
}

/** The one-call button text: "Deactivate <holder> and reactivate this". */
export function reactivationResolveLabel(names: string[]): string {
  if (names.length === 1) return `Deactivate "${names[0]}" and reactivate this`;
  if (names.length === 2) return `Deactivate "${names[0]}" and "${names[1]}" and reactivate this`;
  return `Deactivate ${names.length} products and reactivate this`;
}

const DEACTIVATE_CONFLICT_LINES: Record<string, string> = {
  [API_ERROR_CODES.CODES_CHANGED]:
    "Someone changed this product's codes at the same time. Refresh and try again.",
  [API_ERROR_CODES.CATALOG_TOO_LARGE_FOR_CLEAR_ALL]:
    "Too many products to remove at once. Select fewer and try again.",
};

/** READ_ONLY's 403 already gets the global "workspace is read-only" toast: a caller must not add a second. */
export function isReadOnlyRefusal(err: unknown): boolean {
  return (
    (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code ===
    API_ERROR_CODES.READ_ONLY
  );
}

/**
 * The toast for a failed deactivate / archive / delete. `CODES_CHANGED` (a live code the writer had
 * not locked up front) and `CATALOG_TOO_LARGE_FOR_CLEAR_ALL` (clear-all / bulk delete above the lock
 * cap) each get one fixed sentence; anything else is the bare `title` — the server message is never
 * shown.
 */
export function deactivateFailureToast(
  err: unknown,
  title: string,
): { title: string; description?: string; variant: "error" } {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  const line = typeof code === "string" ? DEACTIVATE_CONFLICT_LINES[code] : undefined;
  return line ? { title, description: line, variant: "error" } : { title, variant: "error" };
}
