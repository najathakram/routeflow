import { API_ERROR_CODES, ORDER_DELIVERED_ON_ROUTE_STOP_COPY } from "@routeflow/types";
import { codedToastCopy, genericToastCopy } from "./generic-toast-copy";

/**
 * Row 590 (SA-978a): an office DELIVERED on an order whose run stop has not completed is refused with
 * ORDER_DELIVERED_ON_ROUTE_STOP. The generic toast shows the fixed sentence (never the neutral conflict line,
 * never the server's text); there is no new dialog.
 */
const err = (code: string) => ({
  message: "Request failed with status code 409",
  response: { status: 409, data: { code, message: "raw server text" } },
});

describe("ORDER_DELIVERED_ON_ROUTE_STOP copy", () => {
  it("maps to the fixed sentence with both ways forward", () => {
    const copy = genericToastCopy(err(API_ERROR_CODES.ORDER_DELIVERED_ON_ROUTE_STOP));
    expect(copy).toBe(
      "This order is on a delivery run. Complete its stop on the route, or take it off the run first.",
    );
    expect(copy).toBe(ORDER_DELIVERED_ON_ROUTE_STOP_COPY);
  });

  it("is a coded refusal, so a surface with its own fallback still shows it", () => {
    expect(codedToastCopy(err(API_ERROR_CODES.ORDER_DELIVERED_ON_ROUTE_STOP))).toBe(
      ORDER_DELIVERED_ON_ROUTE_STOP_COPY,
    );
  });
});
