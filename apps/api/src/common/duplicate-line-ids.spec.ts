import { BadRequestException } from "@nestjs/common";
import { assertNoDuplicateLineIds } from "./duplicate-line-ids";

describe("assertNoDuplicateLineIds (F3)", () => {
  it("the same id twice is 400 DUPLICATE_LINE_ID", () => {
    const run = () => assertNoDuplicateLineIds([{ id: "L1" }, { id: "L2" }, { id: "L1" }]);
    expect(run).toThrow(BadRequestException);
    try {
      run();
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: "DUPLICATE_LINE_ID" });
    }
  });

  it("the same orderItemId twice is refused, and so is an id matching another entry's orderItemId", () => {
    expect(() => assertNoDuplicateLineIds([{ orderItemId: "L1" }, { orderItemId: "L1" }])).toThrow(
      BadRequestException,
    );
    expect(() => assertNoDuplicateLineIds([{ id: "L1" }, { orderItemId: "L1" }])).toThrow(
      BadRequestException,
    );
  });

  it("controls: distinct ids, id-less adds, null/undefined and an entry carrying both fields as one id pass", () => {
    expect(() =>
      assertNoDuplicateLineIds([
        { id: "L1" },
        { id: "L2" },
        {},
        {},
        { id: null, orderItemId: null },
        { id: "L3", orderItemId: "L3" },
      ]),
    ).not.toThrow();
    expect(() => assertNoDuplicateLineIds(undefined)).not.toThrow();
    expect(() => assertNoDuplicateLineIds([])).not.toThrow();
  });

  it('with keys: ["id"] a shared orderItemId is not a duplicate, a shared id still is', () => {
    const opts = { keys: ["id"] as const };
    expect(() =>
      assertNoDuplicateLineIds(
        [
          { id: "L1", orderItemId: "O" },
          { id: "L2", orderItemId: "O" },
        ],
        opts,
      ),
    ).not.toThrow();
    expect(() => assertNoDuplicateLineIds([{ id: "L1" }, { id: "L1" }], opts)).toThrow(
      BadRequestException,
    );
  });
});
