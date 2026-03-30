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
  items: ScannedItem[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  notes: string | null;
}

export async function scanInvoice(imageFile: File): Promise<ScanResult> {
  const formData = new FormData();
  formData.append("image", imageFile);
  const response = await apiClient.post("/vendor-bills/scan-invoice", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return response.data as ScanResult;
}
