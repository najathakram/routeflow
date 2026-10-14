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
  /** Which code (or the name) this holder clashes on. */
  field: ProductReactivationHolder["field"];
  /** The clashing value. */
  value: string;
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

export type ReplaceableCodeField = "sku" | "unitSku" | "barcode";

/** Field order for the new-code step. */
const CODE_FIELD_ORDER: ReplaceableCodeField[] = ["sku", "unitSku", "barcode"];

/** The plain-language noun for a code field ("The {noun} "X" is now used by …"). */
export const CODE_NOUN: Record<ReplaceableCodeField, string> = {
  sku: "SKU",
  unitSku: "unit code",
  barcode: "barcode",
};

/** The tail of the blocked sentence, after "Blocked: {Holder}". */
export const BLOCKED_TAIL =
  "has active variants, so it can't be deactivated from here. Open it to change the code.";

function holderLine(h: ProductReactivationHolder): string {
  if (h.code === API_ERROR_CODES.NAME_TAKEN || h.field === "name") {
    return `Can't reactivate: an active product is already named "${h.value || h.productName}". Rename one of them first.`;
  }
  const noun = CODE_NOUN[h.field as ReplaceableCodeField] ?? CODE_NOUN.sku;
  const base = `The ${noun} "${h.value}" is now used by ${h.productName}.`;
  return h.blocked === "HAS_ACTIVE_VARIANTS"
    ? `${base} Blocked: ${h.productName} ${BLOCKED_TAIL}`
    : base;
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
          field: "name" as const,
          value: data.value as string,
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
    field: h.field,
    value: h.value,
  }));
  return {
    kind: "HOLDERS",
    holders,
    holderIds: [...new Set(holders.map((h) => h.productId))],
    canResolve: holders.every((h) => !h.blocked) && holders.length > 0,
  };
}

/**
 * The codes the operator can replace to get past this refusal, in field order and deduped, or null
 * when a new code cannot help (a name clash anywhere, a stale-holder retry, nothing to name).
 */
export function newCodeFields(refusal: ReactivationRefusal | null): ReplaceableCodeField[] | null {
  if (!refusal || refusal.kind !== "HOLDERS" || refusal.holders.length === 0) return null;
  if (refusal.holders.some((h) => !CODE_FIELD_ORDER.includes(h.field as ReplaceableCodeField))) {
    return null;
  }
  const fields = CODE_FIELD_ORDER.filter((f) => refusal.holders.some((h) => h.field === f));
  return fields.length ? fields : null;
}

/**
 * The write refused a replacement code that was free at the availability check: a 400 `PRODUCT_CODE_IN_USE`
 * (field named in `data.field`), or a 409 `CODE_TAKEN` (field sku | unitSku in `data.field`) / `BARCODE_TAKEN`
 * (always the barcode) from the write transaction. Returns the sent code field it names, else the first sent
 * field, or null for any other error. Call it only for a request that carried replacement codes: the pre-write
 * holders refusal for the ORIGINAL codes is the same 409 code. Only the code, status and field are read; no
 * server text is.
 */
export function codeTakenOnSubmit(
  err: unknown,
  sent: Partial<Record<ReplaceableCodeField, string>>,
): ReplaceableCodeField | null {
  const res = (
    err as { response?: { status?: unknown; data?: { code?: unknown; field?: unknown } } } | null
  )?.response;
  const code = res?.data?.code;
  let named: unknown;
  if (res?.status === 400 && code === API_ERROR_CODES.PRODUCT_CODE_IN_USE) named = res.data?.field;
  else if (res?.status === 409 && code === API_ERROR_CODES.CODE_TAKEN) named = res.data?.field;
  else if (res?.status === 409 && code === API_ERROR_CODES.BARCODE_TAKEN) named = "barcode";
  else return null;
  const field = CODE_FIELD_ORDER.find((f) => f === named);
  if (field && sent[field]) return field;
  return CODE_FIELD_ORDER.find((f) => sent[f]) ?? null;
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
  [API_ERROR_CODES.VARIANT_PARENT_INACTIVE]:
    "Turn the family back on first, then reactivate this variant.",
  [API_ERROR_CODES.PRODUCT_DELETE_CONFLICT]:
    "Nothing was deleted because something changed at the same time. Reload and try again.",
  [API_ERROR_CODES.PRODUCT_HAS_ACTIVE_ORDER_ITEMS]:
    "This product is on an order that is still open. Finish or cancel the order first.",
  [API_ERROR_CODES.FAMILY_NOT_PRICEABLE]:
    "A product family can't be priced or promoted. Use its variants instead.",
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
