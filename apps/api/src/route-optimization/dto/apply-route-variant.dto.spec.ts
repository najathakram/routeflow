import { ValidationPipe } from "@nestjs/common";
import { ApplyRouteVariantDto } from "./apply-route-variant.dto";

/**
 * `POST /routes/:id/variants/apply` used to take an inline TS type as its
 * @Body(). A bare TS type has metatype `Object`, which the global
 * ValidationPipe skips entirely — so `{}` reached the service and blew up on
 * `dto.stopIds.length` as a 500, and a junk `optimizeBy` reached Prisma as an
 * enum error. These assert the DTO class actually gates the endpoint.
 */
describe("ApplyRouteVariantDto", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const meta = {
    type: "body" as const,
    metatype: ApplyRouteVariantDto,
    data: "",
  };

  const valid = {
    stopIds: ["stop-1", "stop-2"],
    optimizeBy: "TIME",
    avoidTolls: false,
  };

  it("accepts a well-formed body", async () => {
    await expect(pipe.transform({ ...valid }, meta)).resolves.toMatchObject({
      stopIds: ["stop-1", "stop-2"],
      optimizeBy: "TIME",
      avoidTolls: false,
    });
  });

  it("accepts the optional key/encodedPolyline/runId fields", async () => {
    await expect(
      pipe.transform({ ...valid, key: "FASTEST", encodedPolyline: "abc", runId: "run-1" }, meta),
    ).resolves.toMatchObject({ key: "FASTEST", encodedPolyline: "abc", runId: "run-1" });
  });

  it("rejects an empty body with a 400 rather than reaching the service", async () => {
    await expect(pipe.transform({}, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an empty stopIds array", async () => {
    await expect(pipe.transform({ ...valid, stopIds: [] }, meta)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects non-string stop ids", async () => {
    await expect(pipe.transform({ ...valid, stopIds: [1, 2] }, meta)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects an optimizeBy outside the enum (would be a Prisma 500 otherwise)", async () => {
    await expect(pipe.transform({ ...valid, optimizeBy: "FASTEST" }, meta)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects a non-boolean avoidTolls", async () => {
    await expect(pipe.transform({ ...valid, avoidTolls: "yes" }, meta)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects unknown properties (forbidNonWhitelisted)", async () => {
    await expect(
      pipe.transform({ ...valid, tenantId: "other-tenant" }, meta),
    ).rejects.toMatchObject({ status: 400 });
  });
});
