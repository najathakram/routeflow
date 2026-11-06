import React from "react";
import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { MonthlyStatement, StatementLineItem } from "./statement.service";
import { fmtPdfDate } from "../common/pdf-date";
import {
  DANGER,
  GRAY,
  StatementFooter,
  StatementLetterhead,
  SUCCESS,
  statementBrand,
  type StatementTenantInfo,
} from "./statement-pdf-shared";

import { roundMoney } from "@routeflow/pricing";

export type { StatementTenantInfo };

// B954: the shared UTC-anchored PDF date (calendar dates are UTC-midnight instants).
const fmtDate = fmtPdfDate;
const fmt = (n: number) => `$${roundMoney(Math.abs(n)).toFixed(2)}`;
const fmtSigned = (n: number) =>
  n < 0 ? `−$${roundMoney(Math.abs(n)).toFixed(2)}` : `$${roundMoney(n).toFixed(2)}`;

export function StatementPdfTemplate({
  statement,
  tenant,
  generatedAt,
}: {
  statement: MonthlyStatement;
  tenant: StatementTenantInfo | null;
  generatedAt: Date;
}) {
  const { navy, styles } = statementBrand(tenant);

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
          <StatementLetterhead tenant={tenant} styles={styles} />
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

        <StatementFooter tenant={tenant} generatedAt={generatedAt} styles={styles} />
      </Page>
    </Document>
  );
}
