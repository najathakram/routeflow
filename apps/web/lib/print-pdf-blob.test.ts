/**
 * WP4 / T10 (R6.6) — `printPdfBlob`'s iframe lifecycle.
 *
 * This is the existing, already-shipped `handlePrint` iframe body lifted
 * verbatim out of `apps/web/app/(dashboard)/invoices/[id]/page.tsx:1668-1678`
 * into a named, reusable export (ruling HL-7) — the timing/cleanup values
 * asserted here are read off that already-running production behavior, not
 * invented.
 *
 * Guarded import: `apps/web/lib/print-pdf-blob.ts` does not exist yet, so
 * the first assertion (the symbol's existence) is what fails RED, not a
 * module-resolution error.
 */

describe("printPdfBlob (T10)", () => {
  let createObjectURL: jest.Mock;
  let revokeObjectURL: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    createObjectURL = jest.fn().mockReturnValue("blob:rf/1");
    revokeObjectURL = jest.fn();
    (URL as any).createObjectURL = createObjectURL;
    (URL as any).revokeObjectURL = revokeObjectURL;
    document.querySelectorAll("iframe").forEach((el) => el.remove());
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("exports printPdfBlob as a function", () => {
    // Guarded import — this is the assertion that fails today (module absent).
    let printPdfBlob: unknown;
    try {
      printPdfBlob = require("./print-pdf-blob").printPdfBlob;
    } catch {
      printPdfBlob = undefined;
    }
    expect(typeof printPdfBlob).toBe("function");
  });

  it("appends exactly one hidden iframe pointed at the object URL, prints on load, and cleans up after 60s", () => {
    const { printPdfBlob } = require("./print-pdf-blob");
    const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });

    printPdfBlob(blob);

    const iframes = document.querySelectorAll("iframe");
    expect(iframes.length).toBe(1);
    const iframe = iframes[0] as HTMLIFrameElement;
    expect(iframe.style.display).toBe("none");
    expect(iframe.src).toBe("blob:rf/1");

    const print = jest.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { print },
    });
    iframe.onload?.(new Event("load"));

    expect(print).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);

    expect(document.querySelectorAll("iframe").length).toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:rf/1");
  });
});
