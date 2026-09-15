/**
 * WP1 — PINS for the edit-items screen's per-line flavor/note field
 * (`app/(operator)/(tabs)/orders/[id]/edit-items.tsx`). Source-text pin (the
 * RN component can't be rendered under the mobile Jest env, which is
 * pure-logic/node only — see jest.config.js) mirroring the convention of
 * `invoice-print-tile.pins.test.ts` / `session-teardown.pins.test.ts`.
 *
 * R5.2/R5.3: both `DraftItemCard` (catalog lines) and `UnlistedDraftCard`
 * (unlisted lines) get an `onSetNote` prop and a toggle-to-TextInput note
 * field, mirroring `NewOrderScreen`'s `cartNote*` pattern. R5.4: the two
 * setters (`setLineNote`/`setUnlistedNote`) are defined and wired at both
 * card call sites — `notes` was already threaded through the save diff
 * before this change (`lib/edit-items-draft.ts`), so no diff-logic edit here.
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

describe("pin: edit-items screen per-line flavor/note field", () => {
  const src = readFileSync(SCREEN_PATH, "utf8");

  it("both draft cards declare an onSetNote prop", () => {
    const onSetNoteOccurrences = src.match(/onSetNote/g) ?? [];
    // prop-type decl + destructure + JSX handler + call site, for each of the two cards.
    expect(onSetNoteOccurrences.length).toBeGreaterThanOrEqual(6);
  });

  it("the note placeholder appears exactly twice (once per card)", () => {
    const matches = src.match(/Flavor or note for this item \(prints on invoice\)/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("the 'Add flavor / note' toggle label appears exactly twice (once per card)", () => {
    const matches = src.match(/>Add flavor \/ note</g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("defines setLineNote (draft/catalog lines) and setUnlistedNote (unlisted lines)", () => {
    expect(src).toMatch(/const setLineNote = \(id: string, notes: string\) =>/);
    expect(src).toMatch(/const setUnlistedNote = \(id: string, notes: string\) =>/);
  });

  it("wires both setters into their card's onSetNote at the two call sites", () => {
    expect(src).toMatch(/onSetNote=\{\(notes\) => setLineNote\(it\.productId, notes\)\}/);
    expect(src).toMatch(/onSetNote=\{\(notes\) => setUnlistedNote\(u\.id, notes\)\}/);
  });

  it("each card's note TextInput toggles open when the line already has a note", () => {
    const noteOpenDecls = src.match(/const \[noteOpen, setNoteOpen\] = useState\(/g) ?? [];
    expect(noteOpenDecls.length).toBe(2);
  });
});
