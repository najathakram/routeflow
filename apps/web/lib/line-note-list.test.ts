import { splitLineNote } from "./line-note-list";

describe("splitLineNote", () => {
  it("splits the comma list into its four entries, in order", () => {
    expect(
      splitLineNote("ACME MINT 20 BOX, ACME CHERRY - 14, ACME LEMON DROP 10, ACME ICE 10"),
    ).toEqual(["ACME MINT 20 BOX", "ACME CHERRY - 14", "ACME LEMON DROP 10", "ACME ICE 10"]);
  });

  it("never splits a comma between two digits", () => {
    expect(splitLineNote("1,000 pcs, 20 box")).toEqual(["1,000 pcs", "20 box"]);
  });

  it("returns null for a sentence with a comma and no digits", () => {
    expect(splitLineNote("Leave at the back door, call first")).toBeNull();
  });

  it("returns null for a single entry", () => {
    expect(splitLineNote("ACME MINT 20 BOX")).toBeNull();
  });

  it("splits on semicolons and line breaks", () => {
    expect(splitLineNote("ACME MINT 20; ACME ICE 10\nACME LEMON 5\r\nACME PEACH 4")).toEqual([
      "ACME MINT 20",
      "ACME ICE 10",
      "ACME LEMON 5",
      "ACME PEACH 4",
    ]);
  });

  it("returns null for empty and whitespace-only notes", () => {
    expect(splitLineNote("")).toBeNull();
    expect(splitLineNote("  \n , ; ")).toBeNull();
  });

  it("drops empty parts from a trailing comma", () => {
    expect(splitLineNote("ACME MINT 20, ACME ICE 10,")).toEqual(["ACME MINT 20", "ACME ICE 10"]);
  });

  it("needs at least half of the parts to carry a digit", () => {
    expect(splitLineNote("ACME MINT 20, ACME ICE, ACME LEMON")).toBeNull();
    expect(splitLineNote("ACME MINT 20, ACME ICE")).toEqual(["ACME MINT 20", "ACME ICE"]);
  });

  it("keeps every word as typed", () => {
    expect(splitLineNote("acme Mint x2, ACME ice 10")).toEqual(["acme Mint x2", "ACME ice 10"]);
  });
});
