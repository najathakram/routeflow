import { TENDER_RULES } from "@routeflow/pricing";
import {
  PAYMENT_PROBLEM_COPY,
  counterSaleErrorCopy,
  finalCounterSaleCopy,
  isDefinitiveCounterSaleRefusal,
} from "./counter-sale";
import {
  COUNTER_BALANCE_CHANGED_COPY,
  SPLIT_CODES,
  SPLIT_PROBLEM_COPY,
  SPLIT_RULE,
  addLeg,
  attemptTender,
  buildSplitPayments,
  canAddLeg,
  canRemoveLeg,
  cashDueCents,
  amountTextToCents,
  legMethodAllowed,
  newSplitRows,
  patchLeg,
  removeLeg,
  rowsFromWire,
  summarizeSplit,
  totalToCents,
  type SplitLegRow,
} from "./counter-split-tender";

/**
 * Split payment at the counter: the pure leg math (integer cents), the rules read from TENDER_RULES.counter, the
 * `payments[]` wire body and the fixed copy of every new server code. No React here.
 */

const row = (
  method: SplitLegRow["method"],
  amount = "",
  reference = "",
  id = `${method}-${amount}`,
): SplitLegRow => ({ id, method, amount, reference });

describe("the rules come from TENDER_RULES.counter, never from a number typed here", () => {
  it("SPLIT_RULE is the shared counter row", () => {
    expect(SPLIT_RULE).toBe(TENDER_RULES.counter);
  });

  it("a fifth line is refused, and add is off at the limit", () => {
    let rows = newSplitRows("CASH");
    while (canAddLeg(rows)) rows = addLeg(rows);
    expect(rows).toHaveLength(TENDER_RULES.counter.maxLegs);
    expect(addLeg(rows)).toHaveLength(TENDER_RULES.counter.maxLegs);
    expect(
      summarizeSplit({ rows: [...rows, row("CARD", "1")], totalCents: 100, isWalkIn: true })
        .problem,
    ).toBe("COUNTER_TOO_MANY_LEGS");
  });

  it("one cash line: the method cannot be picked on a second line", () => {
    const rows = [row("CASH", "10", "", "a"), row("CARD", "5", "", "b")];
    expect(legMethodAllowed(rows, "b", "CASH")).toBe(false);
    expect(legMethodAllowed(rows, "a", "CASH")).toBe(true); // its own line keeps it
    expect(legMethodAllowed(rows, "b", "CHECK")).toBe(true);
  });

  it("On account is only ever alone: not pickable on a split, and a split that has it cannot grow", () => {
    const rows = [row("CARD", "5", "", "a"), row("CASH", "5", "", "b")];
    expect(legMethodAllowed(rows, "a", "ON_ACCOUNT")).toBe(false);
    expect(legMethodAllowed([row("CARD", "5", "", "a")], "a", "ON_ACCOUNT")).toBe(true);
    expect(canAddLeg([row("ON_ACCOUNT", "", "", "a")])).toBe(false);
    expect(
      summarizeSplit({
        rows: [row("ON_ACCOUNT", "", "", "a"), row("CASH", "5", "", "b")],
        totalCents: 500,
        isWalkIn: false,
      }).problem,
    ).toBe("COUNTER_ON_ACCOUNT_NOT_SPLIT");
  });

  it("opens with two lines (the chosen method, then cash or card); never opens on On account; two is the floor", () => {
    expect(newSplitRows("CARD").map((r) => r.method)).toEqual(["CARD", "CASH"]);
    expect(newSplitRows("CASH").map((r) => r.method)).toEqual(["CASH", "CARD"]);
    expect(newSplitRows("ON_ACCOUNT").map((r) => r.method)).toEqual(["CARD", "CASH"]);
    const rows = newSplitRows("CARD");
    expect(canRemoveLeg(rows)).toBe(false);
    expect(removeLeg(rows, rows[0].id)).toHaveLength(2);
    const three = addLeg(rows);
    expect(removeLeg(three, three[2].id).map((r) => r.id)).toEqual([rows[0].id, rows[1].id]);
  });
});

