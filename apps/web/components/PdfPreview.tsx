"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";

/** The one sentence a site's `fallback` says when the PDF can't be drawn. */
export const PDF_PREVIEW_UNAVAILABLE = "Preview isn't available here.";

/**
 * Where `scripts/copy-pdfjs-fallbacks.mjs` puts pdf.js's JavaScript decoders. With wasm off and no URL, a JBIG2 or JPX scan
 * draws white and pdf.js raises nothing, so `fallback` never fires (SA-1074 A-1). The trailing slash is required.
 */
const PDF_WASM_URL = "/pdfjs/";

/** iOS limits total canvas memory, so a very long PDF stops here and says so. */
export const PDF_PREVIEW_MAX_PAGES = 50;

const isTouch = () =>
  typeof window !== "undefined" && window.matchMedia?.("(any-pointer: coarse)").matches === true;

export interface PdfPreviewProps {
  /** The PDF's URL: what desktop's iframe loads, and what restarts the canvas when it changes. */
  src: string;
  title: string;
  className?: string;
  /** The PDF's bytes. CSP's `connect-src` refuses a blob fetch, so pdf.js is handed bytes, never a URL. */
  getBytes: () => Promise<Blob>;
  /** Shown when the PDF can't be drawn: the preview is never blank. */
  fallback: React.ReactNode;
}

/**
 * W-1064 (SA-1074): a PDF preview that scrolls on a phone. `fallback` covers what pdf.js raises; a bad image inside a page
 * isn't raised. iOS draws a PDF in an iframe at its own size and doesn't scroll it,
 * and Android Chrome doesn't draw one inline at all, so touch devices get canvases. Desktop keeps the iframe, for its zoom,
 * find and print.
 */
export function PdfPreview({ src, title, className, getBytes, fallback }: PdfPreviewProps) {
  const [touch] = React.useState(isTouch);
  if (!touch) return <iframe src={src} title={title} className={className} />;
  return (
    <PdfCanvases
      src={src}
      title={title}
      className={className}
      getBytes={getBytes}
      fallback={fallback}
    />
  );
}

function PdfCanvases({ src, title, className, getBytes, fallback }: PdfPreviewProps) {
  const [failed, setFailed] = React.useState(false);
  const [overCap, setOverCap] = React.useState<number | null>(null);
  const pagesRef = React.useRef<HTMLDivElement>(null);
  const getBytesRef = React.useRef(getBytes);
  getBytesRef.current = getBytes;

  // `src` is the only dependency: the scan modal's ◀ ▶ swaps it while the modal stays open.
  React.useEffect(() => {
    const pages = pagesRef.current;
    if (!pages) return;
    let stopped = false;
    let destroy: (() => unknown) | null = null;
    pages.replaceChildren();
    setFailed(false);
    setOverCap(null);

    void (async () => {
      try {
        const blob = await getBytesRef.current();
        const data = new Uint8Array(await blob.arrayBuffer());
        const [pdfjs, { pdfWorkerSrc }] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.min.mjs"),
          import("@/lib/pdf-worker"),
        ]);
        if (stopped) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
        // No text or annotation layer, so a link or a script in a PDF does nothing. `script-src` has no `wasm-unsafe-eval`, so
        // the wasm decoders stay off and a scan decodes through the JavaScript fallbacks.
        const task = pdfjs.getDocument({ data, useWasm: false, wasmUrl: PDF_WASM_URL });
        destroy = () => task.destroy();
        const pdf = await task.promise;
        if (stopped) return;
        if (pdf.numPages > PDF_PREVIEW_MAX_PAGES) setOverCap(pdf.numPages);
        const count = Math.min(pdf.numPages, PDF_PREVIEW_MAX_PAGES);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= count; n += 1) {
          const page = await pdf.getPage(n);
          if (stopped) return;
          const natural = page.getViewport({ scale: 1 });
          const scale = ((pages.clientWidth || natural.width) / natural.width) * dpr;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.display = "block";
          canvas.style.width = "100%";
          const canvasContext = canvas.getContext("2d");
          if (!canvasContext) throw new Error("No canvas context");
          pages.appendChild(canvas);
          await page.render({ canvas, canvasContext, viewport }).promise;
          if (stopped) return;
        }
      } catch {
        if (!stopped) setFailed(true);
      }
    })();

    return () => {
      stopped = true;
      void destroy?.();
    };
  }, [src]);

  if (failed)
    return <div className={cn("flex items-center justify-center p-6", className)}>{fallback}</div>;
  return (
    <div
      role="group"
      aria-label={title}
      tabIndex={0}
      className={cn("overflow-y-auto overscroll-contain bg-surface-raised", className)}
      style={{ touchAction: "pan-x pan-y pinch-zoom" }}
    >
      <div ref={pagesRef} className="space-y-2" />
      {overCap !== null ? (
        <p className="p-3 text-center text-sm text-navy/70">
          Showing the first {PDF_PREVIEW_MAX_PAGES} of {overCap} pages.
        </p>
      ) : null}
    </div>
  );
}
