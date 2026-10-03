import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ChipGroup, Fold, MotionProvider, Switch, useReducedMotion } from "@routeflow/ui/web";
import { mockReducedMotion } from "./matchMedia";

const Probe = () => <span data-testid="p">{String(useReducedMotion())}</span>;
const MOTION_CLASS = /(^|\s)(transition|animate)/;

describe("useReducedMotion / MotionProvider", () => {
  it("is true when the OS says reduce, false when it does not", () => {
    mockReducedMotion(true);
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId("p")).toHaveTextContent("true");
    unmount();
    mockReducedMotion(false);
    render(<Probe />);
    expect(screen.getByTestId("p")).toHaveTextContent("false");
  });

  it("defaults to reduce when matchMedia is missing (SSR-safe)", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    render(<Probe />);
    expect(screen.getByTestId("p")).toHaveTextContent("true");
  });

  it("the provider exposes {reduced} to children", () => {
    mockReducedMotion(true);
    render(
      <MotionProvider>
        <Probe />
      </MotionProvider>,
    );
    expect(screen.getByTestId("p")).toHaveTextContent("true");
  });

  it("with reduce, every animated kit part renders no transition/animation class", () => {
    mockReducedMotion(true);
    const { container } = render(
      <>
        <Switch checked label="a" onCheckedChange={() => {}} />
        <Fold defaultOpen summary="s">
          body
        </Fold>
        <ChipGroup
          ariaLabel="c"
          options={[{ value: "a", label: "A" }]}
          value="a"
          onChange={() => {}}
        />
      </>,
    );
    const offenders = Array.from(container.querySelectorAll("[class]")).filter((el) =>
      el
        .getAttribute("class")!
        .split(/\s+/)
        .some((c) => MOTION_CLASS.test(c) || /^transition/.test(c)),
    );
    expect(offenders).toEqual([]);
  });

  it("with motion allowed, the Switch thumb does transition (so the check above can fail)", () => {
    mockReducedMotion(false);
    const { container } = render(<Switch checked label="a" onCheckedChange={() => {}} />);
    expect(container.innerHTML).toMatch(/transition-transform/);
  });
});
