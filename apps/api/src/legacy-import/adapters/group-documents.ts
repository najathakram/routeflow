import { roundMoney } from "@routeflow/pricing";
import type { LegacyIssue, LegacyIssueCode } from "../parse/legacy-issue";
import type { CanonicalLine, LineKind } from "./canonical";
import { classifyLine } from "./classify-line";
import { buildFallbackSourceKey, signClassOf, type SignClass } from "./sign-class";

export interface GroupedLine extends CanonicalLine {
  /** 1-based position inside the document (file order). */
  lineNo: number;
  /** `<document sourceKey>#<lineNo>`: an item is never a line key (the same item repeats). */
  lineKey: string;
  kind: LineKind;
}

export type DocumentKind = "INVOICE" | "NEGATIVE_UNKNOWN";

export interface GroupedDocument {
  sourceKey: string;
  docNumber: string;
  /** Exact customer text, or null when it is blank or in conflict (the document is held). */
  customerKey: string | null;
  issueDate: string | null;
  lines: GroupedLine[];
  /** Net of the file's line totals, or null when no line carries one. */
  netTotal: number | null;
  signClass: SignClass;
  kind: DocumentKind;
  /** A negative document with no type column posts nowhere: history only. */
  historyOnly: boolean;
  held: boolean;
  holdCodes: LegacyIssueCode[];
}

export interface GroupResult {
  documents: GroupedDocument[];
  issues: LegacyIssue[];
}

/**
 * Group canonical lines into documents by the document key (a Map, not adjacency), in first-seen
 * order. Never silent: a blank document number, a blank or conflicting customer, a date problem and
 * every line defect become issue rows, and the document is HELD. The customer text is never
 * folded or partially matched (ACME is not ACME 2). Totals are the file's totals only.
 */
export function groupDocuments(lines: Iterable<CanonicalLine>): GroupResult {
  const issues: LegacyIssue[] = [];
  const byDoc = new Map<string, CanonicalLine[]>();
  for (const line of lines) {
    if (line.docNumber === "") {
      issues.push({
        severity: "ERROR",
        code: "BLANK_DOCUMENT_NUMBER",
        message: "The row has no invoice number, so it belongs to no document.",
        recordNo: line.recordNo,
        physicalLine: line.physicalLine,
      });
      continue;
    }
    const bucket = byDoc.get(line.docNumber);
    if (bucket) bucket.push(line);
    else byDoc.set(line.docNumber, [line]);
  }

  const documents: GroupedDocument[] = [];
  for (const [docNumber, docLines] of byDoc) {
    const holds = new Set<LegacyIssueCode>();
    const first = docLines[0];
    const report = (
      code: LegacyIssueCode,
      message: string,
      at: CanonicalLine,
      severity: "ERROR" | "WARNING" = "ERROR",
    ) => {
      if (severity === "ERROR") holds.add(code);
      issues.push({
        severity,
        code,
        message,
        recordNo: at.recordNo,
        physicalLine: at.physicalLine,
        sourceDocKey: docNumber,
      });
    };

    for (const l of docLines) {
      for (const d of l.defects) report(d.code, `${d.column}: ${d.message}`, l);
    }

    const dates = [...new Set(docLines.map((l) => l.issueDate).filter((d): d is string => !!d))];
    let issueDate: string | null = null;
    if (dates.length === 1) issueDate = dates[0];
    else if (dates.length > 1) {
      report(
        "DOCUMENT_DATE_CONFLICT",
        "The same invoice number carries more than one date.",
        first,
      );
    } else if (!docLines.some((l) => l.defects.some((d) => d.code === "BAD_DATE"))) {
      report("MISSING_DATE", "The document has no invoice date.", first);
    }

    const names = [...new Set(docLines.map((l) => l.customerName).filter((n) => n !== ""))];
    let customerKey: string | null = null;
    if (first.customerName === "") {
      report("BLANK_CUSTOMER", "The first line of the document has no customer name.", first);
    } else if (names.length > 1) {
      report("CUSTOMER_CONFLICT", "The document names more than one customer.", first);
    } else {
      customerKey = names[0];
      for (const l of docLines) {
        if (l.customerName === "") {
          report(
            "BLANK_CUSTOMER_INHERITED",
            "A blank customer cell took the name used on the document's other lines.",
            l,
            "WARNING",
          );
        }
      }
    }

    const totals = docLines.map((l) => l.total).filter((t): t is number => t !== null);
    const netTotal = totals.length ? totals.reduce((a, t) => roundMoney(a + t), 0) : null;
    const signClass = signClassOf(netTotal);
    const sourceKey = buildFallbackSourceKey(signClass, docNumber);
    const kind: DocumentKind = signClass === "untyped-" ? "NEGATIVE_UNKNOWN" : "INVOICE";

    documents.push({
      sourceKey,
      docNumber,
      customerKey,
      issueDate,
      lines: docLines.map((l, i) => {
        const c = classifyLine(l);
        return {
          ...l,
          kind: c.kind,
          quantity: c.quantity,
          unitPrice: c.unitPrice,
          total: c.total,
          lineNo: i + 1,
          lineKey: `${sourceKey}#${i + 1}`,
        };
      }),
      netTotal,
      signClass,
      kind,
      historyOnly: kind === "NEGATIVE_UNKNOWN",
      held: holds.size > 0,
      holdCodes: [...holds],
    });
  }
  return { documents, issues };
}
