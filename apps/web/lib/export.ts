/**
 * Client-side CSV export utility.
 * Accepts rows as arrays of values; builds a CSV blob and triggers a download.
 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
): void {
  const escape = (v: string | number | boolean | null | undefined): string => {
    const s = v == null ? "" : String(v);
    // Quote if contains comma, newline, or double-quote
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))];

  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Format a date string for CSV (YYYY-MM-DD) */
export function csvDate(d?: string | null): string {
  if (!d) return "";
  return d.split("T")[0];
}
