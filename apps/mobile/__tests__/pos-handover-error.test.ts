import * as fs from "fs";
import * as path from "path";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  HANDED_OVER_DAY_CLOSED_COPY,
  DAY_CLOSED_NOTHING_CHANGED_COPY,
  handOverErrorOutcome,
  releasesHandOverKey,
} from "../lib/pos-handover-error";

/**
 * W-813 (SA-932 §W-813, I-120 hand-over): COUNTER_SALE_DAY_CLOSED is shared by "nothing changed" (the read-only pre-check)
 * and "the hand-over stands, the payment was not taken" (the in-lock refusal after the commit). The phone showed the generic
 * "Couldn't complete" and never refetched, so the clerk tapped again on an order that was already DELIVERED. Now, on any
 * error, the screen refetches the order, releases the held key on a known 4xx (as web), and the copy is chosen from the
 * REFETCHED order, so it is right before and after SA-925's distinct code (#3707) deploys.
 */
const err = (status: number | undefined, code?: string) => ({
  response: status === undefined ? undefined : { status, data: code ? { code } : {} },
});
const DAY = API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED;

describe("handOverErrorOutcome: a closed till day", () => {
  it("the refetched order is DELIVERED: the hand-over stands; say so, close the sheet", () => {
    expect(handOverErrorOutcome(err(409, DAY), "DELIVERED", false)).toEqual({
      message: HANDED_OVER_DAY_CLOSED_COPY,
      handedOver: true,
    });
    expect(HANDED_OVER_DAY_CLOSED_COPY).toBe(
      "Handed over. The till day is closed, so the payment was not taken here. Record it in the office.",
    );
  });
  it("the refetched order is not DELIVERED: nothing changed (complete mode too)", () => {
    for (const complete of [false, true]) {
      expect(handOverErrorOutcome(err(409, DAY), "CONFIRMED", complete)).toEqual({
        message: DAY_CLOSED_NOTHING_CHANGED_COPY,
        handedOver: false,
      });
    }
  });
  it("no refetched status (the refetch failed): never claims the hand-over stands", () => {
    expect(handOverErrorOutcome(err(409, DAY), null, false).handedOver).toBe(false);
  });
});

describe("handOverErrorOutcome: any other error keeps today's copy and the sheet", () => {
  it("a coded refusal maps as before", () => {
    const o = handOverErrorOutcome(
      err(400, API_ERROR_CODES.COUNTER_TENDER_SHORT),
      "CONFIRMED",
      false,
    );
    expect(o).toEqual({
      message: "A walk-in customer must pay the full balance.",
      handedOver: false,
    });
  });
  it("a DELIVERED order on a non-day-closed error is not re-labelled", () => {
    expect(handOverErrorOutcome(err(500), "DELIVERED", false).handedOver).toBe(false);
  });
});

describe("releasesHandOverKey (web PickupCompleteDialog parity)", () => {
  it.each([400, 403, 404, 409, 422])("a known %i releases the key", (s) => {
    expect(releasesHandOverKey(err(s))).toBe(true);
  });
  it.each([500, 502, 503])("a %i keeps it (the outcome is unknown)", (s) => {
    expect(releasesHandOverKey(err(s))).toBe(false);
  });
  it("no response (network) keeps it", () => {
    expect(releasesHandOverKey(err(undefined))).toBe(false);
  });
});

describe("the order screen's hand-over onError", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../app/(operator)/(tabs)/orders/[id].tsx"),
    "utf8",
  );
  const onError = (() => {
    const at = src.indexOf("function submitHandOver");
    const start = src.indexOf("onError:", at);
    return src.slice(start, src.indexOf("});", start));
  })();
  it("refetches the order on every error and chooses the copy from the refetched status", () => {
    expect(onError).toMatch(/await refetch\(\)/);
    expect(onError).toContain("handOverErrorOutcome(");
  });
  it("releases the held key on a known 4xx", () => {
    expect(onError).toMatch(/releasesHandOverKey\(e\)\)\s*releasePickupKey\(order\.id\)/);
  });
});
