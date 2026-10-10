import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ReorderRunStopsDto } from "./reorder-run-stops.dto";

/** The pipe options main.ts sets: whitelist + forbidNonWhitelisted (#2135). */
const PIPE = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = async (body: unknown) => validate(plainToInstance(ReorderRunStopsDto, body), PIPE);
const flat = (errs: any[], prefix = ""): string[] =>
  errs.flatMap((e) => [
    ...(e.constraints ? [`${prefix}${e.property}`] : []),
    ...flat(e.children ?? [], `${prefix}${e.property}.`),
  ]);

describe("ReorderRunStopsDto (#2135)", () => {
  it("accepts a well-formed order", async () => {
    expect(
      await errorsOf({
        order: [
          { id: "a", stopNumber: 1 },
          { id: "b", stopNumber: 2 },
        ],
      }),
    ).toHaveLength(0);
  });

  it.each([
    ["no order", {}],
    ["an empty order", { order: [] }],
    ["a non-array order", { order: "a" }],
  ])("refuses %s", async (_n, body) => {
    expect((await errorsOf(body)).length).toBeGreaterThan(0);
  });

  it.each([0, -1, 1.5, "2", null])("refuses stopNumber %p", async (stopNumber) => {
    expect(flat(await errorsOf({ order: [{ id: "a", stopNumber }] }))).toContain(
      "order.0.stopNumber",
    );
  });

  it.each(["", null, 5])("refuses id %p", async (id) => {
    expect(flat(await errorsOf({ order: [{ id, stopNumber: 1 }] }))).toContain("order.0.id");
  });

  it("refuses unknown properties, top-level and per item", async () => {
    expect(
      flat(await errorsOf({ order: [{ id: "a", stopNumber: 1 }], routeRunId: "x" })),
    ).toContain("routeRunId");
    expect(
      flat(await errorsOf({ order: [{ id: "a", stopNumber: 1, status: "COMPLETED" }] })),
    ).toContain("order.0.status");
  });

  it("caps the list", async () => {
    const order = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, stopNumber: i + 1 }));
    expect(flat(await errorsOf({ order }))).toContain("order");
  });
});
