import { BadRequestException } from "@nestjs/common";
import { retryStockTx } from "./tx-retry";

/**
 * SA-767 r-note Nit 6: the stock-writer transactions (PO receive / edit, vendor-bill receive /
 * revert / void) retry a write conflict (40001/40P01, P2034) up to 3 times. Exhausting them used
 * to surface the raw error as an uncoded 500; it is now a coded, retryable 503 (nothing was saved),
 * the same shape as retryCreditTx / retryRouteTx.
 */
const conflict = (code: string) => Object.assign(new Error("write conflict"), { code });

describe("retryStockTx", () => {
  it("returns the value when a later attempt succeeds", async () => {
    let calls = 0;
    const run = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw conflict("40P01");
      return "ok";
    });
    await expect(retryStockTx("t", run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["P2034", "40001", "40P01"])(
    "a %s on every attempt gives up after 3 with a coded 503 in stock wording",
    async (code) => {
      const run = jest.fn(async () => {
        throw conflict(code);
      });
      await expect(retryStockTx("t", run)).rejects.toMatchObject({
        status: 503,
        response: {
          code: "LOCK_UNAVAILABLE",
          message: expect.stringMatching(/stock change was in progress.*Nothing was saved/),
        },
      });
      expect(run).toHaveBeenCalledTimes(3);
    },
  );

  it("a validated rejection (an HttpException) and a non-conflict error propagate once, untouched", async () => {
    const bad = new BadRequestException("Bill is already received (ref 40001)");
    const runBad = jest.fn(async () => {
      throw bad;
    });
    await expect(retryStockTx("t", runBad)).rejects.toBe(bad);
    expect(runBad).toHaveBeenCalledTimes(1);

    const unique = conflict("P2002");
    const runUnique = jest.fn(async () => {
      throw unique;
    });
    await expect(retryStockTx("t", runUnique)).rejects.toBe(unique);
    expect(runUnique).toHaveBeenCalledTimes(1);
  });
});
