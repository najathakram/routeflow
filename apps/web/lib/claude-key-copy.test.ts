import { CLAUDE_KEY_SHAPE_COPY, saveKeyErrorDescription } from "./claude-key-copy";

describe("saveKeyErrorDescription (B986: the web's own sentence, not the server's)", () => {
  it("a 400 shows the one closed sentence, whatever the server said", () => {
    const err = { response: { status: 400, data: { message: ["server words"] } } };
    expect(saveKeyErrorDescription(err)).toBe("That doesn't look like a Claude API key.");
    expect(CLAUDE_KEY_SHAPE_COPY).toBe("That doesn't look like a Claude API key.");
  });

  it("any other failure shows no description (never the server's text)", () => {
    for (const status of [401, 403, 500, undefined])
      expect(
        saveKeyErrorDescription({ response: { status, data: { message: "boom" } } }),
      ).toBeUndefined();
    expect(saveKeyErrorDescription(new Error("network"))).toBeUndefined();
  });
});
