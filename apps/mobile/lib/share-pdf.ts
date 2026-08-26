import { Linking, Platform } from "react-native";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { showToast } from "./toast";
import { chooseAction } from "./confirm";
import { classifyShareError } from "./share-error";

export interface SharePdfOptions {
  /** Fully-qualified (signed) PDF URL returned by `GET /invoices/:id/pdf`. */
  url: string;
  /** Suggested file name, e.g. "INV-2026-0001.pdf". */
  filename: string;
  /** Share-sheet title. */
  dialogTitle?: string;
  /**
   * Message to share alongside the file (e.g. the WhatsApp "your invoice is
   * ready" text). Passed through to the Web Share API's `text` field.
   * **Native `expo-sharing` is file-only** — `Sharing.shareAsync` has no
   * message/caption parameter, so `text` is silently ignored on native, and
   * on the `window.open` fallback (there's no share sheet to hand it to).
   */
  text?: string;
  /**
   * What's left of the transient-activation budget, in ms, measured from the
   * ORIGINAL tap — not from when this call started. A caller that does its
   * own async prep before calling `sharePdf` (e.g. fetching the signed PDF
   * url via an API mutation) must pass what's left of `ACTIVATION_BUDGET_MS`
   * so the total tap→share() latency never silently blows past the browser's
   * activation window. Defaults to the full budget.
   */
  budgetMs?: number;
  /**
   * Set this ONLY if the caller reacts to a `"ready-await-tap"` outcome by
   * flipping its own control to "PDF ready — tap to share" (the phase/ref
   * dance in the operator invoice/order screens). Callers that ignore the
   * outcome must leave it off: `sharePdf` then hands the operator an
   * explicit "Share PDF" action itself, so a slow link can never end in a
   * tap that does nothing at all.
   */
  retapHandled?: boolean;
}

/**
 * How long, in ms, we'll wait for the PDF to be ready before giving up on
 * sharing/opening it within the SAME tap and instead asking for a second,
 * fresh tap. `navigator.share()` requires "transient user activation" — the
 * browser only honors it for a short window after a real tap/click, and that
 * window survives a SHORT await (it does not survive a `setTimeout`/idle
 * gap). 3s is comfortably inside that window on the mainstream mobile
 * browsers this targets (Android Chrome, iOS Safari) while still being long
 * enough to cover a normal-speed PDF fetch.
 */
export const ACTIVATION_BUDGET_MS = 3000;

/**
 * Outcome of a {@link sharePdf} call.
 *  - `"shared"` — the OS/browser share sheet was invoked (this also covers
 *    the user dismissing it: the Web Share API can't distinguish "sent" from
 *    "cancelled", and neither can we — that was already true before this
 *    change, see the AbortError handling below).
 *  - `"opened-tab"` — no file-share capability (or the file couldn't be
 *    downloaded for one); the PDF opened in a new tab instead.
 *  - `"ready-await-tap"` — the PDF wasn't ready inside the activation
 *    budget, OR `share()` itself rejected with NotAllowedError (iOS Safari's
 *    transient activation not surviving the fetch — see share-error.ts; the
 *    file IS downloaded and cached, so the recovery is identical: one fresh
 *    tap). Nothing was shared or opened. A caller that passed
 *    `retapHandled` should flip its control to a "PDF ready — tap to share"
 *    state; calling `sharePdf` again with the SAME `url` is cheap (the fetch
 *    is cached module-wide) and, once the fetch has actually finished,
 *    resolves on a microtask — fast enough to still carry the SECOND tap's
 *    own activation. Callers that DIDN'T pass it have already been handed an
 *    explicit "Share PDF" action on the operator's behalf, so this outcome
 *    is never silent either.
 *  - `"failed"` — a real failure. Already toasted (or, for the window.open
 *    fallback past budget, already handed the operator an explicit "Open
 *    PDF" action) — callers don't need to toast again.
 */
export type ShareOutcome = "shared" | "opened-tab" | "ready-await-tap" | "failed";

