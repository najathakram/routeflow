import fs from "fs";
import path from "path";

/**
 * B513 (C2 390px audit): the DRAFT-bill edit-mode line-item row used a
 * hardcoded `grid-cols-[1fr_72px_72px_100px_32px]` — 276px of fixed tracks
 * alone, no scroll wrapper anywhere in the ancestor chain — which overflowed
 * a 390px card regardless of content (a STATIC fact, unlike the orders
 * edit-row counterpart audited alongside it, which needs a real-browser
 * confirmation before any fix and is intentionally NOT touched here). This
 * pins the responsive stack: one column below `sm`, the original fixed grid
 * at `sm` and up.
 */
function read(): string {
  return fs.readFileSync(path.join(__dirname, "[id]", "page.tsx"), "utf8");
}

describe("B513 — vendor-bill edit-mode line-item row stacks on mobile", () => {
  it("the row grid is single-column below sm, fixed-track grid at sm and up", () => {
    const src = read();
    expect(src).toContain(
      'className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[1fr_72px_72px_100px_32px]"',
    );
    expect(src).not.toContain(
      'className="grid grid-cols-[1fr_72px_72px_100px_32px] gap-2 items-start"',
    );
  });

  it("the row delete button re-aligns for the stacked layout instead of floating mid-row", () => {
    const src = read();
    expect(src).toContain(
      'className="mt-1 h-9 justify-self-end rounded p-1 text-navy/30 transition-colors hover:text-danger disabled:opacity-20 sm:mt-6 sm:justify-self-auto"',
    );
  });
});
