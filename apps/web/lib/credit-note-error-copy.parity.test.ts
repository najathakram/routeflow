import * as fs from "fs";
import * as path from "path";

/**
 * #2418 U1: web and mobile show the SAME fixed copy for each CREDIT_NOTE_* code. The two files are
 * kept byte-identical in the map literal; this pins it (a wording edit must land in both).
 */
const mapLiteral = (file: string): string => {
  const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
  const start = src.indexOf("export const CREDIT_NOTE_ERROR_COPY");
  const end = src.indexOf("\n};", start);
  return src.slice(start, end + 3);
};

describe("credit-note error copy parity (web = mobile)", () => {
  it("the CREDIT_NOTE_ERROR_COPY map is identical in apps/web and apps/mobile", () => {
    const web = mapLiteral("./credit-note-error-copy.ts");
    const mobile = mapLiteral("../../mobile/lib/credit-note-error-copy.ts");
    expect(web.length).toBeGreaterThan(500);
    expect(mobile).toBe(web);
  });
});

/** #2418 U1: the new edit/void UI never reads a server message (only `body.code` via the copy map). */
describe("credit-note edit/void UI reads no server message", () => {
  const files = [
    "../app/(dashboard)/credit-notes/[id]/_components/EditCreditNoteModal.tsx",
    "../app/(dashboard)/credit-notes/[id]/_components/VoidCreditNoteDialog.tsx",
    "../../mobile/app/(operator)/credit-notes/[id]/edit.tsx",
    "../../mobile/lib/credit-note-error-copy.ts",
    "./credit-note-error-copy.ts",
  ];
  it.each(files)("%s has no response.data.message / data?.message read", (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
    expect(src).not.toMatch(/data\??\.message/);
    expect(src).not.toMatch(/\.response\??\.data\??\.message/);
  });
});
