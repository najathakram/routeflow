import { READ_ONLY_SENTENCE } from "@routeflow/types/read-only-copy";
import { discardErrorCopy, parkErrorCopy, resumeErrorCopy } from "./counter-park";

/** Park / resume / discard are writes: a READ_ONLY 403 says so, instead of "Try again" (retrying cannot help). */
const LINE = READ_ONLY_SENTENCE; // SA-776: the one shared owner's sentence
const readOnly403 = { response: { status: 403, data: { code: "READ_ONLY", message: "RAW" } } };

describe("counter park copy: READ_ONLY", () => {
  it.each([
    ["park", parkErrorCopy],
    ["resume", resumeErrorCopy],
    ["discard", discardErrorCopy],
  ])("%s: a 403 READ_ONLY says the read-only line", (_name, copy) => {
    expect(copy(readOnly403)).toBe(LINE);
  });
});
