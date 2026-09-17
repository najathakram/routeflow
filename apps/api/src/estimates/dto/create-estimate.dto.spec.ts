import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateEstimateDto } from "./create-estimate.dto";

/**
 * B451 gap 4 fix — the MAIN risk of typing what was `@Body() dto: any` is
 * breaking estimate creation in prod for the one real caller
 * (apps/web/lib/api/estimates.ts `useCreateEstimate` + the create-estimate
 * form in apps/web/app/(dashboard)/estimates/page.tsx). This pins that the
 * web's real payload shape — exactly as `handleSubmit` builds it — still
 * passes the real global ValidationPipe options
 * (apps/api/src/main.ts:145-149) unchanged.
 */
describe("CreateEstimateDto — the web client's real create payload", () => {
  // Mirrors apps/web/app/(dashboard)/estimates/page.tsx handleSubmit's `dto`
  // construction verbatim, including the conditional boxes/pieces and
  // DISCOUNTED-price spreads.
  function webPayload(overrides: Record<string, unknown> = {}) {
    return {
      customerId: "cust-1",
      issueDate: "2026-09-16",
      expiresAt: "2026-10-16",
      notes: "Net 30, delivered Tuesdays",
      items: [
        // A catalog line with no box split, standard price (no unitsPerBox spread).
        { productId: "prod-1", description: "Tomatoes", qty: 3 },
        // A catalog line WITH a box split (li.unitsPerBox truthy).
        { productId: "prod-2", description: "Flour 25lb", qty: 24, boxes: 2, pieces: 0 },
        // A DISCOUNTED-price line (li.priceType === "DISCOUNTED").
        { productId: "prod-3", description: "Olive Oil", qty: 5, unitPrice: 8.5 },
      ],
      ...overrides,
    };
  }

  it("passes the real ValidationPipe options (whitelist + forbidNonWhitelisted) unchanged", async () => {
    const instance = plainToInstance(CreateEstimateDto, webPayload());
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it("passes when notes is omitted (notes.trim() || undefined can drop the key)", async () => {
    const { notes, ...withoutNotes } = webPayload();
    const instance = plainToInstance(CreateEstimateDto, withoutNotes);
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it("passes a minimal single unlisted-free-item payload (no productId, no boxes/pieces)", async () => {
    const instance = plainToInstance(
      CreateEstimateDto,
      webPayload({ items: [{ description: "Custom item", qty: 1, unitPrice: 12.5 }] }),
    );
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it("REG (Opus review of 942d5d69): a bare {productId, qty} catalog line — no description, no unitPrice — passes (scripts/feature-smoke.mjs S6, qa-run.js #57/144/145/148/149 all send exactly this shape)", async () => {
    const instance = plainToInstance(CreateEstimateDto, {
      customerId: "cust-1",
      items: [{ productId: "prod-1", qty: 1 }],
    });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it.each(["discount", "taxAmount"])(
    "B451 gap 4: a client sending %s now 400s via forbidNonWhitelisted instead of reaching the service unvalidated",
    async (field) => {
      const instance = plainToInstance(CreateEstimateDto, webPayload({ [field]: 500 }));
      const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
      const whitelistError = errors.find((e) => e.constraints?.whitelistValidation);
      expect(whitelistError).toBeDefined();
      expect(whitelistError!.property).toBe(field);
    },
  );

  it("rejects a negative line qty", async () => {
    const instance = plainToInstance(
      CreateEstimateDto,
      webPayload({ items: [{ description: "x", qty: -1 }] }),
    );
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a negative line unitPrice", async () => {
    const instance = plainToInstance(
      CreateEstimateDto,
      webPayload({ items: [{ description: "x", qty: 1, unitPrice: -5 }] }),
    );
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an empty items array", async () => {
    const instance = plainToInstance(CreateEstimateDto, webPayload({ items: [] }));
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === "items")).toBe(true);
  });
});
