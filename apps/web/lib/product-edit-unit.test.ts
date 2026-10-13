import { packWordToSend } from "./product-edit-unit";

describe("packWordToSend: a stale form must not overwrite a unit rename", () => {
  it("sends nothing when the pack word was not edited (the form opened with Case; a rename made it Carton meanwhile)", () => {
    expect(packWordToSend("Case", "Case")).toBeUndefined();
  });
  it("sends the new word when the operator changed it", () => {
    expect(packWordToSend("Crate", "Case")).toBe("Crate");
  });
  it("a blank edit is left unchanged, never sent", () => {
    expect(packWordToSend("", "Case")).toBeUndefined();
    expect(packWordToSend(undefined, "Case")).toBeUndefined();
  });
});
