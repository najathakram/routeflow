import { parseLegacyCsv } from "../parse/parse-legacy-csv";
import type { DecodeOptions, LegacySource } from "../parse/decode-stream";
import { LegacyParseError, type LegacyIssue } from "../parse/legacy-issue";
import {
  defaultAdapterRegistry,
  type AdapterRegistry,
  type SourceAdapter,
} from "./adapter-registry";
import type { CanonicalLine } from "./canonical";
import { groupDocuments, type GroupedDocument } from "./group-documents";

export interface SalesFileResult {
  adapterKey: string;
  adapterVersion: number;
  linksKnown: boolean;
  headers: string[];
  lineCount: number;
  documents: GroupedDocument[];
  issues: LegacyIssue[];
}

/**
 * Glue for one sales-lines file: decode, parse, resolve the adapter from the header (refusing an
 * unknown one before any row is adapted), adapt every record, group into documents. Pure: it
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

  const grouped = groupDocuments(lines);
  return {
    adapterKey: adapter.key,
    adapterVersion: adapter.version,
    linksKnown: adapter.linksKnown,
    headers,
    lineCount: lines.length,
    documents: grouped.documents,
    issues: [...issues, ...grouped.issues],
  };
}
