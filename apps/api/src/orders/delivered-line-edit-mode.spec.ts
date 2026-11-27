import {
  deliveredLineEditMode,
  isLegacyStruckDelivered,
  lineEditFields,
  NO_ORDER_FACTS,
  type DeliveredLineFacts,
} from "./delivered-line-edit-mode";

/**
 * SA-1506 PR-1a (Amendment 1, C1): one test per decision, so a later ruling flips ONE reason by changing the decider
 * and its test, never a guard. Case order is first-hit-wins; each LOCKED reason has its own case below.
 */
const line = { id: "L1", status: "PENDING", deliveredQty: 10, unitLabel: null };
const facts = (over: Partial<DeliveredLineFacts> = {}): DeliveredLineFacts => ({
  role: "TENANT_ADMIN",
  hasTenant: true,
  orderStatus: "CONFIRMED",
  onRun: false,
  stopCompleted: false,
  routeRunLinked: false,
  orderRouteRows: false,
  routeLineIds: new Set(),
  officeLineIds: new Set(["L1"]),
  liveReturn: false,
  partlyInvoiced: false,
  writtenOffInvoiceNumber: null,
  shipmentBilled: false,
  ...over,
});

describe("deliveredLineEditMode", () => {
  it("1: a line that was never delivered is EDIT", () => {
    expect(deliveredLineEditMode({ id: "L1", deliveredQty: 0 }, facts())).toEqual({ mode: "EDIT" });
  });

  it("1: a struck-off delivered line is EDIT (legacy rules keep it)", () => {
    const struck = { id: "L1", status: "CANCELLED", deliveredQty: 4 };
    expect(deliveredLineEditMode(struck, facts())).toEqual({ mode: "EDIT" });
    expect(isLegacyStruckDelivered(struck)).toBe(true);
    expect(isLegacyStruckDelivered(line)).toBe(false);
  });

  it("2: a unit line is LOCKED UNIT, before any fact is read", () => {
    expect(deliveredLineEditMode({ ...line, unitLabel: "case" }, NO_ORDER_FACTS)).toMatchObject({
      mode: "LOCKED",
      reason: "UNIT",
    });
  });

  it("3: an operator is LOCKED ROLE, told who can correct when an admin could", () => {
    expect(deliveredLineEditMode(line, facts({ role: "OPERATOR" }))).toEqual({
      mode: "LOCKED",
      reason: "ROLE",
      operatorNote: true,
    });
  });

  it("3: an operator gets no admin note when an admin could not correct either", () => {
    expect(deliveredLineEditMode(line, facts({ role: "OPERATOR", liveReturn: true }))).toEqual({
      mode: "LOCKED",
      reason: "ROLE",
      operatorNote: false,
    });
  });

  it("3: a driver, a buyer and a tenantless super admin are LOCKED ROLE with no note", () => {
    for (const role of ["DRIVER", "BUYER", "SUPER_ADMIN"])
      expect(deliveredLineEditMode(line, facts({ role }))).toMatchObject({
        reason: "ROLE",
        operatorNote: false,
      });
    expect(deliveredLineEditMode(line, facts({ hasTenant: false }))).toMatchObject({
      reason: "ROLE",
    });
  });

  it("4: a DELIVERED order is LOCKED REOPEN_FIRST", () => {
    expect(deliveredLineEditMode(line, facts({ orderStatus: "DELIVERED" }))).toMatchObject({
      mode: "LOCKED",
      reason: "REOPEN_FIRST",
    });
  });

  it("4: every other status outside CONFIRMED / PARTIALLY_DELIVERED is LOCKED STATUS, carrying the status", () => {
    for (const orderStatus of ["DRAFT", "PENDING", "OUT_FOR_DELIVERY", "REFUSED", "CANCELLED"])
      expect(deliveredLineEditMode(line, facts({ orderStatus }))).toEqual({
        mode: "LOCKED",
        reason: "STATUS",
        status: orderStatus,
      });
  });

  it("5: ON_RUN, the order is linked to a stop that is not COMPLETED (every delivered line)", () => {
    expect(deliveredLineEditMode(line, facts({ onRun: true }))).toMatchObject({
      mode: "LOCKED",
      reason: "ON_RUN",
    });
    expect(
      deliveredLineEditMode(line, facts({ onRun: true, officeLineIds: new Set() })),
    ).toMatchObject({ reason: "ON_RUN" });
  });

  it("6: ROUTE, a driver or stop recorded the delivery of the line (also a line delivered in full)", () => {
    expect(deliveredLineEditMode(line, facts({ routeLineIds: new Set(["L1"]) }))).toMatchObject({
      mode: "LOCKED",
      reason: "ROUTE",
    });
  });

  it("6: ROUTE wins over an office row on the same line", () => {
    expect(
      deliveredLineEditMode(
        line,
        facts({ routeLineIds: new Set(["L1"]), officeLineIds: new Set(["L1"]) }),
      ),
    ).toMatchObject({ reason: "ROUTE" });
  });

  it("6: a COMPLETED stop makes a line ROUTE, with rows or without (SA-1533 M-3: zero rows no longer wins)", () => {
    expect(deliveredLineEditMode(line, facts({ stopCompleted: true }))).toMatchObject({
      reason: "ROUTE",
    });
    expect(
      deliveredLineEditMode(line, facts({ officeLineIds: new Set(), stopCompleted: true })),
    ).toMatchObject({ mode: "LOCKED", reason: "ROUTE" });
  });

  it("6: an order whose stop link was released but whose run link remains is ROUTE for a line with no rows", () => {
    expect(
      deliveredLineEditMode(line, facts({ officeLineIds: new Set(), routeRunLinked: true })),
    ).toMatchObject({ mode: "LOCKED", reason: "ROUTE" });
  });

  it("6 (SA-1536 z): a driver or stop row on a SIBLING line locks a no-row line ROUTE, links or no links", () => {
    expect(
      deliveredLineEditMode(line, facts({ officeLineIds: new Set(), orderRouteRows: true })),
    ).toMatchObject({ mode: "LOCKED", reason: "ROUTE" });
  });

  it("6/11: an order never on a run, a line with no rows: CORRECT NONE (A2 NEW-M2 stays for office orders)", () => {
    expect(deliveredLineEditMode(line, facts({ officeLineIds: new Set() }))).toEqual({
      mode: "CORRECT",
      basis: "NONE",
    });
  });

  it("7: RETURN, a live return stands on the order", () => {
    expect(deliveredLineEditMode(line, facts({ liveReturn: true }))).toMatchObject({
      mode: "LOCKED",
      reason: "RETURN",
    });
  });

  it("8: SPLIT_BILL, some lines billed and some not", () => {
    expect(deliveredLineEditMode(line, facts({ partlyInvoiced: true }))).toMatchObject({
      mode: "LOCKED",
      reason: "SPLIT_BILL",
    });
  });

  it("9: WRITTEN_OFF carries the invoice number the copy names", () => {
    expect(deliveredLineEditMode(line, facts({ writtenOffInvoiceNumber: "INV-7" }))).toMatchObject({
      mode: "LOCKED",
      reason: "WRITTEN_OFF",
      invoiceNumber: "INV-7",
    });
  });

  it("10: SHIPMENT_BILLED, a bills-at-shipment order the carrier holds", () => {
    expect(deliveredLineEditMode(line, facts({ shipmentBilled: true }))).toMatchObject({
      mode: "LOCKED",
      reason: "SHIPMENT_BILLED",
    });
  });

  it("11: an admin on CONFIRMED or PARTIALLY_DELIVERED with an office row is CORRECT, basis OFFICE", () => {
    for (const orderStatus of ["CONFIRMED", "PARTIALLY_DELIVERED"])
      expect(deliveredLineEditMode(line, facts({ orderStatus }))).toEqual({
        mode: "CORRECT",
        basis: "OFFICE",
      });
  });

  it("first hit wins: reopen-first outranks every later reason", () => {
    expect(
      deliveredLineEditMode(
        line,
        facts({ orderStatus: "DELIVERED", liveReturn: true, partlyInvoiced: true }),
      ),
    ).toMatchObject({ reason: "REOPEN_FIRST" });
  });

  it("ROUTE and RETURN are separate named reasons (PR-1c flips each here); ON_RUN and STATUS stay", () => {
    const variants: Array<[Partial<DeliveredLineFacts>, string]> = [
      [{ routeLineIds: new Set(["L1"]) }, "ROUTE"],
      [{ liveReturn: true }, "RETURN"],
      [{ onRun: true }, "ON_RUN"],
    ];
    for (const [v, reason] of variants)
      expect(deliveredLineEditMode(line, facts(v))).toMatchObject({ mode: "LOCKED", reason });
  });

  it("lineEditFields: the wire fields of each decision (PR-1a: min 0, price not locked, no reason asked)", () => {
    expect(lineEditFields({ mode: "CORRECT", basis: "OFFICE" })).toEqual({
      lineEditMode: "CORRECT",
      lockedReason: null,
      correctionBasis: "OFFICE",
      correctMinQty: 0,
      priceLocked: false,
      needsReason: false,
    });
    expect(lineEditFields({ mode: "LOCKED", reason: "STATUS", status: "PENDING" })).toMatchObject({
      lineEditMode: "LOCKED",
      lockedReason: "STATUS",
      correctionBasis: "NONE",
      lockedStatus: "PENDING",
    });
    expect(lineEditFields({ mode: "EDIT" })).toMatchObject({
      lineEditMode: "EDIT",
      lockedReason: null,
    });
  });
});
