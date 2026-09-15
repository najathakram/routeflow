import { Platform } from "react-native";
// expo-file-system/legacy, not the package root: SDK 54 rewrote this module and moved
// downloadAsync/cacheDirectory behind this entry point — see share-pdf.ts for the full
// B203 history. Reuse the same legacy entry point here.
import * as FileSystem from "expo-file-system/legacy";
import { showToast } from "./toast";
import { openPdfInTab } from "./share-pdf";
import { classifyPrintError, printTransport } from "./print-logic";

export interface PrintPdfOptions {
  /** Fully-qualified (signed) PDF URL returned by `GET /invoices/:id/pdf`. */
  url: string;
  /** Suggested file name, e.g. "INV-2026-0001-final.pdf". */
  filename: string;
}

export type PrintOutcome = "printed" | "dismissed" | "opened-tab" | "failed" | "unavailable";

/**
 * Print a PDF from a (signed) url.
 *
 * - **Web** (R6.5): expo-print has no web implementation — route through the
 *   existing `openPdfInTab` (share-pdf.ts) instead, same as the order
 *   screen's "Open PDF" action; the OS print dialog is reachable from the
 *   browser's own tab chrome.
 * - **Native**: lazily import `expo-print` (R6.4 — never a top-level import,
 *   so a build without the native module linked never crashes just from
 *   importing this file), download the PDF to the app's cache directory,
 *   then hand the local uri to `Print.printAsync`.
 */
export async function printPdf({ url, filename }: PrintPdfOptions): Promise<PrintOutcome> {
  if (printTransport(Platform.OS) === "tab") {
    openPdfInTab(url);
    return "opened-tab";
  }

  let Print: typeof import("expo-print");
  try {
    Print = await import("expo-print");
  } catch {
    showToast("Printing needs the latest app version.");
    return "unavailable";
  }

  try {
    const target = (FileSystem.cacheDirectory ?? "") + filename.replace(/[^\w.-]+/g, "_");
    const { uri } = await FileSystem.downloadAsync(url, target);
    await Print.printAsync({ uri });
    return "printed";
  } catch (err: any) {
    const kind = classifyPrintError(err);
    if (kind === "failed") showToast("Couldn't print the PDF.");
    return kind;
  }
}
