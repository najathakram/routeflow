/**
 * FE1 (row 538 apple-ux): the shared dialog's enter/exit animation eases out (not linear) over ~150 ms, and the
 * reduced-motion branch still removes every animation. Asserts the classes the dialog and its overlay really render.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Modal } from "@routeflow/ui/web";

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("FE1: Modal motion", () => {
  const open = (anchor?: "center" | "top") =>
    render(
      <Modal open onClose={jest.fn()} title="Sample" anchor={anchor}>
        body
      </Modal>,
    );

  it.each(["center", "top"] as const)("the %s dialog eases out over 150 ms, never linear", (a) => {
    open(a);
    const cls = classesOf(screen.getByRole("dialog"));
    expect(cls).toContain("ease-out");
    expect(cls).toContain("duration-150");
    expect(cls.some((c) => /(^|:)(ease-linear|linear)$/.test(c))).toBe(false);
    expect(cls).toContain("data-[state=open]:animate-in");
  });

  it("the backdrop eases out too", () => {
    open();
    const overlay = document.querySelector("[data-modal-overlay]");
    expect(overlay).not.toBeNull();
    const cls = classesOf(overlay as Element);
    expect(cls).toContain("ease-out");
    expect(cls).toContain("duration-150");
  });

  it("reduced motion still switches every animation off (dialog and backdrop)", () => {
    open();
    expect(classesOf(screen.getByRole("dialog"))).toContain("motion-reduce:!animate-none");
    expect(classesOf(document.querySelector("[data-modal-overlay]") as Element)).toContain(
      "motion-reduce:!animate-none",
    );
  });
});
