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

export async function scanInvoice(file: File): Promise<ScanResult> {
  const formData = new FormData();
  formData.append("image", file);
  const response = await apiClient.post("/vendor-bills/scan-invoice", formData, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 60_000, // AI processing can take up to 60s
  });
  return response.data as ScanResult;
}
