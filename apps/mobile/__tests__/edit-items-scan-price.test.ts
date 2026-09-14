/**
 * B263 (B246 Option B) / T2 (REG-B263-B) — `edit-items-scan-price.test.ts`
 *
 * `cause-ruling.md` §2 D3: inside `ProductPicker` (the scan-add surface), a
 * successful scan gets an "Edit price" affordance that opens the SAME
 * `PriceOverrideModal` over the live-but-paused camera (`active={!pickerPriceEditItem}`
 * — the naming ruling gives for the picker-branch price-edit state), applies
 * through the new `applyPriceOverride` (T1), and leaves the pre-existing
 * `canEditPrice` gate on the list branch untouched.
 *
 * Source-text spec in the style of `edit-items-scan-fab.test.ts`: nothing
 * renders under mobile Jest (`jest.config.js:4/:11`), so this reads
 * `edit-items.tsx` as text and pins counted values, never a rendered tree.
 * Paths resolve from `__dirname`, never `process.cwd()`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SCREEN_PATH = join(
  __dirname,
  "..",
  "app",
  "(operator)",
  "(tabs)",
  "orders",
  "[id]",
  "edit-items.tsx",
);
const source = readFileSync(SCREEN_PATH, "utf8");

// `ProductPicker` owns the whole scan-add surface (cause-ruling.md §2 D3);
// splitting here is how the picker-branch assertions below can't
// accidentally match the list branch's PRE-EXISTING `PriceOverrideModal`
// mount (`edit-items.tsx:734`) or `canEditPrice` gate (`:922`).
const splitIndex = source.indexOf("function ProductPicker");

const parentSrc = source.slice(0, splitIndex === -1 ? source.length : splitIndex);
const pickerSrc = source.slice(splitIndex);

describe("edit-items.tsx picker-branch price edit (REG-B263-B)", () => {
  // The picker's own BarcodeScanner mount, isolated once and shared by the
  // two `active` assertions below.
  const scannerBlockMatch = pickerSrc.match(/<BarcodeScanner\b[\s\S]{0,600}?\/>/);
  const scannerBlock = scannerBlockMatch ? scannerBlockMatch[0] : "";
  // The picker's own PriceOverrideModal mount, isolated once and shared by
  // the apply-path oracles below.
  const pickerModalMount = (pickerSrc.match(/<PriceOverrideModal\b[\s\S]{0,1200}?\/>/) ?? [""])[0];

  it("REG-B263-B: mounts exactly one PriceOverrideModal inside the picker branch", () => {
    // TODAY: PriceOverrideModal exists only on the list branch (`:734`) — the
    // picker branch has zero mounts.
    const pickerMounts = pickerSrc.match(/<PriceOverrideModal\b/g) ?? [];
    expect(pickerMounts.length).toBe(1);
  });

  it("REG-B263-B: the picker's BarcodeScanner carries an active= prop", () => {
    // TODAY: the picker's BarcodeScanner mount (`:1984`) takes `onScanned`,
    // `onClose`, `continuous` and `paused` only — no `active` prop at all.
    expect(scannerBlock).toMatch(/active=\{/);
  });

  it("REG-B263-B: the picker's active= expression is the NEGATED picker price-edit state", () => {
    // Its own `it` so the presence assertion above cannot mask this oracle.
    // D1's contract is `active={!pickerPriceEditItem}` — the camera pauses
    // WHILE the price sheet is up. Pinning the polarity rejects the inverse
    // (`active={pickerPriceEditItem}`), which mere identifier presence would
    // have accepted (red-gate audit 2026-09-08).
    const activeMatch = scannerBlock.match(/active=\{([\s\S]*?)\}/);
    const activeExpr = activeMatch ? activeMatch[1] : "";
    expect(activeExpr).toMatch(/^\s*!\s*pickerPriceEditItem\b/);
  });

  it("REG-B263-B: the picker's PriceOverrideModal applies through applyPriceOverride", () => {
    // Scoped to the picker mount's own JSX element, so this pins the WIRING
    // (the modal's own onSave routes through the helper), not the mere
    // presence of the token somewhere in the picker half (red-gate audit
    // 2026-09-08). TODAY: no picker-branch mount at all → empty block → red.
    expect(pickerModalMount).toMatch(/onSave=\{[\s\S]*?applyPriceOverride\(/);
  });

  // The setter half of D3's acceptance chain ("Apply -> applyPriceOverride ->
  // updateDraftItem -> close -> camera resumes"). Without these, deleting the
  // parent's `onEditPrice` wiring leaves the whole picker price edit a silent
  // no-op with the suite green (mutation probe 2026-09-08).
  const parentPickerMount = (parentSrc.match(/<ProductPicker\b[\s\S]{0,6000}?\n\s*\/>/) ?? [""])[0];

  it("REG-B263-G: the picker hands the computed override back to the parent", () => {
    // The call, not just the identifier: the values handed back are the ones
    // `applyPriceOverride` returned, so a hand-off of the RAW typed price is
    // red. `onEditPrice?.()` is rejected too — optional chaining is what lets
    // a missing parent prop degrade to a silent no-op instead of a type error.
    expect(pickerModalMount).toMatch(
      /onEditPrice\(\s*pickerPriceEditItem\s*,\s*updated\.unitPrice\s*,\s*updated\.overrideReason\s*\)/,
    );
    expect(pickerModalMount).not.toMatch(/onEditPrice\?\./);
  });

  it("REG-B263-G: the parent's ProductPicker mount passes onEditPrice", () => {
    expect(parentPickerMount).toMatch(/onEditPrice=\{/);
  });

  it("REG-B263-G: the parent's onEditPrice handler writes into the draft", () => {
    // Its own `it`: a mount that passes the prop but drops the write on the
    // floor is the same silent no-op from the operator's side.
    const handler = (parentPickerMount.match(/onEditPrice=\{[\s\S]{0,1200}?\n\s*\}\}/) ?? [""])[0];
    expect(handler).toMatch(/setDraft\(|setLinePrice\(|updateDraftItem\(/);
  });
});

// Review round (2026-09-08): the picker-branch price edit must sit behind the
// SAME gate as the list branch's price chip — the driver stop screen mounts
// this exact component (`app/(driver)/route/stop/[stopId]/edit-items.tsx`), and
// both the "Add product" button and the scan FAB are ungated, so an ungated
// strip hands a DRIVER (and an operator on a CANCELLED order) a price-override
// path the screen denies everywhere else (and the API silently discards).
describe("edit-items.tsx picker-branch price gate (REG-B263-D)", () => {
  const pickerMount = (parentSrc.match(/<ProductPicker\b[\s\S]*?\/>/) ?? [""])[0];

  it("REG-B263-D: the ProductPicker mount threads the list branch's canEditPrice gate", () => {
    // Re-pointed 2026-09-14: the gate is now PER LINE (SPECIAL-tier lock + the
    // order's edit window, RULINGS R2/R9), and the picker's own `canEditPrice`
    // gates exactly one line — the last-added strip's. The contract this pin
    // exists for is unchanged: the strip is behind the SAME gate the line list
    // puts on that line, never a looser one.
    expect(pickerMount).toMatch(
      /canEditPrice=\{lastAddedLine \? canEditPriceFor\(lastAddedLine\.productId\) : false\}/,
    );
  });

  it("REG-B263-D: the last-added strip's Edit price control is behind canEditPrice", () => {
    const strip = (pickerSrc.match(/styles\.pickerLastAdded\b[\s\S]*?<\/View>/) ?? [""])[0];
    expect(strip).toMatch(/canEditPrice\s*(\?|&&)[\s\S]*?Edit price/);
  });

  it("REG-B263-D: the picker's PriceOverrideModal mount is behind canEditPrice", () => {
    expect(pickerSrc).toMatch(/canEditPrice\s*&&\s*pickerPriceEditItem\s*\?/);
  });
});

// Review round (2026-09-08): a typed below-floor override must NOT stamp the
// margin acknowledgement for the operator — the "Set to floor / Sell anyway"
// guard row stays exactly as at HEAD, and `floorAcked` is written by the
// explicit "Sell anyway" tap alone.
describe("edit-items.tsx below-floor ack is operator-only (REG-B263-E)", () => {
  it("REG-B263-E: no auto-ack helper exists on the screen", () => {
    expect(parentSrc).not.toContain("ackFloorIfNeeded");
    expect(pickerSrc).not.toContain("ackFloorIfNeeded");
  });

  it("REG-B263-E: floorAcked has exactly one writer (the Sell anyway tap)", () => {
    // The contract is "nothing ADDS an ack except the explicit tap". The
    // staged-edit snapshot (2026-09-14) also REPLACES the whole set on restore
    // and on discard — carrying the operator's own acks back, never minting
    // one — so the pin counts the additive writer specifically.
    expect(
      (parentSrc.match(/setFloorAcked\(\(prev\) => new Set\(prev\)\.add\(/g) ?? []).length,
    ).toBe(1);
    // And the only other writers are the two snapshot ones, both of which
    // assign a whole set rather than adding to the live one.
    const others = (parentSrc.match(/setFloorAcked\(/g) ?? []).length - 1;
    expect(parentSrc.match(/setFloorAcked\(new Set\(/g) ?? []).toHaveLength(others);
  });

  it("REG-B263-H: neither PriceOverrideModal apply path touches the ack state", () => {
    const listModal = (parentSrc.match(/<PriceOverrideModal\b[\s\S]*?\/>/) ?? [""])[0];
    const pickerModal = (pickerSrc.match(/<PriceOverrideModal\b[\s\S]*?\/>/) ?? [""])[0];
    expect(listModal).toContain("onSave=");
    expect(pickerModal).toContain("onSave=");
    expect(listModal).not.toMatch(/setFloorAcked|ackFloorIfNeeded/);
    expect(pickerModal).not.toMatch(/setFloorAcked|ackFloorIfNeeded/);
  });
});

// Review round (2026-09-08): the "Added <name> · $price" strip belongs to the
// CURRENT camera session — closing the scanner (Done, or the overlay close)
// clears it, so re-opening the camera inside the same picker session can't show
// a stale confirmation for a line that was not just added.
describe("edit-items.tsx last-added strip is per scan session (REG-B263-F)", () => {
  it("REG-B263-F: the picker's scanner close ends the scan session", () => {
    const block = (pickerSrc.match(/<BarcodeScanner\b[\s\S]*?\/>/) ?? [""])[0];
    const onClose = (block.match(/onClose=\{([\s\S]*?)\n\s*continuous=/) ?? ["", ""])[1];
    expect(onClose).toMatch(/setScanOpen\(false\)[\s\S]*?onScanSessionEnd/);
  });

  it("REG-B263-F: the parent does NOT clear lastScannedId on scan-session end", () => {
    // REVERSED 2026-09-14 (RULINGS R5). The original assertion — a lazy
    // `onScanSessionEnd={[\s\S]*?setLastScannedId(null)` — would now pass
    // VACUOUSLY by running on into `onPick`'s own clear further down the
    // mount, so it is replaced rather than left standing. The camera closing
    // does not undo the add: an add made with the camera SHUT (a hardware
    // wedge, a typed code + Enter) must keep its price affordance. Every other
    // clear (session start, picker close, row tap) is still pinned below.
    const pickerMount = (parentSrc.match(/<ProductPicker\b[\s\S]*?\/>/) ?? [""])[0];
    const endHandler = (pickerMount.match(/onScanSessionEnd=\{[^\n]*\}/) ?? [""])[0];
    expect(endHandler).toMatch(/^onScanSessionEnd=\{/);
    expect(endHandler).not.toContain("setLastScannedId");
  });

  // Review round (2026-09-08): the scanner-close clear is only half the
  // contract. The picker ALSO closes from a product-row tap (`onPick`), which
  // would leave a wedge/search auto-add's id behind for the NEXT picker
  // session, and the search bar's barcode icon re-opens the camera inside one
  // session — both render the strip for a line that was not just added.
  it("REG-B263-F: the parent's onPick close clears lastScannedId", () => {
    const handler = (parentSrc.match(/onPick=\{[\s\S]*?\n {10}\}\}/) ?? [""])[0];
    expect(handler).toMatch(/setLastScannedId\(null\)/);
  });

  it("REG-B263-F: the parent clears lastScannedId on scan-session START too", () => {
    const pickerMount = (parentSrc.match(/<ProductPicker\b[\s\S]*?\/>/) ?? [""])[0];
    expect(pickerMount).toMatch(/onScanSessionStart=\{[\s\S]*?setLastScannedId\(null\)/);
  });

  it("REG-B263-F: every camera-open path in the picker starts a scan session", () => {
    const opens = [...pickerSrc.matchAll(/setScanOpen\(true\)/g)];
    expect(opens.length).toBeGreaterThan(0);
    for (const m of opens) {
      const before = pickerSrc.slice(Math.max(0, (m.index ?? 0) - 120), m.index);
      expect(before).toMatch(/onScanSessionStart\?\.\(\)/);
    }
  });
});

// Review round (2026-09-08): the design-of-record invariant "margin-floor ack
// ... as today" has to hold on the NEW surface too — a typed below-floor price
// is flagged identically on the picker's last-added strip and on the line row:
// same floor derivation, same `needsMarginAck` predicate, same guard, same
// Set-to-floor writer. The strip deliberately has NO "Sell anyway", so the ack
// keeps exactly one writer.
describe("edit-items.tsx picker-strip below-floor parity (REG-B263-G)", () => {
  // The whole strip branch (`{scanOpen && lastAdded ? ( ... ) : null}`), not
  // just its first row — the below-floor affordance lives in the second row.
  // Re-pointed 2026-09-14 with the guard itself (RULINGS R5): the strip is no
  // longer gated on `scanOpen`, so the old literal would slice nothing and
  // silently turn every assertion below vacuous.
  const stripStart = pickerSrc.indexOf("{lastAdded && !trayExpanded ? (");
  const strip =
    stripStart === -1
      ? ""
      : pickerSrc.slice(stripStart, pickerSrc.indexOf("canEditPrice && pickerPriceEditItem"));

  it("REG-B263-G: the screen imports needsMarginAck from the shared money helper", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bneedsMarginAck\b[^}]*\}\s*from\s*"[^"]*lib\/price-override"/,
    );
  });

  it("REG-B263-G: the strip flags a below-floor price through needsMarginAck", () => {
    expect(strip).toMatch(/needsMarginAck\(\s*lastAdded\s*,\s*lastAdded\.unitPrice\s*,/);
  });

  it("REG-B263-G: the strip's below-floor guard reads the same ack + floor the row does", () => {
    expect(strip).toMatch(/canEditPrice\s*&&[\s\S]*?lastAddedFloor\s*!=\s*null/);
    expect(strip).toMatch(/!\s*lastAddedAcked/);
    expect(strip).toMatch(/Set to floor \$\{lastAddedFloor\.toFixed\(2\)\}/);
  });

  it("REG-B263-G: the strip's Set-to-floor uses the parent's price writer, not its own", () => {
    expect(strip).toMatch(/onSetToFloor\(\s*lastAdded\s*,\s*lastAddedFloor\s*\)/);
    expect(strip).not.toMatch(/setDraft\(|applyPriceOverride\(/);
  });

  it("REG-B263-G: the strip never stamps the ack (no Sell anyway on this surface)", () => {
    expect(strip).not.toMatch(/Sell anyway|setFloorAcked/);
    // Belt and braces alongside REG-B263-E: exactly one writer that ADDS an
    // ack, screen-wide (the snapshot restore/discard replace the whole set —
    // see REG-B263-E for why that is not an ack being minted).
    expect((source.match(/setFloorAcked\(\(prev\) => new Set\(prev\)\.add\(/g) ?? []).length).toBe(
      1,
    );
  });

  it("REG-B263-G: the parent derives the strip's floor with the list row's helper", () => {
    const mount = (parentSrc.match(/<ProductPicker\b[\s\S]*?\n\s*\/>/) ?? [""])[0];
    expect(mount).toMatch(/lastAddedFloor=\{[\s\S]*?marginFloorPrice\(/);
    expect(mount).toMatch(/lastAddedAcked=\{[\s\S]*?floorAcked\.has\(/);
    expect(mount).toMatch(/onSetToFloor=\{[\s\S]*?setLinePrice\(/);
    // The list row's own Set-to-floor must keep using that same writer.
    expect(parentSrc).toMatch(/onSetToFloor=\{\(price\) => setLinePrice\(/);
  });
});

// D4: `canEditPrice` is explicitly UNTOUCHED by this fix, so its pin can never
// be red. It deliberately carries NO REG-B263 id — `jest -t "REG-B263"` must
// select only tests the fix turns green (red-gate audit 2026-09-08).
describe("edit-items.tsx list-branch canEditPrice (PIN-B263-D4, unchanged)", () => {
  it("PIN-B263-D4: canEditPrice's gate on the list branch is unchanged", () => {
    // Re-pointed 2026-09-14: the list branch now gates PER LINE through
    // `canEditPriceFor` (SPECIAL-tier lock + web's edit window, RULINGS
    // R2/R9). The order-wide `!isDriver && status !== "CANCELLED"` gate is
    // gone screen-wide — pin that too, so it cannot creep back as a second,
    // looser rule beside the per-line one.
    expect(parentSrc).toMatch(/canEditPrice=\{canEditPriceFor\(it\.productId\)\}/);
    expect(source).not.toContain('canEditPrice={!isDriver && order.status !== "CANCELLED"}');
  });
});

// Light-loop fix round, finding B263-H: the review round's below-floor strip
// (REG-B263-G above) always rendered the literal "Below cost", even for a
// line that is at/above cost but under the margin floor — the list row
// distinguishes the two states, the strip didn't. Comment-strip BOTH halves
// before matching: several comments in this file (including the one this fix
// added right above the strip) now mention "Below cost"/"Below floor" in
// prose, and a source-text assertion must never be satisfiable by a comment.
describe("edit-items.tsx below-floor label parity (REG-B263-H)", () => {
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const strippedParent = stripComments(parentSrc);
  const strippedPicker = stripComments(pickerSrc);

  // Reduce a template literal to its STATIC text, with each `${...}`
  // collapsed to one placeholder — proves the RENDERED WORDING matches
  // without caring how the interpolated percentage is computed (the strip
  // needs a `marginFrac!` non-null assertion the list row doesn't).
  const staticShape = (literal: string) => literal.replace(/\$\{[^}]*\}/g, " ");

  // The list row's own two message literals (`DraftItemCard`) — extracted by
  // regex from the SOURCE OF TRUTH so the strip's copy is checked against
  // whatever the row currently says, never a hand-typed expectation that
  // could silently drift from it.
  const belowCostLiteral = (strippedParent.match(/`Below cost \([^`]*\)`/) ?? [""])[0];
  const belowFloorLiteral = (strippedParent.match(/`Below floor ·[^`]*`/) ?? [""])[0];

  // The strip's below-floor Text element, isolated the same way REG-B263-G
  // isolates the whole strip above (a scoped slice, never a screen-wide
  // search that a coincidental match elsewhere could satisfy).
  const stripRow = (strippedPicker.match(/styles\.pickerLastAddedBelow\b[\s\S]*?<\/Text>/) ?? [
    "",
  ])[0];

  it("REG-B263-H: the strip's below-floor row decides through needsMarginAck and matches the list row's wording", () => {
    // Fixture sanity first: if the list row's own literals ever change
    // shape, fail LOUDLY here rather than have the comparisons below pass by
    // both sides matching empty strings.
    expect(belowCostLiteral).toMatch(/^`Below cost \(/);
    expect(belowFloorLiteral).toMatch(/^`Below floor ·/);

    // Design invariant (c): the row's visibility stays decided by the ONE
    // helper — re-pinned here alongside the label fix so a change that swaps
    // the gate out while "fixing" the label is caught in the same place.
    expect(strippedPicker).toMatch(/needsMarginAck\(/);

    // TODAY (before this fix): the strip renders the bare literal "Below
    // cost" — no backtick, no template, no `marginClass` branch — so neither
    // extracted literal's static shape appears in the row.
    const pickerCostLiteral = (stripRow.match(/`Below cost \([^`]*\)`/) ?? [""])[0];
    const pickerFloorLiteral = (stripRow.match(/`Below floor ·[^`]*`/) ?? [""])[0];
    expect(staticShape(pickerCostLiteral)).toBe(staticShape(belowCostLiteral));
    expect(staticShape(pickerFloorLiteral)).toBe(staticShape(belowFloorLiteral));
  });
});
