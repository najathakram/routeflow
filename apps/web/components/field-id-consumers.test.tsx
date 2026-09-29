import { readFileSync } from "fs";
import { join } from "path";

// B891: fields no longer derive their default id from the label. Every consumer that finds a field
// BY ID (getElementById / an e2e `#id` locator / a label's htmlFor) must pass that id EXPLICITLY at
// the call site, or it would silently stop finding the field. Source-pinned here; the staff and buyer
// login pages also carry an RTL pin in their own page tests.
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("B891: id-dependent consumers pass their ids explicitly", () => {
  it.each([
    // [file, id, what depends on it]
    [
      "app/(dashboard)/finance/payments/page.tsx",
      "payments-search",
      'getElementById("payments-search")',
    ],
    [
      "app/(dashboard)/orders/_components/CreateOrderModal.tsx",
      "delivery-date",
      "e2e 56 #delivery-date",
    ],
    [
      "app/(dashboard)/orders/_components/CreateOrderModal.tsx",
      "order-date",
      "e2e 08/56 #order-date",
    ],
    [
      "components/ReAuthProvider.tsx",
      "reauth-pw",
      'e2e 07 #reauth-pw + <label htmlFor="reauth-pw">',
    ],
    ["app/(auth)/login/page.tsx", "password", 'getElementById("password")'],
    ["app/buyer/login/page.tsx", "buyer-password", 'getElementById("buyer-password")'],
  ])("%s declares id=%s (needed by %s)", (file, id) => {
    expect(read(file)).toMatch(new RegExp(`\\bid="${id}"`));
  });
});
