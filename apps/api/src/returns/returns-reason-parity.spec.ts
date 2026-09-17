/**
 * PR-1c: `CaptureInlineReturnDto`'s hand-typed `CAPTURE_REASONS` literal (class-validator's
 * `@IsIn` needs a literal array, so it can't just import `ReturnsService`'s
 * `VALID_RETURN_REASONS` const) must stay set-equal to the server's own reason set — the
 * exact L-072/`returns-restock-parity.spec.ts` class of duplicated-rule risk, one file over.
 * Static-scan pin, modelled on that file: both declarations are read as TEXT, never imported
 * at runtime, and diffed as sets.
 */
import * as fs from "fs";
import * as path from "path";

const SERVER_FILE = path.join(__dirname, "returns.service.ts");
const DTO_FILE = path.join(__dirname, "dto", "capture-inline-return.dto.ts");

function readSource(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function quotedLiterals(snippet: string): string[] {
  return (snippet.match(/"[^"]*"/g) ?? []).map((m) => m.slice(1, -1));
}

function serverValidReasons(text: string): string[] {
  const m = text.match(/export const VALID_RETURN_REASONS = \[([^\]]*)\]/);
  return m ? quotedLiterals(m[1]) : [];
}

function dtoCaptureReasons(text: string): string[] {
  const m = text.match(/const CAPTURE_REASONS = \[([^\]]*)\]/);
  return m ? quotedLiterals(m[1]) : [];
}

describe("PR-1c: CaptureInlineReturnDto's CAPTURE_REASONS stays set-equal to VALID_RETURN_REASONS", () => {
  const serverReasons = serverValidReasons(readSource(SERVER_FILE));
  const dtoReasons = dtoCaptureReasons(readSource(DTO_FILE));

  it("finds both rules in source (guards against a silently-vacuous suite)", () => {
    expect(serverReasons.length).toBeGreaterThan(0);
    expect(dtoReasons.length).toBeGreaterThan(0);
  });

  it("names exactly the same reasons — no extra, none missing", () => {
    expect(new Set(dtoReasons)).toEqual(new Set(serverReasons));
    expect(dtoReasons.length).toBe(serverReasons.length);
  });
});
