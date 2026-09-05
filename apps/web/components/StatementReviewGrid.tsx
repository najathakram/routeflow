"use client";

import * as React from "react";
import Link from "next/link";
import {
  CheckCircle2,
  HelpCircle,
  FileQuestion,
  FileStack,
  Plus,
  ExternalLink,
  ShieldAlert,
  AlertTriangle,
} from "lucide-react";
import { Button, Card, useToast, cn } from "@routeflow/ui/web";
import {
  useApplyStatement,
  type StatementScanResult,
  type StatementLineMatch,
  type StatementMatchCandidate,
  type StatementLineKind,
  type ParsedStatementLine,
  type ApplyStatementResult,
  type ApplyStatementDto,
  type ConfirmedStatementMatch,
} from "@/lib/api/supplier-statements";
import {
  useVendorBills,
  useCreateVendorBill,
  type VendorBill,
  type CreateVendorBillItem,
} from "@/lib/api/vendor-bills";
import { fmt, fmtCalendarDate, todayIso } from "@/lib/formatting";
import { roundMoney } from "@routeflow/pricing";

// ─── Client-computed sections ───────────────────────────────────────────────
// Neither `SupplierStatementsService` nor `statement-matcher.ts` (WP2, as
// actually landed) computes "unmatched local bills" or an implied-paid
// proposal — the scan response carries only `matches` (one entry per parsed
// line). Both sections below are built here instead, from the SAME
// already-existing `GET /vendor-bills` endpoint `RecordSupplierPaymentModal`
// uses, plus the scan's own `periodStart`. Still deterministic, model-free
// code — just client-side rather than server-side — and never trusted as-is:
// the implied-paid list only ever reaches the server after the operator
// explicitly confirms the literal list in the second-confirmation dialog.

export interface UnmatchedLocalBill {
  billId: string;
  billNumber: string;
  billDate: string | null;
  totalOwed: number;
  outstanding: number;
}

export interface ImpliedPaidBill {
  billId: string;
  billNumber: string;
  billDate: string | null;
  outstanding: number;
}

/** `useVendorBills` has no `enabled` gate — querying with no real supplier id
 *  would otherwise fetch the tenant's ENTIRE bill list. Prisma does a plain
 *  string-equality filter on `VendorBill.supplierId` (not a native uuid
 *  column), so a sentinel that matches nothing is a safe, cheap no-op. */
const NO_SUPPLIER_SENTINEL = "__no-supplier__";

/**
 * Replicates `statement-matcher.ts`'s own closing-balance sanity guard
 * (identical formula/tolerance) purely for the warning banner — the REAL
 * `preChecked` flags already reflect the server's own run of this guard;
 * this is display-only, never a second source of truth for what's safe to
 * apply.
 */
function computeLinesAgree(
  openingBalance: number | null,
  closingBalance: number | null,
  lines: ParsedStatementLine[],
): boolean {
  if (closingBalance == null) return true;
  const signed = (line: ParsedStatementLine): number => {
    const amount = Math.abs(Number(line.amount) || 0);
    switch (line.kind) {
      case "INVOICE":
        return amount;
      case "PAYMENT":
      case "CREDIT":
        return -amount;
      default:
        return Number(line.amount) || 0;
    }
  };
  const sum = roundMoney(lines.reduce((s, l) => s + signed(l), 0));
  return Math.abs(roundMoney(openingBalance ?? 0) + sum - roundMoney(closingBalance)) <= 0.01;
}

// ─── Local row state ────────────────────────────────────────────────────────
// Keyed by ARRAY INDEX into `result.matches` (the wire type carries no id of
// its own — `matches[i]` corresponds to `lines[i]`). ONE source of truth for
// what the operator has decided about each line — nothing here is sent
// anywhere until the explicit Apply.

interface RowState {
  billId: string | null;
  /** Editable string (never a number) — a controlled numeric input eats the
   *  decimal point mid-typing. Parsed once, at validation/submit time. */
  amount: string;
  included: boolean;
}

function emptyRow(): RowState {
  return { billId: null, amount: "", included: false };
}

