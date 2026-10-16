import {
  clearDraft,
  draftHasInput,
  draftKey,
  readDraft,
  writeDraft,
  EMPTY_DRAFT_FORM,
} from "./product-create-draft";

beforeEach(() => localStorage.clear());

describe("product create draft storage", () => {
  it("round-trips a draft", () => {
    const key = draftKey();
    writeDraft(key, { ...EMPTY_DRAFT_FORM, name: "Cola", pricePerUnit: "12.00" });
    const draft = readDraft(key);
    expect(draft?.fields.name).toBe("Cola");
    expect(draft?.fields.pricePerUnit).toBe("12.00");
    expect(typeof draft?.savedAt).toBe("number");
  });

  it("returns null when nothing is saved, or the saved value is junk", () => {
    const key = draftKey();
    expect(readDraft(key)).toBeNull();
    localStorage.setItem(key, "{not json");
    expect(readDraft(key)).toBeNull();
    localStorage.setItem(key, JSON.stringify({ v: 1, savedAt: 1, fields: { name: 5 } }));
    expect(readDraft(key)).toBeNull();
    localStorage.setItem(key, JSON.stringify({ v: 99, savedAt: 1, fields: { name: "x" } }));
    expect(readDraft(key)).toBeNull();
  });

  it("clears a draft", () => {
    const key = draftKey();
    writeDraft(key, { ...EMPTY_DRAFT_FORM, name: "Cola" });
    clearDraft(key);
    expect(readDraft(key)).toBeNull();
  });

  it("never throws when storage fails", () => {
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const rem = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readDraft(draftKey())).toBeNull();
    expect(() => writeDraft(draftKey(), { ...EMPTY_DRAFT_FORM, name: "x" })).not.toThrow();
    expect(() => clearDraft(draftKey())).not.toThrow();
    get.mockRestore();
    set.mockRestore();
    rem.mockRestore();
  });

  it("only counts a change from the blank form as input", () => {
    expect(draftHasInput(EMPTY_DRAFT_FORM)).toBe(false);
    expect(draftHasInput({ ...EMPTY_DRAFT_FORM, name: "  " })).toBe(false);
    expect(draftHasInput({ ...EMPTY_DRAFT_FORM, name: "Cola" })).toBe(true);
    expect(draftHasInput({ ...EMPTY_DRAFT_FORM, costingMethod: "FIFO" })).toBe(true);
  });
});
