/**
 * F30 · REG-B195 — resolve-rung isActive asymmetry produces a false NOT FOUND
 * (and a vanish-on-resume) for a product that genuinely exists but is
 * archived.
 *
 * The barcode rung (`/products/barcode/<code>`) matches inactive products with
 * no `isActive` filter, while the fallback search rung sends `isActive:true`
 * (barcode-resolve.ts:85). Today an inactive product's barcode hit is returned
 * as an ordinary `{ product, source }` HIT — the caller silently adds it, and
 * it vanishes on draft-resume. Fix (R5): the two rungs must AGREE — drop
 * `isActive:true` from the search rung, and a resolved-but-inactive product
 * must come back as a distinct `archived` outcome, never a plain hit and
 * never `{ notFound: true }`.
 *
 * Dropping the filter is only half the fix: archived rows now reach the search
 * rung's result set, so that rung has to CLASSIFY them too — otherwise the
 * silent add just moves from the barcode rung to the fallback. Both of its
 * outcomes are pinned below, including the ambiguity list, which is a PICKER
 * (every row one tap from the order) and which `scan-ladder.ts` branches on
 * BEFORE it checks `archived`.
 *
 * (The draft-resume half of R5 — keeping an archived line flagged instead of
 * dropping it — lives in NewOrderScreen.tsx's resume block; its contract is
 * `decideResumeLine`, locked in order-draft-gate.test.ts. Only the pure
 * resolve-ladder contract is spec'd here.)
 */
jest.mock("../lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

import { apiClient } from "../lib/api-client";
import { resolveProductByCode } from "../lib/barcode-resolve";

const get = apiClient.get as jest.Mock;

describe("resolveProductByCode — archived products (T-B195 / REG-B195)", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("an inactive product matched on the barcode rung resolves as `archived`, distinct from a hit or a notFound", async () => {
    const inactiveProduct = {
      id: "p1",
      name: "Discontinued Widget",
      isActive: false,
      barcode: "0012345678905",
    };
    get.mockResolvedValueOnce({ data: inactiveProduct }); // barcode rung hit

    const result: any = await resolveProductByCode("0012345678905");

    // Today's code returns this as a plain hit — no `archived` flag exists —
    // so a naive caller silently adds it. Must be distinctly flagged instead.
    expect(result.archived).toBe(true);
    // "distinct from notFound": the archived outcome must never also read as a
    // not-found miss. `not.toBe(true)` alone said almost nothing, so pin the
    // positive discriminator too — an archived product resolved on the barcode
    // rung is still a HIT that reports which rung matched, just a flagged one.
    expect(result.notFound).toBeFalsy();
    expect(result.source).toBe("barcode");
    // The caller still needs the product to render the "X is archived" pill.
    expect(result.product?.id).toBe("p1");
  });

  it("the fallback search rung no longer excludes inactive products via isActive:true (REG-B195)", async () => {
    get.mockRejectedValueOnce({ response: { status: 404 } }); // barcode rung: no exact match
    get.mockResolvedValueOnce({ data: { data: [] } }); // search rung: no rows

    await resolveProductByCode("999999999999");

    expect(get).toHaveBeenCalledTimes(2);
    const [, searchConfig] = get.mock.calls[1]!;
    // Sending isActive:true is exactly the asymmetry the bug names — the
    // search rung must stop filtering out archived products so it can agree
    // with the barcode rung instead of independently reporting notFound.
    expect(searchConfig?.params?.isActive).not.toBe(true);
  });

  it("a lone archived substring row on the search rung resolves as `archived`, not a plain hit", async () => {
    get.mockRejectedValueOnce({ response: { status: 404 } }); // barcode rung: no exact match
    get.mockResolvedValueOnce({
      data: {
        data: [{ id: "p2", name: "0012345678905 Discontinued", isActive: false, sku: "DW-1" }],
      },
    });

    const result: any = await resolveProductByCode("0012345678905");

    // The rung that stopped filtering `isActive` must not hand the row back as
    // an ordinary hit — that is the same silent add, one rung lower.
    expect(result.archived).toBe(true);
    expect(result.notFound).toBeFalsy();
    expect(result.ambiguous).toBeFalsy();
    expect(result.source).toBe("search");
    expect(result.product?.id).toBe("p2");
  });

  it("a substring set that is archived top to bottom is an `archived` outcome, not an ambiguous guess", async () => {
    get.mockRejectedValueOnce({ response: { status: 404 } });
    get.mockResolvedValueOnce({
      data: {
        data: [
          { id: "a1", name: "0012345678905 Old", isActive: false },
          { id: "a2", name: "0012345678905 Older", isActive: false },
        ],
      },
    });

    const result: any = await resolveProductByCode("0012345678905");

    // scan-ladder checks `ambiguous` BEFORE `archived`, so an ambiguous result
    // here opens the picker on an archived-only list — every row one tap from
    // the order, with no pill to warn about any of them.
    expect(result.ambiguous).toBeFalsy();
    expect(result.archived).toBe(true);
    expect(result.source).toBe("search");
  });

  it("an archived row alongside one sellable row resolves to the sellable row, not an ambiguous pick", async () => {
    get.mockRejectedValueOnce({ response: { status: 404 } });
    get.mockResolvedValueOnce({
      data: {
        data: [
          { id: "arch", name: "0012345678905 Old", isActive: false },
          { id: "live", name: "0012345678905 Current", isActive: true },
        ],
      },
    });

    const result: any = await resolveProductByCode("0012345678905");

    // Counting the archived row toward ambiguity would open the picker with it
    // as choice #1 — the archived product reaching the order after all.
    expect(result.ambiguous).toBeFalsy();
    expect(result.archived).toBeFalsy();
    expect(result.product?.id).toBe("live");
  });

  it("the ambiguity picker is never seeded with an archived row", async () => {
    get.mockRejectedValueOnce({ response: { status: 404 } });
    get.mockResolvedValueOnce({
      data: {
        data: [
          { id: "arch", name: "0012345678905 Old", isActive: false },
          { id: "live1", name: "0012345678905 Current", isActive: true },
          { id: "live2", name: "0012345678905 Also", isActive: true },
        ],
      },
    });

    const result: any = await resolveProductByCode("0012345678905");

    expect(result.ambiguous).toBe(true);
    // `matches` IS the picker's row set. It has nowhere to render an archived
    // pill, so an archived row must never appear in it.
    expect(result.matches?.map((p: any) => p.id)).toEqual(["live1", "live2"]);
    expect(result.product?.id).toBe("live1");
  });
});
