import { DRAFT_SAVED_ON_LEAVE, draftLeaveNotice } from "../lib/draft-leave-notice";
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

  it("parkability is the screen's own rule: draftParkable is exported for the leave check", () => {
    expect(typeof draftParkable).toBe("function");
  });
});
