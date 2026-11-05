/**
 * B1280: "Reopen order" words three refusals itself (a live return, a paid counter sale, a route run). The page must tell
 * the status hook to stay silent for exactly those three (`localErrorToast: isDemoteRefusal`), or the global toast fires
 * as well and the user sees two. A narrower predicate (the old single-code `isDemoteHasReturnRefusal`) toasts twice for the
 * other two refusals. Source pin: the page is not renderable cheaply; the predicate itself is unit-tested in
 * `lib/order-error-text.test.ts`.
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("orders/[id] Reopen order shows one toast per refusal (B1280)", () => {
  it("the demotion's status hook is silenced by isDemoteRefusal, the predicate for all three refusals", () => {
    expect(src).toMatch(
      /const demoteStatus = useUpdateOrderStatus\(\{\s*localErrorToast: isDemoteRefusal\s*\}\)/,
    );
  });

  it("the page does not fall back to a single-code predicate", () => {
    expect(src).not.toMatch(/isDemoteHasReturnRefusal/);
  });

  it("the page shows the demotion's own sentence from demoteErrorText", () => {
    expect(src).toMatch(/demoteErrorText\(/);
  });
});
