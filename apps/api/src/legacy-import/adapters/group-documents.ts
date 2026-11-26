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
  /**
   * False when the net is incomplete (a row the parser dropped, or a line whose Total is missing
   * or refused): the sign class and the key were computed from part of the document and are
   * provisional. A document with `keyFinal === false` is always held and must never be stored.
   */
  keyFinal: boolean;
}

export interface GroupResult {
  documents: GroupedDocument[];
  issues: LegacyIssue[];
}

/** A row the parser dropped (short or long) whose document number could be read from cell 0. */
export interface DroppedRow {
  docNumber: string;
  code: "ROW_SHORT" | "ROW_LONG";
}

function isBlankRow(l: CanonicalLine): boolean {
  return (
    l.docNumber === "" &&
    l.customerName === "" &&
    l.issueDate === null &&
    l.itemName === null &&
    l.description === null &&
    l.quantity === null &&
    l.unitPrice === null &&
    l.total === null &&
    l.sku === null &&
    l.defects.length === 0
  );
}

/** A line whose own Total is missing or refused leaves the document's net incomplete. */
function lacksUsableTotal(l: CanonicalLine): boolean {
  return l.total === null && (l.quantity !== null || l.unitPrice !== null || l.defects.length > 0);
}

/**
 * Group canonical lines into documents by the document key (a Map, not adjacency), in first-seen
 * order. Never silent: a blank document number, a blank or conflicting customer, a date problem,
 * a dropped row and every line defect become issue rows, and the document is HELD. The customer
 * text is never folded or partially matched (ACME is not ACME 2). Totals are the file's totals
 * only. A document whose net is incomplete is held and its key is marked provisional.
 */
export function groupDocuments(
  lines: Iterable<CanonicalLine>,
  opts: { dropped?: readonly DroppedRow[] } = {},
): GroupResult {
  const issues: LegacyIssue[] = [];
  const dropped = new Map<string, DroppedRow["code"]>();
  for (const d of opts.dropped ?? [])
    if (!dropped.has(d.docNumber)) dropped.set(d.docNumber, d.code);

  const byDoc = new Map<string, CanonicalLine[]>();
  for (const line of lines) {
    if (line.docNumber === "") {
      const blank = isBlankRow(line);
      issues.push({
        severity: blank ? "WARNING" : "ERROR",
        code: blank ? "BLANK_ROW" : "BLANK_DOCUMENT_NUMBER",
        message: blank
          ? "An entirely blank row was skipped."
          : "The row has no invoice number, so it belongs to no document.",
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

    // The parser already reported the dropped row itself (with this document number).
    const droppedCode = dropped.get(docNumber);
    if (droppedCode) holds.add(droppedCode);

    for (const l of docLines) {
      for (const d of l.defects) report(d.code, `${d.column}: ${d.message}`, l);
      if (l.defects.length === 0 && lacksUsableTotal(l)) {
        report("MISSING_TOTAL", "A priced line has no Total, so the net is incomplete.", l);
      }
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
    const keyFinal = !droppedCode && !docLines.some(lacksUsableTotal);

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
      keyFinal,
    });
  }
  return { documents, issues };
}
