import * as fs from "fs";
import * as path from "path";
import { CREDITS_PENDING_COPY } from "@routeflow/types";
import { codedToastCopy } from "./generic-toast-copy";

/**
 * E-MB1: the "saved, credits not applied yet" sentence lives in ONE place (packages/types CREDITS_PENDING_COPY). A per-screen
 * copy of it drifts, so the web toast table points at the shared constant instead of repeating the words.
 */
describe("credits-pending copy has one home", () => {
  it("generic-toast-copy does not repeat the sentence", () => {
    const src = fs.readFileSync(path.join(__dirname, "generic-toast-copy.ts"), "utf8");
    expect(src).not.toMatch(/weren't applied yet/);
    expect(src).toMatch(/CREDITS_PENDING_COPY/);
  });

  it("the toast for ORDER_SAVED_CREDITS_PENDING IS the shared constant", () => {
    expect(
      codedToastCopy({ response: { status: 409, data: { code: "ORDER_SAVED_CREDITS_PENDING" } } }),
    ).toBe(CREDITS_PENDING_COPY);
  });
});
