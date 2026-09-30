import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { UpdateRouteSettingsDto } from "./update-route-settings.dto";

const errs = (o: unknown) => validateSync(plainToInstance(UpdateRouteSettingsDto, o)).length;

describe("UpdateRouteSettingsDto depot coordinates", () => {
  it.each([
    [{ depotLat: 91, depotLng: 0 }],
    [{ depotLat: -91, depotLng: 0 }],
    [{ depotLat: NaN, depotLng: 0 }],
    [{ depotLat: "40", depotLng: 0 }],
    [{ depotLat: 0, depotLng: 181 }],
    [{ depotLat: 0, depotLng: -181 }],
    [{ depotLat: null, depotLng: 0 }],
    [{ depotLat: 0, depotLng: null }],
  ])("rejects %j", (body) => {
    expect(errs(body)).toBeGreaterThan(0);
  });

  it.each([
    [{ depotLat: 90, depotLng: 180 }],
    [{ depotLat: -90, depotLng: -180 }],
    [{ depotLat: 40.7128, depotLng: -74.006 }],
    [{}],
  ])("accepts %j", (body) => {
    expect(errs(body)).toBe(0);
  });
});
