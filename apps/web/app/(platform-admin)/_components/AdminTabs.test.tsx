import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { AdminTabs } from "./AdminTabs";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "billing", label: "Billing & Subscription" },
  { key: "setup", label: "Setup" },
  { key: "config", label: "Configuration" },
];

describe("SA-1: AdminTabs keeps the active tab in view on a narrow screen", () => {
  let scrollIntoView: jest.Mock;
  beforeEach(() => {
    scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  });

  it("scrolls the active tab into view when the page opens on a tab past the fold (?tab=setup)", () => {
    render(<AdminTabs tabs={TABS} active="setup" onChange={jest.fn()} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole("button", { name: "Setup" }));
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ inline: "nearest", block: "nearest" }),
    );
  });

  it("scrolls again when the active tab changes", () => {
    const { rerender } = render(<AdminTabs tabs={TABS} active="overview" onChange={jest.fn()} />);
    scrollIntoView.mockClear();
    rerender(<AdminTabs tabs={TABS} active="config" onChange={jest.fn()} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole("button", { name: "Configuration" }),
    );
  });

  it("marks the active tab with aria-current and still calls onChange with the key", () => {
    const onChange = jest.fn();
    render(<AdminTabs tabs={TABS} active="overview" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Setup" })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    expect(onChange).toHaveBeenCalledWith("setup");
  });

  it("does not throw where scrollIntoView does not exist", () => {
    // @ts-expect-error simulating an old engine
    delete Element.prototype.scrollIntoView;
    expect(() =>
      render(<AdminTabs tabs={TABS} active="setup" onChange={jest.fn()} />),
    ).not.toThrow();
  });
});
