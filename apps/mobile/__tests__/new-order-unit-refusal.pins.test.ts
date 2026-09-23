/**
 * Source pins for the B638 hydration refusal in NewOrderScreen.
 *
 * NewOrderScreen is a React Native component and this workspace's Jest is pure-logic only, so the
 * behaviour that matters is pinned the way `buyer-line-note.pins.test.ts` pins its screen: read the
 * source and assert the guard's SHAPE. The decision itself (`unitLineRefusal`) is unit-tested in
 * drafts-payload.test.ts; these pins hold the wiring:
 *   - a parked draft with a line sold by a unit is refused BEFORE any product is fetched,
 *   - `hydrating` stays true on refusal (no autosave, so the web draft is never overwritten),
 *   - the refusal screen offers no Retry (retrying would refuse again), and never drops a line.
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");

/** The hydration effect body: from its start-of-work marker to its cleanup. */
function hydrationEffect(): string {
  const start = src.indexOf("const parkedLines: DraftCatalogLine[]");
  const end = src.indexOf("}, [hydrating, hydrateAttempt]);", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("NewOrderScreen refuses a parked draft that holds a unit line (B638)", () => {
  it("imports the pure decision from drafts-payload", () => {
    expect(src).toMatch(/unitLineRefusal,[\s\S]{0,80}from "\.\.\/lib\/drafts-payload"/);
  });

  it("decides on the parked lines BEFORE fetching any product", () => {
    const effect = hydrationEffect();
    const decide = effect.indexOf("unitLineRefusal(parkedLines)");
    const fetchFirst = effect.indexOf("apiClient.get<Product>");
    expect(decide).toBeGreaterThan(-1);
    expect(fetchFirst).toBeGreaterThan(decide);
  });

  it("returns out of the effect on refusal — hydrating stays true and nothing is rewritten", () => {
    const effect = hydrationEffect();
    const refusalStmt = effect.slice(
      effect.indexOf("if (refusal)"),
      effect.indexOf("let cancelled"),
    );
    expect(refusalStmt).toContain("setHydrateRefusal(refusal)");
    expect(refusalStmt).toContain("return");
    // Neither the hydrated builder state nor the spinner flag is touched on the refusal path.
    expect(refusalStmt).not.toMatch(/setHydrating\(|setItems\(|setUnlisted\(/);
  });

  it("shows the reason on the existing restore-failed screen with no Retry button", () => {
    const view = src.slice(src.indexOf("hydrateFailed || hydrateRefusal"));
    expect(view).toContain("{hydrateRefusal ??");
    expect(view).toMatch(/\{!hydrateRefusal && \(\s*<Pressable/);
  });
});
