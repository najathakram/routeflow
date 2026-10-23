import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Mobile fit for every ConfirmDialog consumer (#3224 pixel review at 390px): the footer buttons are
 * at least 44px tall and the dialog keeps 16px side gutters. Both are small-screen only, so the
 * desktop dialog is unchanged. jsdom has no layout, so these pin the classes; the 390px pixels are
 * checked in the browser.
 */
describe("ConfirmDialog mobile fit", () => {
  const open = () =>
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={() => undefined}
        title="Disable Route Plus?"
        confirmLabel="Disable add-on"
      />,
    );

  it("footer buttons are 44px tall on small screens and unchanged from sm up", () => {
    open();
    const dialog = within(screen.getByRole("dialog"));
    for (const name of ["Cancel", "Disable add-on"]) {
      const cls = dialog.getByRole("button", { name }).className;
      expect(cls).toMatch(/(^|\s)min-h-11(\s|$)/);
      expect(cls).toMatch(/(^|\s)sm:min-h-0(\s|$)/);
    }
  });

  it("keeps 16px side gutters on small screens and the 384px width from sm up", () => {
    open();
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("max-w-[calc(100vw-2rem)]");
    expect(cls).toContain("sm:max-w-sm");
    expect(cls).not.toMatch(/(^|\s)max-w-sm(\s|$)/); // the bare 384px cap is what left 3px gutters
  });
});

describe("ConfirmDialog P-15 focus + variants", () => {
  const mk = (variant?: "danger" | "secondary" | "warning") =>
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        onConfirm={() => undefined}
        title="Delete thing?"
        confirmLabel="Yes, delete"
        variant={variant}
      />,
    );

  it("a danger dialog opens with focus on Cancel, so Enter cannot confirm", () => {
    mk("danger");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("a warning dialog is not red and does not steal focus to Cancel", () => {
    mk("warning");
    const confirm = screen.getByRole("button", { name: "Yes, delete" });
    expect(confirm.className).not.toMatch(/bg-danger/);
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveFocus();
  });

  it("a secondary dialog keeps the default focus", () => {
    mk("secondary");
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveFocus();
  });
});
