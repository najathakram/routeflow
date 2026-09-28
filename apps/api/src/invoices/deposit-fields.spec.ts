/**
 * #1529 / SA-517: the deposit read-time math, extracted from InvoicesService as a PURE function of
 * `(invoice, totalPaid, todayIso)` so the invoice list, the invoice detail and AR aging all share
 * one rule — and each caller supplies its own notion of "today" (AR aging: the tenant's day).
 */
import { computeDepositFields } from "./deposit-fields";

describe("computeDepositFields (#1529)", () => {
  const inv = (depositPercent: number | null, depositDueDate: string | null, total = 1000) => ({
    total,
    depositPercent,
    depositDueDate: depositDueDate ? new Date(`${depositDueDate}T00:00:00.000Z`) : null,
  });

  it("no deposit ⇒ amount null, never overdue", () => {
    expect(computeDepositFields(inv(null, "2026-09-01"), 0, "2026-09-20")).toEqual({
      depositAmount: null,
      depositOverdue: false,
    });
  });

  it("the amount is percent × total, rounded to cents", () => {
    expect(computeDepositFields(inv(33.333, null, 100), 0, "2026-09-20").depositAmount).toBe(33.33);
  });

  it("due TODAY is not overdue (the whole due day is grace); due yesterday and underpaid is", () => {
    expect(computeDepositFields(inv(50, "2026-09-20"), 0, "2026-09-20").depositOverdue).toBe(false);
    expect(computeDepositFields(inv(50, "2026-09-19"), 0, "2026-09-20").depositOverdue).toBe(true);
  });

  it("paid at or above the deposit ⇒ not overdue", () => {
    expect(computeDepositFields(inv(50, "2026-09-01"), 500, "2026-09-20").depositOverdue).toBe(
      false,
    );
    expect(computeDepositFields(inv(50, "2026-09-01"), 499.99, "2026-09-20").depositOverdue).toBe(
      true,
    );
  });

  it("uses the todayIso it is GIVEN, never the process clock", () => {
    const due = inv(50, "2026-09-20");
    expect(computeDepositFields(due, 0, "2026-09-21").depositOverdue).toBe(true);
    expect(computeDepositFields(due, 0, "2026-09-20").depositOverdue).toBe(false);
  });

  it("no deposit due date ⇒ never overdue", () => {
    expect(computeDepositFields(inv(50, null), 0, "2026-09-20").depositOverdue).toBe(false);
  });
});
