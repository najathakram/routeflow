import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { PackingSlipPage } from "./packing-slip-data";

/**
 * Packing slips (#3168): one Page per order. Quantities only: this document must never print a money
 * field (see packing-slip-data.ts and its spec).
 */
const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica", color: "#111" },
  title: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 14 },
  label: { fontSize: 8, color: "#666", marginBottom: 2 },
  block: { flex: 1 },
  th: { flexDirection: "row", borderBottomWidth: 1, borderColor: "#999", paddingBottom: 4 },
  tr: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderColor: "#ddd" },
  colName: { flex: 4 },
  colSku: { flex: 2 },
  colQty: { flex: 2, textAlign: "right" },
});

export function PackingSlipPdfTemplate({ pages }: { pages: PackingSlipPage[] }) {
  return (
    <Document>
      {pages.map((p) => (
        <Page key={p.orderId} size="LETTER" style={styles.page}>
          <Text style={styles.title}>Packing slip</Text>
          <View style={styles.row}>
            <View style={styles.block}>
              <Text style={styles.label}>FROM</Text>
              <Text>{p.seller.businessName ?? ""}</Text>
              {p.seller.addressLine1 ? <Text>{p.seller.addressLine1}</Text> : null}
              {p.seller.addressLine2 ? <Text>{p.seller.addressLine2}</Text> : null}
              <Text>
                {[p.seller.city, [p.seller.state, p.seller.zip].filter(Boolean).join(" ")]
                  .filter(Boolean)
                  .join(", ")}
              </Text>
            </View>
            <View style={styles.block}>
              <Text style={styles.label}>SHIP TO</Text>
              {p.shipTo.map((l, i) => (
                <Text key={i}>{l}</Text>
              ))}
            </View>
            <View style={styles.block}>
              <Text style={styles.label}>ORDER</Text>
              <Text>{p.orderNumber}</Text>
              {p.carrier ? <Text>Carrier: {p.carrier}</Text> : null}
              {p.trackingNumber ? <Text>Tracking: {p.trackingNumber}</Text> : null}
            </View>
          </View>
          <View style={styles.th}>
            <Text style={styles.colName}>Item</Text>
            <Text style={styles.colSku}>SKU</Text>
            <Text style={styles.colQty}>Qty</Text>
          </View>
          {p.lines.map((l, i) => (
            <View key={i} style={styles.tr} wrap={false}>
              <Text style={styles.colName}>
                {l.name}
                {l.backordered ? "  [BACKORDER]" : ""}
              </Text>
              <Text style={styles.colSku}>{l.sku ?? ""}</Text>
              <Text style={styles.colQty}>{l.qtyText}</Text>
            </View>
          ))}
        </Page>
      ))}
    </Document>
  );
}
