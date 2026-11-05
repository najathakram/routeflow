import {
  DEMOTE_HAS_RETURN_COPY,
  bulkDeleteResultTitle,
  demoteErrorText,
  isDemoteHasReturnRefusal,
  isDemoteRefusal,
  orderErrorText,
} from "./order-error-text";
import { genericToastCopy } from "./generic-toast-copy";

const axiosErr = (
  status: number,
  data: unknown,
  message = `Request failed with status code ${status}`,
) => Object.assign(new Error(message), { response: { status, data } });

describe("orderErrorText (B986-7 Opus fold): coded -> fixed copy, uncoded -> the server's own sentence, never axios text", () => {
  it("an UNCODED 409 shows the server's actionable sentence, not 'Request failed with status code 409'", () => {
    const sentence =
      "This order's invoice has recorded payments. Void the payments or the invoice first, then delete the order.";
    const text = orderErrorText(axiosErr(409, { statusCode: 409, message: sentence }));
    expect(text).toBe(sentence);
    expect(text).not.toMatch(/status code/i);
  });

  it("a coded refusal shows the fixed mapped sentence, never the server message", () => {
    const text = orderErrorText(
      axiosErr(409, { code: "ORDER_BELOW_RETURN_CREDIT", message: "server wording" }),
    );
    expect(text).not.toBe("server wording");
    expect(text.length).toBeGreaterThan(0);
  });

  it("no server sentence (no response / array body) falls to the fixed generic copy, never axios text", () => {
    expect(orderErrorText(axiosErr(500, {}))).not.toMatch(/status code/i);
    expect(orderErrorText(axiosErr(400, { message: ["a must be a string"] }))).not.toMatch(
      /status code|must be a string/i,
    );
    expect(orderErrorText(new Error("Network Error"))).not.toBe("Network Error");
  });

  it('a 5xx never shows the server message ("Internal server error" and the like): fixed generic copy', () => {
    for (const message of ["Internal server error", "Cannot read properties of undefined"]) {
      const text = orderErrorText(axiosErr(500, { statusCode: 500, message }));
      expect(text).not.toContain(message);
      expect(text).toMatch(/our side|try again/i);
    }
    expect(orderErrorText(axiosErr(503, { message: "Service Unavailable" }))).not.toContain(
      "Service Unavailable",
    );
  });

  it('a 403 never shows "Forbidden resource": the permission copy, or the coded copy when a code is present', () => {
    const text = orderErrorText(axiosErr(403, { statusCode: 403, message: "Forbidden resource" }));
    expect(text).not.toContain("Forbidden resource");
    expect(text).toMatch(/permission/i);
    const coded = orderErrorText(
      axiosErr(403, { code: "READ_ONLY", message: "Forbidden resource" }),
    );
    expect(coded).not.toContain("Forbidden resource");
    expect(coded).toMatch(/read-only/i);
  });

  it("the server sentence passes through for 400, 404, 409 and 422 only", () => {
    for (const status of [400, 404, 409, 422]) {
      expect(orderErrorText(axiosErr(status, { message: "Void the invoice first." }))).toBe(
        "Void the invoice first.",
      );
    }
    for (const status of [401, 403, 429, 500, 502]) {
      expect(orderErrorText(axiosErr(status, { message: "Void the invoice first." }))).not.toBe(
        "Void the invoice first.",
      );
    }
  });
});

describe("row 585: deleting an order that has delivered items", () => {
  it("a delete refused with ORDER_DELETE_HAS_DELIVERED shows the fixed sentence, not the server text", () => {
    const text = orderErrorText(
      axiosErr(409, { code: "ORDER_DELETE_HAS_DELIVERED", message: "server wording" }),
    );
    expect(text).toBe(
      "This order has delivered items, so it cannot be deleted. Record a return for the delivered goods instead.",
    );
  });

  it("the bulk-delete toast counts both sides and names no single cause", () => {
    const title = bulkDeleteResultTitle(2, 1);
    expect(title).toContain("2 deleted, 1 kept");
    expect(title).toMatch(/delivered items/);
    expect(title).toMatch(/recorded payments/);
  });
});

describe("demoteErrorText (SA-1101 A-5): a blocked Reopen order / demotion reads its own sentence", () => {
  const live = axiosErr(409, { code: "ORDER_HAS_RETURN", message: "server wording" });

  it("409 ORDER_HAS_RETURN is the A-5 sentence, fixed here (never the server message)", () => {
    expect(demoteErrorText(live)).toBe(
      "This order has a return. To change its delivery status, cancel the return first.",
    );
    expect(demoteErrorText(live)).toBe(DEMOTE_HAS_RETURN_COPY);
  });

  it("is not the Deliver-again sentence the generic toast keeps for the same code", () => {
    expect(genericToastCopy(live)).toMatch(/deliver it again/);
    expect(demoteErrorText(live)).not.toMatch(/deliver it again/);
  });

  it("owns only that refusal: another code, another status, or no response is null", () => {
    expect(isDemoteHasReturnRefusal(live)).toBe(true);
    expect(demoteErrorText(axiosErr(409, { code: "ORDER_CHANGED_DURING_EDIT" }))).toBeNull();
    expect(demoteErrorText(axiosErr(400, { code: "ORDER_HAS_RETURN" }))).toBeNull();
    expect(demoteErrorText(new Error("Network Error"))).toBeNull();
    expect(isDemoteHasReturnRefusal(null)).toBe(false);
  });
});

describe("demoteErrorText (B1280): the other two Reopen order refusals read their own sentence", () => {
  const live = axiosErr(409, { code: "ORDER_HAS_RETURN", message: "server wording" });
  const paidWalkIn = axiosErr(409, {
    code: "WALK_IN_SALE_PAID",
    message:
      "This sale is paid. Ring up added items as a new sale, or use Return to take items back.",
  });
  const onRun = axiosErr(409, {
    code: "ORDER_ROUTE_STOP_COMPLETED",
    message: "This order was delivered on a route run. Reopen its stop from the run instead.",
  });

  it("a paid walk-in sale says it is closed, not 'ring up added items' (that is the edit sentence)", () => {
    expect(demoteErrorText(paidWalkIn)).toBe(
      "This counter sale is paid, so it can't be reopened. To take items back, use Return.",
    );
  });

  it("an order delivered on a route run points to the stop, and says what that does", () => {
    expect(demoteErrorText(onRun)).toBe(
      "This order was delivered on a route run. Reopen its stop from the run, which also reverses stock and payments.",
    );
  });

  it("every Reopen refusal is local to the page (one toast, not also the global one)", () => {
    for (const e of [live, paidWalkIn, onRun]) expect(isDemoteRefusal(e)).toBe(true);
    expect(isDemoteRefusal(axiosErr(409, { code: "ORDER_CHANGED_DURING_EDIT" }))).toBe(false);
    expect(isDemoteRefusal(axiosErr(400, { code: "WALK_IN_SALE_PAID" }))).toBe(false);
    expect(isDemoteRefusal(new Error("Network Error"))).toBe(false);
  });

  it("the sentences are the web's own, whatever the server said", () => {
    expect(demoteErrorText(axiosErr(409, { code: "WALK_IN_SALE_PAID", message: "x" }))).not.toBe(
      "x",
    );
    expect(
      demoteErrorText(axiosErr(409, { code: "ORDER_ROUTE_STOP_COMPLETED", message: "x" })),
    ).not.toBe("x");
  });
});
