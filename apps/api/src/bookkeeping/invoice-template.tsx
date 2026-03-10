import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';

// Prisma Decimal is compatible with this interface (has toNumber / valueOf / toString)
type DecimalLike = { toNumber(): number } | number | string;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceTransactionData {
  id: string;
  status: string;
  totalOwed: DecimalLike;
  totalPaid: DecimalLike;
  dueDate?: Date | string | null;
  createdAt: Date | string;
  paidAt?: Date | string | null;
  notes?: string | null;
  customer?: { businessName: string; contactName?: string | null } | null;
  order?: { orderNumber: string } | null;
  items: Array<{
    id: string;
    description: string;
    qty: DecimalLike;
    unitPrice: DecimalLike;
    subtotal: DecimalLike;
    orderItem?: { product?: { name: string } | null } | null;
  }>;
  payments: Array<{
    id: string;
    amount: DecimalLike;
    method: string;
    reference?: string | null;
    createdAt: Date | string;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toNum = (val: DecimalLike): number => {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val);
  return val.toNumber();
};

const fmt = (val: DecimalLike) => `$${toNum(val).toFixed(2)}`;

const fmtDate = (val: Date | string | null | undefined): string => {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const NAVY = '#1B3A5C';
const BRAND = '#3B6FCA';
const GRAY = '#64748b';
const LIGHT_GRAY = '#f1f5f9';
const BORDER = '#e2e8f0';
const SUCCESS = '#16a34a';
const WARNING = '#d97706';
const DANGER = '#dc2626';

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: NAVY,
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 44,
    backgroundColor: '#ffffff',
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 28,
    paddingBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: NAVY,
  },
  logoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  logoSquare: {
    width: 28,
    height: 28,
    backgroundColor: BRAND,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: NAVY,
  },
  logoSub: {
    fontSize: 8,
    color: GRAY,
    marginTop: 2,
  },
  invoiceTitle: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    color: NAVY,
    letterSpacing: 1,
  },
  invoiceNumber: {
    fontSize: 9,
    color: GRAY,
    marginTop: 4,
    fontFamily: 'Helvetica',
  },

  // Status badge
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
  },

  // Bill info grid
  billGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  billSection: {
    flex: 1,
    paddingRight: 16,
  },
  billLabel: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: GRAY,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  billValue: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: NAVY,
    marginBottom: 2,
  },
  billSub: {
    fontSize: 9,
    color: GRAY,
    marginBottom: 1,
  },

  // Items table
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: NAVY,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 0,
  },
  tableHeaderText: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  tableRowAlt: {
    backgroundColor: LIGHT_GRAY,
  },
  colDescription: { flex: 3 },
  colQty: { flex: 1, textAlign: 'right' },
  colUnit: { flex: 1.4, textAlign: 'right' },
  colSubtotal: { flex: 1.4, textAlign: 'right' },
  cellText: {
    fontSize: 9,
    color: NAVY,
  },
  cellTextRight: {
    fontSize: 9,
    color: NAVY,
    textAlign: 'right',
  },

  // Totals
  totalsWrapper: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  totalsBox: {
    width: 200,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  totalLabel: {
    fontSize: 9,
    color: GRAY,
  },
  totalValue: {
    fontSize: 9,
    color: NAVY,
    fontFamily: 'Helvetica-Bold',
  },
  totalDivider: {
    borderTopWidth: 1,
    borderTopColor: BORDER,
    marginVertical: 4,
  },
  totalBigRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  totalBigLabel: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: NAVY,
  },
  totalBigValue: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: NAVY,
  },

  // Payment history
  sectionTitle: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: GRAY,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 20,
  },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  paymentMethod: {
    fontSize: 9,
    color: NAVY,
  },
  paymentRef: {
    fontSize: 8,
    color: GRAY,
  },
  paymentAmt: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: SUCCESS,
  },
  paymentDate: {
    fontSize: 8,
    color: GRAY,
  },

  // Footer
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 44,
    right: 44,
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  footerText: {
    fontSize: 7,
    color: GRAY,
  },
});

// ─── Component ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  let bg = LIGHT_GRAY;
  let color = GRAY;
  let label = status;
  if (status === 'PAID') { bg = '#dcfce7'; color = SUCCESS; label = 'PAID'; }
  if (status === 'PARTIAL') { bg = '#fef3c7'; color = WARNING; label = 'PARTIAL'; }
  if (status === 'UNPAID') { bg = '#fee2e2'; color = DANGER; label = 'UNPAID'; }
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={{ color, fontSize: 8, fontFamily: 'Helvetica-Bold' }}>{label}</Text>
    </View>
  );
}

