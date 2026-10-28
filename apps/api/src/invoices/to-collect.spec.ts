import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { InvoiceStatus } from "@prisma/client";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";
import {
  CLEARED_INVOICE_STATUSES,
  TO_COLLECT_METHOD_VALUES,
  TO_COLLECT_WHERE,
  markToCollect,
  rollupToCollect,
  toCollectState,
} from "./to-collect";

/**
 * SA-1026 Part A: "To collect" is a typed intent on the invoice (`Invoice.expectedPaymentMethod`) plus a state DERIVED
 * from the status the payment writers already move. One writer, one predicate, one list filter, all in `to-collect.ts`.
 *   A-G6 class pin  : every InvoiceStatus gives the same answer from `toCollectState` and `TO_COLLECT_WHERE`.
 *   A-G7 structural : `expectedPaymentMethod` is WRITTEN only in `to-collect.ts` (count-pinned).
 *   A-G10 tripwire  : no non-spec code writes an InvoicePayment with status PENDING (the held post-dated cheque branch
 *                     of the predicate lands with that writer, in `to-collect.ts`).
 */

type Row = { expectedPaymentMethod: string | null; status: string };
type Cond = { not?: unknown; in?: readonly unknown[]; notIn?: readonly unknown[] };

/** A just-enough Prisma `where` evaluator for the shapes `TO_COLLECT_WHERE` uses (field: value | not | in | notIn). */
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([field, cond]) => {
    const value = (row as Record<string, unknown>)[field];
    if (cond === null || typeof cond !== "object") return value === cond;
    const c = cond as Cond;
    if ("not" in c && value === c.not) return false;
    if (c.in && !c.in.includes(value)) return false;
    if (c.notIn && c.notIn.includes(value)) return false;
    return true;
  });
}

describe("toCollectState (A-G5 truth table)", () => {
  it("no intent is NONE whatever the status: an old On account invoice reads exactly as today", () => {
    for (const status of Object.values(InvoiceStatus)) {
      expect(toCollectState({ expectedPaymentMethod: null, status })).toBe("NONE");
    }
  });

  it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])("intent + open status %s is TO_COLLECT", (status) => {
    expect(toCollectState({ expectedPaymentMethod: "CHECK", status })).toBe("TO_COLLECT");
  });

  it.each(["PAID", "VOID", "WRITTEN_OFF"])("intent + %s is NONE (cleared)", (status) => {
    expect(toCollectState({ expectedPaymentMethod: "CHECK", status })).toBe("NONE");
  });

  it.each(["DRAFT", "SOMETHING_NEW"])(
    "intent + %s is UNKNOWN: fail closed, shown and never hidden",
    (status) => {
      expect(toCollectState({ expectedPaymentMethod: "CHECK", status })).toBe("UNKNOWN");
    },
  );
});

describe("A-G6 class pin: the predicate and the list filter agree for every InvoiceStatus", () => {
  it("the OPEN and CLEARED sets plus DRAFT cover every InvoiceStatus (a new status forces a decision here)", () => {
    const all = Object.values(InvoiceStatus).sort();
    const covered = [...OPEN_INVOICE_STATUSES, ...CLEARED_INVOICE_STATUSES, InvoiceStatus.DRAFT].sort();
    expect(covered).toEqual(all);
  });

  it.each(Object.values(InvoiceStatus))(
    "status %s: TO_COLLECT_WHERE lists the row exactly when the predicate does not say NONE",
    (status) => {
      const row = { expectedPaymentMethod: "CHECK", status };
      const state = toCollectState(row);
      expect(matches(TO_COLLECT_WHERE as Record<string, unknown>, row)).toBe(state !== "NONE");
    },
  );

  it("a row with no intent is never listed, at any status", () => {
    for (const status of Object.values(InvoiceStatus)) {
      expect(
        matches(TO_COLLECT_WHERE as Record<string, unknown>, { expectedPaymentMethod: null, status }),
      ).toBe(false);
    }
  });
});

