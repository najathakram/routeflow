import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isDeepStrictEqual } from "node:util";
import type { ProductUnitLevel } from "@routeflow/types";
import {
  resolvePendingDefaultUnits,
  type DefaultUnitDeps,
  type DefaultUnitLine,
} from "./default-unit-line";
import { useDefaultUnitResolver } from "./hooks/useDefaultUnitResolver";

/**
 * SA-984 §4 / SA-987 §3, row W-E0 (web, no DB): the per-line ladder read, observe and report.
 *
 * With `flag.units_v1` ON, every pending staff line plans "fetch" (pending-unit.ts:84-87): one /products/:id/units read per
 * product, cached by ensureQueryData (useDefaultUnitResolver.ts:40-41). A failed read blocks the line (`ladder-failed`)
 * with the input kept and a Retry; a product with no rows settles on the pack with an unchanged payload. It is fail-closed
 * and moves no money. Pinned here per shape: the resolved line flag off vs flag on, the `getUnits` call count, and the
 * failed-read case. A red cell is a finding (more than one read per product per cache window, or a failure without Retry
 * and kept input): STOP (SA-984 §5), report loudly, never edit the expectation.
 */
const fetchProductUnits = jest.fn();
let subscriptionFlags: string[] = [];
jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({
    isSuccess: true,
    isError: false,
    data: { flags: subscriptionFlags },
    refetch: async () => ({ isSuccess: true, data: { flags: subscriptionFlags } }),
  }),
}));
jest.mock("@/lib/api/product-units", () => ({
  ...jest.requireActual("@/lib/api/product-units"),
  fetchProductUnits: (id: string) => fetchProductUnits(id),
}));

type Fig = Record<string, unknown>;
const show = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));
/** Same failing-assertion form as apps/api's units-fold-battery.ts: OLD (flag off) and NEW (flag on) of every field that moved. */
function expectSame(cell: string, off: Fig, on: Fig): void {
  const diff = Object.keys({ ...off, ...on }).filter((k) => !isDeepStrictEqual(off[k], on[k]));
  if (diff.length === 0) return;
  throw new Error(
    `UNITS-FOLD DIFFERENCE ${cell}\n` +
      diff.map((k) => `  ${k}: OLD=${show(off[k])}  NEW=${show(on[k])}`).join("\n") +
      `\nSTOP (SA-984 §5): report both figures to the SA/owner. Do not edit this expectation.`,
  );
}

const SHAPE_PACKS: Record<string, number | undefined> = {
  "N-null": undefined,
  "N-0": 0,
  "N-1": 1,
  B12: 12,
};
const lineOf = (
  shape: string,
  over: Record<string, unknown> = {},
): DefaultUnitLine & { productName: string } =>
  ({
    tempId: "t1",
    productId: `p-${shape}`,
    productName: `Shape ${shape}`,
    unit: "Box",
    unitsPerBox: SHAPE_PACKS[shape],
    qty: 1,
    listPrice: 11,
    unitPrice: 11,
    priceType: "STANDARD" as const,
    startOnDefaultUnit: true,
    tierPrices: { pricePerUnit: "11.00" } as never,
    ...over,
  }) as never;

const depsOf = (unitsEnabled: boolean, getUnits: DefaultUnitDeps["getUnits"]): DefaultUnitDeps => ({
  isStaff: true,
  unitsEnabled,
  unitsKnown: true,
  getUnits,
  tierFor: () => 1,
});
const noRows = () => jest.fn(async (): Promise<ProductUnitLevel[]> => []);

describe("W-E0 per shape: a pending staff line with NO ladder rows, flag.units_v1 off vs on", () => {
  for (const shape of Object.keys(SHAPE_PACKS)) {
    it(`${shape}: the settled line is identical; ON makes exactly one read, OFF makes none`, async () => {
      const offGet = noRows();
      const onGet = noRows();
      const off = await resolvePendingDefaultUnits([lineOf(shape)], depsOf(false, offGet));
      const on = await resolvePendingDefaultUnits([lineOf(shape)], depsOf(true, onGet));
      expectSame(
        `W-E0 ${shape} resolved line`,
        { line: off.lines[0], blocked: off.blocked },
        { line: on.lines[0], blocked: on.blocked },
      );
      // the toggle is live: the only observable change is the read (a settled pack line either way)
      expect([offGet.mock.calls.length, onGet.mock.calls.length]).toEqual([0, 1]);
      expect(on.lines[0]).toMatchObject({ startOnDefaultUnit: false, unitPrice: 11 });
      expect(on.lines[0].unitLabel).toBeUndefined();
      expect(on.blocked).toEqual([]);
    });
  }
});

