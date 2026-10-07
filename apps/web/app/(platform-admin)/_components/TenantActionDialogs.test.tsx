import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DeleteTenantDialog,
  ExtendTrialDialog,
  ImpersonateDialog,
  SuspendDialog,
  TENANT_ACTION_COPY,
  deleteFailureCopy,
  isValidTrialDays,
  longDate,
  tenantLabel,
  tenantTitle,
} from "./TenantActionDialogs";

/**
 * Back-office confirmations (P1): each names the tenant (name AND slug), says what the action does,
 * focuses Cancel first, and only gates the call (Escape / Cancel / close never confirm).
 */
const acme = { name: "acme", businessName: "Acme Wholesale", slug: "acme" };

describe("tenantLabel / tenantTitle", () => {
  it("the label is the business name, else the name — never empty", () => {
    expect(tenantLabel(acme)).toBe("Acme Wholesale");
    expect(tenantLabel({ name: "acme", businessName: null })).toBe("acme");
    expect(tenantLabel({ name: "acme", businessName: "  " })).toBe("acme");
  });

  it("the title adds the slug, so two tenants that share a name are told apart", () => {
    expect(tenantTitle(acme)).toBe("Acme Wholesale (acme)");
    expect(tenantTitle({ ...acme, slug: "acme-2" })).toBe("Acme Wholesale (acme-2)");
    expect(tenantTitle({ name: "acme" })).toBe("acme");
  });
});

