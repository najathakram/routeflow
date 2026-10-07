import { API_ERROR_CODES } from "@routeflow/types";
import type {
  ProductCodeTakenError,
  ProductHoldersChangedError,
  ProductReactivationHolder,
} from "@routeflow/types";

/**
 * Mobile mirror of apps/web/lib/product-reactivation-refusal.ts. Reactivating a product can be refused with a 409
 * naming the ACTIVE product(s) that now hold one of its codes or its name (CODE_TAKEN / BARCODE_TAKEN / NAME_TAKEN), or
 * HOLDERS_CHANGED when a resolve carried a stale holder set. The copy is mapped from code + field only: the server
 * `message` is never shown.
 */
export interface ReactivationHolderView {
  productId: string;
  productName: string;
  line: string;
  /** The server refuses to deactivate this holder in the one call (it has active variants). */
  blocked: boolean;
}

export type ReactivationRefusal =
  | {
      kind: "HOLDERS";
      holders: ReactivationHolderView[];
      /** Distinct holder ids: exactly what `deactivateHolderIds` must carry. */
      holderIds: string[];
      /** False when any holder is blocked, or none can be named: nothing to offer but "change it there". */
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
    return `An active product is already named "${h.value || h.productName}". Rename one of them first.`;
  }
  const w = WHAT[h.field as "sku" | "unitSku" | "barcode"] ?? WHAT.sku;
  return `${w.noun[0]!.toUpperCase()}${w.noun.slice(1)} "${h.value}" is now used by ${h.productName}. Change it on that product, or give this one ${w.fix}.`;
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

/** The refusal to show, or null when `err` is anything else (the caller shows its generic line). */
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
    // A name clash with no holder to name still gets its sentence, but nothing to resolve.
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
    canResolve: holders.every((h) => !h.blocked),
  };
}

/** The PATCH body that re-sends the reactivation carrying the exact holder ids to deactivate. */
export function reactivationRetryPayload(
  id: string,
  deactivateHolderIds?: string[],
): { id: string; isActive: true; deactivateHolderIds?: string[] } {
  return {
    id,
    isActive: true,
    ...(deactivateHolderIds?.length ? { deactivateHolderIds } : {}),
  };
}

/** The one-call button text: "Deactivate <holder> and reactivate this". */
export function reactivationResolveLabel(names: string[]): string {
  if (names.length === 1) return `Deactivate "${names[0]}" and reactivate this`;
  if (names.length === 2) return `Deactivate "${names[0]}" and "${names[1]}" and reactivate this`;
  return `Deactivate ${names.length} products and reactivate this`;
}
