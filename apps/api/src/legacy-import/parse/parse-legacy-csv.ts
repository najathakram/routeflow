import { Readable, pipeline } from "node:stream";
import { parse } from "csv-parse";
import { decodeLegacyBytes, type DecodeOptions, type LegacySource } from "./decode-stream";
import { LegacyParseError, type LegacyIssue } from "./legacy-issue";

export interface CsvRecord {
  /** 1-based, the header is record 1. */
  recordNo: number;
  /** 1-based physical line where the record starts. */
  physicalLine: number;
  cells: string[];
}

export type CsvEvent =
  | { type: "header"; headers: string[] }
  | ({ type: "record" } & CsvRecord)
  | { type: "issue"; issue: LegacyIssue };

interface ParsedRow {
  info: { lines: number; records: number };
  record: string[];
}

/**
 * Streamed strict CSV read on csv-parse (streaming API): decode (BOM / stray 0xA0 stripped), trim
 * header keys, and never fill or drop a row silently. A row with fewer or more cells than the
 * header is an ERROR issue and is not yielded. A malformed quote or bad byte throws a
 * LegacyParseError (fail loud). Record ends are CRLF or LF; LF inside quotes stays in the field.
 */
export async function* parseLegacyCsv(
  source: LegacySource,
  opts: Pick<DecodeOptions, "encoding"> = {},
): AsyncGenerator<CsvEvent> {
  const queued: LegacyIssue[] = [];
  const decoded = Readable.from(
    decodeLegacyBytes(source, { encoding: opts.encoding, onIssue: (i) => queued.push(i) }),
  );
  const parser = parse({
    columns: false,
    info: true,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: false,
    record_delimiter: ["\r\n", "\n"],
  });
  pipeline(decoded, parser, () => undefined);

  let headers: string[] | null = null;
  let previousEnd = 0;
  try {
    for await (const row of parser as unknown as AsyncIterable<ParsedRow>) {
      while (queued.length) yield { type: "issue", issue: queued.shift() as LegacyIssue };
      const startLine = previousEnd + 1;
      previousEnd = row.info.lines;
      if (headers === null) {
        headers = row.record.map((h) => h.trim());
        yield { type: "header", headers };
        continue;
      }
      const have = row.record.length;
      if (have !== headers.length) {
        const short = have < headers.length;
        yield {
          type: "issue",
          issue: {
            severity: "ERROR",
            code: short ? "ROW_SHORT" : "ROW_LONG",
            message: `The row has ${have} cells but the header has ${headers.length}.`,
            recordNo: row.info.records,
            physicalLine: startLine,
          },
        };
        continue;
      }
      yield {
        type: "record",
        recordNo: row.info.records,
        physicalLine: startLine,
        cells: row.record,
      };
    }
  } catch (err) {
    if (err instanceof LegacyParseError) throw err;
    const e = err as { code?: string; lines?: number; message?: string };
    throw new LegacyParseError(
      "CSV_SYNTAX",
      `The file could not be read as CSV (${e.code ?? "parse error"}).`,
      typeof e.lines === "number" ? e.lines : null,
    );
  }
  while (queued.length) yield { type: "issue", issue: queued.shift() as LegacyIssue };
  if (headers === null) throw new LegacyParseError("EMPTY_FILE", "The file has no header row.");
}

export interface CollectedCsv {
  headers: string[];
  records: CsvRecord[];
  issues: LegacyIssue[];
}

/** Collect the whole stream in memory. For tests and small files; the job iterates instead. */
export async function collectLegacyCsv(
  source: LegacySource,
  opts: Pick<DecodeOptions, "encoding"> = {},
): Promise<CollectedCsv> {
  const out: CollectedCsv = { headers: [], records: [], issues: [] };
  for await (const ev of parseLegacyCsv(source, opts)) {
    if (ev.type === "header") out.headers = ev.headers;
    else if (ev.type === "issue") out.issues.push(ev.issue);
    else
      out.records.push({ recordNo: ev.recordNo, physicalLine: ev.physicalLine, cells: ev.cells });
  }
  return out;
}
