import * as fs from "fs";
import * as path from "path";

/** B984: the contact modal focuses the refused input; the inputs carry the ids the handler targets. */
describe("customers/[id] contact modal focuses a refused name", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../app/(dashboard)/customers/[id]/page.tsx"),
    "utf8",
  );
  it("both mutations pass onError: focusRefused and the inputs have the target ids", () => {
    expect((src.match(/onError: focusRefusedContactField/g) ?? []).length).toBe(2);
    expect(src).toContain('id="contact-first-name"');
    expect(src).toContain('id="contact-last-name"');
    // the handler lives in lib/refused-text-field.ts (customers/[id]/page.tsx sits at its size ratchet)
    expect(src).not.toContain("const focusRefused");
  });
});
