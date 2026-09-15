import * as React from "react";
import { render, screen } from "@testing-library/react";
import { PLAN_KEYS } from "@routeflow/types";
import AdminCreateTenantPage from "./page";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    post: jest.fn(),
  },
}));

describe("AdminCreateTenantPage plan select (REG-743-F1)", () => {
  it("every plan option the form offers is a PLAN_KEYS member and every PLAN_KEYS member is offered", () => {
    render(<AdminCreateTenantPage />);

    // The Plan <label> has no htmlFor/id association with the <select>, so query by
    // role instead of label text — the form has exactly one <select> (Plan).
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const offered = Array.from(select.options).map((o) => o.value);

    // Head hand-types `["STARTER", "PROFESSIONAL", "ENTERPRISE"]` — "PROFESSIONAL" is not a
    // real PLAN_KEYS member (a legacy TenantPlan value) and GROWTH/SCALE are missing, so this
    // fails on head both ways: an offered value absent from PLAN_KEYS, and a PLAN_KEYS member
    // absent from the offered options.
    for (const value of offered) {
      expect(PLAN_KEYS).toContain(value);
    }
    for (const key of PLAN_KEYS) {
      expect(offered).toContain(key);
    }
  });
});
