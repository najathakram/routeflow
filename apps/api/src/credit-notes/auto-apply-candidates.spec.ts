import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  autoApplyCandidateWhere,
  hasOpenCreditBalance,
  sweepableCredits,
} from "./auto-apply-candidates";

describe("autoApplyCandidateWhere", () => {
  const now = new Date("2026-10-04T00:00:00Z");

  it("selects every non-VOID, non-excluded, non-expired note of the customer", () => {
    expect(autoApplyCandidateWhere({ customerId: "c1", now })).toEqual({
      customerId: "c1",
      status: { not: "VOID" },
      autoApplyExcluded: false,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    });
  });

  it("adds the explicit-intent exclusion only when ids are given", () => {
    expect(
      autoApplyCandidateWhere({ customerId: "c1", now, excludeCreditNoteIds: [] }),
    ).not.toHaveProperty("id");
    expect(
      autoApplyCandidateWhere({ customerId: "c1", now, excludeCreditNoteIds: ["a"] }).id,
    ).toEqual({
      notIn: ["a"],
    });
  });
});

describe("hasOpenCreditBalance", () => {
  it("is true above a tenth of a cent and false at or below", () => {
    expect(hasOpenCreditBalance({ amount: 10, amountUsed: 4 })).toBe(true);
    expect(hasOpenCreditBalance({ amount: 10, amountUsed: 10 })).toBe(false);
    expect(hasOpenCreditBalance({ amount: "10.00", amountUsed: "9.9995" })).toBe(false);
  });
});

describe("sweepableCredits (SA-998)", () => {
  const now = new Date("2026-10-04T00:00:00Z");
  const note = (id: string, amount: number, amountUsed = 0) => ({ id, amount, amountUsed });

  function db(over: {
    flag?: boolean | null;
    notes?: any[];
    returns?: Record<string, string>;
    met?: boolean;
  }) {
    const findMany = jest.fn().mockResolvedValue(over.notes ?? []);
    return {
      findMany,
      client: {
        tenantConfig: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              over.flag === null ? null : { creditAutoApplyOnSend: over.flag ?? true },
            ),
        },
        creditNote: { findMany },
        return: {
          findFirst: jest.fn(async ({ where }: any) =>
            over.returns?.[where.creditNoteId]
              ? { orderId: over.returns[where.creditNoteId] }
              : null,
          ),
        },
        order: { findFirst: jest.fn().mockResolvedValue({ status: "PENDING" }) },
        invoice: {
          findMany: jest
            .fn()
            .mockResolvedValue(
              over.met
                ? [{ total: 50, payments: [{ amount: 50, status: "PAID", method: "CASH" }] }]
                : [],
            ),
        },
      },
    };
  }
  const args = { tenantId: "t1", customerId: "c1", now };

  it("is empty, and never queries the notes, when the sweep switch is off or has no config row", async () => {
    for (const flag of [false, null]) {
      const d = db({ flag, notes: [note("a", 10)] });
      await expect(sweepableCredits(d.client, args)).resolves.toEqual([]);
      expect(d.findMany).not.toHaveBeenCalled();
    }
  });

  it("selects with autoApplyCandidateWhere, oldest first, and drops a spent note", async () => {
    const d = db({ notes: [note("a", 10), note("spent", 10, 10), note("b", 5, 1)] });
    const out = await sweepableCredits(d.client, { ...args, excludeCreditNoteIds: ["x"] });
    expect(out.map((n) => n.id)).toEqual(["a", "b"]);
    expect(d.findMany).toHaveBeenCalledWith({
      where: autoApplyCandidateWhere({ customerId: "c1", now, excludeCreditNoteIds: ["x"] }),
      orderBy: { createdAt: "asc" },
    });
  });

  it("holds back an inline-return note until its carrying order is met", async () => {
    const notes = [note("inl", 10), note("plain", 4)];
    const unmet = db({ notes, returns: { inl: "o1" } });
    expect((await sweepableCredits(unmet.client, args)).map((n) => n.id)).toEqual(["plain"]);
    const met = db({ notes, returns: { inl: "o1" }, met: true });
    expect((await sweepableCredits(met.client, args)).map((n) => n.id)).toEqual(["inl", "plain"]);
  });
});

describe("the candidate selection has one home (SA-998 pin, OP-7)", () => {
  it("autoApplyCandidateWhere( is called nowhere outside auto-apply-candidates.ts", () => {
    const root = join(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          /\.ts$/.test(e.name) &&
          !/\.spec\.ts$/.test(e.name) &&
          e.name !== "auto-apply-candidates.ts"
        ) {
          if (readFileSync(p, "utf8").includes("autoApplyCandidateWhere(")) hits.push(p);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
