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
 *
 * B535 note: the delete-button assertion below used to pin the FULL
 * `className` source string. B535 (44x44 tap-target work, additive) wraps
 * it in `cn(TAP_TARGET, "...")` and drops the now-redundant explicit `h-9`
 * in favor of TAP_TARGET's own min-h/min-w sizing — neither of which is
 * what B513 was about (row-stacking alignment, not button height). A
 * full-string match breaks on that additive change, so this now extracts
 * the button's whole opening JSX tag (anchored on its unique `title`
 * attribute) and asserts the specific re-alignment tokens B513 depends on.
 */
function read(): string {
  return fs.readFileSync(path.join(__dirname, "[id]", "page.tsx"), "utf8");
}

/**
 * Index of the `>` that closes a JSX opening tag, scanning forward from
 * `fromIndex`. Skips `=>` (arrow functions inside prop expressions) so it
 * doesn't stop early on an onClick/onChange handler.
 */
function closingAngleIndex(src: string, fromIndex: number): number {
  let i = fromIndex;
  while (i < src.length) {
    const idx = src.indexOf(">", i);
    if (idx === -1) throw new Error("no closing '>' found");
    if (src[idx - 1] !== "=") return idx;
    i = idx + 1;
  }
  throw new Error("no closing '>' found");
}

/**
 * Extracts a `<button ...>` element's full opening tag text, located by a
 * unique marker string inside it (e.g. `title="Remove line"`). Anchoring on
 * the tag boundaries rather than a full className string means the
 * assertion survives attribute reordering or additive wrapper calls
 * (`cn(TAP_TARGET, ...)`) — it only cares what ends up in the rendered tag.
 */
function extractButtonOpenTag(src: string, marker: string): string {
  const markerIndex = src.indexOf(marker);
  if (markerIndex === -1) throw new Error(`marker not found: ${marker}`);
  const tagStart = src.lastIndexOf("<button", markerIndex);
  if (tagStart === -1) throw new Error(`no <button before marker: ${marker}`);
  const tagEnd = closingAngleIndex(src, markerIndex + marker.length);
  return src.slice(tagStart, tagEnd + 1);
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
    const deleteTag = extractButtonOpenTag(src, 'title="Remove line"');
    // These are the tokens the B513 fix actually depends on: the button
    // sits at the row's own top margin and floats to the row's end below
    // `sm` (stacked layout), then reverts to a taller top margin and
    // auto-alignment at `sm` and up (fixed-grid layout). Losing any one of
    // them puts the delete control back to floating mid-row on a stacked
    // card, which is the B513 regression.
    expect(deleteTag).toMatch(/\bmt-1\b/);
    expect(deleteTag).toMatch(/\bjustify-self-end\b/);
    expect(deleteTag).toMatch(/\bsm:mt-6\b/);
    expect(deleteTag).toMatch(/\bsm:justify-self-auto\b/);
  });
});
