/**
 * `scan-accept-guard.ts` (F30 hunt 2026-09-14, scan-guard lane) — NEW MODULE,
 * no such file existed before this fix, so every case here fails on the
 * pre-fix tree simply by failing to import.
 *
 * Pins the single-slot claim in isolation, decoupled from the ladder and any
 * screen: begin/offer/settle semantics, label identity across symbologies,
 * and the two failure modes a bad "fix" would reach for (a code-keyed or
 * time-windowed guard) — see the module header for why those are rejected.
 */
import { createScanAcceptGuard, sameScanCode } from "../lib/scan-accept-guard";

interface P {
  id: string;
  name?: string;
}

const CODE = "4000000000019"; // an unrelated code, used for the non-symbology guard tests
const UPC_A = "012345678905";
const EAN_13 = "0012345678905"; // same physical label, iOS-decoded form
const OTHER_CODE = "2000000000012";

describe("sameScanCode (REG-scanguard-f)", () => {
  it("REG-scanguard-f: matches a UPC-A and its EAN-13 decode as one physical label", () => {
    expect(sameScanCode(UPC_A, EAN_13)).toBe(true);
  });

  it("REG-scanguard-f: rejects two genuinely unrelated codes", () => {
    expect(sameScanCode(UPC_A, "4000000000019")).toBe(false);
  });

  it("REG-scanguard-f: blank input never matches anything", () => {
    expect(sameScanCode("", "123")).toBe(false);
    expect(sameScanCode("123", "")).toBe(false);
  });
});

describe("createScanAcceptGuard — offer parks / settle redeems or discards", () => {
  it("offer() parks a settled match while a claim for the SAME label is open, and settle('accepted') discards it", () => {
    const guard = createScanAcceptGuard<P>();
    const claim = guard.begin(CODE);
    const p1: P = { id: "p1" };
    expect(guard.offer(CODE, p1, "case")).toBe(false);
    expect(claim.settle("accepted")).toBeNull();
  });

  it("settle('unresolved') hands the parked match back so a miss can be redeemed", () => {
    const guard = createScanAcceptGuard<P>();
    const claim = guard.begin(CODE);
    const p1: P = { id: "p1" };
    expect(guard.offer(CODE, p1, "piece")).toBe(false);
    expect(claim.settle("unresolved")).toEqual({ code: CODE, product: p1, unitKind: "piece" });
  });

  it("REG-scanguard-h: settle is idempotent — a second call, and a call after redemption, both return null", () => {
    const guard = createScanAcceptGuard<P>();
    const claim = guard.begin(CODE);
    const p1: P = { id: "p1" };
    guard.offer(CODE, p1, "case");
    expect(claim.settle("unresolved")).toEqual({ code: CODE, product: p1, unitKind: "case" });
    // Already settled once — a second call must not re-redeem the same match.
    expect(claim.settle("unresolved")).toBeNull();
    expect(claim.settle("accepted")).toBeNull();
  });

  it("settle('refused') (archived) discards the parked match — a definite verdict must stand", () => {
    const guard = createScanAcceptGuard<P>();
    const claim = guard.begin(CODE);
    guard.offer(CODE, { id: "p1" }, "case");
    expect(claim.settle("refused")).toBeNull();
  });
});

describe("createScanAcceptGuard — a different label is never blocked", () => {
  it("a DIFFERENT code in the box is never blocked", () => {
    const guard = createScanAcceptGuard<P>();
    guard.begin(CODE);
    expect(guard.offer(OTHER_CODE, { id: "p2" }, "case")).toBe(true);
  });

  it("no open claim never blocks", () => {
    const guard = createScanAcceptGuard<P>();
    expect(guard.offer(CODE, { id: "p1" }, "case")).toBe(true);
  });
});

