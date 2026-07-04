import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { TobaccoReportRow, TobaccoReportTotals } from "./tobacco-report.types";

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: "Helvetica", color: "#1B3A5C" },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  subtitle: { fontSize: 10, color: "#5A6B7C", marginBottom: 14 },
  table: { borderWidth: 0.5, borderColor: "#C9D4DE" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#C9D4DE" },
  headRow: { backgroundColor: "#EEF3F8" },
  totalRow: { backgroundColor: "#EEF3F8", fontFamily: "Helvetica-Bold" },
  cellName: { flex: 2.2, padding: 4 },
  cell: { flex: 1, padding: 4, textAlign: "right" },
  head: { fontFamily: "Helvetica-Bold" },
  footer: { marginTop: 14, fontSize: 8, color: "#5A6B7C", lineHeight: 1.4 },
});

export function TobaccoReportPdf({
  businessName,
  periodLabel,
  rows,
  totals,
  generatedAt,
  generationCount,
}: {
  businessName: string;
  periodLabel: string;
  rows: TobaccoReportRow[];
  totals: TobaccoReportTotals;
  generatedAt: string;
  generationCount: number;
}) {
  const money = (n: number | string) => `$${Number(n).toFixed(2)}`;
  const qty = (n: number | string) =>
    Number(n)
      .toFixed(3)
      .replace(/\.000$/, "");

  return (
    <Document>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        <Text style={styles.title}>Monthly Tobacco Report — {periodLabel}</Text>
        <Text style={styles.subtitle}>
          {businessName} · Generated {generatedAt}
          {generationCount > 1 ? ` · regeneration #${generationCount}` : ""}
        </Text>

        <View style={styles.table}>
          <View style={[styles.row, styles.headRow]}>
            <Text style={[styles.cellName, styles.head]}>Product</Text>
            <Text style={[styles.cell, styles.head]}>Qty purchased</Text>
            <Text style={[styles.cell, styles.head]}>Purchase value</Text>
            <Text style={[styles.cell, styles.head]}>Qty sold</Text>
            <Text style={[styles.cell, styles.head]}>Sales value</Text>
            <Text style={[styles.cell, styles.head]}>Tax collected</Text>
            <Text style={[styles.cell, styles.head]}>Ending stock</Text>
            <Text style={[styles.cell, styles.head]}>Ending value</Text>
          </View>
          {rows.map((r) => (
            <View key={r.productId} style={styles.row}>
              <Text style={styles.cellName}>
                {r.name}
                {r.sku ? ` (${r.sku})` : ""}
              </Text>
              <Text style={styles.cell}>{qty(r.qtyPurchased)}</Text>
              <Text style={styles.cell}>{money(r.purchaseValue)}</Text>
              <Text style={styles.cell}>{qty(r.qtySold)}</Text>
              <Text style={styles.cell}>{money(r.salesValue)}</Text>
              <Text style={styles.cell}>{money(r.taxCollected)}</Text>
              <Text style={styles.cell}>{qty(r.endingStockQty)}</Text>
              <Text style={styles.cell}>{money(r.endingStockValue)}</Text>
            </View>
          ))}
          <View style={[styles.row, styles.totalRow]}>
            <Text style={[styles.cellName, styles.head]}>Totals ({rows.length} products)</Text>
            <Text style={[styles.cell, styles.head]}>{qty(totals.totalQtyPurchased)}</Text>
            <Text style={[styles.cell, styles.head]}>{money(totals.totalPurchaseValue)}</Text>
            <Text style={[styles.cell, styles.head]}>{qty(totals.totalQtySold)}</Text>
            <Text style={[styles.cell, styles.head]}>{money(totals.totalSalesValue)}</Text>
            <Text style={[styles.cell, styles.head]}>{money(totals.totalTaxCollected)}</Text>
            <Text style={[styles.cell, styles.head]}>{qty(totals.endingStockQty)}</Text>
            <Text style={[styles.cell, styles.head]}>{money(totals.endingStockValue)}</Text>
          </View>
        </View>

        <Text style={styles.footer}>
          Purchases = received PURCHASE stock movements of tobacco-flagged products in the period.
          Sales = invoice lines of tobacco-flagged products on non-draft/non-void invoices (tax =
          line subtotal × line tax rate). Ending stock value is priced at the product&apos;s CURRENT
          average cost, not the period-end historical cost. Period boundaries are UTC.
        </Text>
      </Page>
    </Document>
  );
}
