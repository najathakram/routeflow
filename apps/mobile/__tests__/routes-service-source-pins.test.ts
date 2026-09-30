/**
 * Cross-workspace source pin: `apps/mobile/lib/offline-errors.ts#isStopAlreadyCompletedError`
 * decides that a 400 means "the first complete-with-payment already landed" by matching a RAW
 * SERVER MESSAGE. Nothing pinned that string on either side of the wire, so a one-word reword in
 * `apps/api` would silently turn a successful retry back into an error toast with the whole
 * suite green — the driver would be told their stop failed after it completed.
 *
 * This is the mobile half of that pin, in the `__tests__/barcode-normalize.test.ts` idiom (read
 * the other workspace's source with `readFileSync` off `__dirname` and assert on its text).
 *
 * VACUITY GUARD: a regex over a string that came back empty passes for free, so every locator
 * below asserts its own match COUNT is non-zero before asserting anything about the match — a
 * moved or renamed file fails loudly instead of quietly certifying nothing.
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROUTES_SERVICE_PATH = join(
  __dirname,
  "..",
  "..",
  "api",
  "src",
  "routes",
  "routes.service.ts",
);
const OFFLINE_ERRORS_PATH = join(__dirname, "..", "lib", "offline-errors.ts");

const routesServiceSrc = readFileSync(ROUTES_SERVICE_PATH, "utf8");
const offlineErrorsSrc = readFileSync(OFFLINE_ERRORS_PATH, "utf8");

/** The literal the mobile classifier's behaviour depends on. */
const SERVER_MESSAGE = "Stop is already completed";

describe("routes.service.ts still throws the message mobile classifies on (REG-RETURNS-IDEM-C)", () => {
  it("read a non-empty apps/api routes.service.ts (the pin cannot pass vacuously)", () => {
    expect(routesServiceSrc.length).toBeGreaterThan(1000);
    expect(offlineErrorsSrc.length).toBeGreaterThan(0);
  });

  it("throws the exact BadRequestException text at BOTH completion guards", () => {
    const throws = routesServiceSrc.match(
      /throw new BadRequestException\("Stop is already completed"\)/g,
    );
    expect(throws).not.toBeNull();
    // Two guards today (the complete and complete-with-payment paths). If the server drops one,
    // that path stops being classifiable and the driver gets a false failure toast.
    expect(throws!.length).toBeGreaterThanOrEqual(2);
  });

  it("the mobile classifier's substring is genuinely a substring of the server's message", () => {
    // Pull the literal the classifier actually matches on out of ITS source, so the two halves
    // are compared rather than both being asserted against a constant typed twice in this file.
    const includesMatch = offlineErrorsSrc.match(/message\.includes\("([^"]+)"\)/);
    expect(includesMatch).not.toBeNull();
    const mobileSubstring = includesMatch![1]!;
    expect(mobileSubstring.length).toBeGreaterThan(0);
    // The classifier lowercases the server message before matching.
    expect(SERVER_MESSAGE.toLowerCase()).toContain(mobileSubstring);
    // ...and the message it will really see is the one the server throws.
    expect(routesServiceSrc).toContain(`BadRequestException("${SERVER_MESSAGE}")`);
  });

  it("the classifier still requires a 400, so a different failure is never read as success", () => {
    const guardMatch = offlineErrorsSrc.match(
      /export function isStopAlreadyCompletedError[\s\S]*?\n\}/,
    );
    expect(guardMatch).not.toBeNull();
    expect(guardMatch![0]).toContain("status === 400");
  });
});
