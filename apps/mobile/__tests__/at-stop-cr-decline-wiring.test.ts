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
