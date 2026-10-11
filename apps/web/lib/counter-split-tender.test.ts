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
  isSplitTender,
  patchLeg,
  payOneWay,
  removeLeg,
  rowsFromWire,
  SPLIT_SEGMENT_METHODS,
  splitBarText,
  splitIssue,
  stillDueCopy,
  summarizeSplit,
  tenderDisplayOrder,
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

  it("opens with two empty lines, Card first, then Cash (whatever the single method was)", () => {
    const rows = newSplitRows();
    expect(rows.map((r) => [r.method, r.amount, r.reference])).toEqual([
      ["CARD", "", ""],
      ["CASH", "", ""],
    ]);
  });

  it("Add payment: off at the shared maximum and off once nothing remains; a fifth line is refused", () => {
    let rows = newSplitRows();
    expect(canAddLeg(rows, 7000)).toBe(true);
    expect(canAddLeg(rows, 0)).toBe(false);
    while (canAddLeg(rows, 7000)) rows = addLeg(rows, 7000);
    expect(rows).toHaveLength(TENDER_RULES.counter.maxLegs);
    expect(addLeg(rows, 7000)).toHaveLength(TENDER_RULES.counter.maxLegs);
    expect(addLeg(newSplitRows(), 0)).toHaveLength(2);
    const five = [1, 2, 3, 4, 5].map((n) => row("CARD", "1", "", `five-${n}`));
    expect(summarizeSplit({ rows: five, totalCents: 100, isWalkIn: true }).problem).toBe(
      "COUNTER_TOO_MANY_LEGS",
    );
  });

  it("a new line is cash while no cash line exists, else card", () => {
    const noCash = [row("CARD", "", "", "a"), row("CHECK", "", "", "b")];
    expect(addLeg(noCash, 100)[2].method).toBe("CASH");
    expect(addLeg(newSplitRows(), 100)[2].method).toBe("CARD");
  });

  it("the x shows from two lines up (one line is a plain payment)", () => {
    const rows = newSplitRows();
    expect(canRemoveLeg(rows)).toBe(true);
    expect(canRemoveLeg(removeLeg(rows, rows[0].id))).toBe(false);
    expect(removeLeg(rows, rows[0].id).map((r) => r.id)).toEqual([rows[1].id]);
    const single = removeLeg(rows, rows[0].id);
    expect(removeLeg(single, single[0].id)).toHaveLength(1);
  });

  it("one cash line: the method cannot be picked on a second line", () => {
    const rows = [row("CASH", "10", "", "a"), row("CARD", "5", "", "b")];
    expect(legMethodAllowed(rows, "b", "CASH")).toBe(false);
    expect(legMethodAllowed(rows, "a", "CASH")).toBe(true); // its own line keeps it
    expect(legMethodAllowed(rows, "b", "CHECK")).toBe(true);
  });

  it("On account is never part of a split: not a segment, not pickable, and a split that has it is refused", () => {
    expect(SPLIT_SEGMENT_METHODS).toEqual(["CASH", "CARD", "CHECK"]);
    const rows = [row("CARD", "5", "", "a"), row("CASH", "5", "", "b")];
    expect(legMethodAllowed(rows, "a", "ON_ACCOUNT")).toBe(false);
    expect(canAddLeg([row("ON_ACCOUNT", "", "", "a")], 500)).toBe(false);
    expect(
      summarizeSplit({
        rows: [row("ON_ACCOUNT", "5", "", "a"), row("CASH", "5", "", "b")],
        totalCents: 500,
        isWalkIn: false,
      }).problem,
    ).toBe("COUNTER_ON_ACCOUNT_NOT_SPLIT");
  });

  it("Pay one way keeps the FIRST line's method and clears the amounts (a first check keeps its number)", () => {
    expect(payOneWay([row("CARD", "30"), row("CASH", "40")])).toEqual({
      method: "CARD",
      reference: "",
    });
    expect(payOneWay([row("CASH", "30"), row("CARD", "40")]).method).toBe("CASH");
    expect(payOneWay([row("CHECK", "30", "1042"), row("CASH", "40")])).toEqual({
      method: "CHECK",
      reference: "1042",
    });
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

  it("a fresh split reads Remaining $70.00 and shows no error until Complete is tried", () => {
    const s = sum(newSplitRows());
    expect(s).toMatchObject({ remainingCents: 7000, changeCents: 0, covered: false });
    expect(splitBarText(s)).toBe("Remaining $70.00");
    expect(splitIssue(s, false)).toBeNull();
    const tried = splitIssue(s, true);
    expect(tried?.text).toBe("$70.00 is still due.");
  });

  it("walk-in short: Remaining is the rest; the still-due line waits for an attempt and sits under the last line", () => {
    const rows = [row("CARD", "30", "", "c"), row("CASH", "28", "", "k")];
    const s = sum(rows, 7000);
    expect(s.remainingCents).toBe(1200);
    expect(s.problem).toBe("COUNTER_TENDER_SHORT");
    expect(splitBarText(s)).toBe("Remaining $12.00");
    expect(splitIssue(s, false)).toBeNull();
    expect(splitIssue(s, true)).toEqual({ rowId: "k", text: "$12.00 is still due." });
    expect(stillDueCopy(1200)).toBe("$12.00 is still due.");
  });

  it("exact: Change $0.00, covered, no problem", () => {
    const s = sum([row("CARD", "30"), row("CASH", "40")]);
    expect(s).toMatchObject({ remainingCents: 0, changeCents: 0, problem: null, covered: true });
    expect(splitBarText(s)).toBe("Change $0.00");
  });

  it("card 30 + cash 50 on 70: Change $10.00, covered (the brief's red case)", () => {
    const s = sum([row("CARD", "30"), row("CASH", "50")]);
    expect(s).toMatchObject({ remainingCents: 0, changeCents: 1000, problem: null, covered: true });
    expect(splitBarText(s)).toBe("Change $10.00");
  });

  it("cash first then card keeps the clerk's order and still gives the right change", () => {
    const rows = [row("CASH", "50"), row("CARD", "30")];
    const s = sum(rows);
    expect(s.changeCents).toBe(1000);
    expect(buildSplitPayments(rows).map((l) => l.method)).toEqual(["CASH", "CARD"]);
  });

  it("an empty line is not used: card 70 with the cash line left blank is covered and sends ONE leg", () => {
    const rows = [row("CARD", "70"), row("CASH", "")];
    expect(sum(rows)).toMatchObject({ problem: null, covered: true });
    expect(buildSplitPayments(rows)).toEqual([{ method: "CARD", amount: 70 }]);
  });

  it("a named customer may pay part: the rest is left on account, not an error, not covered", () => {
    const s = sum([row("CARD", "30"), row("CHECK", "10", "1001")], 7000, false);
    expect(s).toMatchObject({
      remainingCents: 3000,
      leftOnAccountCents: 3000,
      problem: null,
      covered: false,
    });
  });

  it("a walk-in never has anything left on account", () => {
    expect(sum([row("CARD", "30"), row("CASH", "20")]).leftOnAccountCents).toBe(0);
  });

  it("Card 80 on $70 is refused under the card line, at once, with the brief's line", () => {
    const s = sum([row("CARD", "80", "", "c"), row("CASH", "", "", "k")]);
    expect(s.problem).toBe("COUNTER_PAYMENT_EXCEEDS_TOTAL");
    expect(splitIssue(s, false)).toEqual({
      rowId: "c",
      text: "Card and check can't be more than the total.",
    });
  });

  it("card + check above the total, or any cash once they already cover it, is EXCEEDS_TOTAL (under the right line)", () => {
    const over = sum([row("CARD", "50", "", "a"), row("CHECK", "30", "9", "b")]);
    expect(over.problem).toBe("COUNTER_PAYMENT_EXCEEDS_TOTAL");
    expect(over.problemRowId).toBe("b");
    const cashOnCovered = sum([row("CARD", "70", "", "a"), row("CASH", "5", "", "k")]);
    expect(cashOnCovered.problem).toBe("COUNTER_PAYMENT_EXCEEDS_TOTAL");
    expect(cashOnCovered.problemRowId).toBe("k");
  });

  it("a check without its number stops the sale and says so under the check line once Complete is tried", () => {
    const s = sum([row("CARD", "30"), row("CHECK", "40", "  ", "k")]);
    expect(s.problem).toBe("COUNTER_CHECK_NUMBER_REQUIRED");
    expect(splitIssue(s, false)).toBeNull();
    expect(splitIssue(s, true)).toEqual({ rowId: "k", text: "Enter the check number." });
    expect(sum([row("CARD", "30"), row("CHECK", "40", "1042")])).toMatchObject({ covered: true });
  });

  it("a three-decimal or non-numeric amount is refused at once: 'Enter the amount in dollars and cents.'", () => {
    for (const bad of ["30.001", "abc", "-5"]) {
      const s = sum([row("CARD", bad, "", "c"), row("CASH", "40")]);
      expect(s.problem).toBe("COUNTER_LEG_NOT_CENTS");
      expect(splitIssue(s, false)).toEqual({
        rowId: "c",
        text: "Enter the amount in dollars and cents.",
      });
    }
  });

  it("two cash lines are refused under the second: 'Only one cash payment per sale.'", () => {
    const s = sum([row("CASH", "30", "", "a"), row("CASH", "40", "", "b")]);
    expect(s.problem).toBe("COUNTER_DUPLICATE_CASH_LEG");
    expect(splitIssue(s, false)).toEqual({ rowId: "b", text: "Only one cash payment per sale." });
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

  it("never a dash in the change slot, whatever is entered", () => {
    for (const rows of [
      newSplitRows(),
      [row("CARD", "abc"), row("CASH", "")],
      [row("CARD", "80"), row("CASH", "5")],
      [row("CARD", "30"), row("CASH", "50")],
    ]) {
      expect(splitBarText(sum(rows))).toMatch(/^(Remaining|Change) \$\d+\.\d{2}$/);
    }
  });

  it("cashDueCents is what the sale still owes after the OTHER lines (Exact = Remaining)", () => {
    const rows = [row("CARD", "30", "", "c"), row("CASH", "", "", "k")];
    expect(cashDueCents(rows, "k", 7000)).toBe(4000);
    expect(cashDueCents(rows, "c", 7000)).toBe(7000);
    expect(cashDueCents([row("CARD", "90", "", "c"), row("CASH", "", "", "k")], "k", 7000)).toBe(0);
  });
});

describe("how a tender is listed (display order only)", () => {
  it("non-cash first, then cash; each group keeps the order it came in", () => {
    const items = [{ method: "CASH" }, { method: "CHECK" }, { method: "CARD" }];
    expect(tenderDisplayOrder(items).map((i) => i.method)).toEqual(["CHECK", "CARD", "CASH"]);
    expect(items.map((i) => i.method)).toEqual(["CASH", "CHECK", "CARD"]); // the input is untouched
  });

  it("a split is two or more methods that took money; store credit is not one", () => {
    expect(isSplitTender([{ method: "CARD" }, { method: "CASH" }])).toBe(true);
    expect(isSplitTender([{ method: "CASH" }, { method: "STORE_CREDIT" }])).toBe(false);
    expect(isSplitTender([{ method: "CASH" }])).toBe(false);
    expect(isSplitTender([])).toBe(false);
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
    const a = newSplitRows();
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

  it("the brief's inline lines are exact", () => {
    expect(SPLIT_PROBLEM_COPY.COUNTER_DUPLICATE_CASH_LEG).toBe("Only one cash payment per sale.");
    expect(SPLIT_PROBLEM_COPY.COUNTER_PAYMENT_EXCEEDS_TOTAL).toBe(
      "Card and check can't be more than the total.",
    );
    expect(SPLIT_PROBLEM_COPY.COUNTER_LEG_NOT_CENTS).toBe("Enter the amount in dollars and cents.");
    expect(SPLIT_PROBLEM_COPY.COUNTER_TOO_MANY_LEGS).toBe("Up to 4 payments per sale.");
    expect(SPLIT_PROBLEM_COPY.COUNTER_TENDER_CHANGED).toBe(
      "This sale was already paid a different way. Check recent sales.",
    );
  });

  it("the post-commit over-cover line is the one the brief fixed", () => {
    expect(COUNTER_BALANCE_CHANGED_COPY).toBe("The balance changed — take the payment again");
  });
});