/**
 * Synchronous capability probe — no `await`, safe to call at render time to
 * decide copy/labels before the user has tapped anything. Native builds are
 * always treated as capable: unlike `navigator.share`, `expo-sharing` isn't
 * gated by a transient-activation window, so its real
 * `Sharing.isAvailableAsync()` check can safely happen at share time instead
 * (see {@link sharePdf}'s native branch) without risking a silent failure.
 */
export function canShareFilesHere(): boolean {
  if (Platform.OS !== "web") return true;
  const nav: any = typeof navigator !== "undefined" ? navigator : undefined;
  return !!(nav?.share && nav?.canShare);
}

/**
 * Open a (signed) PDF url directly — the plain "Open PDF" action, independent
 * of whether the OS/browser share API is available or a share just failed.
 * This is the SAME `window.open(url, "_blank", "noopener")` fallback
 * `sharePdf` itself already falls back to once file-sharing isn't available
 * or the activation budget runs out (see the two `window.open` call sites
 * below) — exposed standalone so a caller can offer it as its own always-on
 * row instead of only reaching it through a failed/degraded share attempt.
 * Native has no tab to open, so it defers to `Linking.openURL` — the same
 * pattern already used elsewhere in this app to open receipt/tracking links
 * (e.g. `(operator)/(tabs)/invoices/[id].tsx`'s payment-receipt viewer).
 */
export function openPdfInTab(url: string): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener");
      return;
    }
    showToast("Couldn't open the PDF.");
    return;
  }
  Linking.openURL(url).catch(() => showToast("Couldn't open the PDF."));
}

// Per-url fetch cache. Lets a "second tap" (after the first timed out against
// ACTIVATION_BUDGET_MS) reuse the in-flight/finished download instead of
// re-fetching, and — once resolved — hand `navigator.share()` an
// already-in-hand File synchronously rather than a fresh network fetch.
//
// Every terminal outcome releases its own entry (see `releasePdfFile`), but
// some attempts simply never come back — the operator dismisses the retap
// dialog, or navigates away mid-fetch — and each entry pins a whole PDF's
// bytes in memory on a long-lived Expo Web session. Callers that re-mint a
// signed url per tap also key a NEW entry every time. So the map is capped
// LRU-style: only the most recent handful of shares can still be awaiting a
// second tap, and anything older is already unreachable.
const PDF_CACHE_MAX = 3;
const pdfFileCache = new Map<string, Promise<File>>();

function fetchPdfFile(url: string, filename: string): Promise<File> {
  const cached = pdfFileCache.get(url);
  if (cached) {
    // Re-insert to mark it as most-recently-used (Map iterates in insertion
    // order, so the eviction below always drops the oldest entry).
    pdfFileCache.delete(url);
    pdfFileCache.set(url, cached);
    return cached;
  }
  const pending = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`PDF fetch failed (${res.status})`);
      return res.blob();
    })
    .then((blob) => new File([blob], sanitizeFilename(filename), { type: "application/pdf" }));
  pdfFileCache.set(url, pending);
  // Don't poison the cache with a failed attempt — the next tap should retry.
  // Identity-checked so a late rejection can't evict a newer entry for the
  // same url that a retry has since put in its place.
  pending.catch(() => {
    if (pdfFileCache.get(url) === pending) pdfFileCache.delete(url);
  });
  while (pdfFileCache.size > PDF_CACHE_MAX) {
    const oldest = pdfFileCache.keys().next().value;
    if (oldest === undefined) break;
    pdfFileCache.delete(oldest);
  }
  return pending;
}

/**
 * Free a cached PDF's bytes once its share attempt has reached a TERMINAL
 * outcome (shared, dismissed, unshareable, or failed). Deliberately NOT
 * called on the budget-expiry path — that's the one case the cache exists
 * for, since the operator's second tap has to find the download waiting.
 */
function releasePdfFile(url: string): void {
  pdfFileCache.delete(url);
}

