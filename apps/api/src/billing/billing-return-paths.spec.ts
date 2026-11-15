import * as fs from "fs";
import * as path from "path";
import { BILLING_CANCEL_PATH, BILLING_RETURN_PATHS } from "@routeflow/types";
import {
  API_BILLING_CANCEL_PATH,
  API_BILLING_RETURN_PATHS,
  billingReturnUrl,
} from "./billing-return-paths";

// SA-1146 B-1 (B446): one home for every Checkout success / cancel / return address.

describe("billing return paths: the API copy equals the shared allowlist", () => {
  // Compiled API code cannot value-import @routeflow/types (no-runtime-types-import.spec), so the API keeps a
  // local copy; this spec is what keeps the two from drifting.
  it("the three return paths are the shared ones, key for key", () => {
    expect(API_BILLING_RETURN_PATHS).toEqual(BILLING_RETURN_PATHS);
  });
  it("the cancel path is the shared one", () => {
    expect(API_BILLING_CANCEL_PATH).toBe(BILLING_CANCEL_PATH);
    expect(API_BILLING_CANCEL_PATH).toBe("/settings/billing?checkout=cancelled");
  });
  it("joins a path to the web base without a doubled slash", () => {
    expect(billingReturnUrl("https://app.test/", API_BILLING_RETURN_PATHS.plan)).toBe(
      "https://app.test/settings/billing?checkout=success",
    );
    expect(billingReturnUrl("https://app.test", API_BILLING_CANCEL_PATH)).toBe(
      "https://app.test/settings/billing?checkout=cancelled",
    );
  });
});

/** Every non-spec .ts under `dir`, recursively. */
function scan(dir: string): { f: string; text: string }[] {
  const out: { f: string; text: string }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...scan(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts"))
      out.push({
        f: path.relative(SRC, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
  }
  return out;
}
const SRC = path.resolve(__dirname, "..");
const sources = scan(SRC);
const HOME = "billing/billing-return-paths.ts";

describe("billing return paths: no literal Checkout return address outside the one home", () => {
  it("there are sources to scan, and the home file exists", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.f === HOME)).toBe(true);
  });

  it("no `/settings/billing?...` literal outside billing-return-paths.ts", () => {
    const hits = sources
      .filter((s) => s.f !== HOME && /\/settings\/billing\?/.test(s.text))
      .map((s) => s.f);
    expect(hits).toEqual([]);
  });

  it("no `/billing/success` or `/billing/cancel` anywhere (those were never pages)", () => {
    const hits = sources
      .filter((s) => /\/billing\/(success|cancel)\b/.test(s.text))
      .map((s) => s.f);
    expect(hits).toEqual([]);
  });
});
