import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned: the at-door adjust screen must drop a succeeded ADD_ITEM from local
// `added` state INSIDE the batch loop (not only at the very end), or a re-Save after
// a later entry's failure rebuilds the diff from index 0 and double-adds the line
// server-side (B795). dropSucceededAddedLine's own logic is covered in at-door-diff.test.ts.
describe("adjust.tsx drops a succeeded ADD_ITEM from `added` mid-batch (B795)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/adjust.tsx"),
    "utf8",
  );

  it("imports dropSucceededAddedLine from the at-door-diff module", () => {
    expect(src).toMatch(/dropSucceededAddedLine/);
  });

  it("calls it inside processDiff's loop, AFTER the failure check and BEFORE the loop ends", () => {
    const fnAt = src.indexOf("async function processDiff(");
    expect(fnAt).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n  async function handleSave", fnAt);
    const body = src.slice(fnAt, fnEnd);

    const failCheckAt = body.indexOf("if (!ok)");
    const dropCallAt = body.indexOf("dropSucceededAddedLine");
    const loopCloseAt = body.lastIndexOf("}");

    expect(failCheckAt).toBeGreaterThan(-1);
    expect(dropCallAt).toBeGreaterThan(failCheckAt);
    expect(dropCallAt).toBeLessThan(loopCloseAt);
    expect(body).toMatch(/setAdded\(\(prev\) => dropSucceededAddedLine\(prev, entry\)\)/);
  });
});
