/**
 * POS mode (SA-763r P-2) pure logic: preference seeding, the progress steps, the per-state action
 * selection (one primary per state), and the fixed copy the brief pins.
 */
import {
  POS_COPY,
  POS_MODE_PREF_KEY,
  pickupCompleteErrorCopy,
  decidePickupResponse,
  pendingRefusalIsDone,
  planPosTender,
  posConfirmStepsAfterPending,
  posHandOverBalance,
  posConfirmSteps,
  posMergeAlert,
  posMayHandOverUnpaid,
  posBalanceDue,
  posCanSwitchToDelivery,
  posSwitchToDeliveryHint,
  posCartSaveLabel,
  posCutNote,
  posFinishFailureMessage,
  posFinishSuccessMessage,
  posLiveInvoices,
  posMergePrompt,
  posModeFromPreferences,
  posModePrefPatch,
  posOrderActions,
  posProgressSteps,
  posStatusBody,
} from "../lib/pos-mode";

const inv = (status: string, id = "i1") => ({ id, status });
const keys = (a: { key: string }[]) => a.map((x) => x.key);

describe("POS preference", () => {
  it("is keyed orders.posMode; unset and anything but 'true' is off", () => {
    expect(POS_MODE_PREF_KEY).toBe("orders.posMode");
    expect(posModeFromPreferences(undefined)).toBe(false);
    expect(posModeFromPreferences({})).toBe(false);
    expect(posModeFromPreferences({ "orders.posMode": "false" })).toBe(false);
    expect(posModeFromPreferences({ "orders.posMode": "true" })).toBe(true);
  });
  it("PATCHes the string form", () => {
    expect(posModePrefPatch(true)).toEqual({ "orders.posMode": "true" });
    expect(posModePrefPatch(false)).toEqual({ "orders.posMode": "false" });
  });
});

describe("posOrderActions", () => {
  it("PENDING: only Switch to delivery (Confirm lives in the status bar)", () => {
    expect(keys(posOrderActions({ invoices: [] }, "PENDING"))).toEqual(["switchToDelivery"]);
  });
  it("CONFIRMED without an invoice: Create invoice is the one primary, Hand over secondary", () => {
    const a = posOrderActions({ invoices: [] }, "CONFIRMED");
    expect(keys(a)).toEqual(["createInvoice", "handOver", "readyForPickup", "switchToDelivery"]);
    expect(a.filter((x) => x.tier === "primary").map((x) => x.key)).toEqual(["createInvoice"]);
  });
  it("CONFIRMED with an invoice: Hand over is the one primary; Ready for pickup stays secondary", () => {
    const a = posOrderActions({ invoices: [inv("DRAFT")] }, "CONFIRMED");
    expect(keys(a)).toEqual(["handOver", "readyForPickup", "switchToDelivery"]);
    expect(a.filter((x) => x.tier === "primary").map((x) => x.key)).toEqual(["handOver"]);
    expect(a.find((x) => x.key === "readyForPickup")?.tier).toBe("secondary");
  });
  it("a VOID invoice does not count: Create invoice is still offered", () => {
    expect(keys(posOrderActions({ invoices: [inv("VOID")] }, "CONFIRMED"))[0]).toBe(
      "createInvoice",
    );
  });
  it("once Ready for pickup (OUT_FOR_DELIVERY) the notification is not offered again", () => {
    const a = posOrderActions({ invoices: [inv("DRAFT")] }, "OUT_FOR_DELIVERY");
    // The server refuses a fulfil-path change once OUT_FOR_DELIVERY, so it is not offered either.
    expect(keys(a)).toEqual(["handOver"]);
  });
  it("DELIVERED: Record payment until every live invoice is PAID, then Print", () => {
    const due = posOrderActions({ invoices: [inv("SENT", "a"), inv("PAID", "b")] }, "DELIVERED");
    expect(due).toEqual([
      { key: "recordPayment", label: POS_COPY.recordPayment, tier: "primary", invoiceId: "a" },
    ]);
    const paid = posOrderActions({ invoices: [inv("PAID", "a"), inv("VOID", "b")] }, "DELIVERED");
    expect(paid[0]).toMatchObject({ key: "printInvoice", invoiceId: "a" });
    expect(posOrderActions({ invoices: [] }, "DELIVERED")).toEqual([]);
  });
  it("offers no DELIVERED / Out-for-delivery status action by any key", () => {
    for (const st of ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      expect(keys(posOrderActions({ invoices: [inv("SENT")] }, st))).not.toContain("markDelivered");
    }
  });
  it("Switch to delivery only while the order is open (mirrors order-lifecycle's blocked set)", () => {
    expect(posCanSwitchToDelivery("PENDING")).toBe(true);
    expect(posCanSwitchToDelivery("CONFIRMED")).toBe(true);
    expect(posCanSwitchToDelivery("OUT_FOR_DELIVERY")).toBe(false);
    expect(posCanSwitchToDelivery("DELIVERED")).toBe(false);
    expect(posCanSwitchToDelivery("CANCELLED")).toBe(false);
  });
});

