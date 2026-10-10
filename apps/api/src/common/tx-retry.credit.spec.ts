import { BadRequestException } from "@nestjs/common";
import { retryCreditTx } from "./tx-retry";

/**
 * SA-706c fold: the credit-spend transactions retry a write conflict (40001/40P01, P2034) up to 3
 * times. Exhausting them used to surface the raw P2034 as an uncoded 500; it is now a coded,
 * retryable 503 (nothing was saved). Everything else is unchanged.
 */
const conflict = (code: string) => Object.assign(new Error("write conflict"), { code });

describe("retryCreditTx", () => {
  it("returns the value when a later attempt succeeds", async () => {
    let calls = 0;
    const run = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw conflict("P2034");
      return "ok";
    });
    await expect(retryCreditTx("t", run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["P2034", "40001", "40P01"])(
    "a %s on every attempt gives up after 3 with a coded 503",
    async (code) => {
      const run = jest.fn(async () => {
        throw conflict(code);
      });
      await expect(retryCreditTx("t", run)).rejects.toMatchObject({
        status: 503,
        response: { code: "LOCK_UNAVAILABLE" },
      });
      expect(run).toHaveBeenCalledTimes(3);
    },
  );

  it("a validated rejection (an HttpException) and a non-conflict error propagate once, untouched", async () => {
    const bad = new BadRequestException("Credit note CN-9 (ref 40001) has expired");
    const runBad = jest.fn(async () => {
      throw bad;
    });
    await expect(retryCreditTx("t", runBad)).rejects.toBe(bad);
    expect(runBad).toHaveBeenCalledTimes(1);

    const unique = conflict("P2002");
    const runUnique = jest.fn(async () => {
      throw unique;
    });
    await expect(retryCreditTx("t", runUnique)).rejects.toBe(unique);
    expect(runUnique).toHaveBeenCalledTimes(1);
  });
});
