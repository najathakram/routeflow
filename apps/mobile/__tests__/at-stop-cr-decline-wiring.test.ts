import { readFileSync } from "fs";
import { join } from "path";

/**
 * B790 — the pure classifyAtStopResolveError() only DECIDES which failures should
 * decline the just-created CR; this pins that adjust.tsx actually ACTS on that
 * decision. RN screens aren't renderable in this jest lane (pure-logic only — see
 * credit-limit-wiring.test.ts for the same pattern), so the wiring is source-pinned:
 * today the screen could stop calling declineCr for the "credit"/"decline" branches
 * and every other test would stay green.
 */
describe("B790: adjust.tsx declines the CR for every non-regulated, non-already-resolved 409", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/adjust.tsx"),
    "utf8",
  );

  it("uses classifyAtStopResolveError(e) to decide, not a hand-rolled if-chain", () => {
    expect(src).toMatch(/classifyAtStopResolveError\(e\)/);
  });

  it('the "credit" branch calls declineCr.mutate with the classified reason', () => {
    const at = src.indexOf('case "credit":');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('case "decline":', at));
    expect(body).toMatch(
      /declineCr\.mutate\(\{\s*crId:\s*createdCrId,\s*reason:\s*outcome\.reason\s*\}\)/,
    );
  });

  it('the "decline" branch calls declineCr.mutate with the classified reason', () => {
    const at = src.indexOf('case "decline":');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("}\n    }\n  }", at) + 20);
    expect(body).toMatch(
      /declineCr\.mutate\(\{\s*crId:\s*createdCrId,\s*reason:\s*outcome\.reason\s*\}\)/,
    );
  });

  it('the "already-resolved" branch never declines (the one benign-race exception)', () => {
    const at = src.indexOf('case "already-resolved":');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('case "credit":', at));
    expect(body).not.toMatch(/declineCr\.mutate/);
  });

  it('the "regulated" branch stays deferred — never declines immediately', () => {
    const at = src.indexOf('case "regulated":');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('case "already-resolved":', at));
    expect(body).not.toMatch(/declineCr\.mutate/);
    expect(body).toMatch(/blockedCrRef\.current = createdCrId/);
  });
});

/**
 * Row 510: a DRIVER's restricted add/raise. The CR is created (the buyer is notified) and the resolve is refused with
 * the fixed "Ask the office to approve this sale" 409. Like the regulated case it is NOT declined (a declined CR cannot
 * be approved, and the office is the one who may override) -- unlike the regulated case nothing here ever declines it
 * later either: Remove/Cancel have no restricted equivalent.
 */
describe("row 510: adjust.tsx leaves a driver's restricted CR PENDING and shows the shared block", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/adjust.tsx"),
    "utf8",
  );
  const branch = () => {
    const at = src.indexOf('case "restricted":');
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf('case "already-resolved":', at));
  };

  it("builds the shared warning hook and renders its modal (the same blocked copy with the legal lines)", () => {
    expect(src).toContain("useRestrictionWarningRetry()");
    expect(src).toContain("{rw.modal}");
  });

  it('the "restricted" branch opens the shared block through rw.handle and never declines', () => {
    const body = branch();
    expect(body).toMatch(/rw\.handle\(\s*e,/);
    expect(body).not.toMatch(/declineCr\.mutate/);
    expect(body).not.toMatch(/declineOrphanedBlockedCr/);
    // the regulated case's deferred cleanup is NOT armed: Remove/Cancel must never decline this CR
    expect(body).not.toMatch(/blockedCrRef\.current = createdCrId/);
  });

  it("hands the entry to the office so a bare re-tap of Save changes can not file a second CR for it", () => {
    const body = branch();
    expect(body).toMatch(/dropHandedOffAdded\(prev, entry\)/); // an ADD_ITEM draft
    expect(body).toMatch(/dropHandedOffQty\(m, entry\)/); // a CHANGE_QTY / REMOVE_ITEM edit is dropped too
    expect(body).toMatch(/return false;/); // the batch pauses behind the modal, like the regulated guard
  });

  it("resumes the rest of the batch AFTER the driver reads the block (index + 1, never the same entry)", () => {
    expect(src).toMatch(/processDiff\(pending\.diff, pending\.index \+ 1\)/);
    expect(src).toMatch(/rw\.handle\(\s*e,\s*\(\) => undefined,/);
  });

  it("the batch end goes through useAtStopBatchEnd: its OWN completion signal, not the saving flag alone", () => {
    expect(src).toContain("useAtStopBatchEnd(");
    expect(src).toMatch(/markBatchEnded\(\)/);
    // the old pattern (a flag ref + an effect that waits on `saving` changing) is gone
    expect(src).not.toContain("batchJustCompletedRef");
  });

  it("a hand-off ends in a CONFIRMATION that stays until the driver taps Done: no auto-navigation, no timed toast", () => {
    const at = src.indexOf('case "sent-to-office":');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('case "done":', at));
    expect(body).toMatch(/setSentToOffice\(true\)/);
    expect(body).not.toMatch(/router\.back\(\)|showToast/);
    expect(src).toContain('testID="sent-to-office"');
    expect(src).toContain("AT_STOP_RESTRICTED_SENT_TITLE");
    expect(src).toContain("AT_STOP_RESTRICTED_SENT_COPY");
    // the primary button becomes Done and goes back
    expect(src).toMatch(/sentToOffice \? "Done"/);
    expect(src).toMatch(/sentToOffice \? \(\) => router\.back\(\)/);
  });
});
