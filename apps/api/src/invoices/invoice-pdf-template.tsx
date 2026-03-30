import React from "react";
import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";

type DecimalLike = { toNumber(): number } | number | string;

export interface InvoicePdfData {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: Date | string;
  dueDate?: Date | string | null;
  paidAt?: Date | string | null;
  subtotal: DecimalLike;
  taxAmount: DecimalLike;
  discount: DecimalLike;
  shippingFee: DecimalLike;
  total: DecimalLike;
  notes?: string | null;
  terms?: string | null;
  customer: {
    businessName: string;
    contactName?: string | null;
    phone?: string | null;
    addresses?: Array<{
      line1: string;
      city: string;
      state: string;
      zip: string;
      isDefault: boolean;
    }>;
  };
  items: Array<{
    id: string;
    description: string;
    qty: DecimalLike;
    unitPrice: DecimalLike;
    discount: DecimalLike;
    taxRate: DecimalLike;
    subtotal: DecimalLike;
    product?: { name: string } | null;
    barcodeDataUri?: string;
    barcodeText?: string;
  }>;
  payments: Array<{
    id: string;
    amount: DecimalLike;
    method: string;
    reference?: string | null;
    notes?: string | null;
    paidAt: Date | string;
  }>;
}

const toNum = (val: DecimalLike): number => {
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val);
  return val.toNumber();
};
const fmt = (val: DecimalLike) => `$${toNum(val).toFixed(2)}`;
const fmtDate = (val: Date | string | null | undefined): string => {
  if (!val) return "—";
  return new Date(val).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const NAVY = "#1B3A5C";
const BRAND = "#3B6FCA";
const GRAY = "#64748b";
const LIGHT_GRAY = "#f1f5f9";
const BORDER = "#e2e8f0";
const SUCCESS = "#16a34a";
const WARNING = "#d97706";
const DANGER = "#dc2626";

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: NAVY,
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 44,
    backgroundColor: "#ffffff",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 28,
    paddingBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: NAVY,
  },
  logoBox: { flexDirection: "row", alignItems: "center", gap: 8 },
  logoSquare: {
    width: 28,
    height: 28,
    backgroundColor: BRAND,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 13, fontFamily: "Helvetica-Bold", color: NAVY },
  logoSub: { fontSize: 8, color: GRAY, marginTop: 2 },
  invoiceTitle: { fontSize: 22, fontFamily: "Helvetica-Bold", color: NAVY, letterSpacing: 1 },
  invoiceNumber: { fontSize: 9, color: GRAY, marginTop: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, marginTop: 6 },
  billGrid: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  billSection: { flex: 1, paddingRight: 16 },
  billLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: GRAY,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  billValue: { fontSize: 10, fontFamily: "Helvetica-Bold", color: NAVY, marginBottom: 2 },
  billSub: { fontSize: 9, color: GRAY, marginBottom: 1 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: NAVY,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  tableHeaderText: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: "#ffffff",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  tableRowAlt: { backgroundColor: LIGHT_GRAY },
  colDescription: { flex: 3 },
  colQty: { flex: 1, textAlign: "right" },
  colUnit: { flex: 1.4, textAlign: "right" },
  colSubtotal: { flex: 1.4, textAlign: "right" },
  cellText: { fontSize: 9, color: NAVY },
  cellTextRight: { fontSize: 9, color: NAVY, textAlign: "right" },
  totalsWrapper: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
  totalsBox: { width: 220 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  totalLabel: { fontSize: 9, color: GRAY },
  totalValue: { fontSize: 9, color: NAVY, fontFamily: "Helvetica-Bold" },
  totalDivider: { borderTopWidth: 1, borderTopColor: BORDER, marginVertical: 4 },
  totalBigRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  totalBigLabel: { fontSize: 11, fontFamily: "Helvetica-Bold", color: NAVY },
  totalBigValue: { fontSize: 11, fontFamily: "Helvetica-Bold", color: NAVY },
  sectionTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: GRAY,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 20,
  },
  paymentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 44,
    right: 44,
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerText: { fontSize: 7, color: GRAY },
});

function StatusBadge({ status }: { status: string }) {
  let bg = LIGHT_GRAY,
    color = GRAY,
    label = status;
  if (status === "PAID") {
    bg = "#dcfce7";
    color = SUCCESS;
  }
  if (status === "PARTIAL") {
    bg = "#fef3c7";
    color = WARNING;
  }
  if (status === "OVERDUE") {
    bg = "#fee2e2";
    color = DANGER;
  }
  if (status === "VOID") {
    bg = "#f1f5f9";
    color = GRAY;
  }
  if (status === "WRITTEN_OFF") {
    bg = "#f5f5f4";
    color = "#78716c";
  }
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color, fontSize: 8, fontFamily: "Helvetica-Bold" }}>{label}</Text>
    </View>
  );
}

