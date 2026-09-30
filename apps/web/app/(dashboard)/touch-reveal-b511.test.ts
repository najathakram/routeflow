import fs from "fs";
import path from "path";

/**
 * B511 (C2 390px audit): four row/overlay actions were gated purely on
 * `opacity-0 group-hover:opacity-100`, which never reveals on touch since
 * `:hover` doesn't fire there — the control read as absent. jsdom can't
 * evaluate `@media (hover: none)` (no layout/media-query engine), so this
 * pins the source-level facts a browser check can't regress silently: the
 * shared `.touch-reveal` utility exists, is declared outside any `@layer`
 * (so it always wins the cascade over the layered Tailwind utilities
 * regardless of generation order), and every hover-reveal call site now
 * carries it.
 *
 * B535 note: the per-call-site assertions below used to pin the FULL
 * `className` source string. B535 (44x44 tap-target work, additive) wraps
 * each of these in `cn(TAP_TARGET, "...")` and, in one case, drops a now-
 * redundant explicit `p-1.5` in favor of TAP_TARGET's own min-h/min-w
 * sizing — neither of which touches touch-reveal's fix. A full-string match
 * breaks on any such additive className change, so these now extract each
 * button's whole opening JSX tag (anchored on its unique, non-styling
 * `title` attribute, independent of attribute order) and assert that the
 * specific tokens the B511 fix depends on are present in it.
 */
function read(relPath: string): string {
  return fs.readFileSync(path.join(__dirname, relPath), "utf8");
}

/** Returns the substring inside the first balanced-brace block opening at `startIndex`. */
function braceBlockBody(css: string, startIndex: number): string {
  const openIndex = css.indexOf("{", startIndex);
  let depth = 0;
  for (let i = openIndex; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openIndex + 1, i);
    }
  }
  throw new Error("unbalanced braces");
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
 * unique marker string inside it (e.g. `title="Edit payment"`). Anchoring on
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

describe("B511 — hover-reveal row actions stay visible on touch", () => {
  it("globals.css declares .touch-reveal unlayered, forcing opacity 1 under (hover: none)", () => {
    const css = read("../globals.css");
    const layerStart = css.indexOf("@layer utilities");
    expect(layerStart).toBeGreaterThan(-1);
    const layerBody = braceBlockBody(css, layerStart);
    expect(layerBody).not.toContain(".touch-reveal");

    const match = css.match(/@media \(hover: none\) \{\s*\.touch-reveal \{\s*opacity: 1;/);
    expect(match).not.toBeNull();
    // and it must actually sit outside the utilities layer body found above
    expect(css.indexOf(match![0])).toBeGreaterThan(layerStart + layerBody.length);
  });

  it("invoices payment-history Edit/Delete carry touch-reveal", () => {
    const src = read("invoices/[id]/page.tsx");
    const editTag = extractButtonOpenTag(src, 'title="Edit payment"');
    const deleteTag = extractButtonOpenTag(src, 'title="Delete payment"');
    for (const tag of [editTag, deleteTag]) {
      // touch-reveal is the fix itself; opacity-0 + group-hover:opacity-100
      // is the hover-reveal pattern touch-reveal exists to override on touch
      // devices — asserting all three together confirms this is genuinely a
      // hover-reveal control that has opted into the fix, not an unrelated
      // element that merely happens to carry the class name.
      expect(tag).toMatch(/\btouch-reveal\b/);
      expect(tag).toMatch(/\bopacity-0\b/);
      expect(tag).toMatch(/\bgroup-hover:opacity-100\b/);
    }
  });

  it("customers document delete, tax-doc overlay, and tag-remove carry touch-reveal", () => {
    const src = read("customers/[id]/page.tsx");

    const deleteDocTag = extractButtonOpenTag(src, 'title="Delete document"');
    expect(deleteDocTag).toMatch(/\btouch-reveal\b/);
    expect(deleteDocTag).toMatch(/\bopacity-0\b/);
    expect(deleteDocTag).toMatch(/\bgroup-hover:opacity-100\b/);

    // The tax-doc overlay wrapper is a plain <div>, not a tap target, so
    // B535 never touches it — it is still an exact, unbroken literal match
    // and is left as one.
    expect(src).toContain(
      'className="touch-reveal absolute inset-0 flex items-center justify-center gap-1.5 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"',
    );

    const tagRemoveTag = extractButtonOpenTag(src, 'title={`Remove tag "${tag.name}"`}');
    expect(tagRemoveTag).toMatch(/\btouch-reveal\b/);
    expect(tagRemoveTag).toMatch(/\bopacity-0\b/);
    expect(tagRemoveTag).toMatch(/\bgroup-hover:opacity-100\b/);
  });
});
