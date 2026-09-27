/**
 * #2403 (P0, epic #2400): "Remove credit" on an invoice showed only for role === "OPERATOR",
 * but the API's RolesGuard lets TENANT_ADMIN (and SUPER_ADMIN) satisfy @Roles(OPERATOR)
 * (roles.guard.ts ROLE_SATISFIES). SA-436 PR-3: isOperator -> isStaff, one condition, the
 * server's own role set.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { RemoveCreditButton } from "./RemoveCreditButton";

describe("RemoveCreditButton (#2403)", () => {
  it.each(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])("%s sees Remove credit", (role) => {
    const onRemove = jest.fn();
    render(<RemoveCreditButton role={role} voided={false} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove credit" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it.each(["DRIVER", "CUSTOMER", undefined])("%s does not", (role) => {
    render(<RemoveCreditButton role={role} voided={false} onRemove={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Remove credit" })).toBeNull();
  });

  it("nobody sees it on a voided invoice", () => {
    render(<RemoveCreditButton role="TENANT_ADMIN" voided onRemove={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Remove credit" })).toBeNull();
  });

  it("the invoice page renders it instead of an OPERATOR-only gate", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/<RemoveCreditButton[\s\S]*?role=\{user\?\.role\}/);
    expect(src).not.toMatch(/role === "OPERATOR"/);
  });
});