describe("createScanAcceptGuard — superseding claims (REG-scanguard-g)", () => {
  it("REG-scanguard-g: a superseded begin() carries a same-label deferral forward and the old settle() no-ops", () => {
    const guard = createScanAcceptGuard<P>();
    const first = guard.begin(CODE);
    const p1: P = { id: "p1" };
    guard.offer(CODE, p1, "case");
    const second = guard.begin(CODE);
    // The stale claim is dead — it must not redeem the match a second time.
    expect(first.settle("unresolved")).toBeNull();
    // The new claim inherited the parked match.
    expect(second.settle("unresolved")).toEqual({ code: CODE, product: p1, unitKind: "case" });
  });

  it("REG-scanguard-m: a superseded begin() for a DIFFERENT label does NOT inherit the old deferral, and the orphaned claim still redeems its OWN match", () => {
    const guard = createScanAcceptGuard<P>();
    const first = guard.begin(CODE);
    const p1: P = { id: "p1" };
    guard.offer(CODE, p1, "case");
    const second = guard.begin(OTHER_CODE);
    // The new claim is for a different physical label — it must not redeem a
    // match found for CODE.
    expect(second.settle("unresolved")).toBeNull();
    // …but CODE's own ladder invocation still ends, and the settled list DID
    // resolve CODE. Dropping it here is a false "No product for" pill for a
    // line the operator can see resolved.
    expect(first.settle("unresolved")).toEqual({ code: CODE, product: p1, unitKind: "case" });
  });

  it("REG-scanguard-m: an orphaned claim that ends 'accepted'/'refused' still DISCARDS its match — no resurrection after the ladder resolved", () => {
    const guard = createScanAcceptGuard<P>();
    const accepted = guard.begin(CODE);
    guard.offer(CODE, { id: "p1" }, "case");
    guard.begin(OTHER_CODE); // supersedes, different label
    expect(accepted.settle("accepted")).toBeNull();
    // And the discard is permanent — a later call cannot resurrect it.
    expect(accepted.settle("unresolved")).toBeNull();

    const refused = guard.begin(CODE);
    guard.offer(CODE, { id: "p2" }, "case");
    guard.begin(OTHER_CODE);
    expect(refused.settle("refused")).toBeNull();
    expect(refused.settle("unresolved")).toBeNull();
  });

  it("REG-scanguard-m: a same-label match is redeemed EXACTLY once — donor first, then heir", () => {
    const guard = createScanAcceptGuard<P>();
    const first = guard.begin(CODE);
    const p1: P = { id: "p1" };
    guard.offer(CODE, p1, "case");
    const second = guard.begin(CODE); // takes the parked match
    expect(first.settle("unresolved")).toBeNull();
    expect(second.settle("unresolved")).toEqual({ code: CODE, product: p1, unitKind: "case" });
  });

  it("REG-scanguard-m: a same-label match is redeemed EXACTLY once — heir first, then donor", () => {
    const guard = createScanAcceptGuard<P>();
    const first = guard.begin(CODE);
    const p1: P = { id: "p1" };
    guard.offer(CODE, p1, "case");
    const second = guard.begin(CODE);
    expect(second.settle("unresolved")).toEqual({ code: CODE, product: p1, unitKind: "case" });
    expect(first.settle("unresolved")).toBeNull();
  });

  it("REG-scanguard-m: a claim settled BEFORE a same-label begin() leaves nothing for the new claim to redeem", () => {
    const guard = createScanAcceptGuard<P>();
    const first = guard.begin(CODE);
    const p1: P = { id: "p1" };
    guard.offer(CODE, p1, "case");
    expect(first.settle("unresolved")).toEqual({ code: CODE, product: p1, unitKind: "case" });
    const second = guard.begin(CODE);
    expect(second.settle("unresolved")).toBeNull();
  });
});

// Structural rejection of the two "cheaper" fixes the design explicitly ruled
// out: nothing here may key on a stored code across scans, or on a clock.
describe("createScanAcceptGuard — never a code-history or time-window guard", () => {
  it("a fresh guard's second begin() for a code from an earlier, already-settled claim is a brand-new, unblocked claim", () => {
    const guard = createScanAcceptGuard<P>();
    const first = guard.begin(CODE);
    first.settle("accepted"); // closed, nothing parked
    const second = guard.begin(CODE);
    // Nothing survives the settle: offering the SAME code against the NEW
    // claim (simulating a deliberate re-scan) is not silently blocked by any
    // memory of the earlier one.
    expect(guard.offer(CODE, { id: "p1" }, "case")).toBe(false); // parks on the OPEN (second) claim
    expect(second.settle("unresolved")).toEqual({
      code: CODE,
      product: { id: "p1" },
      unitKind: "case",
    });
  });
});