describe("W-E0 failed read (SA-632 / #2865 case c): fail-closed, input kept", () => {
  for (const shape of Object.keys(SHAPE_PACKS)) {
    it(`${shape}: ON blocks the line as ladder-failed and leaves it untouched; OFF never reads, so it settles (OBSERVED, reported)`, async () => {
      const failing = jest.fn(async (): Promise<ProductUnitLevel[]> => {
        throw new Error("offline");
      });
      const input = lineOf(shape);
      const on = await resolvePendingDefaultUnits([input], depsOf(true, failing));
      expect(on.blocked).toEqual(["t1"]);
      expect(on.reasons).toEqual({ t1: "ladder-failed" });
      expect(on.lines[0]).toBe(input); // the input is kept as typed, never sent as the pack
      expect(failing).toHaveBeenCalledTimes(1);

      const off = await resolvePendingDefaultUnits([lineOf(shape)], depsOf(false, failing));
      expect(off.blocked).toEqual([]);
      expect(failing).toHaveBeenCalledTimes(1); // OFF made no second read
      expect(off.lines[0].startOnDefaultUnit).toBe(false);
    });
  }
});

// ─── the real hook: one read per product per cache window, and Retry ───────────────────────────────────────────────
function harness(initial: Array<DefaultUnitLine & { productName: string }>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(
    () => {
      const [lines, setLines] = React.useState(initial);
      const r = useDefaultUnitResolver(lines, setLines, () => 1, true);
      return { lines, ...r };
    },
    { wrapper },
  );
}

describe("W-E0 the real hook (useDefaultUnitResolver)", () => {
  beforeEach(() => {
    fetchProductUnits.mockReset();
  });

  it("flag ON: two pending lines of one product make ONE read, and a submit-time resolve inside the cache window makes none", async () => {
    subscriptionFlags = ["flag.units_v1"];
    fetchProductUnits.mockResolvedValue([]);
    const h = harness([lineOf("B12"), lineOf("B12", { tempId: "t2" })]);
    await waitFor(() =>
      expect(h.result.current.lines.every((l) => !l.startOnDefaultUnit)).toBe(true),
    );
    expect(fetchProductUnits).toHaveBeenCalledTimes(1);
    await act(async () => {
      await h.result.current.resolveBeforeSubmit([lineOf("B12", { tempId: "t3" })]);
    });
    expect(fetchProductUnits).toHaveBeenCalledTimes(1);
  });

  it("flag ON: two products make one read EACH (not one per line, not one per render)", async () => {
    subscriptionFlags = ["flag.units_v1"];
    fetchProductUnits.mockResolvedValue([]);
    const h = harness([
      lineOf("B12"),
      lineOf("N-1", { tempId: "t2" }),
      lineOf("N-1", { tempId: "t3" }),
    ]);
    await waitFor(() =>
      expect(h.result.current.lines.every((l) => !l.startOnDefaultUnit)).toBe(true),
    );
    expect(fetchProductUnits.mock.calls.map((c) => c[0]).sort()).toEqual(["p-B12", "p-N-1"]);
  });

  it("flag OFF: no read at all and the line settles on the pack", async () => {
    subscriptionFlags = [];
    const h = harness([lineOf("B12")]);
    await waitFor(() => expect(h.result.current.lines[0].startOnDefaultUnit).toBe(false));
    expect(fetchProductUnits).not.toHaveBeenCalled();
  });

  it("flag ON, the read fails: the line stays pending with its input, shows 'failed' (Retry offered), and Retry settles it", async () => {
    subscriptionFlags = ["flag.units_v1"];
    fetchProductUnits.mockRejectedValue(new Error("offline"));
    const input = lineOf("B12");
    const h = harness([input]);
    await waitFor(() =>
      expect(h.result.current.statusFor(h.result.current.lines[0])).toBe("failed"),
    );
    expect(h.result.current.lines[0]).toBe(input); // kept as typed
    expect(h.result.current.lines[0].startOnDefaultUnit).toBe(true);
    expect(typeof h.result.current.retry).toBe("function"); // Retry offered

    fetchProductUnits.mockResolvedValue([]);
    await act(async () => {
      await h.result.current.retry();
    });
    expect(h.result.current.lines[0].startOnDefaultUnit).toBe(false);
    expect(h.result.current.statusFor(h.result.current.lines[0])).toBeUndefined();
    expect(fetchProductUnits).toHaveBeenCalledTimes(2); // the failed read is not cached: Retry reads again, once
  });
});