function kindLabel(kind: StatementLineKind): string {
  switch (kind) {
    case "INVOICE":
      return "Invoice";
    case "PAYMENT":
      return "Payment";
    case "CREDIT":
      return "Credit";
    case "ADJUSTMENT":
      return "Adjustment";
    default:
      return kind;
  }
}

/** What the operator actually confirmed, kept client-side for the post-apply
 *  summary — the real `ApplyStatementResult` echoes back payment rows keyed by
 *  bill id, never a bill NUMBER, which is what the summary table shows. */
export interface AppliedRowSummary {
  billId: string;
  billNumber: string;
  amount: number;
}

const inputCls =
  "w-28 rounded border px-2 py-1 text-right text-sm focus:outline-none focus:ring-1 focus:ring-brand-500";

interface Props {
  result: StatementScanResult;
  onApplied: (
    applied: ApplyStatementResult,
    confirmed: AppliedRowSummary[],
    impliedPaid: ImpliedPaidBill[] | null,
  ) => void;
}

/**
 * The one review screen (PR-F WP4). Five sections: Matched (pre-checked),
 * Needs a look (candidate picker, resolve-before-apply per line), Unmatched
 * statement lines (offer "create bill"), Unmatched local bills (read-only),
 * and — separately, never folded into the main Apply — the implied-paid
 * proposal with its own checkbox and its own second confirmation. Matching
 * itself already happened server-side, deterministically (WP2); this screen
 * only lets the operator dispose of what the matcher proposed.
 */