describe("posProgressSteps", () => {
  const done = (o: { invoices?: { id: string; status: string }[] }, st: string) =>
    posProgressSteps(o, st).map((s) => s.done);
  it("is Confirmed -> Invoice (draft) -> Handed over with no delivery step", () => {
    const steps = posProgressSteps({ invoices: [] }, "CONFIRMED");
    expect(steps.map((s) => s.label)).toEqual(["Confirmed", "Invoice (draft)", "Handed over"]);
    expect(done({ invoices: [] }, "CONFIRMED")).toEqual([true, false, false]);
  });
  it("the invoice reads '(draft)' until every live invoice is issued", () => {
    expect(posProgressSteps({ invoices: [inv("DRAFT")] }, "CONFIRMED")[1]).toMatchObject({
      label: "Invoice (draft)",
      done: true,
    });
    expect(posProgressSteps({ invoices: [inv("SENT")] }, "CONFIRMED")[1].label).toBe("Invoice");
  });
  it("DELIVERED completes the third step; PENDING completes none", () => {
    expect(done({ invoices: [inv("SENT")] }, "DELIVERED")).toEqual([true, true, true]);
    expect(done({ invoices: [] }, "PENDING")).toEqual([false, false, false]);
  });
  it("ignores VOID invoices", () => {
    expect(posLiveInvoices({ invoices: [inv("VOID")] })).toEqual([]);
    expect(done({ invoices: [inv("VOID")] }, "CONFIRMED")[1]).toBe(false);
  });
});

describe("copy and half-failure messaging", () => {
  it("names the missing half of Confirm & invoice", () => {
    expect(posFinishFailureMessage("confirm")).toBe(
      "Order created, but it couldn't be confirmed. Open it to confirm.",
    );
    expect(posFinishFailureMessage("invoice")).toBe(
      "Order confirmed, but the invoice wasn't created. Open it and choose Create invoice.",
    );
    expect(posFinishSuccessMessage(true)).toBe("Order confirmed and invoiced");
    expect(posFinishSuccessMessage(false)).toBe("Order confirmed");
  });
  it("MERGE_CHOICE_REQUIRED copy; a backdated order cannot be added to", () => {
    expect(posMergePrompt(false)).toMatchObject({
      title: "This customer already has an open counter order",
      addLabel: "Add to it",
      newLabel: "Start a new one",
    });
    expect(posMergePrompt(true).message).toMatch(/backdated order has to be created separately/);
  });
  it("the cut-after-hand-over note shows only on a handed-over POS order", () => {
    const note =
      "Cutting items after hand-over doesn't put them back on the shelf. If the goods came back, record a return.";
    expect(posCutNote({ fulfillPath: "PICKUP", counterSale: false }, "DELIVERED")).toBe(note);
    expect(posCutNote({ fulfillPath: "PICKUP", counterSale: false }, "CONFIRMED")).toBeNull();
    expect(posCutNote({ fulfillPath: "PICKUP", counterSale: true }, "DELIVERED")).toBeNull();
    expect(posCutNote({ fulfillPath: "ROUTE" }, "DELIVERED")).toBeNull();
  });
});

