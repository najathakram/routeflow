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
    // SA-1026 B: invisible but LAID OUT. Chrome's PDF viewer does not start inside a display:none (0x0) frame, so print() found nothing.
    expect(iframe.style.display).not.toBe("none");
    expect(iframe.style.visibility).not.toBe("hidden");
    expect(iframe.style.opacity).toBe("0");
    expect(iframe.style.width).toBe("1px");
    expect(iframe.style.height).toBe("1px");
    expect(iframe.src).toBe("blob:rf/1");

    const print = jest.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { print, focus: jest.fn() },
    });
    iframe.onload?.(new Event("load"));

    expect(print).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);

    expect(document.querySelectorAll("iframe").length).toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:rf/1");
  });

  it("when the frame cannot print, the PDF opens in a new tab so staff can print it from the viewer (SA-1026 B)", () => {
    const { printPdfBlob } = require("./print-pdf-blob");
    const open = jest.spyOn(window, "open").mockReturnValue(null);
    printPdfBlob(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: {
        focus: jest.fn(),
        print: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(() => iframe.onload?.(new Event("load"))).not.toThrow();
    expect(open).toHaveBeenCalledWith("blob:rf/1", "_blank");
  });
});
