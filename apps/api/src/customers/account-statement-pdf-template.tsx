import React from "react";
import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { AccountStatement } from "@routeflow/types";
import {
  DANGER,
  GRAY,
  StatementFooter,
  StatementLetterhead,
  SUCCESS,
  statementBrand,
  type StatementTenantInfo,
} from "../buyer/statement-pdf-shared";
import { buildAccountStatementPdfModel, type Tone } from "./account-statement-pdf-model";

/**
 * SA-1078 (W-1096) PR-3: the printable "Open balance" statement, layout only. Every word and figure comes from
 * `buildAccountStatementPdfModel` (account-statement-pdf-model.ts), which is built from the server's read; nothing is
 * added, netted or clamped here. Rows and the foot are kept whole (`wrap={false}`), the foot is the last block before the
 * fixed page footer, so a long statement wraps across pages and ends with the Open balance.
 */
export function AccountStatementPdfTemplate({
  statement,
  tenant,
  generatedAt,
}: {
  statement: AccountStatement;
  tenant: StatementTenantInfo | null;
  generatedAt: Date;
}) {
  const { navy, styles } = statementBrand(tenant);
  const m = buildAccountStatementPdfModel(statement);
  const tone = (t: Tone) => (t === "danger" ? DANGER : t === "success" ? SUCCESS : navy);

  // Column widths (flex).
  const col = {
    invoice: { flex: 1.5 },
    due: { flex: 1.6 },
    money: { flex: 1.1, textAlign: "right" as const },
  };

  return (
    <Document title={m.title} author={tenant?.businessName ?? undefined}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <StatementLetterhead tenant={tenant} styles={styles} />
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.title}>STATEMENT</Text>
            <Text style={styles.subtitle}>{m.asOfLabel}</Text>
          </View>
        </View>

        <View style={styles.billGrid}>
          <View style={styles.billSection}>
            <Text style={styles.billLabel}>Statement For</Text>
            <Text style={styles.billValue}>{m.customerName}</Text>
          </View>
        </View>

        <View style={styles.totalsWrapper} wrap={false}>
          <View style={styles.totalsBox}>
            {m.summary.map((line, idx) =>
              idx === 0 ? (
                <View key={line.label} style={styles.totalBigRow}>
                  <Text style={[styles.totalBigLabel, { color: tone(line.tone) }]}>
                    {line.label}
                  </Text>
                  <Text style={[styles.totalBigValue, { color: tone(line.tone) }]}>
                    {line.value}
                  </Text>
                </View>
              ) : (
                <View key={line.label} style={styles.totalRow}>
                  <Text style={[styles.totalLabel, { color: tone(line.tone) }]}>{line.label}</Text>
                  <Text style={[styles.totalValue, { color: tone(line.tone) }]}>{line.value}</Text>
                </View>
              ),
            )}
          </View>
        </View>

        <Text style={styles.sectionTitle}>Open invoices</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, col.invoice]}>Invoice</Text>
          <Text style={[styles.tableHeaderText, col.due]}>Due</Text>
          <Text style={[styles.tableHeaderText, col.money]}>Total</Text>
          <Text style={[styles.tableHeaderText, col.money]}>Paid</Text>
          {m.showCreditColumn ? (
            <Text style={[styles.tableHeaderText, col.money]}>Credit</Text>
          ) : null}
          <Text style={[styles.tableHeaderText, col.money]}>Unpaid</Text>
        </View>
        {m.invoices.length > 0 ? (
          m.invoices.map((row, idx) => (
            <View
              key={row.key}
              wrap={false}
              style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowAlt : {}]}
            >
              <Text style={[styles.cellText, col.invoice]}>{row.invoice}</Text>
              <View style={col.due}>
                <Text style={styles.cellText}>{row.due}</Text>
                {row.late ? (
                  <Text style={{ fontSize: 7, color: DANGER, marginTop: 1 }}>{row.late}</Text>
                ) : null}
              </View>
              <Text style={[styles.cellTextRight, col.money]}>{row.total}</Text>
              <Text style={[styles.cellTextRight, col.money]}>{row.paid}</Text>
              {m.showCreditColumn ? (
                <Text style={[styles.cellTextRight, col.money]}>{row.credit}</Text>
              ) : null}
              <Text style={[styles.cellTextRight, col.money, { fontFamily: "Helvetica-Bold" }]}>
                {row.unpaid}
              </Text>
            </View>
          ))
        ) : (
          <View style={styles.tableRow}>
            <Text style={styles.cellText}>No open invoices.</Text>
          </View>
        )}

        {m.payments.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Paid in the last 30 days</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderText, styles.colDate]}>Date</Text>
              <Text style={[styles.tableHeaderText, styles.colDescription]}>Payment</Text>
              <Text style={[styles.tableHeaderText, styles.colAmount]}>Amount</Text>
            </View>
            {m.payments.map((p, idx) => (
              <View
                key={p.key}
                wrap={false}
                style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowAlt : {}]}
              >
                <Text style={[styles.cellText, styles.colDate]}>{p.date}</Text>
                <Text style={[styles.cellText, styles.colDescription]}>{p.what}</Text>
                <Text style={[styles.cellTextRight, styles.colAmount, { color: SUCCESS }]}>
                  {p.amount}
                </Text>
              </View>
            ))}
            {m.paymentsNote ? (
              <Text style={{ fontSize: 7, color: GRAY, marginTop: 4 }}>{m.paymentsNote}</Text>
            ) : null}
          </>
        ) : null}

        {m.credits.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Credits</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderText, styles.colDate]}>Date</Text>
              <Text style={[styles.tableHeaderText, styles.colDescription]}>Credit</Text>
              <Text style={[styles.tableHeaderText, styles.colAmount]}>Available</Text>
            </View>
            {m.credits.map((c, idx) => (
              <View
                key={c.key}
                wrap={false}
                style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowAlt : {}]}
              >
                <Text style={[styles.cellText, styles.colDate]}>{c.date}</Text>
                <Text style={[styles.cellText, styles.colDescription]}>{c.what}</Text>
                <Text style={[styles.cellTextRight, styles.colAmount, { color: SUCCESS }]}>
                  {c.amount}
                </Text>
              </View>
            ))}
          </>
        ) : null}

        {/* The foot: the last block on the last page, kept whole. */}
        <View style={styles.totalsWrapper} wrap={false}>
          <View style={styles.totalsBox}>
            <View style={styles.totalDivider} />
            <View style={styles.totalBigRow}>
              <Text style={[styles.totalBigLabel, { color: navy }]}>{m.foot.label}</Text>
              <Text style={[styles.totalBigValue, { color: navy }]}>{m.foot.value}</Text>
            </View>
          </View>
        </View>

        <StatementFooter tenant={tenant} generatedAt={generatedAt} styles={styles} />
      </Page>
    </Document>
  );
}
