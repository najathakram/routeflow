import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExtendTrialDialog, ImpersonateDialog, longDate, tenantLabel } from "./TenantActionDialogs";

/**
 * Back-office confirmations (P1): each names the tenant, says what the action does, focuses Cancel
 * first, and only gates the call (Escape / Cancel / close never confirm).
 */
const acme = { name: "acme", businessName: "Acme Wholesale" };

describe("tenantLabel", () => {
  it("is the business name, else the name — never empty", () => {
    expect(tenantLabel(acme)).toBe("Acme Wholesale");
    expect(tenantLabel({ name: "acme", businessName: null })).toBe("acme");
    expect(tenantLabel({ name: "acme", businessName: "  " })).toBe("acme");
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

  it("names the tenant in the title and the user you will act as in the body", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Impersonate Acme Wholesale?" })).toBeInTheDocument();
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

  it("Enter on the focused Cancel closes without confirming; Escape closes without confirming", () => {
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
  const setup = (status: string, days = 14) => {
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
      />,
    );
    return { onClose, onConfirm };
  };

  it("on a TRIAL tenant it says when the trial will end (today + days), nothing about a status change", () => {
    setup("TRIAL");
    expect(
      screen.getByRole("dialog", { name: "Extend the trial for Acme Wholesale?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The trial will end on October 21, 2026.")).toBeInTheDocument();
    expect(screen.queryByText(/changes its status to Trial/)).not.toBeInTheDocument();
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
          `Acme Wholesale is ${word}. Extending the trial changes its status to Trial until November 6, 2026.`,
        ),
      ).toBeInTheDocument();
    },
  );

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

describe("longDate", () => {
  it("formats a long US date", () => {
    expect(longDate(new Date("2026-10-21T12:00:00"))).toBe("October 21, 2026");
  });
});
