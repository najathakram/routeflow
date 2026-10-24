/**
 * POS-3: a counter sale line may carry an optional `note` (max 200, HTML stripped) that the writer stores on the existing
 * OrderItem.notes. Validated with the app's own pipe settings (whitelist + forbidNonWhitelisted), so an unknown field on a
 * line is still refused: the new key is additive, not a loosening.
 */
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CounterSaleDto } from "./counter-sale.dto";
import { toCounterOrderItem } from "./counter-sale-lines";

const PID = "11111111-1111-4111-8111-111111111111";
const body = (item: Record<string, unknown>) => ({
  walkIn: true,
  items: [{ productId: PID, qty: 1, ...item }],
  payment: { method: "CARD" },
});
const check = async (item: Record<string, unknown>) => {
  const dto = plainToInstance(CounterSaleDto, body(item));
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors };
};

describe("counter sale line note", () => {
  it("accepts a note and keeps it on the DTO", async () => {
    const { dto, errors } = await check({ note: "no ice" });
    expect(errors).toHaveLength(0);
    expect(dto.items[0].note).toBe("no ice");
  });

  it("strips HTML from the note", async () => {
    const { dto, errors } = await check({ note: "<b>no</b> ice<script>x()</script>" });
    expect(errors).toHaveLength(0);
    expect(dto.items[0].note).not.toMatch(/[<>]/);
    expect(dto.items[0].note).toContain("no");
  });

  it("caps the note at 200 characters", async () => {
    expect((await check({ note: "x".repeat(200) })).errors).toHaveLength(0);
    expect((await check({ note: "x".repeat(201) })).errors.length).toBeGreaterThan(0);
  });

  it("still refuses an unknown field on a line (the key is additive, not a loosening)", async () => {
    expect((await check({ bogus: 1 })).errors.length).toBeGreaterThan(0);
    expect((await check({ notes: "wrong key" })).errors.length).toBeGreaterThan(0);
  });

  it("writes the note to OrderItem.notes (trimmed) and omits a blank one", () => {
    const withNote = toCounterOrderItem(
      { productId: PID, qty: 2, note: "  no ice " } as never,
      null,
    );
    expect(withNote.notes).toBe("no ice");
    expect(withNote.qty).toBe(2);
    expect(
      "notes" in toCounterOrderItem({ productId: PID, qty: 2, note: "   " } as never, null),
    ).toBe(false);
    expect("notes" in toCounterOrderItem({ productId: PID, qty: 2 } as never, null)).toBe(false);
  });

  it("a note leaves boxes/pieces/qty exactly as before", () => {
    const a = toCounterOrderItem({ productId: PID, boxes: 1, pieces: 3 } as never, 12);
    const b = toCounterOrderItem({ productId: PID, boxes: 1, pieces: 3, note: "x" } as never, 12);
    const { notes, ...rest } = b as never as Record<string, unknown>;
    expect(notes).toBe("x");
    expect(rest).toEqual(a);
  });
});
