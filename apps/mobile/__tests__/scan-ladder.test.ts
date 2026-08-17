/**
 * The shared scan ladder (PR-2). These pin the behavior the two sale builders
 * had inline before the extraction, so adopting it in the editors can't quietly
 * change what a scan does.
 */
import { makeScanHandler, runWedgeSubmit } from "../lib/scan-ladder";
import type { ScanOutcome, ScanFeedback } from "../lib/scan-loop";
import type { BarcodeResolveResult } from "../lib/barcode-resolve";

/** Narrow an outcome to its feedback — every ladder branch here returns one. */
function fb(out: ScanOutcome): ScanFeedback {
  const f = out && out.feedback;
  if (!f) throw new Error("expected feedback on the outcome");
  return f;
}

/** Narrow to the hand-off action a branch is expected to carry. */
function action(f: ScanFeedback): NonNullable<ScanFeedback["action"]> {
  if (!f.action) throw new Error("expected a hand-off action on the feedback");
  return f.action;
}

interface P {
  id?: string | null;
  barcode?: string | null;
  sku?: string | null;
  unitSku?: string | null;
  name?: string;
}

const CASE_CODE = "4000000000019";
const PIECE_CODE = "2000000000012";
const boxed: P = { id: "p1", name: "6-pack", barcode: CASE_CODE, unitSku: PIECE_CODE };

/** Records what the ladder did, standing in for the screen's cart + sheets. */
function harness(over: Partial<Parameters<typeof makeScanHandler<P>>[0]> = {}) {
  const calls = {
    accepted: [] as Array<{ id?: string | null; unit: "case" | "piece" }>,
    ambiguous: [] as string[],
    created: [] as string[],
  };
  const deps = {
    products: [boxed] as P[],
    accept: (p: P, unit: "case" | "piece"): ScanOutcome => {
      calls.accepted.push({ id: p.id, unit });
      return { feedback: { kind: "added" as const, text: `Added ${p.name}` } };
    },
    resolve: async (): Promise<BarcodeResolveResult<P>> => ({ notFound: true }),
    onAmbiguous: (c: string) => calls.ambiguous.push(c),
    onCreate: (c: string) => calls.created.push(c),
    ...over,
  };
  return { scan: makeScanHandler<P>(deps), calls };
}

describe("makeScanHandler — local fast path", () => {
  it("adds a locally-known case code without hitting the server", async () => {
    let resolveCalls = 0;
    const { scan, calls } = harness({
      resolve: async (): Promise<BarcodeResolveResult<P>> => {
        resolveCalls++;
        return { notFound: true };
      },
    });
    const out = await scan(CASE_CODE);
    expect(calls.accepted).toEqual([{ id: "p1", unit: "case" }]);
    expect(resolveCalls).toBe(0);
    expect(out).toMatchObject({ feedback: { kind: "added" } });
  });

  it("classifies the PIECE code as a loose piece, not a case", async () => {
    const { scan, calls } = harness();
    await scan(PIECE_CODE);
    expect(calls.accepted).toEqual([{ id: "p1", unit: "piece" }]);
  });

  it("ignores blank input entirely", async () => {
    const { scan, calls } = harness();
    expect(await scan("   ")).toBeUndefined();
    expect(calls.accepted).toHaveLength(0);
  });
});

describe("makeScanHandler — server fallback", () => {
  it("accepts a server-resolved product", async () => {
    const server: P = { id: "p2", name: "Server hit", barcode: "999" };
    const { scan, calls } = harness({
      products: [],
      resolve: async (): Promise<BarcodeResolveResult<P>> => ({
        product: server,
        source: "barcode",
      }),
    });
    await scan("999");
    expect(calls.accepted).toEqual([{ id: "p2", unit: "case" }]);
  });

  it("offers a Choose pill on an ambiguous match instead of guessing matches[0]", async () => {
    const { scan, calls } = harness({
      products: [],
      resolve: async (): Promise<BarcodeResolveResult<P>> => ({
        ambiguous: true,
        matches: [{ id: "a" }, { id: "b" }],
        product: { id: "a" },
        source: "search",
      }),
    });
    const out = fb(await scan("12345"));
    // The guess is NOT added — that is the whole point of the branch.
    expect(calls.accepted).toHaveLength(0);
    expect(out.kind).toBe("error");
    expect(out.text).toContain("2 products match");
    expect(action(out).label).toBe("Choose");
    action(out).onPress();
    expect(calls.ambiguous).toEqual(["12345"]);
  });

  it("surfaces a lookup failure rather than claiming the product doesn't exist", async () => {
    const { scan } = harness({
      products: [],
      resolve: async () => {
        throw { response: { data: { message: "Gateway timeout" } } };
      },
    });
    const out = fb(await scan("777"));
    expect(out.kind).toBe("error");
    expect(out.text).toBe("Gateway timeout");
    expect(out.action).toBeUndefined();
  });
});