export function InvoicePdfTemplate({ invoice }: { invoice: InvoicePdfData }) {
  const subtotal = toNum(invoice.subtotal);
  const taxAmount = toNum(invoice.taxAmount);
  const discount = toNum(invoice.discount);
  const shippingFee = toNum(invoice.shippingFee);
  const total = toNum(invoice.total);
  const totalPaid = invoice.payments.reduce((s, p) => s + toNum(p.amount), 0);
  const balance = total - totalPaid;
  const addr =
    invoice.customer.addresses?.find((a) => a.isDefault) ?? invoice.customer.addresses?.[0];

  return (
    <Document title={`Invoice ${invoice.invoiceNumber}`} author="RouteFlow">
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <View style={styles.logoBox}>
              <View style={styles.logoSquare}>
                <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "#fff" }}>RF</Text>
              </View>
              <Text style={styles.logoText}>RouteFlow</Text>
            </View>
            <Text style={styles.logoSub}>routeflow.io</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.invoiceTitle}>INVOICE</Text>
            <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
            <StatusBadge status={invoice.status} />
          </View>
        </View>

        {/* Billing info */}
        <View style={styles.billGrid}>
          <View style={styles.billSection}>
            <Text style={styles.billLabel}>Bill To</Text>
            <Text style={styles.billValue}>{invoice.customer.businessName}</Text>
            {invoice.customer.contactName ? (
              <Text style={styles.billSub}>{invoice.customer.contactName}</Text>
            ) : null}
            {invoice.customer.phone ? (
              <Text style={styles.billSub}>{invoice.customer.phone}</Text>
            ) : null}
            {addr ? (
              <Text style={styles.billSub}>
                {addr.line1}, {addr.city}, {addr.state} {addr.zip}
              </Text>
            ) : null}
          </View>
          <View style={{ flex: 1, alignItems: "flex-end" }}>
            <Text style={styles.billLabel}>Invoice Details</Text>
            <Text style={styles.billSub}>Invoice Date: {fmtDate(invoice.issueDate)}</Text>
            {invoice.dueDate ? (
              <Text style={styles.billSub}>Due Date: {fmtDate(invoice.dueDate)}</Text>
            ) : null}
            {invoice.paidAt ? (
              <Text style={[styles.billSub, { color: SUCCESS }]}>
                Paid: {fmtDate(invoice.paidAt)}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Line items */}
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colDescription]}>Description</Text>
          <Text style={[styles.tableHeaderText, styles.colQty]}>Qty</Text>
          <Text style={[styles.tableHeaderText, styles.colUnit]}>Unit Price</Text>
          <Text style={[styles.tableHeaderText, styles.colSubtotal]}>Subtotal</Text>
        </View>
        {invoice.items.map((item, idx) => (
          <View key={item.id} style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowAlt : {}]}>
            <View style={styles.colDescription}>
              <Text style={styles.cellText}>{item.description}</Text>
              {item.barcodeDataUri ? (
                <View style={{ marginTop: 3 }}>
                  <Image
                    src={item.barcodeDataUri}
                    style={{ height: 18, width: 80, objectFit: "contain" }}
                  />
                  <Text style={{ fontSize: 6, color: "#64748b", marginTop: 1 }}>
                    {item.barcodeText}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.cellTextRight, styles.colQty]}>{toNum(item.qty).toFixed(2)}</Text>
            <Text style={[styles.cellTextRight, styles.colUnit]}>{fmt(item.unitPrice)}</Text>
            <Text style={[styles.cellTextRight, styles.colSubtotal]}>{fmt(item.subtotal)}</Text>
          </View>
        ))}

        {/* Totals */}
        <View style={styles.totalsWrapper}>
          <View style={styles.totalsBox}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>{fmt(subtotal)}</Text>
            </View>
            {taxAmount > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Tax</Text>
                <Text style={styles.totalValue}>{fmt(taxAmount)}</Text>
              </View>
            ) : null}
            {discount > 0 ? (
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: SUCCESS }]}>Discount</Text>
                <Text style={[styles.totalValue, { color: SUCCESS }]}>-{fmt(discount)}</Text>
              </View>
            ) : null}
            {shippingFee > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Shipping</Text>
                <Text style={styles.totalValue}>{fmt(shippingFee)}</Text>
              </View>
            ) : null}
            <View style={styles.totalDivider} />
            <View style={styles.totalBigRow}>
              <Text style={styles.totalBigLabel}>Total</Text>
              <Text style={styles.totalBigValue}>{fmt(total)}</Text>
            </View>
            {totalPaid > 0 ? (
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: SUCCESS }]}>Amount Paid</Text>
                <Text style={[styles.totalValue, { color: SUCCESS }]}>-{fmt(totalPaid)}</Text>
              </View>
            ) : null}
            <View style={styles.totalDivider} />
            <View style={styles.totalBigRow}>
              <Text style={[styles.totalBigLabel, { color: balance > 0 ? DANGER : SUCCESS }]}>
                Balance Due
              </Text>
              <Text style={[styles.totalBigValue, { color: balance > 0 ? DANGER : SUCCESS }]}>
                {fmt(balance > 0 ? balance : 0)}
              </Text>
            </View>
          </View>
        </View>

        {/* Payment history */}
        {invoice.payments.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Payment History</Text>
            {invoice.payments.map((pmt) => (
              <View key={pmt.id} style={styles.paymentRow}>
                <View>
                  <Text style={{ fontSize: 9, color: NAVY }}>{pmt.method}</Text>
                  {pmt.reference ? (
                    <Text style={{ fontSize: 8, color: GRAY }}>Ref: {pmt.reference}</Text>
                  ) : null}
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: SUCCESS }}>
                    {fmt(pmt.amount)}
                  </Text>
                  <Text style={{ fontSize: 8, color: GRAY }}>{fmtDate(pmt.paidAt)}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* Notes */}
        {invoice.notes ? (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={{ fontSize: 9, color: GRAY }}>{invoice.notes}</Text>
          </View>
        ) : null}

        {/* Terms */}
        {invoice.terms ? (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.sectionTitle}>Terms & Conditions</Text>
            <Text style={{ fontSize: 9, color: GRAY }}>{invoice.terms}</Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>RouteFlow · routeflow.io</Text>
          <Text style={styles.footerText}>Generated {fmtDate(new Date())}</Text>
        </View>
      </Page>
    </Document>
  );
}
