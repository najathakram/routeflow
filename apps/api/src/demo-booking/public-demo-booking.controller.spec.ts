import { PublicDemoBookingController } from "./public-demo-booking.controller";
import { CancelDemoBookingDto, RescheduleDemoBookingDto } from "./dto/demo-booking.dto";

/**
 * Review finding 8: the manage token must never travel in the URL path (it
 * lands in access logs and Sentry's `originalUrl` tag on any 5xx, and a
 * path-templated route has no natural place to expire it). These pin the
 * transport, not the business logic — `DemoBookingService` itself is fully
 * covered elsewhere.
 */
describe("PublicDemoBookingController — token transport (review finding 8)", () => {
  function build() {
    const service = {
      getByToken: jest.fn().mockResolvedValue({ id: "b1" }),
      reschedule: jest.fn().mockResolvedValue({ id: "b1" }),
      cancel: jest.fn().mockResolvedValue({ id: "b1" }),
      create: jest.fn().mockResolvedValue({ booking: { id: "b1" }, manageToken: "tok" }),
      getAvailability: jest.fn(),
    };
    return { service, controller: new PublicDemoBookingController(service as never) };
  }

  it("reads the token from the X-Booking-Token header, not a URL param", async () => {
    const { service, controller } = build();
    await controller.get("secret-token-value");
    expect(service.getByToken).toHaveBeenCalledWith("secret-token-value");
  });

  it("treats a missing header as an empty token rather than throwing in the controller", async () => {
    const { service, controller } = build();
    await controller.get(undefined as unknown as string);
    expect(service.getByToken).toHaveBeenCalledWith("");
  });

  it("reads the token from the request body on reschedule, not a URL param", async () => {
    const { service, controller } = build();
    const dto: RescheduleDemoBookingDto = {
      token: "secret-token-value",
      startsAt: "2026-10-16T14:00:00Z",
    };
    await controller.reschedule(dto);
    expect(service.reschedule).toHaveBeenCalledWith("secret-token-value", "2026-10-16T14:00:00Z");
  });

  it("reads the token from the request body on cancel, not a URL param", async () => {
    const { service, controller } = build();
    const dto: CancelDemoBookingDto = { token: "secret-token-value", reason: "changed plans" };
    await controller.cancel(dto);
    expect(service.cancel).toHaveBeenCalledWith("secret-token-value", "changed plans");
  });

  it("never returns the manage token from create — it only reaches the visitor by email", async () => {
    const { controller } = build();
    const result = await controller.create(
      {
        name: "Alex",
        email: "alex@example.com",
        company: "Acme",
        startsAt: "2026-10-16T14:00:00Z",
        timeZone: "America/Chicago",
      },
      { ip: "127.0.0.1" } as never,
    );
    expect(result).not.toHaveProperty("manageToken");
  });
});
