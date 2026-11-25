import { parseLegacyCsv } from "../parse/parse-legacy-csv";
import type { DecodeOptions, LegacySource } from "../parse/decode-stream";
import { LegacyParseError, type LegacyIssue, type LegacyIssueCode } from "../parse/legacy-issue";
import {
  defaultAdapterRegistry,
  type AdapterRegistry,
  type SourceAdapter,
} from "./adapter-registry";
import type { CanonicalLine } from "./canonical";
import { groupDocuments, type DroppedRow, type GroupedDocument } from "./group-documents";

export interface SalesFileResult {
  adapterKey: string;
  adapterVersion: number;
  linksKnown: boolean;
  headers: string[];
  lineCount: number;
  documents: GroupedDocument[];
  /**
   * True when an ERROR row cannot be tied to any document (no document number, or a dropped row
   * with a blank first cell): the file's documents cannot be trusted, so `documents` is empty.
   */
  blocked: boolean;
  blockReasons: LegacyIssueCode[];
  issues: LegacyIssue[];
}

function droppedRowOf(i: LegacyIssue): DroppedRow | null {
  if ((i.code === "ROW_SHORT" || i.code === "ROW_LONG") && i.sourceDocKey) {
    return { docNumber: i.sourceDocKey, code: i.code };
  }
  return null;
}

/**
 * Glue for one sales-lines file: decode, parse, resolve the adapter from the header (refusing an
 * unknown one before any row is adapted), adapt every record, group into documents. A row the
 * parser dropped holds its document; one that names no document blocks the whole file. Pure: it
 * stages and writes nothing. The caller owns persistence (a later PR).
 */
export async function readSalesFile(
  source: LegacySource,
  opts: Pick<DecodeOptions, "encoding"> & { registry?: AdapterRegistry } = {},
): Promise<SalesFileResult> {
  const registry = opts.registry ?? defaultAdapterRegistry;
  const issues: LegacyIssue[] = [];
  const lines: CanonicalLine[] = [];
  let adapter: SourceAdapter | null = null;
  let headers: string[] = [];

  for await (const ev of parseLegacyCsv(source, { encoding: opts.encoding })) {
    if (ev.type === "issue") {
      issues.push(ev.issue);
    } else if (ev.type === "header") {
      const resolved = registry.resolve(ev.headers);
      if (!resolved.ok) throw new LegacyParseError("UNKNOWN_SHAPE", resolved.message, 1);
      adapter = resolved.adapter;
      headers = ev.headers;
    } else if (adapter) {
      const { line } = adapter.adaptRecord({
        headers,
        cells: ev.cells,
        recordNo: ev.recordNo,
        physicalLine: ev.physicalLine,
      });
      if (line) lines.push(line);
    }
  }
  if (!adapter) throw new LegacyParseError("EMPTY_FILE", "The file has no header row.");

  const dropped = issues.map(droppedRowOf).filter((d): d is DroppedRow => d !== null);
  const grouped = groupDocuments(lines, { dropped });
  const all = [...issues, ...grouped.issues];

  const blockReasons = [
    ...new Set(
      all
        .filter(
          (i) =>
            i.severity === "ERROR" &&
            (i.code === "BLANK_DOCUMENT_NUMBER" ||
              ((i.code === "ROW_SHORT" || i.code === "ROW_LONG") && !i.sourceDocKey)),
        )
        .map((i) => i.code),
    ),
  ];
  const blocked = blockReasons.length > 0;

  return {
    adapterKey: adapter.key,
    adapterVersion: adapter.version,
    linksKnown: adapter.linksKnown,
    headers,
    lineCount: lines.length,
    documents: blocked ? [] : grouped.documents,
    blocked,
    blockReasons,
    issues: all,
  };
}
