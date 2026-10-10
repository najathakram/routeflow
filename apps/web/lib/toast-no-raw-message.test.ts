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

  /** `src` without comments and without the ONE allow-listed lookup (`sentenceForMessage`). */
  const codeOnly = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
      .replace(/function sentenceForMessage[\s\S]*?\n}\n/, "");

  it.each(FILES)("%s: the word `message` appears nowhere in code outside the one lookup", (f) => {
    const src = fs.readFileSync(path.join(LIB, f), "utf8");
    expect(codeOnly(src).match(/\bmessage\b/g) ?? []).toEqual([]);
  });

  it("the one lookup reads data.message only as a key into the two closed sentence tables", () => {
    const src = fs.readFileSync(path.join(LIB, "generic-toast-copy.ts"), "utf8");
    const fn = src.match(/function sentenceForMessage[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(fn).toContain("KNOWN_SERVER_SENTENCES, message");
    expect(fn).toContain("KNOWN_REFUSAL_SENTENCES, message");
    expect(fn).not.toMatch(/toast|title|description/);
    expect(src).not.toMatch(/title:\s*(?:data|message)/);
  });

  it("mutation-proof: a planted `message` outside the lookup is caught by the codeOnly scan", () => {
    const planted =
      "function ok(){}\nconst m = x.message;\nfunction sentenceForMessage(d){\n  return d.message;\n}\n";
    ("function ok(){}\nconst m = x.message;\nfunction sentenceForMessage(d){ return d.message; }\n");
    expect(codeOnly(planted).match(/\bmessage\b/g)).toHaveLength(1);
  });

  it("mutation-proof: the scan goes red on a planted raw-message toast", () => {
    expect(rawMessageReads("toast({ title: data?.message || error.message });")).toHaveLength(2);
    expect(rawMessageReads("const m = (e as any)?.response?.data?.message;")).toHaveLength(1);
  });
});
