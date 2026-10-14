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
  const offlineAt = body.indexOf('case "offline":');
  const branchEnd = body.indexOf("return false;", offlineAt);
  const branchBody = body.slice(offlineAt, branchEnd);

  it("switches on classifyAtStopResolveError and has an offline case", () => {
    expect(body).toMatch(/switch \(outcome\.action\)/);
    expect(body).toMatch(/classifyAtStopResolveError\(e\)/);
    expect(offlineAt).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(offlineAt);
  });

  it("drops the draft via dropSucceededAddedLine only when the create already succeeded and the entry is an ADD_ITEM", () => {
    expect(branchBody).toMatch(/createdCrId/);
    expect(branchBody).toMatch(/entry\.type === "ADD_ITEM"/);
    expect(branchBody).toMatch(/setAdded\(\(prev\) => dropSucceededAddedLine\(prev, entry\)\)/);
  });

  it("the drop happens before the case returns false, and only under the offline case", () => {
    const dropAt = body.indexOf("dropSucceededAddedLine");
    expect(dropAt).toBeGreaterThan(offlineAt);
    expect(dropAt).toBeLessThan(branchEnd);
    expect(body.indexOf("dropSucceededAddedLine", dropAt + 1)).toBe(-1);
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
  const at = src.indexOf('case "already-resolved":');
  const branchEnd = src.indexOf("return true;", at);
  const branchBody = src.slice(at, branchEnd);

  it("checks the resolved status and uses a distinct declined message", () => {
    expect(at).toBeGreaterThan(-1);
    expect(branchBody).toMatch(/outcome\.status === "DECLINED"/);
    expect(branchBody).toMatch(/declined by the office/i);
    // no status => the generic toast, never the declined one
    expect(branchBody).toMatch(/changed elsewhere/);
  });
});

// Opus review round 2 on #1302 (fleet lead relay): the scan FAB stayed live
// during Save, and a successful batch called router.back() unconditionally --
// discarding any units a concurrent re-scan left in `added` mid-flight. An
// under-bill in the COMMON case, not an edge case.
describe("adjust.tsx never silently discards leftover added units (round 2)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/adjust.tsx"),
    "utf8",
  );

  it("hides the scan FAB while a save is in progress, not just during the license block", () => {
    const at = src.indexOf("<BarcodeFab");
    expect(at).toBeGreaterThan(-1);
    const tagEnd = src.indexOf("/>", at);
    const tag = src.slice(at, tagEnd);
    // row 510: and once the batch ended in the "sent to the office" confirmation
    expect(tag).toMatch(/hidden=\{saving \|\| !!licenseBlock \|\| sentToOffice\}/);
  });

  it("processDiff's success path never calls router.back() or shows 'Order updated' directly", () => {
    const fnAt = src.indexOf("async function processDiff(");
    const fnEnd = src.indexOf("markBatchEnded();", fnAt);
    expect(fnEnd).toBeGreaterThan(-1);
    const body = src.slice(fnAt, fnEnd);
    expect(body).not.toMatch(/router\.back\(\)/);
    expect(body).not.toMatch(/Order updated/);
  });

  it("the stay-or-navigate decision still goes through leftoverAddedMessage (via decideAtStopBatchEnd)", () => {
    const outcome = readFileSync(join(__dirname, "..", "lib/at-stop-cr-outcome.ts"), "utf8");
    expect(outcome).toMatch(/leftoverAddedMessage\(p\.added\)/);
    const hook = readFileSync(join(__dirname, "..", "lib/use-at-stop-batch-end.ts"), "utf8");
    expect(hook).toMatch(/decideAtStopBatchEnd\(/);
    expect(src).toMatch(/useAtStopBatchEnd\(/);
  });

  it("the batch-end effect reads the CURRENT `added` and `saving` (never a stale closure) and has its own signal", () => {
    const hook = readFileSync(join(__dirname, "..", "lib/use-at-stop-batch-end.ts"), "utf8");
    const at = hook.indexOf("decideAtStopBatchEnd(");
    const depsAt = hook.indexOf("}, [", at);
    const deps = hook.slice(depsAt, hook.indexOf(")", depsAt));
    expect(deps).toMatch(/\bsaving\b/);
    expect(deps).toMatch(/\badded\b/);
    expect(deps).toMatch(/\bended\b/);
  });
});