describe("amountTextToCents: whole cents only, no float drift", () => {
  it.each([
    ["", 0],
    ["12", 1200],
    ["12.5", 1250],
    ["12.50", 1250],
    [".5", 50],
    ["5.", 500],
    ["19.99", 1999],
    ["1146.1", 114610],
  ])("%j -> %j", (text, cents) => expect(amountTextToCents(text)).toBe(cents));

  it.each(["abc", "-1", "1.234", ".", "1,5", "1e3", "$5"])("%j is not a whole-cent amount", (t) =>
    expect(amountTextToCents(t)).toBeNull(),
  );

  it("totalToCents is exact for a roundMoney total", () => {
    expect(totalToCents(19.99)).toBe(1999);
    expect(totalToCents(70)).toBe(7000);
    expect(totalToCents(1146.1)).toBe(114610);
  });
});

describe("summarizeSplit: Remaining, change and the first rule that stops the sale", () => {
  const sum = (rows: SplitLegRow[], total = 7000, isWalkIn = true) =>
    summarizeSplit({ rows, totalCents: total, isWalkIn });

  it("walk-in short: remaining is the rest and the sale is stopped (TENDER_SHORT)", () => {
    const s = sum([row("CARD", "30"), row("CASH", "20")]);
    expect(s.remainingCents).toBe(2000);
    expect(s.changeCents).toBe(0);
    expect(s.problem).toBe("COUNTER_TENDER_SHORT");
  });

  it("exact: nothing remaining, no change, no problem", () => {
    const s = sum([row("CARD", "30"), row("CASH", "40")]);
    expect(s).toMatchObject({ remainingCents: 0, changeCents: 0, problem: null });
  });

  it("card 30 + cash 50 on 70: change 10, no problem (the brief's red case)", () => {
    const s = sum([row("CARD", "30"), row("CASH", "50")]);
    expect(s).toMatchObject({ remainingCents: 0, changeCents: 1000, problem: null });
  });

  it("a named customer may pay part: the rest is left on account, not an error", () => {
    const s = sum([row("CARD", "30"), row("CHECK", "10", "1001")], 7000, false);
    expect(s).toMatchObject({ remainingCents: 3000, leftOnAccountCents: 3000, problem: null });
  });

  it("a walk-in never has anything left on account", () => {
    expect(sum([row("CARD", "30"), row("CASH", "20")]).leftOnAccountCents).toBe(0);
  });

  it("card + check above the total, or any cash once they already cover it, is EXCEEDS_TOTAL", () => {
    expect(sum([row("CARD", "50"), row("CHECK", "30", "9")]).problem).toBe(
      "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    );
    expect(sum([row("CARD", "70"), row("CASH", "5")]).problem).toBe(
      "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    );
  });

  it("a check without its number, an empty or zero line, and a three-decimal amount each stop the sale", () => {
    expect(sum([row("CARD", "30"), row("CHECK", "40", "  ")]).problem).toBe(
      "COUNTER_CHECK_NUMBER_REQUIRED",
    );
    expect(sum([row("CARD", "30"), row("CASH", "")]).problem).toBe("COUNTER_LEG_AMOUNT_REQUIRED");
    expect(sum([row("CARD", "30"), row("CASH", "0")]).problem).toBe("COUNTER_LEG_AMOUNT_REQUIRED");
    expect(sum([row("CARD", "30.001"), row("CASH", "40")]).problem).toBe("COUNTER_LEG_NOT_CENTS");
  });

  it("two cash lines are refused (one cash line)", () => {
    expect(sum([row("CASH", "30"), row("CASH", "40")]).problem).toBe("COUNTER_DUPLICATE_CASH_LEG");
  });

  it("cents stay exact where floats drift (19.99 + 0.01 on 20.00)", () => {
    const s = sum([row("CARD", "19.99"), row("CASH", "0.01")], 2000);
    expect(s).toMatchObject({
      enteredCents: 2000,
      remainingCents: 0,
      changeCents: 0,
      problem: null,
    });
  });

  it("cashDueCents is what the sale still owes after the OTHER lines", () => {
    const rows = [row("CARD", "30", "", "c"), row("CASH", "", "", "k")];
    expect(cashDueCents(rows, "k", 7000)).toBe(4000);
    expect(cashDueCents(rows, "c", 7000)).toBe(7000);
    expect(cashDueCents([row("CARD", "90", "", "c"), row("CASH", "", "", "k")], "k", 7000)).toBe(0);
  });
});

describe("the payments[] wire body", () => {
  const rows = [row("CARD", "30"), row("CHECK", "10.5", " 1001 "), row("CASH", "40")];

  it("sends every leg with its amount as decimal dollars; only a check carries a reference", () => {
    expect(buildSplitPayments(rows)).toEqual([
      { method: "CARD", amount: 30 },
      { method: "CHECK", amount: 10.5, reference: "1001" },
      { method: "CASH", amount: 40 },
    ]);
  });

  it("amounts are whole-cent dollars, never a float artifact", () => {
    const [leg] = buildSplitPayments([row("CARD", "1146.1")]);
    expect(leg.amount).toBe(1146.1);
    expect(Math.round((leg.amount ?? 0) * 100)).toBe(114610);
  });

  it("a held attempt replays the EXACT legs: the stored legs rebuild the same rows and the same body", () => {
    const wire = buildSplitPayments(rows);
    expect(buildSplitPayments(rowsFromWire(wire))).toEqual(wire);
    expect(rowsFromWire(wire).map((r) => [r.method, r.reference])).toEqual([
      ["CARD", ""],
      ["CHECK", "1001"],
      ["CASH", ""],
    ]);
  });

  it("attemptTender reads leg 0's method and the cash entered, from either body shape", () => {
    expect(
      attemptTender({
        payments: [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 50 },
        ],
      }),
    ).toEqual({ method: "CARD", cashAmount: 50 });
    expect(attemptTender({ payment: { method: "CASH", amount: 20 } })).toEqual({
      method: "CASH",
      cashAmount: 20,
    });
    expect(attemptTender({ payment: { method: "CARD" } })).toEqual({
      method: "CARD",
      cashAmount: null,
    });
  });

  it("patchLeg only changes the one line", () => {
    const a = newSplitRows("CARD");
    const b = patchLeg(a, a[0].id, { amount: "12" });
    expect(b[0].amount).toBe("12");
    expect(b[1]).toBe(a[1]);
  });
});

describe("every new server code has FIXED copy, and the server's text is never used", () => {
  const CODES = Object.values(SPLIT_CODES);

  it("PAYMENT_PROBLEM_COPY carries a non-empty line for each of the eleven codes", () => {
    expect(CODES).toHaveLength(11);
    for (const code of CODES) {
      expect((PAYMENT_PROBLEM_COPY as Record<string, string>)[code]).toBe(
        (SPLIT_PROBLEM_COPY as Record<string, string>)[code],
      );
      expect((PAYMENT_PROBLEM_COPY as Record<string, string>)[code]).toMatch(/\S/);
    }
  });

  it.each(CODES.filter((c) => c !== "COUNTER_TENDER_CHANGED"))(
    "400 %s -> its fixed copy, not the server message, and a definitive refusal",
    (code) => {
      const err = { response: { status: 400, data: { code, message: "SERVER TEXT" } } };
      expect(counterSaleErrorCopy(err)).toBe(SPLIT_PROBLEM_COPY[code]);
      expect(counterSaleErrorCopy(err)).not.toContain("SERVER TEXT");
      expect(isDefinitiveCounterSaleRefusal(err)).toBe(true);
    },
  );

  it("409 COUNTER_TENDER_CHANGED is FINAL (the sale exists, a replay cannot succeed) with its own copy", () => {
    const err = {
      response: { status: 409, data: { code: "COUNTER_TENDER_CHANGED", message: "SERVER TEXT" } },
    };
    expect(finalCounterSaleCopy(err)).toBe(SPLIT_PROBLEM_COPY.COUNTER_TENDER_CHANGED);
    expect(counterSaleErrorCopy(err)).toBe(SPLIT_PROBLEM_COPY.COUNTER_TENDER_CHANGED);
  });

  it("the post-commit over-cover line is the one the brief fixed", () => {
    expect(COUNTER_BALANCE_CHANGED_COPY).toBe("The balance changed — take the payment again");
  });
});