describe("makeScanHandler — miss", () => {
  it("offers Create when the caller can create products", async () => {
    const { scan, calls } = harness({ products: [] });
    const out = fb(await scan("55555"));
    expect(out.text).toContain('No product for "55555"');
    expect(action(out).label).toBe("Create");
    action(out).onPress();
    expect(calls.created).toEqual(["55555"]);
  });

  it("reports plainly, with no dead button, when the caller cannot create (driver)", async () => {
    const { scan } = harness({ products: [], onCreate: undefined });
    const out = fb(await scan("55555"));
    expect(out.kind).toBe("error");
    expect(out.action).toBeUndefined();
  });

  it("never returns close — a mis-read must not kill the scanner", async () => {
    const { scan } = harness({ products: [] });
    const out = await scan("55555");
    expect(out && out.close).toBeUndefined();
  });
});

describe("makeScanHandler — products getter", () => {
  it("reads rows at call time so a memoized handler can't go stale", async () => {
    let rows: P[] = [];
    const { scan, calls } = harness({ products: () => rows });
    await scan(CASE_CODE);
    expect(calls.accepted).toHaveLength(0); // nothing loaded yet
    rows = [boxed];
    await scan(CASE_CODE);
    expect(calls.accepted).toEqual([{ id: "p1", unit: "case" }]);
  });
});

describe("runWedgeSubmit", () => {
  const noop = () => {};

  it("ignores a typed product NAME — Enter after typing must add nothing", async () => {
    let scanned = 0;
    const spy = async () => {
      scanned++;
      return undefined;
    };
    await runWedgeSubmit({ term: "blue cheese", scan: spy, clearSearch: noop, showInline: noop });
    // Short digit runs are typing too — the shortest real barcode is EAN-8.
    await runWedgeSubmit({ term: "55555", scan: spy, clearSearch: noop, showInline: noop });
    expect(scanned).toBe(0);
  });

  it("reports inline on a successful add and leaves the search box alone", async () => {
    const shown: string[] = [];
    let cleared = 0;
    await runWedgeSubmit({
      term: CASE_CODE,
      scan: async () => ({ feedback: { kind: "added", text: "Added 6-pack" } }),
      clearSearch: () => cleared++,
      showInline: (t) => shown.push(t),
    });
    expect(shown).toEqual(["Added 6-pack"]);
    expect(cleared).toBe(0);
  });

  it("clears the field and opens the hand-off directly when one is offered", async () => {
    let cleared = 0;
    let opened = 0;
    const shown: string[] = [];
    await runWedgeSubmit({
      term: "55555555", // ≥8 digits, or looksLikeScanCode rejects it as typing
      scan: async () => ({
        feedback: {
          kind: "error",
          text: "No product",
          action: { label: "Create", onPress: () => opened++ },
        },
      }),
      clearSearch: () => cleared++,
      showInline: (t) => shown.push(t),
    });
    expect(cleared).toBe(1);
    expect(opened).toBe(1);
    expect(shown).toEqual([]); // the sheet replaces the toast
  });

  it("falls back to an inline message when the outcome carries no action", async () => {
    const shown: string[] = [];
    await runWedgeSubmit({
      term: "55555555",
      scan: async () => ({ feedback: { kind: "error", text: "Couldn't look up barcode." } }),
      clearSearch: noop,
      showInline: (t) => shown.push(t),
    });
    expect(shown).toEqual(["Couldn't look up barcode."]);
  });
});
