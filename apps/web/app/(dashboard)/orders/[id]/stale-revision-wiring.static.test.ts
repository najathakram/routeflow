import { readFileSync } from "fs";
import { join } from "path";

/** Row 372 (web half): the edit save sends the revision it loaded, and a stale 409 reaches the notice, not a toast. */
const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
const api = readFileSync(join(__dirname, "../../../../lib/api/orders.ts"), "utf8");

describe("order edit sends expectedRevisionNumber (row 372)", () => {
  it("handleSaveItems sends the revision the editor loaded", () => {
    expect(page).toContain("expectedRevisionNumber: stale.expected()");
  });
  it("EVERY updateItems.mutate call site sends the revision (Save Draft AND the draft publish path)", () => {
    // balanced-brace scan: the first object literal after each `updateItems.mutate(`
    const sites: string[] = [];
    for (
      let at = page.indexOf("updateItems.mutate(");
      at !== -1;
      at = page.indexOf("updateItems.mutate(", at + 1)
    ) {
      const open = page.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (; end < page.length; end++) {
        if (page[end] === "{") depth++;
        if (page[end] === "}" && --depth === 0) break;
      }
      sites.push(page.slice(open, end + 1));
    }
    expect(sites.length).toBeGreaterThanOrEqual(2); // a silent no-match cannot pass
    for (const body of sites) expect(body).toContain("expectedRevisionNumber: stale.expected()");
  });
  it("every save diffs against the lines captured at edit-open, never the live refetch (MF3)", () => {
    const calls = page.match(/buildItemUpdates\(editItems,[^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).toContain("stale.baseLines()");
  });
  it("Reload re-bases the edit through the shared rebase helpers (MF3)", () => {
    expect(page).toContain("rebaseEditItems(editItems, base.lines");
    expect(page).toContain("rebasePendingDeletes(ids, fresh.lines");
  });
  it("feeChanged is judged against the fee the editor loaded at BOTH save sites, never the live refetch (MF3)", () => {
    const sites = page.match(/const feeChanged =[^;]*;/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const s of sites) expect(s).toContain("stale.baseFee()");
  });
  it("a stale 409 is captured by the notice and owns the toast", () => {
    expect(page).toContain("stale.capture(err)");
    expect(page).toContain("stale.ownsToast(e)");
    expect(page).toContain("{stale.node}");
  });
  it("the mutation puts the field on the PATCH body", () => {
    expect(api).toMatch(
      /\.patch<Order>\(`\/orders\/\$\{id\}\/items`, \{[^}]*expectedRevisionNumber/,
    );
  });
});
