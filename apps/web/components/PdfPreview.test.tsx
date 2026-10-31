import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { PDF_PREVIEW_MAX_PAGES, PdfPreview } from "./PdfPreview";

/** W-1064 (SA-1074): a PDF that scrolls on a touch device. Desktop keeps its iframe. pdf.js and its worker are mocked. */
const mockGetDocument = jest.fn();
const mockImported = jest.fn();
const mockPdfjs = () => {
  mockImported();
  return { GlobalWorkerOptions: {}, getDocument: (a: unknown) => mockGetDocument(a) };
};
jest.mock("pdfjs-dist/legacy/build/pdf.min.mjs", () => mockPdfjs(), { virtual: true });
jest.mock("@/lib/pdf-worker", () => ({ pdfWorkerSrc: () => "/worker.mjs" }));

const blob = { arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
const page = () => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: () => ({ promise: Promise.resolve() }),
});
function pdf(numPages: number, getPage = async () => page()) {
  const destroy = jest.fn();
  const task = { promise: Promise.resolve({ numPages, getPage }), destroy };
  mockGetDocument.mockReturnValue(task);
  return task;
}
const touch = (on: boolean) => {
  window.matchMedia = jest.fn().mockImplementation((q: string) => ({
    matches: on && q === "(any-pointer: coarse)",
  })) as never;
};
const preview = (over: Partial<React.ComponentProps<typeof PdfPreview>> = {}) => (
  <PdfPreview
    src="blob:one"
    title="Invoice preview"
    className="h-full"
    getBytes={async () => blob}
    fallback={<p>Preview isn&apos;t available here.</p>}
    {...over}
  />
);
const canvases = () => document.querySelectorAll("canvas");

beforeEach(() => {
  jest.clearAllMocks();
  touch(true);
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({})) as never;
});

describe("PdfPreview on touch", () => {
  it("P1: draws every page on a canvas from bytes, never a URL", async () => {
    pdf(3);
    render(preview());
    await waitFor(() => expect(canvases()).toHaveLength(3));
    const args = mockGetDocument.mock.calls[0][0];
    expect(args.data).toBeInstanceOf(Uint8Array);
    expect(args.url).toBeUndefined();
    expect(args.useWasm).toBe(false);
    expect(args.wasmUrl).toBe("/pdfjs/"); // P11: without it a scanned page draws white, with no error
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("P2: stops at the cap and says so", async () => {
    pdf(PDF_PREVIEW_MAX_PAGES + 1);
    render(preview());
    expect(await screen.findByText("Showing the first 50 of 51 pages.")).toBeInTheDocument();
    expect(canvases()).toHaveLength(50);
  });

  it("P3: a document pdf.js can't open shows the fallback", async () => {
    mockGetDocument.mockReturnValue({
      promise: Promise.reject(new Error("bad pdf")),
      destroy: jest.fn(),
    });
    render(preview());
    expect(await screen.findByText("Preview isn't available here.")).toBeInTheDocument();
  });

  it("P4: bytes that won't load show the fallback", async () => {
    render(preview({ getBytes: () => Promise.reject(new Error("no bytes")) }));
    expect(await screen.findByText("Preview isn't available here.")).toBeInTheDocument();
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  it("P5 guard: unmounting mid-draw destroys the task and draws nothing more", async () => {
    let release = () => undefined as void;
    const held = new Promise<void>((r) => (release = r));
    const getPage = jest.fn(async () => {
      await held;
      return page();
    });
    const task = pdf(3, getPage);
    const view = render(preview());
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(task.destroy).toHaveBeenCalled();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(canvases()).toHaveLength(0);
  });

  it("P10 guard: a new src destroys the old task and draws only the new file", async () => {
    const first = pdf(2);
    const view = render(preview());
    await waitFor(() => expect(canvases()).toHaveLength(2));
    const second = pdf(1);
    view.rerender(preview({ src: "blob:two" }));
    await waitFor(() => expect(canvases()).toHaveLength(1));
    expect(first.destroy).toHaveBeenCalled();
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it("the scroller scrolls and keeps pinch zoom", async () => {
    pdf(1);
    render(preview());
    const scroller = screen.getByLabelText("Invoice preview");
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/overscroll-contain/);
    expect(scroller.style.touchAction).toBe("pan-x pan-y pinch-zoom");
    await waitFor(() => expect(canvases()).toHaveLength(1));
  });
});

describe("PdfPreview without touch", () => {
  it("P6 guard: the same iframe, and pdf.js is never imported", async () => {
    touch(false);
    const getBytes = jest.fn();
    render(preview({ getBytes }));
    const frame = screen.getByTitle("Invoice preview");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", "blob:one");
    expect(frame).toHaveClass("h-full");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockImported).not.toHaveBeenCalled();
    expect(getBytes).not.toHaveBeenCalled();
  });
});
