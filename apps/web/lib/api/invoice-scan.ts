import { apiClient } from "../api-client";

export interface ScannedItem {
  extractedName: string;
  qty: number;
  unitCost: number;
  lineTotal: number | null;
  matchedProductId: string | null;
  matchedProductName: string | null;
  confidence: "high" | "medium" | "low" | "none";
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
 * Scan one or more invoice files (image pages or a PDF) in a single AI call.
 * Multi-page invoices: pass each page as its own File — the API combines them.
 * HEIC files (iPhone photos) are accepted and converted server-side to JPEG.
 */
export async function scanInvoice(files: File | File[]): Promise<ScanResult> {
  const formData = new FormData();
  const arr = Array.isArray(files) ? files : [files];
  for (const f of arr) formData.append("images", f, f.name);
  const response = await apiClient.post("/vendor-bills/scan-invoice", formData, {
    headers: { "Content-Type": "multipart/form-data" },
    // Multi-page scans + HEIC conversion can take longer; allow up to 120s.
    timeout: 120_000,
  });
  return response.data as ScanResult;
}
