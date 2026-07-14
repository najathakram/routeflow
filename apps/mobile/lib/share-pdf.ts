import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

export interface SharePdfOptions {
  /** Fully-qualified (signed) PDF URL returned by `GET /invoices/:id/pdf`. */
  url: string;
  /** Suggested file name, e.g. "INV-2026-0001.pdf". */
  filename: string;
  /** Share-sheet title. */
  dialogTitle?: string;
}

/**
 * Share a PDF straight to the OS / browser share sheet WITHOUT first saving it
 * to the user's Downloads or Photos.
 *
 * - **Web build** (the primary RouteFlow mobile deployment): fetch the signed
 *   URL into memory and hand a `File` to the Web Share API (`navigator.share`,
 *   level 2 — supported on Android Chrome & iOS Safari). Nothing is written to
 *   disk. Falls back to opening the PDF in a new tab when the browser can't
 *   share files (most desktops).
 * - **Native**: download to the app's CACHE directory (not the user-visible
 *   Downloads/Photos) and present the native share sheet via `expo-sharing`.
 *
 * Resolves quietly when the user dismisses the share sheet.
 */
export async function sharePdf({ url, filename, dialogTitle }: SharePdfOptions): Promise<void> {
  if (Platform.OS === "web") {
    await sharePdfWeb(url, filename, dialogTitle);
    return;
  }

  const target = (FileSystem.cacheDirectory ?? "") + sanitizeFilename(filename);
  const { uri } = await FileSystem.downloadAsync(url, target);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }
  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    dialogTitle: dialogTitle ?? filename,
    UTI: "com.adobe.pdf",
  });
}

async function sharePdfWeb(url: string, filename: string, dialogTitle?: string): Promise<void> {
  const nav: any = typeof navigator !== "undefined" ? navigator : undefined;

  // Web Share API level 2 — share the file directly, no download step.
  if (nav?.share && nav?.canShare) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`PDF fetch failed (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], sanitizeFilename(filename), { type: "application/pdf" });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: dialogTitle ?? filename });
        return;
      }
    } catch (err: any) {
      // User dismissed the OS share sheet — not an error.
      if (err?.name === "AbortError") return;
      // Any other failure → fall through to opening the PDF.
    }
  }

  // Fallback: open the PDF (browsers without file-level Web Share, e.g. desktop).
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener");
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const base = cleaned || "invoice";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

export interface ShareCsvOptions {
  /** Fully-qualified (signed) CSV URL, e.g. from `fetchRegulatedFilingUrl(id, "csv")`. */
  url: string;
  /** Suggested file name, e.g. "regulated-filing-2026-06.csv". */
  filename: string;
  /** Share-sheet title. */
  dialogTitle?: string;
}

/**
 * Share a CSV straight to the OS / browser share sheet, mirroring {@link sharePdf}
 * but for `text/csv` artifacts (e.g. a regulated filing's presigned CSV URL). Kept
 * as a standalone sibling rather than a generic parameter on `sharePdf` so the
 * existing, widely-used PDF path is untouched.
 */
export async function shareCsv({ url, filename, dialogTitle }: ShareCsvOptions): Promise<void> {
  if (Platform.OS === "web") {
    await shareCsvWeb(url, filename, dialogTitle);
    return;
  }

  const target = (FileSystem.cacheDirectory ?? "") + sanitizeCsvFilename(filename);
  const { uri } = await FileSystem.downloadAsync(url, target);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }
  await Sharing.shareAsync(uri, {
    mimeType: "text/csv",
    dialogTitle: dialogTitle ?? filename,
    UTI: "public.comma-separated-values-text",
  });
}

async function shareCsvWeb(url: string, filename: string, dialogTitle?: string): Promise<void> {
  const nav: any = typeof navigator !== "undefined" ? navigator : undefined;

  if (nav?.share && nav?.canShare) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`CSV fetch failed (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], sanitizeCsvFilename(filename), { type: "text/csv" });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: dialogTitle ?? filename });
        return;
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
    }
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener");
  }
}

function sanitizeCsvFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const base = cleaned || "export";
  return base.toLowerCase().endsWith(".csv") ? base : `${base}.csv`;
}