describe("rollupToCollect: one answer for an order that holds several invoices", () => {
  it("any TO_COLLECT wins, then UNKNOWN (shown), else NONE", () => {
    expect(rollupToCollect(["NONE", "TO_COLLECT", "UNKNOWN"])).toBe("TO_COLLECT");
    expect(rollupToCollect(["NONE", "UNKNOWN"])).toBe("UNKNOWN");
    expect(rollupToCollect(["NONE", "NONE"])).toBe("NONE");
    expect(rollupToCollect([])).toBe("NONE");
  });
});

describe("markToCollect: the one writer", () => {
  const tx = () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    return { tx: { invoice: { updateMany } } as never, updateMany };
  };

  it("sets the intent only where none is set yet (a replay keeps the first intent), tenant-scoped", async () => {
    const { tx: t, updateMany } = tx();
    await markToCollect(t, { tenantId: "t1", invoiceIds: ["i1", "i2"], method: "CHECK" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", id: { in: ["i1", "i2"] }, expectedPaymentMethod: null },
      data: { expectedPaymentMethod: "CHECK" },
    });
  });

  it("zero ids throw: a caller that lost its invoices must not read as marked (L-202)", async () => {
    const { tx: t, updateMany } = tx();
    await expect(
      markToCollect(t, { tenantId: "t1", invoiceIds: [], method: "CHECK" }),
    ).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a method outside TO_COLLECT_METHOD_VALUES before any write", async () => {
    const { tx: t, updateMany } = tx();
    await expect(
      markToCollect(t, { tenantId: "t1", invoiceIds: ["i1"], method: "CASH" as never }),
    ).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
    expect([...TO_COLLECT_METHOD_VALUES]).toEqual(["CHECK"]);
  });
});

// ---- source scans (A-G7, A-G10) --------------------------------------------------------------------------------

const SRC = join(__dirname, "..");
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") sourceFiles(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

describe("A-G7: expectedPaymentMethod is written only in to-collect.ts (OP-7)", () => {
  // A WRITE is the field set to a value: `expectedPaymentMethod: <identifier or literal>` or a shorthand property. A read
  // (`select: { expectedPaymentMethod: true }`, `{ not: null }`, the CAS `: null`) and a `?:` type member are not.
  const WRITE = /expectedPaymentMethod\s*:\s*(?!true\b|false\b|null\b|\{)\S|[{,]\s*expectedPaymentMethod\s*[,}]/g;

  it("no other non-spec file assigns it", () => {
    const writers = sourceFiles(SRC)
      .filter((f) => rel(f) !== "invoices/to-collect.ts")
      .filter((f) => WRITE.test(readFileSync(f, "utf8")))
      .map(rel);
    WRITE.lastIndex = 0;
    expect(writers).toEqual([]);
  });

  it("to-collect.ts itself writes it exactly once", () => {
    const text = readFileSync(join(SRC, "invoices", "to-collect.ts"), "utf8");
    expect((text.match(WRITE) ?? []).length).toBe(1);
  });

  it("no raw SQL touches the column outside migrations", () => {
    const raw = sourceFiles(SRC)
      .filter((f) => /expected_payment_method/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(raw).toEqual([]);
  });
});

describe("A-G10 tripwire: nothing writes a PENDING InvoicePayment yet", () => {
  const WRITER = /\.invoicePayment\s*\.\s*(?:create|createMany|update|updateMany|upsert)\s*\(/g;
  const PENDING = /status\s*:\s*(?:["'`]PENDING["'`]|PaymentStatus\.PENDING)/;

  it("fails the day a non-spec writer sets a payment to PENDING; the held-cheque rule must land with it", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(WRITER)) {
        const window = text.slice(m.index ?? 0, (m.index ?? 0) + 1500);
        if (PENDING.test(window)) offenders.push(rel(f));
      }
    }
    expect({
      offenders,
      note:
        "A held post-dated cheque (a PENDING InvoicePayment) clears the To collect tag (SA-1026 §2.5, owner 23:47Z). " +
        "Add the held-payments branch to toCollectState and TO_COLLECT_WHERE in invoices/to-collect.ts " +
        "(HELD_STATUSES / sumHeld in packages/pricing payment-confirmation.ts), then update this tripwire.",
    }).toEqual({ offenders: [], note: expect.any(String) });
  });
});