describe("hand-over tender and fixed error copy", () => {
  const base = {
    skip: false,
    method: "CASH" as const,
    amountRaw: "",
    reference: "",
    balanceDue: 42.5,
  };
  it("a blank amount is the exact balance; the body is a payment", () => {
    expect(planPosTender({ ...base, isWalkIn: false })).toEqual({
      ok: true,
      body: { payment: { method: "CASH", amount: 42.5 } },
    });
  });
  it("a named customer may skip the tender (empty body); a walk-in may not", () => {
    expect(planPosTender({ ...base, isWalkIn: false, skip: true })).toEqual({ ok: true, body: {} });
    expect(planPosTender({ ...base, isWalkIn: true, skip: true })).toEqual({
      ok: false,
      problem: "TENDER_REQUIRED",
    });
  });
  it("a check needs its number; amount must be positive", () => {
    expect(planPosTender({ ...base, isWalkIn: true, method: "CHECK" })).toEqual({
      ok: false,
      problem: "CHECK_NUMBER",
    });
    // card / check send no amount (cash only), like web
    expect(
      planPosTender({ ...base, isWalkIn: true, method: "CHECK", reference: " 1042 " }),
    ).toEqual({ ok: true, body: { payment: { method: "CHECK", reference: "1042" } } });
    expect(planPosTender({ ...base, isWalkIn: true, method: "CARD" })).toEqual({
      ok: true,
      body: { payment: { method: "CARD" } },
    });
    expect(planPosTender({ ...base, isWalkIn: false, amountRaw: "0" })).toEqual({
      ok: false,
      problem: "AMOUNT",
    });
    expect(planPosTender({ ...base, isWalkIn: false, amountRaw: "abc" })).toMatchObject({
      ok: false,
    });
  });
  it("the balance sums live invoices (minus payments) and falls back to the total", () => {
    expect(posBalanceDue(10, [])).toBe(10);
    expect(
      posBalanceDue(99, [
        { status: "SENT", total: 30, balanceDue: 20 },
        { status: "DRAFT", total: 5, balanceDue: 5 },
        { status: "VOID", total: 100 },
      ]),
    ).toBe(25);
  });
  it("maps error codes to fixed copy and never to server text", () => {
    const e = (code: string) => ({ response: { data: { code, message: "SERVER TEXT" } } });
    expect(pickupCompleteErrorCopy(e("PICKUP_NOT_READY"))).toMatch(/isn't ready for pickup/);
    expect(pickupCompleteErrorCopy(e("WALK_IN_NO_ACCOUNT"))).toMatch(/walk-in customer can't/);
    expect(pickupCompleteErrorCopy(e("COUNTER_TENDER_SHORT"))).toBe(
      "A walk-in customer must pay the full balance.",
    );
    const generic = pickupCompleteErrorCopy(e("SOMETHING_ELSE"));
    expect(generic).toMatch(/Couldn't complete the pickup/);
    expect(generic).not.toMatch(/SERVER TEXT/);
    expect(pickupCompleteErrorCopy(new Error("boom"))).toBe(generic);
  });
  it("the cart sheet primary says Confirm & invoice in POS mode", () => {
    expect(posCartSaveLabel(true, false)).toBe("Confirm & invoice");
    expect(posCartSaveLabel(false, false)).toBe("Save order");
    expect(posCartSaveLabel(true, true)).toBe("Saving…");
  });
});

describe("no-payment hand-over needs a known-named customer", () => {
  it("only isWalkIn === false may hand over unpaid (true / null / undefined may not)", () => {
    expect(posMayHandOverUnpaid(false)).toBe(true);
    expect(posMayHandOverUnpaid(true)).toBe(false);
    expect(posMayHandOverUnpaid(null)).toBe(false);
    expect(posMayHandOverUnpaid(undefined)).toBe(false);
  });
  it("planPosTender refuses skip while the customer is unknown", () => {
    const base = {
      skip: true,
      method: "CASH" as const,
      amountRaw: "",
      reference: "",
      balanceDue: 5,
    };
    expect(planPosTender({ ...base, isWalkIn: undefined })).toEqual({
      ok: false,
      problem: "TENDER_REQUIRED",
    });
    expect(planPosTender({ ...base, isWalkIn: false })).toEqual({ ok: true, body: {} });
  });
  it("maps a 400 WALK_IN_NO_ACCOUNT to fixed copy", () => {
    expect(
      pickupCompleteErrorCopy({
        response: { status: 400, data: { code: "WALK_IN_NO_ACCOUNT", message: "x" } },
      }),
    ).toMatch(/can't be charged on account/);
  });
});

describe("pickup-complete 200 response decision (money)", () => {
  const res = (over: Record<string, unknown>) =>
    ({
      orderId: "o",
      orderNumber: "1",
      invoiceId: "i",
      invoiceNumber: "I-1",
      total: 40,
      paid: 0,
      balanceDue: 40,
      paymentRecorded: true,
      ...over,
    }) as never;

  it("a recorded payment (or none requested) is done and releases the Idempotency-Key", () => {
    expect(decidePickupResponse(res({ paid: 40, balanceDue: 0 }))).toMatchObject({
      kind: "done",
      releaseKey: true,
      message: "Handed over",
    });
  });
  it("PICKUP_PAYMENT_REQUIRED on a 200 returns to the tender step, SAME key, owing balanceDue", () => {
    expect(
      decidePickupResponse(
        res({ paymentRecorded: false, paymentErrorCode: "PICKUP_PAYMENT_REQUIRED" }),
      ),
    ).toEqual({
      kind: "retry-tender",
      releaseKey: false,
      owed: 40,
      message: "A balance is due on this order now. Take payment to finish.",
    });
  });
  it("COUNTER_TENDER_SHORT on a 200 is the same retry, with the walk-in copy", () => {
    const d = decidePickupResponse(
      res({ paymentRecorded: false, paymentErrorCode: "COUNTER_TENDER_SHORT", balanceDue: 12.5 }),
    );
    expect(d).toMatchObject({ kind: "retry-tender", releaseKey: false, owed: 12.5 });
    expect((d as { message: string }).message).toBe(
      "A walk-in customer must pay the full balance.",
    );
  });
  it("any other unrecorded payment is done (hand-over committed) but says so, and releases the key", () => {
    const d = decidePickupResponse(res({ paymentRecorded: false, paymentErrorCode: "SOMETHING" }));
    expect(d).toMatchObject({ kind: "done", releaseKey: true });
    expect((d as { message: string }).message).toMatch(/payment wasn't recorded/);
  });
});

describe("POS merge alert buttons", () => {
  const labels = (b: boolean) => posMergeAlert(b, () => {}).buttons.map((x) => x.label);
  it("offers Add to it only when not backdated", () => {
    expect(labels(false)).toEqual(["Cancel", "Add to it", "Start a new one"]);
    expect(labels(true)).toEqual(["Cancel", "Start a new one"]);
  });
});

describe("Confirm & invoice from a merged DRAFT (row 311)", () => {
  it("a DRAFT target is promoted to PENDING first; others go straight to CONFIRMED", () => {
    expect(posConfirmSteps("DRAFT")).toEqual(["PENDING", "CONFIRMED"]);
    expect(posConfirmSteps("PENDING")).toEqual(["CONFIRMED"]);
    expect(posConfirmSteps(undefined)).toEqual(["CONFIRMED"]);
    expect(posConfirmSteps(null)).toEqual(["CONFIRMED"]);
  });
  it("a refused PENDING step is done only on a 400/409 whose re-read shows PENDING or CONFIRMED", () => {
    expect(pendingRefusalIsDone(400, "PENDING")).toBe(true);
    expect(pendingRefusalIsDone(409, "CONFIRMED")).toBe(true);
    expect(pendingRefusalIsDone(400, "DRAFT")).toBe(false);
    expect(pendingRefusalIsDone(400, undefined)).toBe(false);
    expect(pendingRefusalIsDone(500, "PENDING")).toBe(false);
    expect(pendingRefusalIsDone(undefined, "PENDING")).toBe(false);
  });
  it("merged half-failure copy is specific", () => {
    expect(posFinishFailureMessage("confirm", true)).toBe(
      "Order merged, but it couldn't be confirmed. Open it to confirm.",
    );
    expect(posFinishFailureMessage("confirm", false)).toMatch(/Order created/);
    expect(posFinishFailureMessage("invoice", true)).toMatch(/invoice wasn't created/);
  });
});

describe("hand-over balance, change and zero-owed", () => {
  it("a $100 invoice with a $40 deposit owes $60 (server balanceDue per invoice)", () => {
    expect(posBalanceDue(100, [{ status: "SENT", total: 100, balanceDue: 60 }])).toBe(60);
  });
  it("only live invoices count; a VOID or WRITTEN_OFF one does not", () => {
    expect(
      posBalanceDue(100, [
        { status: "SENT", total: 100, balanceDue: 60.005 },
        { status: "VOID", total: 100, balanceDue: 100 },
        { status: "WRITTEN_OFF", total: 50, balanceDue: 50 },
      ]),
    ).toBe(60.01);
  });
  it("nothing owed needs no tender, even for a walk-in", () => {
    const base = { method: "CASH" as const, amountRaw: "", reference: "" };
    expect(planPosTender({ ...base, isWalkIn: true, skip: false, balanceDue: 0 })).toEqual({
      ok: true,
      body: {},
    });
    expect(planPosTender({ ...base, isWalkIn: true, skip: true, balanceDue: 0 })).toEqual({
      ok: true,
      body: {},
    });
  });
  it("cash change is shown on the done message; absent or zero change adds nothing", () => {
    const r = (over: Record<string, unknown>) =>
      ({ paymentRecorded: true, balanceDue: 0, ...over }) as never;
    expect(decidePickupResponse(r({ change: 3.5 })).message).toBe("Handed over. Change $3.50");
    expect(decidePickupResponse(r({ change: 0 })).message).toBe("Handed over");
    expect(decidePickupResponse(r({})).message).toBe("Handed over");
  });
  it("Record payment / Print pick the first unpaid live invoice, else the first live one", () => {
    const a = posOrderActions(
      { invoices: [inv("PAID", "p"), inv("VOID", "v"), inv("SENT", "u"), inv("PARTIAL", "w")] },
      "DELIVERED",
    );
    expect(a[0]).toMatchObject({ key: "recordPayment", invoiceId: "u" });
    const paid = posOrderActions({ invoices: [inv("VOID", "v"), inv("PAID", "p")] }, "DELIVERED");
    expect(paid[0]).toMatchObject({ key: "printInvoice", invoiceId: "p" });
  });
});

describe("posHandOverBalance (never the gross total when the balances are not known)", () => {
  const live = [{ id: "a", status: "SENT" }];
  const q = (over: Record<string, unknown>) => ({
    orderTotal: 100,
    orderInvoices: live,
    owedOverride: null,
    isFetching: false,
    isError: false,
    details: undefined as { status: string; total: number; balanceDue?: number }[] | undefined,
    ...over,
  });
  it("loading: no amount", () => {
    expect(posHandOverBalance(q({ isFetching: true }))).toEqual({ state: "loading" });
    expect(posHandOverBalance(q({}))).toEqual({ state: "loading" });
  });
  it("error: no amount and no gross fallback", () => {
    expect(posHandOverBalance(q({ isError: true }))).toEqual({ state: "error" });
    expect(posHandOverBalance(q({ isError: true, details: [] }))).toEqual({ state: "error" });
  });
  it("ready: the sum of server balanceDue (deposit case)", () => {
    expect(
      posHandOverBalance(q({ details: [{ status: "SENT", total: 100, balanceDue: 60 }] })),
    ).toEqual({ state: "ready", amount: 60 });
  });
  it("refetching a cached read is loading again", () => {
    expect(
      posHandOverBalance(
        q({ isFetching: true, details: [{ status: "SENT", total: 100, balanceDue: 60 }] }),
      ),
    ).toEqual({ state: "loading" });
  });
  it("a detail with no balanceDue is unknown, not gross", () => {
    expect(posHandOverBalance(q({ details: [{ status: "SENT", total: 100 }] }))).toEqual({
      state: "error",
    });
  });
  it("no live invoice yet: the order total; the server's owed override wins", () => {
    expect(posHandOverBalance(q({ orderInvoices: [] }))).toEqual({ state: "ready", amount: 100 });
    expect(posHandOverBalance(q({ owedOverride: 25, isError: true }))).toEqual({
      state: "ready",
      amount: 25,
    });
  });
  it("every invoice written off owes nothing (not the gross total)", () => {
    expect(
      posHandOverBalance(
        q({
          orderInvoices: [{ id: "a", status: "WRITTEN_OFF" }],
          details: [{ status: "WRITTEN_OFF", total: 100, balanceDue: 100 }],
        }),
      ),
    ).toEqual({ state: "ready", amount: 0 });
  });
});

describe("misc money-safety", () => {
  it("Record payment never targets a WRITTEN_OFF invoice", () => {
    const a = posOrderActions(
      { invoices: [inv("WRITTEN_OFF", "w"), inv("SENT", "u")] },
      "DELIVERED",
    );
    expect(a[0]).toMatchObject({ key: "recordPayment", invoiceId: "u" });
    expect(posOrderActions({ invoices: [inv("WRITTEN_OFF", "w")] }, "DELIVERED")).toEqual([]);
  });
  it("a re-read of CONFIRMED after a refused PENDING skips the CONFIRMED patch", () => {
    expect(posConfirmStepsAfterPending("CONFIRMED")).toEqual([]);
    expect(posConfirmStepsAfterPending("PENDING")).toEqual(["CONFIRMED"]);
  });
});

describe("posStatusBody (row 510)", () => {
  const ack = {
    restrictionOverrides: [{ lineKey: "l:i1", reason: "Owner approved" }],
    warningHash: "rw1:abc",
  };
  it("is the bare status when there is no acknowledgement (a plain finish is unchanged)", () => {
    expect(posStatusBody("CONFIRMED")).toEqual({ status: "CONFIRMED" });
    expect(posStatusBody("PENDING", undefined)).toEqual({ status: "PENDING" });
  });
  it("carries the overrides and the hash as top-level fields, for each of the two steps", () => {
    expect(posStatusBody("PENDING", ack)).toEqual({ status: "PENDING", ...ack });
    expect(posStatusBody("CONFIRMED", ack)).toEqual({ status: "CONFIRMED", ...ack });
  });
});

describe("M6 posSwitchToDeliveryHint", () => {
  it("explains the lock only on a Ready-for-pickup order", () => {
    expect(posSwitchToDeliveryHint("OUT_FOR_DELIVERY")).toMatch(/back to Confirmed/);
    for (const s of ["PENDING", "CONFIRMED", "DELIVERED", "CANCELLED"]) {
      expect(posSwitchToDeliveryHint(s)).toBeNull();
    }
  });
});
