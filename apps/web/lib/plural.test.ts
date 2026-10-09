import { countNoun } from "./plural";

describe("countNoun", () => {
  it("renders 1 variant singular and other counts plural", () => {
    expect(countNoun(1, "variant")).toBe("1 variant");
    expect(countNoun(2, "variant")).toBe("2 variants");
    expect(countNoun(0, "variant")).toBe("0 variants");
  });
  it("accepts an irregular plural", () => {
    expect(countNoun(2, "box", "boxes")).toBe("2 boxes");
  });
});