export function StatementReviewGrid({ result, onApplied }: Props) {
  const { toast } = useToast();
  const applyMutation = useApplyStatement(result.scanId ?? "");
  const createBill = useCreateVendorBill();

  // 500 mirrors RecordSupplierPaymentModal's own ceiling — a single
  // supplier's open bills should never approach it.
  const billsQuery = useVendorBills({
    supplierId: result.supplierId ?? NO_SUPPLIER_SENTINEL,
    limit: 500,
  });
  const billsById = React.useMemo(() => {
    const map = new Map<string, VendorBill>();
    for (const b of billsQuery.data?.data ?? []) map.set(b.id, b);
    return map;
  }, [billsQuery.data]);
  /** Real `totalOwed − totalPaid` wherever the bill is known locally, falling
   *  back to the candidate's own `total` (never derived from `status` —
   *  house rule) when it isn't (e.g. beyond the 500-row ceiling). */
  const outstandingFor = React.useCallback(
    (billId: string, fallback: number): number => {
      const b = billsById.get(billId);
      return b ? roundMoney(Number(b.totalOwed) - Number(b.totalPaid)) : fallback;
    },
    [billsById],
  );
  /** A DRAFT bill hasn't been received, so a statement can't settle it — the
   *  server refuses one outright (`statement-apply.service.ts`), and marking
   *  it PAID here would strip it of every draft-only transition (edit, revert,
   *  delete) for stock that never arrived. Only knowable for bills the query
   *  actually returned; anything beyond the 500-row ceiling reads as
   *  not-a-draft here and is still caught server-side. */
  const isDraftBill = React.useCallback(
    (billId: string): boolean => billsById.get(billId)?.status === "DRAFT",
    [billsById],
  );

  const indexed = React.useMemo(
    () => result.matches.map((m, idx) => ({ m, idx })),
    [result.matches],
  );
  const matchedTiered = React.useMemo(
    () => indexed.filter(({ m }) => m.tier !== "UNMATCHED"),
    [indexed],
  );
  const preCheckedMatches = React.useMemo(
    () => matchedTiered.filter(({ m }) => m.preChecked),
    [matchedTiered],
  );
  const needsLookMatches = React.useMemo(
    () => matchedTiered.filter(({ m }) => !m.preChecked),
    [matchedTiered],
  );
  const unmatchedLines = React.useMemo(
    () => indexed.filter(({ m }) => m.tier === "UNMATCHED"),
    [indexed],
  );

  const linesAgree = React.useMemo(
    () => computeLinesAgree(result.openingBalance, result.closingBalance, result.lines),
    [result.openingBalance, result.closingBalance, result.lines],
  );

  // Every bill this statement mentions at all (any candidate on any line,
  // winning or not) — a local open bill NOT in this set is one the statement
  // never brought up.
  const referencedBillIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const m of result.matches) for (const c of m.candidates) s.add(c.billId);
    return s;
  }, [result.matches]);

  const unmatchedLocalBills = React.useMemo<UnmatchedLocalBill[]>(() => {
    if (!result.supplierId) return [];
    const rows: UnmatchedLocalBill[] = [];
    for (const b of Array.from(billsById.values())) {
      if (b.status === "VOID") continue;
      if (referencedBillIds.has(b.id)) continue;
      const outstanding = roundMoney(Number(b.totalOwed) - Number(b.totalPaid));
      if (outstanding <= 0.001) continue;
      rows.push({
        billId: b.id,
        billNumber: b.billNumber,
        billDate: b.billDate ?? null,
        totalOwed: Number(b.totalOwed),
        outstanding,
      });
    }
    rows.sort((a, b) => (a.billDate ?? "").localeCompare(b.billDate ?? ""));
    return rows;
  }, [billsById, referencedBillIds, result.supplierId]);

  // Older, still-open, and never mentioned by the statement at all — the
  // period it opens with implies its own prior activity was already settled.
  // DRAFT bills are excluded on purpose: a draft hasn't been received, so it
  // isn't a liability this statement can imply was settled, and marking it
  // PAID would permanently strip it of every draft-only transition (edit,
  // revert, delete) and drop it out of the needs-mapping queue for a payment
  // it never received. The server refuses them too (statement-apply.service).
  const impliedPaidBills = React.useMemo<ImpliedPaidBill[]>(() => {
    if (!result.periodStart) return [];
    const cutoff = Date.parse(result.periodStart);
    if (!Number.isFinite(cutoff)) return [];
    return unmatchedLocalBills
      .filter(
        (b) =>
          b.billDate &&
          Date.parse(b.billDate) < cutoff &&
          billsById.get(b.billId)?.status !== "DRAFT",
      )
      .map((b) => ({
        billId: b.billId,
        billNumber: b.billNumber,
        billDate: b.billDate,
        outstanding: b.outstanding,
      }));
  }, [unmatchedLocalBills, billsById, result.periodStart]);

  const [rows, setRows] = React.useState<Record<number, RowState>>({});
  /** The scan whose rows have already been seeded. Seeding is once per scan —
   *  re-running it on a later re-render would wipe in-progress operator
   *  edits. */
  const seededScanRef = React.useRef<string | null>(null);
  // Seed only when a genuinely different scan loads — and never BEFORE the
  // bills query has settled: until it does, `outstandingFor` falls back to the
  // candidate's full `total`, so an already part- or fully-paid bill would
  // pre-fill above its real remaining balance and flip to a blocking
  // "Exceeds the bill's outstanding" the moment the real balances land,
  // disabling Apply for the whole screen.
  React.useEffect(() => {
    if (!billsQuery.isSuccess && !billsQuery.isError) return;
    const scanKey = result.scanId ?? "";
    if (seededScanRef.current === scanKey) return;
    seededScanRef.current = scanKey;
    const next: Record<number, RowState> = {};
    for (const { m, idx } of matchedTiered) {
      if (m.preChecked && m.billId) {
        const candidate = m.candidates.find((c) => c.billId === m.billId) ?? null;
        const cap = candidate ? outstandingFor(candidate.billId, candidate.total) : m.line.amount;
        const amount = roundMoney(Math.min(m.line.amount, cap));
        next[idx] = {
          billId: m.billId,
          amount: String(amount),
          // Nothing left to pay (the bill is already settled in our own books
          // — e.g. a re-scanned statement), or the match is a DRAFT bill the
          // server refuses to settle: keep the match visible, but never
          // pre-check a row whose amount could only ever fail validation.
          included: amount > 0.001 && !isDraftBill(m.billId),
        };
      } else {
        next[idx] = emptyRow();
      }
    }
    setRows(next);
  }, [
    result.scanId,
    billsQuery.isSuccess,
    billsQuery.isError,
    matchedTiered,
    outstandingFor,
    isDraftBill,
  ]);

  const [createdFromLine, setCreatedFromLine] = React.useState<
    Record<number, { billId: string; billNumber: string }>
  >({});

  const [impliedPaidArmed, setImpliedPaidArmed] = React.useState(false);
  const [impliedPaidConfirmOpen, setImpliedPaidConfirmOpen] = React.useState(false);
  const [notes, setNotes] = React.useState("");

  const setRow = (idx: number, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [idx]: { ...(prev[idx] ?? emptyRow()), ...patch } }));

  const pickCandidate = (
    idx: number,
    m: StatementLineMatch,
    candidate: StatementMatchCandidate,
  ) => {
    const cap = outstandingFor(candidate.billId, candidate.total);
    const amount = roundMoney(Math.min(m.line.amount, cap));
    setRow(idx, { billId: candidate.billId, amount: String(amount), included: true });
  };

  const clearPick = (idx: number) => setRow(idx, { billId: null, included: false });

  const toggleIncluded = (idx: number) =>
    setRows((prev) => {
      const r = prev[idx];
      if (!r || !r.billId) return prev;
      return { ...prev, [idx]: { ...r, included: !r.included } };
    });

  /** How many INCLUDED rows currently point at each bill. Candidates are
   *  shared across lines, so two rows can land on the same bill — which the
   *  server rejects outright (one bill, one line), failing the whole apply.
   *  Flag it on the rows themselves instead of finding out at Apply time. */
  const includedBillIdCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const { idx } of matchedTiered) {
      const r = rows[idx];
      if (r?.included && r.billId) counts.set(r.billId, (counts.get(r.billId) ?? 0) + 1);
    }
    return counts;
  }, [matchedTiered, rows]);

  const rowError = (m: StatementLineMatch, r: RowState): string | null => {
    if (!r.billId) return null;
    // Only an INCLUDED row is validated — an unchecked row contributes nothing
    // to the Apply, and a seeded zero (a bill already settled in our own
    // books) would otherwise show a red error on a row that isn't going
    // anywhere. `hasBlockingError` only ever looks at included rows anyway.
    if (!r.included) return null;
    if ((includedBillIdCounts.get(r.billId) ?? 0) > 1) {
      return "This bill is already included on another line";
    }
    if (isDraftBill(r.billId)) {
      return "This bill is still a draft — receive it before settling it";
    }
    const amt = parseFloat(r.amount);
    if (!Number.isFinite(amt) || amt <= 0) return "Enter a valid amount";
    const candidate = m.candidates.find((c) => c.billId === r.billId) ?? null;
    if (candidate) {
      const outstanding = outstandingFor(candidate.billId, candidate.total);
      if (amt > outstanding + 0.005) {
        return `Exceeds the bill's outstanding ${fmt(outstanding)}`;
      }
    }
    if (amt > m.line.amount + 0.005) {
      return `Exceeds the statement line's ${fmt(m.line.amount)}`;
    }
    return null;
  };

  const includedEntries = matchedTiered
    .map(({ m, idx }) => ({ m, idx, r: rows[idx] }))
    .filter(
      (x): x is { m: StatementLineMatch; idx: number; r: RowState } =>
        !!x.r?.included && !!x.r.billId,
    );

  const hasBlockingError = includedEntries.some(({ m, r }) => !!rowError(m, r));
  const confirmedTotal = roundMoney(
    includedEntries.reduce((s, { r }) => s + (parseFloat(r.amount) || 0), 0),
  );
  const impliedPaidTotal = roundMoney(impliedPaidBills.reduce((s, b) => s + b.outstanding, 0));
  const impliedPaidRange =
    impliedPaidBills.length > 0
      ? (() => {
          const dates = impliedPaidBills.map((b) => b.billDate).filter(Boolean) as string[];
          if (dates.length === 0) return null;
          const sorted = [...dates].sort();
          return `${fmtCalendarDate(sorted[0])} – ${fmtCalendarDate(sorted[sorted.length - 1])}`;
        })()
      : null;

  const canApply =
    !!result.scanId &&
    !applyMutation.isPending &&
    !hasBlockingError &&
    (includedEntries.length > 0 || (impliedPaidArmed && impliedPaidBills.length > 0));

  const handleApply = async () => {
    if (!result.scanId) return;
    const confirmed: ConfirmedStatementMatch[] = includedEntries.map(({ idx, r }) => ({
      // The row's index IS the statement line the operator picked this bill
      // on — the server caps the amount against that line, so a candidate
      // other than the matcher's suggestion is accepted rather than rejected.
      lineIndex: idx,
      billId: r.billId as string,
      amount: roundMoney(parseFloat(r.amount) || 0),
    }));
    const summary: AppliedRowSummary[] = includedEntries.map(({ m, r }) => {
      const candidate = m.candidates.find((c) => c.billId === r.billId) ?? null;
      return {
        billId: r.billId as string,
        billNumber: candidate?.billNumber ?? "—",
        amount: roundMoney(parseFloat(r.amount) || 0),
      };
    });
    const dto: ApplyStatementDto = {
      confirmed,
      ...(impliedPaidArmed && impliedPaidBills.length > 0
        ? { impliedPaid: { billIds: impliedPaidBills.map((b) => b.billId) } }
        : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    try {
      const res = await applyMutation.mutateAsync(dto);
      toast({
        title: "Statement applied",
        description: res.excess > 0.001 ? `${fmt(res.excess)} left as account credit.` : undefined,
        variant: "success",
      });
      onApplied(res, summary, impliedPaidArmed ? impliedPaidBills : null);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: msg ?? "Couldn't apply the statement", variant: "error" });
    }
  };

  const handleCreateBillFromLine = (idx: number, m: StatementLineMatch) => {
    if (!result.supplierId) {
      toast({ title: "No supplier identified — can't create a bill", variant: "error" });
      return;
    }
    const billDate = m.line.date ?? todayIso();
    const items: CreateVendorBillItem[] = [
      {
        description: m.line.refNumber ? `Statement line — ${m.line.refNumber}` : "Statement line",
        qty: 1,
        unitCost: m.line.amount,
      },
    ];
    createBill.mutate(
      {
        supplierId: result.supplierId,
        billDate,
        // No terms to read off a statement line — same-day is the honest
        // default; the operator can edit the bill afterward.
        dueDate: billDate,
        // The line's own reference IS the supplier's invoice number —
        // normalized and indexed server-side. Without it the new bill can
        // never exact-ref match the line it came from on a re-scan, and a
        // later invoice scan of the same document would sail past
        // findVendorBillDuplicate's number layer and post a second bill.
        ...(m.line.refNumber ? { supplierInvoiceNumber: m.line.refNumber } : {}),
        items,
        notes: `Created from supplier statement reconciliation (scan ${result.scanId ?? "unsaved"}).`,
      },
      {
        onSuccess: (bill) => {
          setCreatedFromLine((prev) => ({
            ...prev,
            [idx]: { billId: bill.id, billNumber: bill.billNumber },
          }));
          toast({ title: `Bill ${bill.billNumber} created`, variant: "success" });
        },
        onError: (e: unknown) => {
          const err = e as { response?: { data?: { message?: string } }; message?: string };
          toast({
            title: "Couldn't create the bill",
            description: err?.response?.data?.message ?? err?.message,
            variant: "error",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      {/* Statement summary */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-navy">
              {result.supplier ?? "Unknown supplier"}
              {result.supplierId && (
                <Link
                  href={`/suppliers/${result.supplierId}`}
                  className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-brand-600 hover:underline"
                >
                  View supplier <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </h3>
            <p className="mt-1 text-sm text-navy/70">
              {result.periodStart && result.periodEnd
                ? `${fmtCalendarDate(result.periodStart)} – ${fmtCalendarDate(result.periodEnd)}`
                : "Statement period not read"}
              {result.fileName ? ` · ${result.fileName}` : ""}
            </p>
          </div>
          <div className="flex gap-6 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-navy/50">Opening</p>
              <p className="font-medium text-navy">
                {result.openingBalance != null ? fmt(result.openingBalance) : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-navy/50">Closing</p>
              <p className="font-medium text-navy">
                {result.closingBalance != null ? fmt(result.closingBalance) : "—"}
              </p>
            </div>
          </div>
        </div>
        {!result.supplierId && (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-warning-bg px-3 py-2 text-xs text-[#B45309]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Couldn&apos;t identify the supplier — matching against local bills is unavailable until
            this statement is linked to one.
          </p>
        )}
        {!result.scanId && (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-danger-bg px-3 py-2 text-xs text-[#B91C1C]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            This scan couldn&apos;t be saved, so it can&apos;t be applied or revisited later — scan
            again once the underlying issue clears.
          </p>
        )}
        {result.notes && <p className="mt-3 text-xs italic text-navy/60">Note: {result.notes}</p>}
      </Card>

      {!linesAgree && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-[#B91C1C]">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">
              This statement&apos;s lines don&apos;t reconcile to its own closing balance.
            </p>
            <p className="mt-0.5 text-xs">
              Nothing was pre-checked — review every match below before applying.
            </p>
          </div>
        </div>
      )}

      {/* 1. Matched */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-success" />
          <h3 className="text-sm font-semibold text-navy">Matched</h3>
          <span className="text-xs text-navy/50">
            {preCheckedMatches.length} line(s) — exact reference and amount
          </span>
        </div>
        {preCheckedMatches.length === 0 ? (
          <p className="text-sm italic text-navy/50">No lines matched exactly.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-surface-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2 text-left">Statement line</th>
                  <th className="px-3 py-2 text-left">Our bill</th>
                  <th className="px-3 py-2 text-right">Amount to pay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {preCheckedMatches.map(({ m, idx }) => {
                  const row = rows[idx] ?? emptyRow();
                  const candidate = m.candidates.find((c) => c.billId === row.billId) ?? null;
                  const outstanding = candidate
                    ? outstandingFor(candidate.billId, candidate.total)
                    : null;
                  const error = row.billId ? rowError(m, row) : null;
                  return (
                    <tr key={idx}>
                      <td className="px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={row.included}
                          onChange={() => toggleIncluded(idx)}
                          className="h-4 w-4 rounded border-surface-border"
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p className="font-medium text-navy">{m.line.refNumber ?? "—"}</p>
                        <p className="text-xs text-navy/50">
                          {fmtCalendarDate(m.line.date)} · {fmt(m.line.amount)}
                        </p>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <p className="font-medium text-brand-600">{candidate?.billNumber ?? "—"}</p>
                        <p className="text-xs text-navy/50">
                          {fmtCalendarDate(candidate?.date ?? null)} · owed{" "}
                          {candidate ? fmt(candidate.total) : "—"} · outstanding{" "}
                          {outstanding != null ? fmt(outstanding) : "—"}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max={outstanding ?? undefined}
                          value={row.amount}
                          disabled={!row.included}
                          onChange={(e) => setRow(idx, { amount: e.target.value })}
                          className={cn(
                            inputCls,
                            error ? "border-danger" : "border-surface-border",
                            !row.included && "opacity-50",
                          )}
                        />
                        {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 2. Needs a look */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-semibold text-navy">Needs a look</h3>
          <span className="text-xs text-navy/50">{needsLookMatches.length} line(s)</span>
        </div>
        {needsLookMatches.length === 0 ? (
          <p className="text-sm italic text-navy/50">Nothing flagged.</p>
        ) : (
          <div className="space-y-2">
            {needsLookMatches.map(({ m, idx }) => {
              const row = rows[idx] ?? emptyRow();
              const candidate = m.candidates.find((c) => c.billId === row.billId) ?? null;
              const error = row.billId ? rowError(m, row) : null;
              const mismatchNote =
                m.tier === "EXACT_REF"
                  ? "Reference matches, but the amount doesn't."
                  : "Matched by amount and date only — not a certain match.";
              return (
                <div key={idx} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-navy">
                        {m.line.refNumber ?? "No reference"}
                        <span className="ml-2 font-normal text-navy/60">
                          {fmtCalendarDate(m.line.date)} · {fmt(m.line.amount)}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-navy/60">{mismatchNote}</p>
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-navy/70">
                      <input
                        type="checkbox"
                        checked={row.included}
                        disabled={!row.billId}
                        onChange={() => toggleIncluded(idx)}
                        className="h-4 w-4 rounded border-surface-border disabled:opacity-40"
                      />
                      Include in Apply
                    </label>
                  </div>
                  {m.candidates.length === 0 ? (
                    <p className="mt-2 text-xs italic text-navy/50">
                      No local bill candidates for this line.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {m.candidates.map((c) => {
                        const isSuggested = c.billId === m.billId;
                        const isSelected = row.billId === c.billId;
                        const cOutstanding = outstandingFor(c.billId, c.total);
                        return (
                          <button
                            key={c.billId}
                            type="button"
                            onClick={() => pickCandidate(idx, m, c)}
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                              isSelected
                                ? "border-brand-500 bg-brand-100 text-brand-700"
                                : "border-surface-border bg-white text-navy hover:bg-brand-50",
                              isSuggested && !isSelected && "ring-1 ring-brand-300",
                            )}
                          >
                            {c.billNumber} · {fmt(c.total)} · outstanding {fmt(cOutstanding)}
                            {c.date ? ` · ${fmtCalendarDate(c.date)}` : ""}
                            {isSuggested ? " (suggested)" : ""}
                          </button>
                        );
                      })}
                      {row.billId && (
                        <button
                          type="button"
                          onClick={() => clearPick(idx)}
                          className="text-xs text-navy/50 hover:underline"
                        >
                          Not a match
                        </button>
                      )}
                    </div>
                  )}
                  {row.billId && (
                    <div className="mt-2 flex items-center gap-2">
                      <label className="text-xs text-navy/70">Amount to pay</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max={
                          candidate ? outstandingFor(candidate.billId, candidate.total) : undefined
                        }
                        value={row.amount}
                        onChange={(e) => setRow(idx, { amount: e.target.value })}
                        className={cn(inputCls, error ? "border-danger" : "border-surface-border")}
                      />
                      {error && <span className="text-[11px] text-danger">{error}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 3. Unmatched statement lines */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <FileQuestion className="h-4 w-4 text-navy/50" />
          <h3 className="text-sm font-semibold text-navy">Unmatched statement lines</h3>
          <span className="text-xs text-navy/50">
            {unmatchedLines.length} line(s) — we have no matching bill
          </span>
        </div>
        {unmatchedLines.length === 0 ? (
          <p className="text-sm italic text-navy/50">Every line matched a local bill.</p>
        ) : (
          <div className="space-y-1.5">
            {unmatchedLines.map(({ m, idx }) => {
              const created = createdFromLine[idx];
              return (
                <div
                  key={idx}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-surface-border px-3 py-2"
                >
                  <p className="text-sm font-medium text-navy">
                    {m.line.refNumber ?? "No reference"}
                    <span className="ml-2 font-normal text-navy/60">
                      {fmtCalendarDate(m.line.date)} · {fmt(m.line.amount)} ·{" "}
                      {kindLabel(m.line.kind)}
                    </span>
                  </p>
                  {created ? (
                    <Link
                      href={`/vendor-bills/${created.billId}`}
                      className="text-xs font-medium text-brand-600 hover:underline"
                    >
                      Bill {created.billNumber} created →
                    </Link>
                  ) : m.line.kind === "INVOICE" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleCreateBillFromLine(idx, m)}
                      loading={createBill.isPending}
                    >
                      <Plus className="h-3.5 w-3.5" /> Create bill from line
                    </Button>
                  ) : (
                    <span className="text-xs text-navy/40">Not an invoice — no local action</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 4. Unmatched local bills */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <FileStack className="h-4 w-4 text-navy/50" />
          <h3 className="text-sm font-semibold text-navy">Unmatched local bills</h3>
          <span className="text-xs text-navy/50">
            {unmatchedLocalBills.length} bill(s) the statement never mentions
          </span>
        </div>
        {unmatchedLocalBills.length === 0 ? (
          <p className="text-sm italic text-navy/50">
            No open local bills are missing from this statement.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-surface-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                <tr>
                  <th className="px-3 py-2 text-left">Bill #</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-right">Owed</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {unmatchedLocalBills.map((b) => (
                  <tr key={b.billId}>
                    <td className="px-3 py-2">
                      <Link
                        href={`/vendor-bills/${b.billId}`}
                        className="font-medium text-brand-600 hover:underline"
                      >
                        {b.billNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-navy/70">{fmtCalendarDate(b.billDate)}</td>
                    <td className="px-3 py-2 text-right text-navy/70">{fmt(b.totalOwed)}</td>
                    <td className="px-3 py-2 text-right font-medium text-navy">
                      {fmt(b.outstanding)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 5. Implied-paid proposal — its own panel, its own checkbox, its own
          second confirmation. NEVER folded into the main Apply below. */}
      {impliedPaidBills.length > 0 && (
        <Card className="border-2 border-danger/30">
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-danger" />
            <h3 className="text-sm font-semibold text-navy">Implied-paid proposal</h3>
          </div>
          <p className="text-sm text-navy/80">
            This statement implies these <strong>{impliedPaidBills.length}</strong> older bills
            {impliedPaidRange ? ` (${impliedPaidRange})` : ""} were settled —{" "}
            <strong>{fmt(impliedPaidTotal)}</strong> total. They predate the period this
            statement&apos;s opening balance already accounts for and are still open locally.
          </p>
          <label className="mt-3 flex items-center gap-2 text-sm font-medium text-navy">
            <input
              type="checkbox"
              checked={impliedPaidArmed}
              onChange={(e) => {
                if (e.target.checked) setImpliedPaidConfirmOpen(true);
                else setImpliedPaidArmed(false);
              }}
              className="h-4 w-4 rounded border-surface-border"
            />
            Mark these paid too
          </label>
          {impliedPaidArmed && (
            <p className="mt-1 text-xs font-medium text-success">
              Included — will mark {impliedPaidBills.length} bill(s) paid when you Apply below.
            </p>
          )}
        </Card>
      )}

      {/* Apply */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-navy/70">
              Notes (internal, optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Anything worth recording about this reconciliation…"
            />
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm text-navy/70">
              {includedEntries.length} bill(s) — {fmt(confirmedTotal)}
              {impliedPaidArmed && impliedPaidBills.length > 0 && (
                <>
                  {" "}
                  + {impliedPaidBills.length} older bill(s) marked paid ({fmt(impliedPaidTotal)})
                </>
              )}
            </p>
            <Button
              className="mt-2"
              onClick={() => void handleApply()}
              disabled={!canApply}
              loading={applyMutation.isPending}
            >
              Apply
            </Button>
          </div>
        </div>
      </Card>

      {impliedPaidConfirmOpen && (
        <ImpliedPaidConfirmOverlay
          bills={impliedPaidBills}
          total={impliedPaidTotal}
          onCancel={() => setImpliedPaidConfirmOpen(false)}
          onConfirm={() => {
            setImpliedPaidArmed(true);
            setImpliedPaidConfirmOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Implied-paid second confirmation ──────────────────────────────────────
// Hand-rolled overlay (not the shared `Modal`, capped at max-w-lg) — this can
// legitimately list dozens of bills. This dialog is the "second confirmation"
// the plan requires: checking the panel's checkbox only OPENS this; the box
// itself doesn't go checked until Confirm is clicked here.

function ImpliedPaidConfirmOverlay({
  bills,
  total,
  onCancel,
  onConfirm,
}: {
  bills: ImpliedPaidBill[];
  total: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-surface-border px-6 py-4">
          <ShieldAlert className="h-5 w-5 text-danger" />
          <h2 className="text-base font-semibold text-navy">Mark {bills.length} bill(s) paid?</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <p className="text-sm text-navy/80">
            This statement implies these bills were settled — they predate the period the
            statement&apos;s own opening balance already accounts for. Every bill this will mark
            paid is listed below; nothing outside this list is affected.
          </p>
          <div className="mt-3 overflow-hidden rounded-lg border border-surface-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                <tr>
                  <th className="px-3 py-2 text-left">Bill #</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-right">Marks paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {bills.map((b) => (
                  <tr key={b.billId}>
                    <td className="px-3 py-2 font-medium text-navy">{b.billNumber}</td>
                    <td className="px-3 py-2 text-navy/70">{fmtCalendarDate(b.billDate)}</td>
                    <td className="px-3 py-2 text-right text-navy">{fmt(b.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-right text-sm font-semibold text-navy">Total: {fmt(total)}</p>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Confirm — mark {bills.length} bill(s) paid
          </Button>
        </div>
      </div>
    </div>
  );
}
