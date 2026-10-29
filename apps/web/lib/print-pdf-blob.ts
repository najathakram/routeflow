/**
 * Print a PDF blob via an invisible iframe.
 *
 * Lifted (WP4) from the invoice detail page's `handlePrint` iframe body into a shared, reusable export — the
 * invoices-list row Print button, the order-detail "Invoice Ready" modal and the counter's Print invoice all
 * call this instead of duplicating the iframe dance.
 *
 * SA-1026 B: the frame is invisible but LAID OUT (1px, transparent), never `display:none`. Chrome's PDF viewer
 * does not start inside a display:none (0x0) frame, so `print()` had nothing to print. If the frame still
 * cannot print, the PDF opens in a new tab, where the viewer's own Print button works.
 */
export function printPdfBlob(blob: Blob): void {
  const blobUrl = URL.createObjectURL(blob);
  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.src = blobUrl;
  document.body.appendChild(iframe);
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      window.open(blobUrl, "_blank");
    }
    setTimeout(() => {
      iframe.remove();
      URL.revokeObjectURL(blobUrl);
    }, 60_000);
  };
}