export function InvoiceTemplate({ transaction: txn }: { transaction: InvoiceTransactionData }) {
  const total = toNum(txn.totalOwed);
  const paid = toNum(txn.totalPaid);
  const balance = total - paid;
  const invoiceRef = txn.order?.orderNumber ?? txn.id.slice(0, 8).toUpperCase();

  return (
    <Document title={`Invoice ${invoiceRef}`} author="RouteFlow">
      <Page size="A4" style={styles.page}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <View>
            <View style={styles.logoBox}>
              <View style={styles.logoSquare}>
                <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#fff' }}>RF</Text>
              </View>
              <Text style={styles.logoText}>RouteFlow</Text>
            </View>
            <Text style={styles.logoSub}>Austin, TX · routeflow.io</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.invoiceTitle}>INVOICE</Text>
            <Text style={styles.invoiceNumber}>{invoiceRef}</Text>
            <View style={styles.badgeRow}>
              <StatusBadge status={txn.status} />
            </View>
          </View>
        </View>

        {/* ── Billing info ── */}
        <View style={styles.billGrid}>
          <View style={styles.billSection}>
            <Text style={styles.billLabel}>Bill To</Text>
            <Text style={styles.billValue}>{txn.customer?.businessName ?? '—'}</Text>
            {txn.customer?.contactName ? (
              <Text style={styles.billSub}>{txn.customer.contactName}</Text>
            ) : null}
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={styles.billLabel}>Invoice Details</Text>
            <Text style={styles.billSub}>
              Date: {fmtDate(txn.createdAt)}
            </Text>
            {txn.dueDate ? (
              <Text style={styles.billSub}>Due: {fmtDate(txn.dueDate)}</Text>
            ) : null}
            {txn.paidAt ? (
              <Text style={[styles.billSub, { color: SUCCESS }]}>
                Paid: {fmtDate(txn.paidAt)}
              </Text>
            ) : null}
          </View>
        </View>

        {/* ── Line items table ── */}
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, styles.colDescription]}>Description</Text>
          <Text style={[styles.tableHeaderText, styles.colQty]}>Qty</Text>
          <Text style={[styles.tableHeaderText, styles.colUnit]}>Unit Price</Text>
          <Text style={[styles.tableHeaderText, styles.colSubtotal]}>Subtotal</Text>
        </View>
        {txn.items.map((item, idx) => (
          <View
            key={item.id}
            style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowAlt : {}]}
          >
            <View style={styles.colDescription}>
              <Text style={styles.cellText}>{item.description}</Text>
            </View>
            <Text style={[styles.cellTextRight, styles.colQty]}>
              {toNum(item.qty).toFixed(2)}
            </Text>
            <Text style={[styles.cellTextRight, styles.colUnit]}>
              {fmt(item.unitPrice)}
            </Text>
            <Text style={[styles.cellTextRight, styles.colSubtotal]}>
              {fmt(item.subtotal)}
            </Text>
          </View>
        ))}

        {/* ── Totals ── */}
        <View style={styles.totalsWrapper}>
          <View style={styles.totalsBox}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>{fmt(total)}</Text>
            </View>
            <View style={styles.totalDivider} />
            <View style={styles.totalBigRow}>
              <Text style={styles.totalBigLabel}>Total</Text>
              <Text style={styles.totalBigValue}>{fmt(total)}</Text>
            </View>
            {paid > 0 ? (
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: SUCCESS }]}>Amount Paid</Text>
                <Text style={[styles.totalValue, { color: SUCCESS }]}>
                  -{fmt(paid)}
                </Text>
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

        {/* ── Payment history ── */}
        {txn.payments.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Payment History</Text>
            {txn.payments.map((pmt) => (
              <View key={pmt.id} style={styles.paymentRow}>
                <View>
                  <Text style={styles.paymentMethod}>{pmt.method}</Text>
                  {pmt.reference ? (
                    <Text style={styles.paymentRef}>Ref: {pmt.reference}</Text>
                  ) : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.paymentAmt}>{fmt(pmt.amount)}</Text>
                  <Text style={styles.paymentDate}>{fmtDate(pmt.createdAt)}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* ── Notes ── */}
        {txn.notes ? (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={{ fontSize: 9, color: GRAY }}>{txn.notes}</Text>
          </View>
        ) : null}

        {/* ── Footer ── */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>RouteFlow · Austin, TX · routeflow.io</Text>
          <Text style={styles.footerText}>
            Generated {fmtDate(new Date())}
          </Text>
        </View>

      </Page>
    </Document>
  );
}
