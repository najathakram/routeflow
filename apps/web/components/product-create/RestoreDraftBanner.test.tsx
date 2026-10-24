import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RestoreDraftBanner } from "./RestoreDraftBanner";

describe("RestoreDraftBanner", () => {
  it("offers Restore and Start fresh", async () => {
    const onRestore = jest.fn();
    const onDiscard = jest.fn();
    render(<RestoreDraftBanner onRestore={onRestore} onDiscard={onDiscard} />);
    expect(screen.getByTestId("units-v2-restore-banner")).toBeInTheDocument();
    expect(screen.getByTestId("units-v2-restore-yes")).toHaveTextContent("Restore");
    expect(screen.getByTestId("units-v2-restore-no")).toHaveTextContent("Start fresh");
    await userEvent.click(screen.getByTestId("units-v2-restore-yes"));
    expect(onRestore).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId("units-v2-restore-no"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("uses no em or en dashes in its copy", () => {
    render(<RestoreDraftBanner onRestore={jest.fn()} onDiscard={jest.fn()} />);
    expect(screen.getByTestId("units-v2-restore-banner").textContent).not.toMatch(/[–—]/);
  });
});
