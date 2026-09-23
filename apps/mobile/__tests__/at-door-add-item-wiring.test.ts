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

// Opus review round 1 on #1302 (same B795 class, pre-existing): a resolve
// POST that times out AFTER the server committed the create is a network
// error, gets queued offline, and REPLAYS later (applying the item) -- while
// submitEntry's own return value is false and the draft stays in `added`, so
// the next Save sends a SECOND ADD_ITEM on top of the queued replay.
describe("submitEntry drops the draft when a successful create's resolve goes offline (round 1 finding 2)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/adjust.tsx"),
    "utf8",
  );
  const fnAt = src.indexOf("async function submitEntry(");
  const fnEnd = src.indexOf("\n  // Resumable batch runner", fnAt);
  const body = src.slice(fnAt, fnEnd);
  const offlineAt = body.indexOf("isOfflineQueued");
  const branchEnd = body.indexOf("return false;", offlineAt);
  const branchBody = body.slice(offlineAt, branchEnd);

  it("finds the isOfflineQueued branch", () => {
    expect(offlineAt).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(offlineAt);
  });

  it("drops the draft via dropSucceededAddedLine only when the create already succeeded and the entry is an ADD_ITEM", () => {
    expect(branchBody).toMatch(/createdCrId/);
    expect(branchBody).toMatch(/entry\.type === "ADD_ITEM"/);
    expect(branchBody).toMatch(/dropSucceededAddedLine/);
  });
});

// Opus review round 1 on #1302, finding 3 (minor): the "already resolved"
// toast read the same generic "changed elsewhere" whether the office
// APPROVED or DECLINED the CR -- name a decline distinctly.
describe("submitEntry names a DECLINED already-resolved CR distinctly (round 1 finding 3)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/adjust.tsx"),
    "utf8",
  );
  const at = src.indexOf('"CHANGE_REQUEST_ALREADY_RESOLVED"');
  const branchEnd = src.indexOf("return true;", at);
  const branchBody = src.slice(at, branchEnd);

  it("checks the resolved status and uses a distinct declined message", () => {
    expect(at).toBeGreaterThan(-1);
    expect(branchBody).toMatch(/DECLINED/);
    expect(branchBody).toMatch(/declined/i);
  });
});
