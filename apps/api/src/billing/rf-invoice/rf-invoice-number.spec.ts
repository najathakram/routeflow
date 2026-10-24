// PR1 NUM-1: RF-YYYY-NNNN minting (UTC issue year, max+1, never reused) + the number-index-only retry.
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { withAdvisoryLock } from "../../common/db-locks";
import { RF_INVOICE_NUMBER_INDEX, RF_INVOICE_PERIOD_INDEX } from "./rf-invoice.constants";
import {
  mintRfInvoiceNumber,
  withRfInvoiceNumber,
  withRfInvoiceNumberLock,
} from "./rf-invoice-number";

const db = (numbers: string[]) => ({
  rfInvoice: { findMany: jest.fn(async () => numbers.map((number) => ({ number }))) },
});

const p2002 = (index: string) => ({
  code: "P2002",
  meta: { driverAdapterError: { cause: { constraint: { index } } } },
});

describe("rf-invoice-number", () => {
  it("NUM-1: 0041 -> 0042 in the UTC issue year", async () => {
    const n = await mintRfInvoiceNumber(
      db(["RF-2026-0007", "RF-2026-0041", "RF-2026-0040"]) as any,
      new Date("2026-10-07T00:20:00Z"),
    );
    expect(n).toBe("RF-2026-0042");
  });

  it("NUM-1: year rollover restarts at 0001, judged in UTC (31 Dec 23:30 -05:00 is already 2027)", async () => {
    const n = await mintRfInvoiceNumber(
      db(["RF-2026-0099"]) as any,
      new Date("2027-01-01T04:30:00Z"),
    );
    expect(n).toBe("RF-2027-0001");
  });

  it("NUM-1: a number past 9999 keeps counting (no lexicographic trap) and pads to 4", async () => {
    expect(await mintRfInvoiceNumber(db([]) as any, new Date("2026-01-01T00:00:00Z"))).toBe(
      "RF-2026-0001",
    );
    expect(
      await mintRfInvoiceNumber(
        db(["RF-2026-9999", "RF-2026-10000"]) as any,
        new Date("2026-06-01T00:00:00Z"),
      ),
    ).toBe("RF-2026-10001");
  });

  it("NUM-1: ignores other years and malformed numbers", async () => {
    const n = await mintRfInvoiceNumber(
      db(["RF-2025-0500", "RF-2026-oops", "RF-2026-0003"]) as any,
      new Date("2026-03-01T00:00:00Z"),
    );
    expect(n).toBe("RF-2026-0004");
  });

  it("NUM-1: a P2002 on THE NUMBER INDEX is retried once, then succeeds", async () => {
    const attempt = jest
      .fn()
      .mockRejectedValueOnce(p2002(RF_INVOICE_NUMBER_INDEX))
      .mockResolvedValueOnce("ok");
    await expect(withRfInvoiceNumber(attempt)).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("NUM-1: the retry happens only once (second number collision propagates)", async () => {
    const attempt = jest.fn().mockRejectedValue(p2002(RF_INVOICE_NUMBER_INDEX));
    await expect(withRfInvoiceNumber(attempt)).rejects.toMatchObject({ code: "P2002" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("NUM-1 (SA M1): a P2002 on any OTHER index is never retried", async () => {
    for (const index of [RF_INVOICE_PERIOD_INDEX, "RfInvoice_pkey"]) {
      const attempt = jest.fn().mockRejectedValue(p2002(index));
      await expect(withRfInvoiceNumber(attempt)).rejects.toMatchObject({ code: "P2002" });
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });

  it("mints under the billing-family wait lock named rf-invoice-number (5 s)", async () => {
    await withRfInvoiceNumberLock(async () => "x");
    expect(withAdvisoryLock).toHaveBeenCalledWith(
      { family: "billing", key: "rf-invoice-number", mode: "wait", waitMs: 5000 },
      expect.any(Function),
    );
  });
});
