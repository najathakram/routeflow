import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook } from "@testing-library/react";
import { createSubmitAttempt } from "@routeflow/types/submit-attempt";
import { useCreateOrderSubmitKey } from "./use-create-order-submit-key";

// SA-824 (d): the Create Order modal's submit-key rule is the ONE shared rule in packages/types. The hook holds it across
// renders and adds nothing: this pin drives the same script through the hook and through the shared machine and requires the
// same keys, the same latch answers and the same onChange announcements, and it fails if the hook grows a second state machine.

type Step =
  | ["begin", string]
  | ["settle", "success" | "refused" | "unknown" | "same-attempt" | "conflict"]
  | ["adopt", string, boolean?];

const SCRIPT: Step[] = [
  ["begin", "cart-A"],
  ["begin", "cart-A"], // latched: null
  ["settle", "unknown"],
  ["begin", "cart-B"], // unknown keeps the key through an edit
  ["settle", "refused"], // a 4xx on the retry only releases the latch
  ["begin", "cart-C"],
  ["settle", "conflict"], // a coded key-conflict clears unknown and re-mints
  ["begin", "cart-D"],
  ["settle", "same-attempt"],
  ["begin", "cart-E"], // a plain edit re-mints
  ["settle", "success"],
  ["adopt", "K-FROM-DRAFT"],
  ["begin", "cart-F"], // an adopted key survives an edit
  ["settle", "refused"],
  ["adopt", "K-FORK", true],
];

function run(machine: {
  begin(f: string): string | null;
  settle(o: Exclude<Step, ["begin", string] | ["adopt", string, boolean?]>[1]): void;
  adopt(k: string, o?: { fresh?: boolean }): void;
  peek(): string;
  maybeUsed(): boolean;
  hasUnknown(): boolean;
}) {
  const seen: unknown[] = [];
  for (const [op, arg, flag] of SCRIPT) {
    if (op === "begin") seen.push(machine.begin(arg as string));
    else if (op === "settle") machine.settle(arg as never);
    else machine.adopt(arg as string, flag ? { fresh: true } : undefined);
    seen.push([machine.peek(), machine.maybeUsed(), machine.hasUnknown()]);
  }
  return seen;
}

/** Deterministic mint so two runs are comparable. */
function counter() {
  let n = 0;
  return () => `k${++n}`;
}

describe("create-order submit key is the shared submit-attempt rule (SA-824 d)", () => {
  it("the hook and the shared machine answer the same script identically", () => {
    const hookChanges: string[] = [];
    // The hook mints through mintSubmitKey (a random UUID); map each distinct key to its first-seen index.
    const { result } = renderHook(() => useCreateOrderSubmitKey(true, (k) => hookChanges.push(k)));
    const names = new Map<string, string>();
    const norm = (v: unknown): unknown =>
      typeof v === "string"
        ? v.startsWith("K-")
          ? v
          : (names.get(v) ?? (names.set(v, `k${names.size + 1}`), names.get(v)))
        : Array.isArray(v)
          ? v.map(norm)
          : v;
    const viaHook = run(result.current).map(norm);

    const sharedChanges: string[] = [];
    const viaShared = run(createSubmitAttempt(counter(), (k) => sharedChanges.push(k)));

    expect(viaHook).toEqual(viaShared);
    // the same number of announcements, and the adopted keys are announced verbatim
    expect(hookChanges.length).toBe(sharedChanges.length + 1); // + the hook's announce-on-open
    expect(hookChanges.filter((k) => k.startsWith("K-"))).toEqual(
      sharedChanges.filter((k) => k.startsWith("K-")),
    );
  });

  it("the hook delegates: it holds no state machine of its own", () => {
    const src = readFileSync(join(__dirname, "use-create-order-submit-key.ts"), "utf8");
    expect(src).toContain('from "@routeflow/types/submit-attempt"');
    expect(src).toContain("createSubmitAttempt(");
    for (const own of ["inFlight", "fingerprint", "adopted", "unknown:"]) {
      expect(src).not.toContain(own);
    }
  });
});
