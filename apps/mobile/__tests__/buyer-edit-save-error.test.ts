import { readFileSync } from "fs";
import { join } from "path";
import { buyerEditSaveError } from "../lib/buyer-edit-save-error";

const COPY =
  "Part of this order was already delivered, so it can't be changed here. Contact the seller to change it.";

describe("buyerEditSaveError (SA-1149 M1-5m)", () => {
  it("409 ORDER_EDIT_DELIVERED_LINES shows the buyer copy, never the server sentence", () => {
    const err = {
      response: {
        status: 409,
        data: { code: "ORDER_EDIT_DELIVERED_LINES", message: "Change each line instead" },
      },
    };
    expect(buyerEditSaveError(err)).toBe(COPY);
  });

  it("another 409 keeps the server message", () => {
    const err = { response: { status: 409, data: { code: "OTHER", message: "Server says no" } } };
    expect(buyerEditSaveError(err)).toBe("Server says no");
  });

  it("no response: the error message, then the generic fallback", () => {
    expect(buyerEditSaveError({ message: "Network Error" })).toBe("Network Error");
    expect(buyerEditSaveError(null)).toBe("Save failed.");
  });
});

// RN screens are not renderable in this jest lane, so the wiring is source-pinned: the buyer edit screen
// must route its save error through buyerEditSaveError, or the 409 shows the server sentence again.
describe("edit-items.tsx shows the buyer copy through buyerEditSaveError (SA-1149 M1-5m)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(customer)/orders/[id]/edit-items.tsx"),
    "utf8",
  );
  it("imports the helper and passes the save error to it", () => {
    expect(src).toMatch(/import \{ buyerEditSaveError \} from "[^"]*buyer-edit-save-error"/);
    expect(src).toMatch(/onError: \(e: any\) => showToast\(buyerEditSaveError\(e\)\)/);
  });
});
