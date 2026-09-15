/**
 * Driver-durability lane (design/driver-durability.json, sections B and C) —
 * source-text pins for the two at-door screens. Mobile Jest is pure-logic
 * only (testEnvironment node, no React renderer/RTL — jest.config.js), so
 * screen wiring is pinned by reading the file as text and asserting on its
 * shape, in the style of `edit-items-scan-price.test.ts`. Paths resolve from
 * `__dirname`, never `process.cwd()`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const RETURN_SCREEN_PATH = join(
  __dirname,
  "..",
  "app",
  "(driver)",
  "route",
  "stop",
  "[stopId]",
  "return",
  "index.tsx",
);
const PAYMENT_SCREEN_PATH = join(
  __dirname,
  "..",
  "app",
  "(driver)",
  "route",
  "stop",
  "[stopId]",
  "payment.tsx",
);

const returnSrc = readFileSync(RETURN_SCREEN_PATH, "utf8");
const paymentSrc = readFileSync(PAYMENT_SCREEN_PATH, "utf8");

describe("return/index.tsx reads/writes the persisted submission set (REG-DRIVER-DURABILITY-B)", () => {
  it("imports the persisted store and the pure dedup filter, not a bare in-memory Set", () => {
    // TODAY (pre-fix): `submittedOrderIds` is `useState<ReadonlySet<string>>`,
    // reset to empty on every mount — an offline-queued return survives a
    // network error but is forgotten the moment the app is killed, so the
    // identical return can be issued a second time and double-credit the
    // customer.
    expect(returnSrc).toMatch(
      /import\s*\{\s*useReturnSubmissionStore\s*\}\s*from\s*"..\/..\/..\/..\/..\/..\/store\/returnSubmissionStore"/,
    );
    expect(returnSrc).toContain("pendingReturnPayloads");
  });

  it("never re-declares a local submittedOrderIds Set", () => {
    // The old in-memory dedup state must be gone entirely, not left dangling
    // alongside the store (that would just be dead code hiding the real fix).
    // NOTE: `damagedKeys` legitimately keeps its own unrelated
    // `useState<ReadonlySet<string>>` (the per-row damaged-toggle overrides),
    // so this pins the specific dead names, not the generic hook shape.
    expect(returnSrc).not.toContain("submittedOrderIds");
    expect(returnSrc).not.toContain("setSubmittedOrderIds");
  });

  it("filters pending payloads through pendingReturnPayloads keyed by stopId, not a raw .has(orderId)", () => {
    // TODAY (pre-fix): `payloads.filter((p) => !submittedOrderIds.has(p.orderId))`
    // — no stopId scoping, and backed by the non-persisted Set above.
    expect(returnSrc).toMatch(
      /pendingReturnPayloads\(\s*payloads\s*,\s*submitted\s*,\s*stopId\s*\)/,
    );
    expect(returnSrc).not.toMatch(/payloads\.filter\(\(p\)\s*=>\s*!submittedOrderIds\.has/);
  });

  it("marks a submission durable via the store instead of local setState", () => {
    // TODAY (pre-fix): `setSubmittedOrderIds((prev) => { const next = new
    // Set(prev); ...; return next; })` — an in-process-only update.
    expect(returnSrc).toMatch(
      /useReturnSubmissionStore\.getState\(\)\.markSubmitted\(\s*stopId\s*,/,
    );
  });
});

describe("payment.tsx treats a 400 'Stop is already completed' as success (REG-DRIVER-DURABILITY-C)", () => {
  it("imports isStopAlreadyCompletedError alongside classifyMutationError", () => {
    // TODAY (pre-fix): only `classifyMutationError` is imported; any
    // non-offline-queued rejection — including this specific, provably-benign
    // 400 — falls into the generic error toast + re-armed button.
    expect(paymentSrc).toContain("isStopAlreadyCompletedError");
    expect(paymentSrc).toMatch(
      /import\s*\{[\s\S]{0,80}classifyMutationError[\s\S]{0,120}\}\s*from\s*"..\/..\/..\/..\/..\/lib\/offline-errors"/,
    );
  });

  it("has a catch-block branch for the already-completed case, positioned before the generic fallback", () => {
    const catchIdx = paymentSrc.indexOf(
      "} catch (e: any) {\n      const outcome = classifyMutationError(e);",
    );
    expect(catchIdx).toBeGreaterThan(-1);
    const queuedIdx = paymentSrc.indexOf('outcome.kind === "queued"', catchIdx);
    const branchIdx = paymentSrc.indexOf("isStopAlreadyCompletedError(e)", catchIdx);
    const fallbackIdx = paymentSrc.indexOf("showToast(outcome.message);", catchIdx);
    expect(queuedIdx).toBeGreaterThan(catchIdx);
    // TODAY (pre-fix): branchIdx is -1 (no such branch exists at all), so this
    // fails outright before the ordering assertions below can even run.
    expect(branchIdx).toBeGreaterThan(queuedIdx);
    expect(fallbackIdx).toBeGreaterThan(branchIdx);
  });

  it("refreshes the same route-run queries the success path invalidates, then navigates back to the route list", () => {
    const branchMatch = paymentSrc.match(
      /if \(isStopAlreadyCompletedError\(e\)\) \{[\s\S]{0,400}?\n {6}\}/,
    );
    expect(branchMatch).not.toBeNull();
    const branch = branchMatch ? branchMatch[0] : "";
    // Reuses the exact invalidation keys useCompleteWithPayment's own
    // onSuccess uses (lib/api/routes.ts) rather than re-deriving new ones.
    expect(branch).toMatch(/invalidateQueries\(\{\s*queryKey:\s*\["route-runs",\s*runId\]\s*\}\)/);
    expect(branch).toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\["route-runs",\s*"active"\]\s*\}\)/,
    );
    expect(branch).toContain('router.replace("/(driver)/route")');
    // Never surfaces the raw server message for this specific, benign case.
    expect(branch).not.toContain("showToast(outcome.message)");
  });
});
