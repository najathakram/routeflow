/**
 * F30 · REG-B193 + REG-B201 — the wedge-scanner submit path (R3).
 *
 * REG-B193: `handleSearchSubmit` early-returns on `searchScanBusy` while the
 * search field is cleared only inside `acceptScannedProduct` — so a second
 * hardware-scanner burst arriving mid-resolve types into the still-populated
 * field, and the eventual submit resolves "<code1><code2>" as one garbage
 * code (NewOrderScreen.tsx:1089,1131-1145). Fix: clear the field
 * SYNCHRONOUSLY on every submit (the web CreateOrderModal invariant) and
 * buffer — never drop, never concatenate — a submit that arrives while the
 * previous one is still resolving.
 *
 * REG-B201: the settled-search auto-add effect is guarded only by an 800ms
 * same-code window (NewOrderScreen.tsx:1148-1161); a query refetch that
 * re-settles after the window re-adds the product with no new scan. Fix:
 * guard on a per-scan nonce instead of a time window, so a stale settle from
 * an already-satisfied or overtaken attempt can never fire again.
 *
 * `apps/mobile/lib/wedge-submit.ts` is the extraction target for this logic
 * (currently inlined in NewOrderScreen.tsx) — this package ships it as a
 * signature-only stub; the build phase implements it against this contract.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  createWedgeSubmitHandler,
  createAutoAddGuard,
  createScanAttempt,
} from "../lib/wedge-submit";

// Real wedge codes: `looksLikeScanCode` (lib/wedge-scan.ts) gates the whole
// wedge path to digit-only runs of ≥8 chars, so an implementation that reuses
// that gate — the likely one — must still see these as scans.
const CODE_1 = "10000001";
const CODE_2 = "10000002";

describe("createWedgeSubmitHandler — wedge burst handling (T-B193 / REG-B193)", () => {
  it("clears the field synchronously on submit, and buffers a burst arriving mid-resolve instead of dropping or concatenating it", async () => {
    const scanCalls: string[] = [];
    let releaseFirst!: () => void;
    const firstLookup = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const scan = jest.fn((code: string) => {
      scanCalls.push(code);
      return scanCalls.length === 1 ? firstLookup : Promise.resolve();
    });
    const clearSearch = jest.fn();

    const submit = createWedgeSubmitHandler({ scan, clearSearch });

    // Burst 1: the wedge types CODE_1 and fires Enter.
    const p1 = submit(CODE_1);

    // The field must already be empty by the time control returns to the
    // caller — SYNCHRONOUSLY, before the lookup is even awaited — so a
    // second hardware burst has nothing left in the box to concatenate onto.
    expect(clearSearch).toHaveBeenCalledTimes(1);
    expect(scanCalls).toEqual([CODE_1]);

    // Burst 2 arrives 80ms later while burst 1's resolve is still in flight.
    const p2 = submit(CODE_2);

    // Never dropped, and — the actual bug — never concatenated into a single
    // "1000000110000002" lookup. It must not even have fired yet: burst 1
    // still owns the resolve slot.
    expect(scanCalls).toEqual([CODE_1]);

    releaseFirst();
    await p1;
    await p2;

    // Both bursts resolved separately, each with its own exact code.
    expect(scanCalls).toEqual([CODE_1, CODE_2]);
    expect(clearSearch).toHaveBeenCalledTimes(2);
  });

  it("leaves a typed product NAME in the search box — the sync clear is for scans only", async () => {
    const scan = jest.fn(() => Promise.resolve());
    const clearSearch = jest.fn();
    const submit = createWedgeSubmitHandler({ scan, clearSearch });

    // An operator types a name and hits the keyboard's Return/Search key. The
    // scan gate (looksLikeScanCode) rejects it downstream, so clearing here
    // would wipe the search and reset the filtered list under them.
    await submit("coca");

    expect(clearSearch).not.toHaveBeenCalled();
  });
});

describe("createAutoAddGuard — settled-search auto-add (T-B201 / REG-B201)", () => {
  it("refuses a slow refetch that re-settles for a scan already satisfied — no phantom add", () => {
    const guard = createAutoAddGuard();
    const nonce = guard.start(); // wedge submit begins, field cleared synchronously

    // The scan's own lookup settles first and adds once.
    expect(guard.shouldAutoAdd(nonce)).toBe(true);

    // A background refetch for the same query re-settles later (well past any
    // fixed time window) — must NOT add a second phantom line.
    expect(guard.shouldAutoAdd(nonce)).toBe(false);
  });

  it("refuses a settle tied to an overtaken (stale) scan attempt, even before it has ever fired", () => {
    const guard = createAutoAddGuard();
    const staleNonce = guard.start(); // first scan begins
    const currentNonce = guard.start(); // a second scan starts before the first's search settled

    // The stale attempt's late settle must not fire — a per-scan nonce, not a
    // time window, is what makes this deterministic.
    expect(guard.shouldAutoAdd(staleNonce)).toBe(false);
    // The current attempt is unaffected.
    expect(guard.shouldAutoAdd(currentNonce)).toBe(true);
  });
});

describe("createScanAttempt — the attempt ends when the field clears (REG-B201 must not eat a re-scan)", () => {
  it("lets the operator scan the SAME item again for a second unit once the field has cleared", () => {
    const attempt = createScanAttempt();

    // Scan 1: the settled rows land, the item is added, and accepting it
    // clears the search field (acceptScannedProduct).
    expect(attempt.shouldAutoAdd(CODE_1)).toBe(true);
    attempt.end(); // field is now empty

    // Scan 2, same SKU, ~3s later — a deliberate second unit. Guarding per
    // CODE instead of per ATTEMPT would silently add nothing here, forever.
    expect(attempt.shouldAutoAdd(CODE_1)).toBe(true);
  });

  it("still refuses a phantom re-settle for the same code while the field has NOT cleared", () => {
    const attempt = createScanAttempt();

    expect(attempt.shouldAutoAdd(CODE_1)).toBe(true);
    // A background refetch re-settles for the same still-active attempt: no
    // new scan happened, so no second line.
    expect(attempt.shouldAutoAdd(CODE_1)).toBe(false);
  });

  it("treats a different code as a new attempt without needing an explicit end()", () => {
    const attempt = createScanAttempt();

    expect(attempt.shouldAutoAdd(CODE_1)).toBe(true);
    expect(attempt.shouldAutoAdd(CODE_2)).toBe(true);
    expect(attempt.shouldAutoAdd(CODE_2)).toBe(false);
  });
});

/**
 * WIRING — the two contracts above live in an extraction target. Filling in
 * lib/wedge-submit.ts alone turns them green while `NewOrderScreen.tsx` keeps
 * the code that actually loses scans: `handleSearchSubmit`'s
 * `if (searchScanBusy.current) return;` (B193 — burst 2 is dropped while its
 * text is already in the still-populated field, so the eventual submit resolves
 * the concatenation) and the 800ms `lastAutoAdd` window (B201 — a slow refetch
 * re-settles past the window and adds a phantom line).
 *
 * Mobile tests are pure-logic only (no RN tree), so delegation is pinned at the
 * source level — the technique barcode-normalize.test.ts already uses to stop
 * its two copies drifting. These fail today and keep failing for any fix that
 * leaves the screen's own copies in place.
 */
