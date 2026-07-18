import { apiClient } from "../api-client";

/** A ranked "Did you mean…" suggestion for a line that didn't confidently match. */
export interface ScanCandidate {
  productId: string;
  /** Composed display name (e.g. "Big Red Chewing Gum - Cinnamon"). */
  name: string;
  sku: string | null;
  /** Weighted-overlap score, 0..1. */
  score: number;
}

export interface ScannedItem {
  extractedName: string;
  qty: number;
  unitCost: number;
  lineTotal: number | null;
  matchedProductId: string | null;
  matchedProductName: string | null;
  confidence: "high" | "medium" | "low" | "none";
  /** Item code / SKU printed on the line, as read by the OCR (if any). */
  sku?: string | null;
  /** Ranked alternates when the match was too weak to auto-assign. */
  candidates?: ScanCandidate[];
}

export interface ScanResult {
  supplier: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  expenseDescription: string | null;
  expenseCategory: string | null;
  items: ScannedItem[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  notes: string | null;
}

/**
 * Scan the files of ONE invoice (image pages or a PDF) in a single AI call.
 * Multi-page invoices: pass each page as its own File — the API combines them.
 * Batch scans call this once per invoice; pass `signal` so an abandoned batch
 * actually aborts its in-flight requests.
 * HEIC files (iPhone photos) are accepted and converted server-side to JPEG.
 */
export async function scanInvoice(files: File | File[], signal?: AbortSignal): Promise<ScanResult> {
  const formData = new FormData();
  const arr = Array.isArray(files) ? files : [files];
  for (const f of arr) formData.append("images", f, f.name);
  const response = await apiClient.post("/vendor-bills/scan-invoice", formData, {
    headers: { "Content-Type": "multipart/form-data" },
    // Multi-page scans + HEIC conversion can take longer; allow up to 120s.
    timeout: 120_000,
    signal,
  });
  return response.data as ScanResult;
}
