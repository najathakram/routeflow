import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { useResetOnOpen } from "./use-reset-on-open";

/**
 * The Dispatch form on a cold load: the dialog opens before the tenant's zone resolves, the operator types a date and a
 * driver, then the zone resolves. The reset must not run again then, and a field still empty must take the tenant's day.
 */
function useForm(open: boolean, today: string | undefined) {
  const [date, setDate] = React.useState("");
  const [driverId, setDriverId] = React.useState("");
  useResetOnOpen(open, today, (day) => {
    setDate(day);
    setDriverId("");
  });
  // what `useOnTenantToday` does when the zone arrives: seed into an empty field only
  React.useEffect(() => {
    if (today) setDate((cur) => cur || today);
  }, [today]);
  return { date, driverId, setDate, setDriverId };
}

describe("useResetOnOpen", () => {
  it("keeps what was typed when the tenant's day resolves after the dialog opened", () => {
    const { result, rerender } = renderHook(({ open, today }) => useForm(open, today), {
      initialProps: { open: true, today: undefined as string | undefined },
    });
    act(() => {
      result.current.setDate("2026-12-01");
      result.current.setDriverId("drv-1");
    });
    rerender({ open: true, today: "2026-10-26" });
    expect(result.current.date).toBe("2026-12-01");
    expect(result.current.driverId).toBe("drv-1");
  });

  it("fills an empty date with the tenant's day when it resolves", () => {
    const { result, rerender } = renderHook(({ open, today }) => useForm(open, today), {
      initialProps: { open: true, today: undefined as string | undefined },
    });
    expect(result.current.date).toBe("");
    rerender({ open: true, today: "2026-10-26" });
    expect(result.current.date).toBe("2026-10-26");
  });

  it("resets on every open, to the tenant's day when it is already known", () => {
    const { result, rerender } = renderHook(({ open, today }) => useForm(open, today), {
      initialProps: { open: false, today: "2026-10-26" as string | undefined },
    });
    rerender({ open: true, today: "2026-10-26" });
    act(() => {
      result.current.setDate("2026-12-01");
      result.current.setDriverId("drv-1");
    });
    rerender({ open: false, today: "2026-10-26" });
    rerender({ open: true, today: "2026-10-26" });
    expect(result.current.date).toBe("2026-10-26");
    expect(result.current.driverId).toBe("");
  });
});
