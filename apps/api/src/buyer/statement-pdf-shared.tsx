import React from "react";
import { Text, View, StyleSheet, Image } from "@react-pdf/renderer";

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

export const DEFAULT_NAVY = "#1B3A5C";
export const DEFAULT_BRAND = "#3B6FCA";
export const GRAY = "#64748b";
export const LIGHT_GRAY = "#f1f5f9";
export const BORDER = "#e2e8f0";
export const SUCCESS = "#16a34a";
export const DANGER = "#dc2626";

// Darken a hex color by a factor (0-1). Used to derive a "navy" from the
// tenant's primary color when they don't supply a separate dark color.
export function darken(hex: string, factor = 0.55): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return DEFAULT_NAVY;
  const r = Math.max(0, Math.round(parseInt(clean.slice(0, 2), 16) * factor));
  const g = Math.max(0, Math.round(parseInt(clean.slice(2, 4), 16) * factor));
  const b = Math.max(0, Math.round(parseInt(clean.slice(4, 6), 16) * factor));
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function buildStyles(primary: string, navy: string) {
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

/** The brand colours of one render: the tenant's primary colour with safe fallbacks, and the navy derived from it. */
export function statementBrand(tenant: StatementTenantInfo | null) {
  const primary =
    tenant?.primaryColor && /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.test(tenant.primaryColor)
      ? tenant.primaryColor
      : DEFAULT_BRAND;
  const navy = primary === DEFAULT_BRAND ? DEFAULT_NAVY : darken(primary);
  return { primary, navy, styles: buildStyles(primary, navy) };
}

type Styles = ReturnType<typeof buildStyles>;

/** The tenant's letterhead (logo, name, address, contact), shared by the monthly and the current statement. */
export function StatementLetterhead({
  tenant,
  styles,
}: {
  tenant: StatementTenantInfo | null;
  styles: Styles;
}) {
  const hasTenant = !!tenant?.businessName;
  const tenantAddrLine = [tenant?.city, [tenant?.state, tenant?.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return (
    <View>
      {hasTenant ? (
        <>
          <View style={styles.logoBox}>
            {tenant?.logoDataUri ? (
              <Image src={tenant.logoDataUri} style={styles.logoImage} />
            ) : null}
            <Text style={styles.logoText}>{tenant?.businessName}</Text>
          </View>
          {tenant?.addressLine1 ? <Text style={styles.logoSub}>{tenant.addressLine1}</Text> : null}
          {tenant?.addressLine2 ? <Text style={styles.logoSub}>{tenant.addressLine2}</Text> : null}
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
            <Text style={{ fontSize: 9, fontFamily: "Helvetica-Bold", color: "#fff" }}>RF</Text>
          </View>
          <Text style={styles.logoText}>RouteFlow</Text>
        </View>
      )}
    </View>
  );
}

/** The fixed page footer shared by both statements. */
export function StatementFooter({
  tenant,
  generatedAt,
  styles,
}: {
  tenant: StatementTenantInfo | null;
  generatedAt: Date;
  styles: Styles;
}) {
  const hasTenant = !!tenant?.businessName;
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.footerText}>
        {hasTenant
          ? [tenant?.businessName, tenant?.website].filter(Boolean).join(" · ")
          : "RouteFlow"}
      </Text>
      <Text style={styles.footerMuted}>Powered by RouteFlow</Text>
      <Text style={styles.footerText}>Generated {fmtDateTime(generatedAt)}</Text>
    </View>
  );
}