describe("ImpersonateDialog", () => {
  const setup = (over: Partial<React.ComponentProps<typeof ImpersonateDialog>> = {}) => {
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    render(
      <ImpersonateDialog
        open
        tenant={acme}
        adminUsername="acme_admin"
        onClose={onClose}
        onConfirm={onConfirm}
        {...over}
      />,
    );
    return { onClose, onConfirm };
  };

  it("names the tenant and slug in the title and the user you will act as in the body", () => {
    setup();
    expect(
      screen.getByRole("dialog", { name: "Impersonate Acme Wholesale (acme)?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("acme_admin")).toBeInTheDocument();
    expect(screen.getByText(/full\s+access for up to 15 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/The audit log records that this session started/)).toBeInTheDocument();
    expect(screen.getByText(/click Exit impersonation in the\s+red bar/)).toBeInTheDocument();
  });

  it('falls back to "its admin" when the acting user is not known (the list row)', () => {
    setup({ adminUsername: null });
    expect(screen.getByText("its admin")).toBeInTheDocument();
  });

  it("puts the initial focus on Cancel, not on Impersonate", () => {
    setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Impersonate" })).not.toHaveFocus();
  });

  it("the Cancel button and Escape each close without confirming", () => {
    const { onClose, onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("the Impersonate button confirms exactly once", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Impersonate" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(
      <ImpersonateDialog open={false} tenant={acme} onClose={jest.fn()} onConfirm={jest.fn()} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ExtendTrialDialog", () => {
  const NOW = new Date("2026-10-07T12:00:00");
  const setup = (
    status: string,
    days = 14,
    over: Partial<React.ComponentProps<typeof ExtendTrialDialog>> = {},
  ) => {
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    render(
      <ExtendTrialDialog
        open
        tenant={acme}
        status={status}
        days={days}
        now={NOW}
        onClose={onClose}
        onConfirm={onConfirm}
        {...over}
      />,
    );
    return { onClose, onConfirm };
  };

  it("on a TRIAL tenant it says when the trial will end (today + days), nothing about a status change", () => {
    setup("TRIAL");
    expect(
      screen.getByRole("dialog", { name: "Extend the trial for Acme Wholesale (acme)?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The trial will end on October 21, 2026.")).toBeInTheDocument();
    expect(screen.queryByText(/changes its status to Trial/)).not.toBeInTheDocument();
  });

  it("shows the days and the date they lead to", () => {
    setup("TRIAL", 14);
    expect(screen.getByText("14 days from today.")).toBeInTheDocument();
    expect(screen.getByText("The trial will end on October 21, 2026.")).toBeInTheDocument();
  });

  it("one day reads singular", () => {
    setup("TRIAL", 1);
    expect(screen.getByText("1 day from today.")).toBeInTheDocument();
  });

  it.each([
    ["ACTIVE", "Active"],
    ["SUSPENDED", "Suspended"],
    ["CANCELLED", "Cancelled"],
  ])(
    "on a %s tenant it says the status changes to Trial (the server sets TRIAL unconditionally)",
    (status, word) => {
      setup(status, 30);
      expect(
        screen.getByText(
          `Acme Wholesale (acme) is ${word}. Extending the trial changes its status to Trial until November 6, 2026.`,
        ),
      ).toBeInTheDocument();
    },
  );

  it("a TRIAL tenant whose current end is LATER than the new date is warned the trial is SHORTENED", () => {
    setup("TRIAL", 14, { trialEndsAt: "2026-12-01T12:00:00.000Z" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /This shortens the trial from December 1, 2026 to October 21, 2026\./,
    );
  });

  it("no warning when the new date is later, when the tenant is not on a trial, or there is no end", () => {
    setup("TRIAL", 14, { trialEndsAt: "2026-10-10T12:00:00.000Z" });
    expect(screen.queryByText(/shortens/)).not.toBeInTheDocument();
  });

  it("not on a trial: a later current end is not a 'shortening' (the status change is the news)", () => {
    setup("ACTIVE", 14, { trialEndsAt: "2027-01-01T12:00:00.000Z" });
    expect(screen.queryByText(/shortens/)).not.toBeInTheDocument();
  });

  it.each([[0], [-3], [366], [Number.NaN], [2.5]])(
    "days %p: a plain 'Enter 1–365 days' line, Confirm blocked, no date and never 'Invalid Date'",
    (days) => {
      const { onConfirm } = setup("TRIAL", days);
      expect(screen.getByText("Enter 1–365 days.")).toBeInTheDocument();
      expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
      expect(screen.queryByText(/trial will end/)).not.toBeInTheDocument();
      const confirm = screen.getByRole("button", { name: "Extend Trial" });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it("isValidTrialDays: whole numbers 1 to 365 only", () => {
    for (const ok of [1, 14, 365]) expect(isValidTrialDays(ok)).toBe(true);
    for (const bad of [0, -1, 366, 1.5, Number.NaN, Infinity]) {
      expect(isValidTrialDays(bad)).toBe(false);
    }
  });

  it("focuses Cancel first; Cancel and Escape never confirm; Extend Trial confirms once", () => {
    const { onClose, onConfirm } = setup("ACTIVE");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Extend Trial" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("SuspendDialog", () => {
  const setup = () => {
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    render(<SuspendDialog open tenant={acme} onClose={onClose} onConfirm={onConfirm} />);
    return { onClose, onConfirm };
  };

  it("names the tenant and slug, says what suspending does, and Cancel is focused first", () => {
    setup();
    expect(
      screen.getByRole("dialog", { name: 'Suspend "Acme Wholesale (acme)"?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /People at Acme Wholesale \(acme\) can't sign in while it's suspended\. You can reactivate it at any\s+time\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("Cancel and Escape never confirm; Suspend confirms once", () => {
    const { onClose, onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("DeleteTenantDialog", () => {
  const setup = (over: Partial<React.ComponentProps<typeof DeleteTenantDialog>> = {}) => {
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    render(
      <DeleteTenantDialog open tenant={acme} onClose={onClose} onConfirm={onConfirm} {...over} />,
    );
    return { onClose, onConfirm };
  };
  const slugBox = () => screen.getByLabelText("Type the tenant slug to confirm deletion");

  it("names the tenant and slug, says it cannot be undone, and asks for the slug", () => {
    setup();
    expect(
      screen.getByRole("dialog", { name: "Delete Acme Wholesale (acme)?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This cancels and archives Acme Wholesale (acme). You can't undo this."),
    ).toBeInTheDocument();
    expect(screen.getByText(/To confirm, type the tenant slug:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("Delete Tenant stays disabled until the slug is typed EXACTLY", () => {
    const { onConfirm } = setup();
    const del = screen.getByRole("button", { name: "Delete Tenant" });
    expect(del).toBeDisabled();
    for (const wrong of ["acm", "ACME", "acme ", " acme", "acme-2", ""]) {
      fireEvent.change(slugBox(), { target: { value: wrong } });
      expect(del).toBeDisabled();
    }
    fireEvent.click(del);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(slugBox(), { target: { value: "acme" } });
    expect(del).toBeEnabled();
    fireEvent.click(del);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("an error from the page shows INSIDE the dialog and the dialog stays open", () => {
    setup({ error: TENANT_ACTION_COPY.deleteRefused });
    expect(screen.getByRole("alert")).toHaveTextContent(TENANT_ACTION_COPY.deleteRefused);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("while deleting the button says so and is disabled; Cancel and Escape never confirm", () => {
    const { onClose, onConfirm } = setup({ busy: true });
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("what was typed is cleared when the dialog is opened again", () => {
    const { rerender } = render(
      <DeleteTenantDialog open tenant={acme} onClose={jest.fn()} onConfirm={jest.fn()} />,
    );
    fireEvent.change(slugBox(), { target: { value: "acme" } });
    rerender(
      <DeleteTenantDialog open={false} tenant={acme} onClose={jest.fn()} onConfirm={jest.fn()} />,
    );
    rerender(<DeleteTenantDialog open tenant={acme} onClose={jest.fn()} onConfirm={jest.fn()} />);
    expect((slugBox() as HTMLInputElement).value).toBe("");
  });
});

describe("fixed failure copy", () => {
  it("a 400 or 409 on delete is the 'only a suspended tenant' sentence; anything else a plain failure", () => {
    expect(deleteFailureCopy({ response: { status: 400 } })).toBe(TENANT_ACTION_COPY.deleteRefused);
    expect(deleteFailureCopy({ response: { status: 409 } })).toBe(TENANT_ACTION_COPY.deleteRefused);
    expect(deleteFailureCopy({ response: { status: 500 } })).toBe(TENANT_ACTION_COPY.deleteFailed);
    expect(deleteFailureCopy(new Error("boom"))).toBe(TENANT_ACTION_COPY.deleteFailed);
    expect(deleteFailureCopy(null)).toBe(TENANT_ACTION_COPY.deleteFailed);
  });

  it("no copy carries a raw server shape", () => {
    expect(TENANT_ACTION_COPY.noAdmin("Acme")).toBe(
      "Acme has no active admin. Create one in Admin Account, then try again.",
    );
  });
});

describe("longDate", () => {
  it("formats a long US date", () => {
    expect(longDate(new Date("2026-10-21T12:00:00"))).toBe("October 21, 2026");
  });
});
