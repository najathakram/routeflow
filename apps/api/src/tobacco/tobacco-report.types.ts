/** Per-product row of a monthly tobacco report. Decimals serialized as strings. */
export interface TobaccoReportRow {
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  qtyPurchased: string;
  purchaseValue: string;
  qtySold: string;
  salesValue: string;
  taxCollected: string;
  endingStockQty: string;
  endingStockValue: string;
}

export interface TobaccoReportTotals {
  totalQtyPurchased: number;
  totalPurchaseValue: number;
  totalQtySold: number;
  totalSalesValue: number;
  totalTaxCollected: number;
  endingStockQty: number;
  endingStockValue: number;
}
