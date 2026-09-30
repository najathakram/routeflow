import fs from "fs";
import path from "path";

/**
 * B510 (C2 390px audit): three tables were wrapped in `overflow-hidden`
 * instead of `overflow-x-auto`, so a row wider than the viewport clipped
 * instead of scrolling. jsdom has no layout engine and can't prove the
 * visual fix, so this pins the source-level fact a real browser can't
 * regress silently: each wrapper carries a horizontal-scroll class and its
 * table has an explicit min-width instead of relying on the (now-removed)
 * hidden overflow to hide the squeeze.
 */
function read(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, relPath), "utf8");
}

describe("B510 — detail-screen tables scroll instead of clipping at mobile widths", () => {
  it("customers/[id] statement ledger uses overflow-x-auto, not overflow-hidden", () => {
    const src = read("customers/[id]/page.tsx");
    expect(src).toContain('<div className="-mx-8 overflow-x-auto">');
    expect(src).toContain('<table className="w-full min-w-[640px] text-sm">');
    expect(src).not.toContain('<div className="-mx-8 overflow-hidden">');
  });

  it("customers/[id] statement summary strip stacks to 2 columns below sm", () => {
    const src = read("customers/[id]/page.tsx");
    expect(src).toContain("grid grid-cols-2 gap-px overflow-hidden rounded-lg");
    expect(src).toContain("sm:grid-cols-4");
  });

  it("returns/[id] items table uses overflow-x-auto, not overflow-hidden", () => {
    const src = read("returns/[id]/page.tsx");
    expect(src).toContain('<div className="-mx-6 overflow-x-auto border-t border-surface-border">');
    expect(src).toContain('<table className="w-full min-w-[520px] text-sm">');
    expect(src).not.toContain('<div className="-mx-6 overflow-hidden border-t');
  });

  it("orders SplitInvoiceModal table uses overflow-x-auto, not overflow-hidden", () => {
    const src = read("orders/_components/SplitInvoiceModal.tsx");
    expect(src).toContain(
      '<div className="overflow-x-auto rounded-md border border-surface-border">',
    );
    expect(src).toContain('<table className="w-full min-w-[420px] text-sm">');
    expect(src).not.toContain('<div className="overflow-hidden rounded-md border');
  });
});
