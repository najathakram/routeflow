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
  tenant?: {
    businessName?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
    phone?: string | null;
    website?: string | null;
    customerEmail?: string | null;
    primaryColor?: string | null;
    logoDataUri?: string | null;
  } | null;
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

const DEFAULT_NAVY = "#1B3A5C";
const DEFAULT_BRAND = "#3B6FCA";
const GRAY = "#64748b";
const LIGHT_GRAY = "#f1f5f9";
const BORDER = "#e2e8f0";
const SUCCESS = "#16a34a";
const WARNING = "#d97706";
const DANGER = "#dc2626";

// Darken a hex color by a factor (0-1). Used to derive a "navy" from the
// tenant's primary color when they don't supply a separate dark color.
function darken(hex: string, factor = 0.55): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return DEFAULT_NAVY;
  const r = Math.max(0, Math.round(parseInt(clean.slice(0, 2), 16) * factor));
  const g = Math.max(0, Math.round(parseInt(clean.slice(2, 4), 16) * factor));
  const b = Math.max(0, Math.round(parseInt(clean.slice(4, 6), 16) * factor));
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function buildStyles(primary: string, navy: string) {
  return StyleSheet.create({
    page: {
      fontFamily: "Helvetica",
      fontSize: 9,
      color: navy,
      paddingTop: 40,
      // Extra room at the bottom so the fixed footer + the floating Terms
      // block both fit without colliding with line items or totals.
      paddingBottom: 50,
      paddingHorizontal: 44,
      backgroundColor: "#ffffff",
      // Column flex lets `marginTop: "auto"` on the Terms wrapper push it
      // to the bottom of the page above the footer.
      flexDirection: "column",
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 28,
      paddingBottom: 20,
      borderBottomWidth: 2,
      borderBottomColor: navy,
    },
    logoBox: { flexDirection: "row", alignItems: "center", gap: 8 },
    logoImage: { height: 40, width: 40, objectFit: "contain" },
    logoSquare: {
      width: 28,
      height: 28,
      backgroundColor: primary,
      borderRadius: 4,
      alignItems: "center",
      justifyContent: "center",
    },
    logoText: { fontSize: 13, fontFamily: "Helvetica-Bold", color: navy },
    logoSub: { fontSize: 8, color: GRAY, marginTop: 2 },
    invoiceTitle: { fontSize: 22, fontFamily: "Helvetica-Bold", color: navy, letterSpacing: 1 },
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
    billValue: { fontSize: 10, fontFamily: "Helvetica-Bold", color: navy, marginBottom: 2 },
    billSub: { fontSize: 9, color: GRAY, marginBottom: 1 },
    tableHeader: {
      flexDirection: "row",
      backgroundColor: navy,
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
    cellText: { fontSize: 9, color: navy },
    cellTextRight: { fontSize: 9, color: navy, textAlign: "right" },
    totalsWrapper: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
    totalsBox: { width: 220 },
    totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
    totalLabel: { fontSize: 9, color: GRAY },
    totalValue: { fontSize: 9, color: navy, fontFamily: "Helvetica-Bold" },
    totalDivider: { borderTopWidth: 1, borderTopColor: BORDER, marginVertical: 4 },
    totalBigRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
    totalBigLabel: { fontSize: 11, fontFamily: "Helvetica-Bold", color: navy },
    totalBigValue: { fontSize: 11, fontFamily: "Helvetica-Bold", color: navy },
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
    footerMuted: { fontSize: 7, color: "#94a3b8" },
    // Terms block — fills the remaining space above the page footer so the
    // T&Cs always sit at the bottom of the printed page rather than directly
    // under the totals. The light-gray fill + accent border make them feel
    // like a separate section without dominating the rest of the layout.
    termsWrapper: {
      marginTop: "auto",
      paddingTop: 14,
    },
    termsBox: {
      borderTopWidth: 2,
      borderTopColor: navy,
      backgroundColor: LIGHT_GRAY,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 4,
    },
    termsLabel: {
      fontSize: 8,
      fontFamily: "Helvetica-Bold",
      color: navy,
      textTransform: "uppercase",
      letterSpacing: 1,
      marginBottom: 6,
    },
    termsBody: {
      fontSize: 8.5,
      color: "#475569",
      lineHeight: 1.45,
    },
  });
}

function StatusBadge({
  status,
  styles,
}: {
  status: string;
  styles: ReturnType<typeof buildStyles>;
}) {
  let bg = LIGHT_GRAY;
  let color = GRAY;
  const label = status;
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

  const tenant = invoice.tenant ?? null;
  const hasTenant = !!tenant?.businessName;
  const tenantAddrLine = [tenant?.city, [tenant?.state, tenant?.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  // Resolve per-render brand colors from tenant, with safe fallbacks.
  const primary =
    tenant?.primaryColor && /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.test(tenant.primaryColor)
      ? tenant.primaryColor
      : DEFAULT_BRAND;
  const navy = primary === DEFAULT_BRAND ? DEFAULT_NAVY : darken(primary);
  const styles = buildStyles(primary, navy);

  return (
    <Document title={`Invoice ${invoice.invoiceNumber}`} author={tenant?.businessName ?? undefined}>
      <Page size="A4" style={styles.page}>
        {/*
          Wrap everything *above* the Terms in a flexGrow:1 container.
          react-pdf occasionally ignores `marginTop: auto` alone — making
          the wrapper grow guarantees the Terms block ends up flush with
          the bottom of the page (above the fixed footer) regardless of
          how short the invoice body is.
        */}
        <View style={{ flexGrow: 1 }}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            {hasTenant ? (
              <>
                <View style={styles.logoBox}>
                  {tenant.logoDataUri ? (
                    <Image src={tenant.logoDataUri} style={styles.logoImage} />
                  ) : null}
                  <Text style={styles.logoText}>{tenant.businessName}</Text>
                </View>
                {tenant.addressLine1 ? (
                  <Text style={styles.logoSub}>{tenant.addressLine1}</Text>
                ) : null}
                {tenant.addressLine2 ? (
                  <Text style={styles.logoSub}>{tenant.addressLine2}</Text>
                ) : null}
                {tenantAddrLine ? <Text style={styles.logoSub}>{tenantAddrLine}</Text> : null}
                {tenant.phone ? <Text style={styles.logoSub}>{tenant.phone}</Text> : null}
                {tenant.customerEmail ? (
                  <Text style={styles.logoSub}>{tenant.customerEmail}</Text>
                ) : null}
                {tenant.website ? <Text style={styles.logoSub}>{tenant.website}</Text> : null}
              </>
            ) : (
              <View style={styles.logoBox}>
                <View style={styles.logoSquare}>
                  <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "#fff" }}>
                    RF
                  </Text>
                </View>
                <Text style={styles.logoText}>RouteFlow</Text>
              </View>
            )}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.invoiceTitle}>INVOICE</Text>
            <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
            <StatusBadge status={invoice.status} styles={styles} />
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
                  <Text style={{ fontSize: 9, color: navy }}>{pmt.method}</Text>
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
        </View>{/* /flexGrow:1 wrapper */}

        {/*
          Terms & Conditions — sits OUTSIDE the flexGrow:1 wrapper above
          and is therefore pushed to the bottom of the last page (above
          the fixed footer) regardless of how short the invoice body is.
          Styled as a distinct callout block (accent top border + light
          fill) so it reads as a separate section rather than another row
          of body copy.
        */}
        {invoice.terms ? (
          <View style={styles.termsWrapper} wrap={false}>
            <View style={styles.termsBox}>
              <Text style={styles.termsLabel}>Terms &amp; Conditions</Text>
              <Text style={styles.termsBody}>{invoice.terms}</Text>
            </View>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {hasTenant
              ? [tenant.businessName, tenant.website].filter(Boolean).join(" · ")
              : "RouteFlow"}
          </Text>
          <Text style={styles.footerMuted}>Powered by RouteFlow</Text>
          <Text style={styles.footerText}>Generated {fmtDate(new Date())}</Text>
        </View>
      </Page>
    </Document>
  );
}
