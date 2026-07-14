import React from "react";
import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import type { MonthlyStatement, StatementLineItem } from "./statement.service";

/**
 * P5-15: tenant branding shape for the monthly statement PDF header/footer.
 * Mirrors the `TenantInfo` shape loaded by InvoicePdfService — kept as its
 * own interface (rather than importing the invoice one) so the buyer/
 * statement surface has no dependency on the invoices module.
 */
export interface StatementTenantInfo {
  businessName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  website: string | null;
  customerEmail: string | null;
  primaryColor: string | null;
  logoKey: string | null;
  logoDataUri?: string;
}

const fmtDate = (val: Date | string | null | undefined): string => {
  if (!val) return "—";
  return new Date(val).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};
const fmtDateTime = (val: Date | string | null | undefined): string => {
  if (!val) return "—";
  return new Date(val).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};
const fmt = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const fmtSigned = (n: number) => (n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);

const DEFAULT_NAVY = "#1B3A5C";
const DEFAULT_BRAND = "#3B6FCA";
const GRAY = "#64748b";
const LIGHT_GRAY = "#f1f5f9";
const BORDER = "#e2e8f0";
const SUCCESS = "#16a34a";
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
      paddingBottom: 50,
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
    title: { fontSize: 22, fontFamily: "Helvetica-Bold", color: navy, letterSpacing: 1 },
    subtitle: { fontSize: 9, color: GRAY, marginTop: 4 },
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
    colDate: { flex: 1 },
    colDescription: { flex: 3 },
    colAmount: { flex: 1.2, textAlign: "right" },
    cellText: { fontSize: 9, color: navy },
    cellTextRight: { fontSize: 9, color: navy, textAlign: "right" },
    totalsWrapper: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
    totalsBox: { width: 240 },
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
  });
}

export function StatementPdfTemplate({
  statement,
  tenant,
  generatedAt,
}: {
  statement: MonthlyStatement;
  tenant: StatementTenantInfo | null;
  generatedAt: Date;
}) {
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

  const { period, customer, opening, charges, payments, credits, adjustments, closing } = statement;
  const hasAdjustments = adjustments !== 0;
  // `to` is exclusive — show the last covered calendar day.
  const periodEnd = new Date(new Date(period.to).getTime() - 1);

  return (
    <Document
      title={`Statement ${period.label} — ${customer.businessName}`}
      author={tenant?.businessName ?? undefined}
    >
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            {hasTenant ? (
              <>
                <View style={styles.logoBox}>
                  {tenant?.logoDataUri ? (
                    <Image src={tenant.logoDataUri} style={styles.logoImage} />
                  ) : null}
                  <Text style={styles.logoText}>{tenant?.businessName}</Text>
                </View>
                {tenant?.addressLine1 ? (
                  <Text style={styles.logoSub}>{tenant.addressLine1}</Text>
                ) : null}
                {tenant?.addressLine2 ? (
                  <Text style={styles.logoSub}>{tenant.addressLine2}</Text>
                ) : null}
                {tenantAddrLine ? <Text style={styles.logoSub}>{tenantAddrLine}</Text> : null}
                {tenant?.phone ? <Text style={styles.logoSub}>{tenant.phone}</Text> : null}
                {tenant?.customerEmail ? (
                  <Text style={styles.logoSub}>{tenant.customerEmail}</Text>
                ) : null}
                {tenant?.website ? <Text style={styles.logoSub}>{tenant.website}</Text> : null}
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
            <Text style={styles.title}>STATEMENT</Text>
            <Text style={styles.subtitle}>{period.label}</Text>
            <Text style={styles.subtitle}>Statement of Account</Text>
          </View>
        </View>

        {/* Account / period grid */}
        <View style={styles.billGrid}>
          <View style={styles.billSection}>
            <Text style={styles.billLabel}>Statement For</Text>
            <Text style={styles.billValue}>{customer.businessName}</Text>
          </View>
          <View style={{ flex: 1, alignItems: "flex-end" }}>
            <Text style={styles.billLabel}>Period</Text>
            <Text style={styles.billSub}>
              {fmtDate(period.from)} — {fmtDate(periodEnd)}
            </Text>
          </View>
        </View>

        {/* Summary block (money-sensitive, fixed order) */}
        <View style={styles.totalsWrapper}>
          <View style={styles.totalsBox}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Opening Balance</Text>
              <Text style={styles.totalValue}>{fmt(opening)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>+ Charges</Text>
              <Text style={styles.totalValue}>{fmt(charges)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: SUCCESS }]}>− Payments</Text>
              <Text style={[styles.totalValue, { color: SUCCESS }]}>{fmt(payments)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: SUCCESS }]}>− Credits</Text>
              <Text style={[styles.totalValue, { color: SUCCESS }]}>{fmt(credits)}</Text>
            </View>
            {hasAdjustments ? (
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: GRAY }]}>Adjustments</Text>
                <Text style={[styles.totalValue, { color: GRAY }]}>{fmtSigned(adjustments)}</Text>
              </View>
            ) : null}
            <View style={styles.totalDivider} />
            <View style={styles.totalBigRow}>
              <Text style={[styles.totalBigLabel, { color: closing > 0 ? DANGER : SUCCESS }]}>
                Closing Balance
              </Text>
              <Text style={[styles.totalBigValue, { color: closing > 0 ? DANGER : SUCCESS }]}>
                {fmt(closing)}
              </Text>
            </View>
            <Text style={{ fontSize: 7, color: GRAY, marginTop: 6, lineHeight: 1.4 }}>
              Closing balance is the net amount receivable on open invoices at period end.
              {hasAdjustments
                ? " Adjustments reflect write-offs or corrections during the period."
                : ""}
            </Text>
          </View>
        </View>

        {/* Activity table */}
        <Text style={styles.sectionTitle}>Activity</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colDate]}>Date</Text>
          <Text style={[styles.tableHeaderText, styles.colDescription]}>Description</Text>
          <Text style={[styles.tableHeaderText, styles.colAmount]}>Amount</Text>
        </View>
        {statement.lineItems.length > 0 ? (
          statement.lineItems.map((item: StatementLineItem, idx: number) => (
            <View
              key={`${item.type}-${item.reference}-${item.date}-${idx}`}
              style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowAlt : {}]}
            >
              <Text style={[styles.cellText, styles.colDate]}>{fmtDate(item.date)}</Text>
              <Text style={[styles.cellText, styles.colDescription]}>{item.description}</Text>
              <Text
                style={[
                  styles.cellTextRight,
                  styles.colAmount,
                  { color: item.amount < 0 ? SUCCESS : navy },
                ]}
              >
                {fmtSigned(item.amount)}
              </Text>
            </View>
          ))
        ) : (
          <View style={styles.tableRow}>
            <Text style={styles.cellText}>No activity this period.</Text>
          </View>
        )}

        {/* Available credit callout */}
        {statement.availableCredit > 0 ? (
          <View style={{ marginTop: 16 }}>
            <Text style={{ fontSize: 9, color: SUCCESS }}>
              Available store credit: {fmt(statement.availableCredit)} — not included in the closing
              balance.
            </Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {hasTenant
              ? [tenant?.businessName, tenant?.website].filter(Boolean).join(" · ")
              : "RouteFlow"}
          </Text>
          <Text style={styles.footerMuted}>Powered by RouteFlow</Text>
          <Text style={styles.footerText}>Generated {fmtDateTime(generatedAt)}</Text>
        </View>
      </Page>
    </Document>
  );
}
