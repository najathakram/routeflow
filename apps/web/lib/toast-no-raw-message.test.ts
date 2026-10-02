import * as fs from "fs";
import * as path from "path";
import { rawMessageReads } from "./raw-message-scan";

/**
 * B980 static scan: the GLOBAL toast path (the mutation-error handler and its copy module) never
 * renders the server message or an error's own `.message`. A per-surface onError that does is B980b.
 */
const LIB = __dirname;
const FILES = ["mutation-error-toast.ts", "generic-toast-copy.ts"];

describe("global toast path never renders the raw message (B980)", () => {
  it.each(FILES)("%s", (f) => {
    const src = fs.readFileSync(path.join(LIB, f), "utf8");
    // The only allowed read is the closed allow-list lookup in generic-toast-copy (`data.message` typed-checked and looked up, never rendered).
    const hits = rawMessageReads(src).filter(
      (h) => !(f === "generic-toast-copy.ts" && h === "data.message"),
    );
    expect(hits).toEqual([]);
  });

  it("generic-toast-copy reads data.message only as a lookup key into the two closed sentence tables", () => {
    const src = fs.readFileSync(path.join(LIB, "generic-toast-copy.ts"), "utf8");
    expect(src).toMatch(/const message = data\.message;/);
    expect(src).toMatch(/KNOWN_SERVER_SENTENCES, message\)/);
    expect(src).toMatch(/KNOWN_REFUSAL_SENTENCES, message\)/);
    expect(src).not.toMatch(/title:\s*(?:data|message)/);
  });

  it("mutation-proof: the scan goes red on a planted raw-message toast", () => {
    expect(rawMessageReads("toast({ title: data?.message || error.message });")).toEqual([
      "data?.message",
      "error.message",
    ]);
    expect(rawMessageReads("const m = (e as any)?.response?.data?.message;")).toEqual([
      "response?.data?.message",
    ]);
  });
});
