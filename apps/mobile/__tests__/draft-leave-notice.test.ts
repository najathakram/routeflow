import {
  DRAFT_SAVED_ON_LEAVE,
  announceAfterFlush,
  draftLeaveNotice,
} from "../lib/draft-leave-notice";
import { draftParkable } from "../lib/drafts-payload";

/**
 * Row 699 (604 audit; decisions/sa/699-preread.md): leaving mobile Create Order kept the order as a server draft WITHOUT
 * saying so. On leave, when a draft actually remains, the screen says "Draft saved. Find it in Orders."; Discard stays in
 * DraftStrip. The draft id and parkability are read AT LEAVE TIME. (R4, the web F24 / S5 specs staying green, is the
 * web suite's own guard.)
 */
const base = { draftId: "d-1", parkable: true, submitted: false };

describe("row 699: the leave notice for a kept order draft", () => {
  it("R1: a customer + 1 line (parkable) with a draft id at leave: exactly the one notice", () => {
    expect(draftLeaveNotice(base)).toBe(DRAFT_SAVED_ON_LEAVE);
    expect(DRAFT_SAVED_ON_LEAVE).toBe("Draft saved. Find it in Orders.");
  });

  it("R2: after a submit (its draft is pilled and discarded) nothing is said", () => {
    expect(draftLeaveNotice({ ...base, submitted: true })).toBeNull();
  });

  it("R3: an empty screen (no customer or no line: not parkable) says nothing", () => {
    expect(draftLeaveNotice({ ...base, parkable: false })).toBeNull();
  });

  it("no server draft was ever created (still debouncing, or parking never allowed): nothing is said", () => {
    expect(draftLeaveNotice({ ...base, draftId: null })).toBeNull();
  });

  it("a submit still in flight says nothing (its own outcome speaks)", () => {
    expect(draftLeaveNotice({ ...base, submitting: true })).toBeNull();
  });

  it("parkability is the screen's own rule: a customer AND a line (catalog or unlisted)", () => {
    const s = (over: Record<string, unknown>) =>
      ({ customer: { id: "c1" }, items: [], unlisted: [], ...over }) as never;
    expect(draftParkable(s({ items: [{ productId: "p1" }] }))).toBe(true);
    expect(draftParkable(s({ unlisted: [{ name: "Ice" }] }))).toBe(true);
    expect(draftParkable(s({}))).toBe(false); // a customer and no line
    expect(draftParkable(s({ customer: null, items: [{ productId: "p1" }] }))).toBe(false); // a line, no customer
  });
});

describe("row 699 review MUST: the notice follows a SUCCESSFUL save only", () => {
  it("a flush that rejects (offline, or the draft deleted elsewhere: 404) says nothing and reports the error", async () => {
    const onSaved = jest.fn();
    const onError = jest.fn();
    const err = new Error("offline");
    await announceAfterFlush(() => Promise.reject(err), onSaved, onError);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("a flush that resolves announces once, after the save (never before it settles)", async () => {
    const order: string[] = [];
    let release!: () => void;
    const flush = () =>
      new Promise<void>((r) => {
        release = () => {
          order.push("saved");
          r();
        };
      });
    const done = announceAfterFlush(flush, () => order.push("announce"), jest.fn());
    expect(order).toEqual([]); // nothing said while the create is still pending
    release();
    await done;
    expect(order).toEqual(["saved", "announce"]);
  });
});
