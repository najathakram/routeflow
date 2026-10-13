/**
 * The api never value-imports @routeflow/types at runtime, so the service keeps its own display-order list of
 * fulfilment modes. This pins it (and the registry's config modes) to the shared constants.
 */
import { COUNTER_SALES_MODE_VALUES, FULFILMENT_MODE_VALUES } from "@routeflow/types";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { FULFILMENT_OPTION_ORDER } from "./settings-fulfilment.service";

const modesOf = (key: string) =>
  Object.keys(FEATURE_REGISTRY.find((f) => f.key === key)!.config!.modes);

describe("fulfilment mode lists agree", () => {
  it("the service's option order is set-equal to the shared FULFILMENT_MODE_VALUES and the registry", () => {
    expect(new Set(FULFILMENT_OPTION_ORDER)).toEqual(new Set(FULFILMENT_MODE_VALUES));
    expect(FULFILMENT_OPTION_ORDER).toHaveLength(FULFILMENT_MODE_VALUES.length);
    expect(new Set(modesOf("fulfilment_model"))).toEqual(new Set(FULFILMENT_MODE_VALUES));
  });

  it("counter_sales registry modes equal the shared COUNTER_SALES_MODE_VALUES", () => {
    expect(new Set(modesOf("counter_sales"))).toEqual(new Set(COUNTER_SALES_MODE_VALUES));
  });
});
