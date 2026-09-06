import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { PostLocationDto } from "./post-location.dto";

/**
 * B185 (F25-location) — pins today's `PostLocationDto` validation surface and
 * red-set-tests the new `accuracy` field the fix adds.
 *
 * REG-B185 (T3/T4): `accuracy` does not exist on the DTO yet, so under the
 * global pipe's `whitelist: true, forbidNonWhitelisted: true` (apps/api/src/main.ts)
 * any payload carrying it fails with a `whitelistValidation` violation on
 * "accuracy" today — both T3 (a valid 4.5) and T4 (an invalid -1) hit that SAME
 * violation pre-fix. Post-fix, T3 must validate clean and T4 must fail via
 * `@Min(0)` instead — see the dual assertion below.
 */

const basePayload = {
  lat: 34.05,
  lng: -118.24,
  recordedAt: "2026-09-04T00:00:00.000Z",
};

async function whitelistErrors(payload: object) {
  const dto = plainToInstance(PostLocationDto, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe("PostLocationDto", () => {
  describe("REG-B185 accuracy field", () => {
    it("REG-B185 DTO accepts a mapped-to-null ping with a valid accuracy", async () => {
      const errors = await whitelistErrors({
        ...basePayload,
        heading: null,
        speedKph: null,
        accuracy: 4.5,
      });
      expect(errors).toHaveLength(0);
    });

    it("REG-B185 DTO still rejects a negative accuracy", async () => {
      const errors = await whitelistErrors({
        ...basePayload,
        accuracy: -1,
      });
      const accuracyError = errors.find((e) => e.property === "accuracy");

      // Some violation on "accuracy" must exist both pre-fix (whitelistValidation,
      // since the property isn't declared yet) and post-fix (@Min(0)).
      expect(accuracyError).toBeDefined();

      // The behavioral wrong-value this REG test actually pins: pre-fix the ONLY
      // constraint present is `whitelistValidation`; post-fix it must be gone and
      // `min` must be present instead.
      const constraintKeys = Object.keys(accuracyError?.constraints ?? {});
      expect(constraintKeys).not.toContain("whitelistValidation");
      expect(constraintKeys).toContain("min");
    });

    // B185 (F25-location): the column is `Decimal(8,2)` (schema/sales.prisma) —
    // an unbounded accuracy would overflow Postgres and 500 the whole ping,
    // the same failure class the sentinel fix closed off for heading/speedKph.
    it("REG-B185 DTO rejects an accuracy above the Decimal(8,2) column bound", async () => {
      const errors = await whitelistErrors({
        ...basePayload,
        accuracy: 1000000,
      });
      const accuracyError = errors.find((e) => e.property === "accuracy");
      expect(accuracyError).toBeDefined();

      const constraintKeys = Object.keys(accuracyError?.constraints ?? {});
      expect(constraintKeys).not.toContain("whitelistValidation");
      expect(constraintKeys).toContain("max");
    });

    it("REG-B185 DTO accepts an accuracy exactly at the 99999.99 bound", async () => {
      const errors = await whitelistErrors({
        ...basePayload,
        accuracy: 99999.99,
      });
      expect(errors).toHaveLength(0);
    });
  });

  describe("T5 pins — existing validation surface unchanged", () => {
    it("accepts a fully valid payload", async () => {
      const errors = await whitelistErrors({
        ...basePayload,
        heading: 180,
        speedKph: 42,
        batteryPct: 55,
        runId: "run-1",
      });
      expect(errors).toHaveLength(0);
    });

    it("rejects lat out of range", async () => {
      const errors = await whitelistErrors({ ...basePayload, lat: 91 });
      const latError = errors.find((e) => e.property === "lat");
      expect(latError).toBeDefined();
      expect(Object.keys(latError?.constraints ?? {})).toContain("max");
    });

    it("rejects lat below range", async () => {
      const errors = await whitelistErrors({ ...basePayload, lat: -91 });
      const latError = errors.find((e) => e.property === "lat");
      expect(latError).toBeDefined();
      expect(Object.keys(latError?.constraints ?? {})).toContain("min");
    });

    it("rejects lng out of range", async () => {
      const errors = await whitelistErrors({ ...basePayload, lng: 181 });
      const lngError = errors.find((e) => e.property === "lng");
      expect(lngError).toBeDefined();
      expect(Object.keys(lngError?.constraints ?? {})).toContain("max");
    });

    it("rejects lng below range", async () => {
      const errors = await whitelistErrors({ ...basePayload, lng: -181 });
      const lngError = errors.find((e) => e.property === "lng");
      expect(lngError).toBeDefined();
      expect(Object.keys(lngError?.constraints ?? {})).toContain("min");
    });

    it("rejects a negative heading", async () => {
      const errors = await whitelistErrors({ ...basePayload, heading: -1 });
      const headingError = errors.find((e) => e.property === "heading");
      expect(headingError).toBeDefined();
      expect(Object.keys(headingError?.constraints ?? {})).toContain("min");
    });

    it("rejects a negative speedKph", async () => {
      const errors = await whitelistErrors({ ...basePayload, speedKph: -1 });
      const speedKphError = errors.find((e) => e.property === "speedKph");
      expect(speedKphError).toBeDefined();
      expect(Object.keys(speedKphError?.constraints ?? {})).toContain("min");
    });

    it("rejects a missing recordedAt", async () => {
      const { recordedAt: _omit, ...rest } = basePayload;
      const errors = await whitelistErrors(rest);
      const recordedAtError = errors.find((e) => e.property === "recordedAt");
      expect(recordedAtError).toBeDefined();
    });
  });
});
