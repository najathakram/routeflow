import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateOrderItemsDto } from "./update-order-items.dto";

/**
 * Multi-line per-item notes: `UpdateOrderItemDto.notes` had no `@MaxLength` at all — the create
 * path already capped at 2000 (`OrderItemDto.notes`), so an edit could write an unbounded note the
 * create path would have refused. Closing that gap here, not raising it — 2000 is create's own
 * existing cap, kept in step rather than picked fresh.
 */
describe("UpdateOrderItemsDto — items[].notes is bounded (was unbounded)", () => {
  function payloadWithNote(notes: string) {
    return plainToInstance(UpdateOrderItemsDto, {
      items: [{ id: "li-1", action: "UPDATE", notes }],
    });
  }

  it("refuses a note over 2000 characters", async () => {
    const errors = await validate(payloadWithNote("x".repeat(2001)));
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    const notesError = itemErrors.find((e) => e.property === "notes");
    expect(notesError?.constraints).toHaveProperty("maxLength");
  });

  it("accepts a note at exactly 2000 characters — the same cap the create path enforces", async () => {
    const errors = await validate(payloadWithNote("x".repeat(2000)));
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    expect(itemErrors.find((e) => e.property === "notes")).toBeUndefined();
  });

  it("accepts a genuinely multi-line note well under the cap", async () => {
    const errors = await validate(payloadWithNote("line one\nline two\nline three"));
    const itemErrors = errors[0]?.children?.[0]?.children ?? [];
    expect(itemErrors.find((e) => e.property === "notes")).toBeUndefined();
  });
});