const BUDGET_EXPIRED = Symbol("pdf-share-budget-expired");
const FETCH_FAILED = Symbol("pdf-share-fetch-failed");

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | typeof BUDGET_EXPIRED> {
  if (ms <= 0) return Promise.resolve(BUDGET_EXPIRED);
  return Promise.race([
    promise,
    new Promise<typeof BUDGET_EXPIRED>((resolve) => setTimeout(() => resolve(BUDGET_EXPIRED), ms)),
  ]);
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
 * **Contract for callers on web:** never `await` anything between the user's
 * tap and calling `sharePdf` — awaiting a PDF fetch there burns the
 * transient-activation window, so on a slow link BOTH `navigator.share` and
 * the `window.open` fallback fail, silently, and the operator's tap does
 * nothing. Call `sharePdf` as the first async step of the tap handler and let
 * it own the budget internally; every failure path already toasts (or, once
 * the budget is spent, hands back an explicit "Open PDF" action) — nothing
 * about the outcome needs to be silent again.
 */
export async function sharePdf(options: SharePdfOptions): Promise<ShareOutcome> {
  if (Platform.OS !== "web") return sharePdfNative(options);
  return sharePdfWeb(options);
}

async function sharePdfNative(options: SharePdfOptions): Promise<ShareOutcome> {
  const { url, filename, dialogTitle } = options;
  // `text` is intentionally unused here — `expo-sharing`'s shareAsync has no
  // message/caption parameter, only a file (documented on SharePdfOptions.text).
  try {
    const target = (FileSystem.cacheDirectory ?? "") + sanitizeFilename(filename);
    const { uri } = await FileSystem.downloadAsync(url, target);
    if (!(await Sharing.isAvailableAsync())) {
      showToast("Sharing isn't available on this device.");
      return "failed";
    }
    await Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      dialogTitle: dialogTitle ?? filename,
      UTI: "com.adobe.pdf",
    });
    return "shared";
  } catch (err: any) {
    showToast(err?.message ?? "Couldn't share the PDF.");
    return "failed";
  }
}

/**
 * The caller isn't driving its own "PDF ready — tap to share" control, so
 * hand the operator an explicit action rather than returning silently. The
 * dialog button's press is a FRESH gesture (its own transient activation)
 * and re-enters `sharePdfWeb` with the SAME `url`, whose fetch has by then
 * almost certainly resolved — so `share()` is reached on a microtask. It has
 * to be this closure and not "tap the button again": callers like the
 * statement/tobacco screens mint a NEW signed url per tap, which would miss
 * the per-url cache and just race the budget all over again.
 */
function offerRetapShare(options: SharePdfOptions): void {
  chooseAction("PDF ready", "It took a moment too long to share automatically.", [
    {
      label: "Share PDF",
      style: "default",
      onPress: () => {
        // Backstop: this press has no caller left to catch a rejection, so a
        // throw here would be the exact silence this dialog exists to avoid.
        void sharePdfWeb({ ...options, budgetMs: ACTIVATION_BUDGET_MS }).catch(() => {
          showToast("Couldn't share the PDF.");
        });
      },
    },
    { label: "Dismiss", style: "cancel" },
  ]);
}

