import type { PieceSnapshot } from "@/lib/scan-line-units";
import type { ReviewItem, InvoiceGroup } from "./types";

export const fmt = (n: number | null | undefined) =>
  n != null
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
    : "—";

export const emptyReviewItem = (): ReviewItem => ({
  extractedName: "",
  productId: "",
  description: "",
  qty: "1",
  unitCost: "",
  lineTotal: null,
  extractedQty: "1",
  extractedUnitCost: "",
  confidence: "none",
});

export const makeInvoice = (kind: "pdf" | "images", files: File[]): InvoiceGroup => ({
  id: crypto.randomUUID(),
  kind,
  files,
  pagePreviews: files.map((f) => ({
    url: URL.createObjectURL(f),
    type: f.type === "application/pdf" ? ("pdf" as const) : ("image" as const),
    name: f.name,
  })),
  previewIndex: 0,
  status: "scanning",
  error: null,
  scanResult: null,
  reviewItems: [],
  invoiceNumber: "",
  supplierId: "",
  supplierMatchAmbiguous: false,
  billDate: new Date().toISOString().slice(0, 10),
  dueDate: "",
  createMode: "bill",
  expenseCategoryId: "",
  expenseDescription: "",
  expenseDate: new Date().toISOString().slice(0, 10),
  expensePaymentMethod: "CASH",
  expenseNotes: "",
  createdBillId: null,
  expenseCreated: false,
  duplicate: null,
  duplicateCheckPending: false,
  allowDuplicate: false,
});

/**
 * Grouping rule (owner decision): each PDF is its own invoice; all image
 * files together are the pages of ONE invoice. A single file of either kind
 * behaves exactly like today's flow.
 */
export function groupFiles(files: File[]): Array<{ kind: "pdf" | "images"; files: File[] }> {
  const groups: Array<{ kind: "pdf" | "images"; files: File[] }> = [];
  const images: File[] = [];
  let imagesAt = -1;
  files.forEach((f) => {
    if (f.type === "application/pdf") {
      groups.push({ kind: "pdf", files: [f] });
    } else {
      if (imagesAt === -1) imagesAt = groups.length;
      images.push(f);
    }
  });
  if (images.length > 0) groups.splice(imagesAt, 0, { kind: "images", files: images });
  return groups;
}

/**
 * Scored supplier auto-match (replaces first-substring-wins): exact name →
 * unique startsWith → unique substring (either direction, longest name wins).
 * Several equally-plausible candidates → no silent pick, operator chooses.
 */
export function matchSupplier(
  detected: string,
  suppliers: Array<{ id: string; name: string }>,
): { id: string; ambiguous: boolean } {
  const d = detected.trim().toLowerCase();
  if (!d) return { id: "", ambiguous: false };
  const exact = suppliers.filter((s) => s.name.trim().toLowerCase() === d);
  if (exact.length === 1) return { id: exact[0].id, ambiguous: false };
  if (exact.length > 1) return { id: "", ambiguous: true };
  const starts = suppliers.filter(
    (s) => s.name.trim().toLowerCase().startsWith(d) || d.startsWith(s.name.trim().toLowerCase()),
  );
  if (starts.length === 1) return { id: starts[0].id, ambiguous: false };
  if (starts.length > 1) return { id: "", ambiguous: true };
  const contains = suppliers.filter((s) => {
    const n = s.name.trim().toLowerCase();
    return n.includes(d) || d.includes(n);
  });
  if (contains.length === 1) return { id: contains[0].id, ambiguous: false };
  return { id: "", ambiguous: contains.length > 1 };
}

/**
 * A row's pieces-terms canonical truth, derived from its current on-screen
 * qty/unitCost/packSize (unit is DERIVED from `packSize > 1`, never stored
 * separately). Recomputed after every DIRECT qty/unitCost/packSize edit so
 * the Boxes/Pieces toggle always replays what's actually on screen — never a
 * stale OCR extraction. The toggle itself must NOT call this: it replays the
 * row's existing `preConvert` snapshot instead, so repeated toggling never
 * drifts (see `toBillLine` in lib/scan-line-units.ts).
 */
export function canonicalizeLine(
  qty: string,
  unitCost: string,
  packSize: number | null,
): PieceSnapshot {
  const q = parseFloat(qty) || 0;
  const c = parseFloat(unitCost) || 0;
  const pack = packSize && packSize > 1 ? packSize : null;
  return pack ? { qtyPieces: q * pack, costPerPiece: c / pack } : { qtyPieces: q, costPerPiece: c };
}
