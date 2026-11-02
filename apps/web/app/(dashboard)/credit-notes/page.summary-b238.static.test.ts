/**
 * B238: the credit-notes page's counters and tiles are the server summary's, not a client reduce over a fetch-all.
 * `useCreditNotes({ limit: 999 })` returned at most 999 rows, so a tenant with more undercounted every tile.
 */
import { readFileSync } from "fs";
import { join } from "path";

const list = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("credit-notes page tiles (B238)", () => {
  it("reads the server summary and no longer fetches every note", () => {
    expect(list).toMatch(/useCreditNoteSummary\(/);
    expect(list).not.toMatch(/limit:\s*999/);
  });

  it("does not re-derive the tiles on the client", () => {
    expect(list).not.toMatch(/function isOpenCredit/);
    expect(list).not.toMatch(/all\.filter\(/);
    expect(list).not.toMatch(/const all = /);
  });
});