describe("NewOrderScreen delegates the wedge path (REG-B193 / REG-B201 wiring)", () => {
  const screenSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");

  it("REG-B193: NewOrderScreen imports the wedge-submit handler instead of owning the busy ref", () => {
    expect(screenSrc).toMatch(/from\s+["']\.\.\/lib\/wedge-submit["']/);
  });

  it("REG-B193: the drop-the-second-burst early return is gone from handleSearchSubmit", () => {
    // NewOrderScreen.tsx:1132 today. Dropping burst 2 IS the concatenation
    // bug's first half — nothing clears the field, so the next Enter submits
    // code1+code2 as one garbage lookup.
    expect(screenSrc).not.toMatch(/if\s*\(\s*searchScanBusy\.current\s*\)\s*return\s*;/);
  });

  it("REG-B201: the 800ms same-code auto-add window is replaced by the per-scan nonce guard", () => {
    // NewOrderScreen.tsx:1158 today — `now - lastAutoAdd.current.at < 800`.
    // A time window cannot distinguish "this scan already added" from "a
    // refetch re-settled"; only a nonce tied to the scan attempt can.
    expect(screenSrc).not.toMatch(/lastAutoAdd\.current\.at\s*<\s*800/);
    expect(screenSrc).toMatch(/createAutoAddGuard|shouldAutoAdd/);
  });
});
