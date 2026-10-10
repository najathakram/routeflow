import { filenameFromDisposition } from "./csv-export-request";

/**
 * Save `data` as a pretty-printed JSON file. Kept apart from lib/export.ts: that module is the CSV
 * writer (BOM, formula-injection guard) and none of it applies to a JSON document.
 */
export function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The Content-Disposition filename when the server sent one, else `prefix-YYYY-MM-DD.json` (UTC). */
export function jsonExportFilename(prefix: string, disposition: unknown): string {
  return (
    filenameFromDisposition(disposition) ??
    `${prefix}-${new Date().toISOString().slice(0, 10)}.json`
  );
}
