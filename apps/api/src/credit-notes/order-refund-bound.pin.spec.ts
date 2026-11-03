import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1091 piece 1 (RR-12): every value-giver reads the ONE order-wide bound (`loadOrderRefundRoom` + `orderRoomRefusal`, written
 * once in line-credit-headroom.ts). Three sites give value back: the credit-note door (`validateAndBuildCnItems`), the recorded
 * standard refund (`claimRefund`) and the inline return (`assertWithinLineHeadroom`, which serves the quote, a refund capture and
 * a store-credit capture). A fourth door must call the helper and move this pin on purpose; a site that stops calling it fails
 * here before it can pay twice.
 */
const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** The text of one method: from its declaration to the next two-space-indented member. */
function bodyOf(text: string, decl: RegExp): string {
  const m = decl.exec(text);
  if (!m) throw new Error(`declaration not found: ${decl}`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/\n {2}(?:private |public |protected )?(?:async )?[A-Za-z_]+\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("SA-1091 (RR-12): each value-giver calls the one order-wide bound", () => {
  it("the credit-note door reads it for every note on an invoice", () => {
    const body = bodyOf(
      read("credit-notes/credit-notes.service.ts"),
      /async validateAndBuildCnItems\(/,
    );
    expect(body).toContain("loadOrderRefundRoom(");
    expect(body).toContain("orderRoomRefusal(");
  });

  it("the recorded standard refund reads it inside the claim transaction, before the claim write", () => {
    const body = bodyOf(read("returns/returns.service.ts"), /private async claimRefund\(/);
    const read1 = body.indexOf("loadOrderRefundRoom(");
    expect(read1).toBeGreaterThan(-1);
    expect(body).toContain("orderRoomRefusal(");
    expect(read1).toBeLessThan(body.indexOf("refundClaimWhere(id)"));
  });

  it("the inline return reads it for every source order of its chunks (quote, refund and store credit)", () => {
    const body = bodyOf(
      read("returns/inline-returns.service.ts"),
      /private async assertWithinLineHeadroom\(/,
    );
    expect(body).toContain("loadOrderRefundRoom(");
    expect(body).toContain("orderRoomRefusal(");
  });

  it("the helper is written once, and no other source file builds its own order-wide sum", () => {
    const calls: string[] = [];
    for (const rel of [
      "credit-notes/credit-notes.service.ts",
      "returns/returns.service.ts",
      "returns/inline-returns.service.ts",
      "credit-notes/credit-note-reissue.service.ts",
      "returns/inline-return-refund.ts",
    ])
      for (const l of read(rel).split("\n"))
        if (l.includes("loadOrderRefundRoom(")) calls.push(`${rel}: ${l.trim()}`);
    expect(calls).toHaveLength(3);
    const helper = read("credit-notes/line-credit-headroom.ts");
    expect(helper.match(/export async function loadOrderRefundRoom\b/g)).toHaveLength(1);
    expect(helper.match(/export function orderRoomRefusal/g)).toHaveLength(1);
    // the many-orders twin (read-only census) shares the one arithmetic: both compose through composeOrderRefundRoom, and the
    // room formula is written there and nowhere else
    expect(helper.match(/export async function loadOrderRefundRooms\b/g)).toHaveLength(1);
    expect(helper.match(/export function composeOrderRefundRoom\b/g)).toHaveLength(1);
    expect(helper.match(/composeOrderRefundRoom\(/g)).toHaveLength(3); // definition + the two loaders
    expect(helper.match(/billed - notes - unlinked - recorded - inline/g)).toHaveLength(1);
  });
});
