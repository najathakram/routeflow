/**
 * R1 (Opus REQUIRED, B747, SA-085a follow-up): `hydrateParkedLine`'s units-ladder fetch used to
 * treat ANY failure (network error, timeout, 5xx, a 403 from units_v1 being off) the same as "this
 * product genuinely has no units" — swallowing the error into `units: []` and letting the caller
 * silently resume the line as a plain pack. For a unit-sold line (a Case, a Pallet) that is the
 * B606 shape: a $480 Case line resumes billing at the $42 pack price, no error shown, nothing
 * aborted. `decideResumeLine` already gets this right for the PRODUCT fetch (404 = genuinely
 * gone, anything else = abort); the units fetch must follow the exact same rule.
 */
jest.mock("../lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

import { apiClient } from "../lib/api-client";
import { hydrateParkedLine } from "../lib/resume-draft-hydration";

const get = apiClient.get as jest.Mock;

const httpError = (status?: number) => {
  const err: any = new Error("request failed");
  if (status !== undefined) err.response = { status };
  return err;
};

describe("hydrateParkedLine — units ladder fetch failure classification (R1, B747)", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("a non-unit line never even attempts the units fetch", async () => {
    get.mockResolvedValueOnce({ data: { id: "p1", isActive: true } });
    const result = await hydrateParkedLine({ productId: "p1" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      li: { productId: "p1" },
      product: { id: "p1", isActive: true },
      failed: false,
      units: [],
    });
  });

  it("a unit-labeled line whose units fetch succeeds resumes normally with the live ladder", async () => {
    const ladder = [{ label: "Case", factorToBase: 12 }];
    get.mockResolvedValueOnce({ data: { id: "p1", isActive: true } });
    get.mockResolvedValueOnce({ data: ladder });
    const result = await hydrateParkedLine({ productId: "p1", unitLabel: "Case" });
    expect(result).toEqual({
      li: { productId: "p1", unitLabel: "Case" },
      product: { id: "p1", isActive: true },
      failed: false,
      units: ladder,
    });
  });

  it("a genuine 404 on the units fetch is treated as 'no units' — not a failure", async () => {
    get.mockResolvedValueOnce({ data: { id: "p1", isActive: true } });
    get.mockRejectedValueOnce(httpError(404));
    const result = await hydrateParkedLine({ productId: "p1", unitLabel: "Case" });
    expect(result).toEqual({
      li: { productId: "p1", unitLabel: "Case" },
      product: { id: "p1", isActive: true },
      failed: false,
      units: [],
    });
  });

  it("R1 (red on the pre-fix code): a 5xx on the units fetch ABORTS hydration — never silently falls back to the pack", async () => {
    get.mockResolvedValueOnce({ data: { id: "p1", isActive: true } });
    get.mockRejectedValueOnce(httpError(500));
    const result = await hydrateParkedLine({ productId: "p1", unitLabel: "Case" });
    expect(result.failed).toBe(true);
    expect(result.product).toBeNull();
  });

  it("R1: a network error with no response at all (offline/timeout) also aborts hydration", async () => {
    get.mockResolvedValueOnce({ data: { id: "p1", isActive: true } });
    get.mockRejectedValueOnce(httpError(undefined));
    const result = await hydrateParkedLine({ productId: "p1", unitLabel: "Case" });
    expect(result.failed).toBe(true);
    expect(result.product).toBeNull();
  });

  it("R1: a 403 (units_v1 off on this tenant) also aborts hydration, not a silent pack fallback", async () => {
    get.mockResolvedValueOnce({ data: { id: "p1", isActive: true } });
    get.mockRejectedValueOnce(httpError(403));
    const result = await hydrateParkedLine({ productId: "p1", unitLabel: "Case" });
    expect(result.failed).toBe(true);
    expect(result.product).toBeNull();
  });

  it("the PRODUCT fetch's own failure classification is unchanged (decideResumeLine, regression guard)", async () => {
    get.mockRejectedValueOnce(httpError(404));
    expect(await hydrateParkedLine({ productId: "p1" })).toEqual({
      li: { productId: "p1" },
      product: null,
      failed: false,
      units: [],
    });

    get.mockReset();
    get.mockRejectedValueOnce(httpError(500));
    expect(await hydrateParkedLine({ productId: "p1" })).toEqual({
      li: { productId: "p1" },
      product: null,
      failed: true,
      units: [],
    });
  });
});