async function sharePdfWeb(options: SharePdfOptions): Promise<ShareOutcome> {
  const {
    url,
    filename,
    dialogTitle,
    text,
    retapHandled,
    budgetMs = ACTIVATION_BUDGET_MS,
  } = options;
  const nav: any = typeof navigator !== "undefined" ? navigator : undefined;
  const deadline = Date.now() + Math.max(0, budgetMs);

  // Web Share API level 2 — share the file directly, no download step.
  if (nav?.share && nav?.canShare) {
    // The DOWNLOAD's own failures (non-2xx signed url, expired signature,
    // offline, CORS) happen before share() is ever reached, so the share
    // catch below can't see them. Catch them here instead: toast — no
    // failure path may be silent, and this one can arrive on a retap where
    // no caller is left holding a try/catch — then fall through to opening
    // the plain url, which needs no fetch of ours.
    const raced = await withBudget(fetchPdfFile(url, filename), deadline - Date.now()).catch(() => {
      releasePdfFile(url);
      showToast("Couldn't prepare the PDF for sharing.");
      return FETCH_FAILED;
    });
    if (raced === BUDGET_EXPIRED) {
      // The download keeps running in the background (only our WAIT for it
      // stopped) — a second tap picks up the by-then-probably-finished
      // cached file synchronously instead of re-fetching. That second tap is
      // the caller's own control when it asked for it, otherwise the dialog
      // below; either way the operator is never left with nothing.
      if (!retapHandled) offerRetapShare(options);
      return "ready-await-tap";
    }
    if (raced !== FETCH_FAILED) {
      const file = raced;
      try {
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], text, title: dialogTitle ?? filename });
          releasePdfFile(url); // no further need — free the bytes
          return "shared";
        }
        // This exact file isn't shareable (rare) — fall through to opening it.
        releasePdfFile(url);
      } catch (err: any) {
        switch (classifyShareError(err?.name)) {
          case "dismissed":
            // User dismissed the OS share sheet — not an error.
            releasePdfFile(url);
            return "shared";
          case "retap": {
            // iOS Safari: share() rejected with NotAllowedError because the
            // transient-activation window didn't survive the PDF fetch — even
            // though the fetch is DONE and the File is in hand. This is the
            // customer-visible "share works on desktop, fails on my phone"
            // bug. Recover exactly like a budget expiry: KEEP the cached file
            // (do NOT release it — the whole point is that the next tap
            // shares it synchronously under its own fresh activation) and
            // hand the operator one explicit tap.
            if (!retapHandled) offerRetapShare(options);
            return "ready-await-tap";
          }
          case "failed":
            releasePdfFile(url);
            showToast("Couldn't share the PDF.");
            return "failed";
        }
      }
    }
  }

  // Fallback: open the PDF directly (desktop browsers without file-level Web
  // Share, the rare canShare(files) rejection above, or a download that failed
  // before share() could be reached). This needs no fetch of its own — `url`
  // is already a plain string — so the only way it can still be past budget is
  // if the CALLER already spent it on its own async prep (e.g. fetching the
  // signed url) before calling us. In that case
  // calling window.open() blind risks a silent popup-block, so we hand the
  // operator an explicit action instead — a tap on it is a fresh gesture.
  if (deadline - Date.now() <= 0) {
    chooseAction("PDF ready", "It took a moment too long to open automatically.", [
      {
        label: "Open PDF",
        style: "default",
        onPress: () => {
          if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
        },
      },
      { label: "Dismiss", style: "cancel" },
    ]);
    return "failed";
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener");
    return "opened-tab";
  }
  showToast("Couldn't open the PDF.");
  return "failed";
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

export interface ShareCsvTextOptions {
  /** Raw CSV bytes, already fully serialized server-side (e.g. fetchRegulatedReportCsvText). */
  csv: string;
  /** Suggested file name, e.g. "acme-tobacco-tx_comptroller-2026-06-01-2026-06-30.csv". */
  filename: string;
  /** Share-sheet title. */
  dialogTitle?: string;
}

/**
 * Share CSV TEXT already in memory — the sibling of {@link shareCsv} for endpoints that
 * need an auth header the OS share sheet can't send (e.g. the regulated reports CSV export,
 * which is computed on demand and never gets a presigned URL). Nothing is downloaded from a
 * URL here: the caller already has the bytes.
 *
 * - **Web**: wraps the string in a Blob and triggers a programmatic `<a download>`.
 * - **Native**: writes the string to the app's CACHE directory (not the user-visible
 *   Downloads/Photos) and presents the native share sheet via `expo-sharing`.
 *
 * Leaves {@link sharePdf} and {@link shareCsv} untouched — this is a standalone sibling,
 * not a generic parameter on either.
 */
export async function shareCsvText({
  csv,
  filename,
  dialogTitle,
}: ShareCsvTextOptions): Promise<void> {
  const name = sanitizeCsvFilename(filename);

  if (Platform.OS === "web") {
    if (typeof document === "undefined") return;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
    return;
  }

  const target = (FileSystem.cacheDirectory ?? "") + name;
  await FileSystem.writeAsStringAsync(target, csv, { encoding: FileSystem.EncodingType.UTF8 });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }
  await Sharing.shareAsync(target, {
    mimeType: "text/csv",
    dialogTitle: dialogTitle ?? name,
    UTI: "public.comma-separated-values-text",
  });
}
