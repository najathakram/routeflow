/**
 * Print a PDF blob via a hidden iframe.
 *
 * Lifted verbatim (WP4) from the invoice detail page's `handlePrint` iframe
 * body (`invoices/[id]/page.tsx:1668-1678`) into a shared, reusable export —
 * the invoices-list row Print button and the order-detail "Invoice Ready"
 * modal both call this instead of duplicating the iframe dance.
 */
export function printPdfBlob(blob: Blob): void {
  const blobUrl = URL.createObjectURL(blob);
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = blobUrl;
  document.body.appendChild(iframe);
  iframe.onload = () => {
    iframe.contentWindow?.print();
    setTimeout(() => {
      iframe.remove();
      URL.revokeObjectURL(blobUrl);
    }, 60_000);
  };
}
